import { chromium } from 'playwright';
import { resolvePath, sleep, jitter, info, warn } from './util.js';
import { COL_RE, pageWorker } from './columns.js';

/**
 * 打开持久化用户目录的浏览器上下文。登录态保存在 userDataDir,
 * 手动登录一次后即可长期复用(session 过期前)。
 */
export async function launchBrowser(config) {
  const b = config.browser;
  const userDataDir = resolvePath(b.userDataDir);
  info('启动浏览器(持久 profile):', userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !!b.headless,
    channel: b.channel && b.channel !== 'chromium' ? b.channel : undefined,
    slowMo: b.slowMoMs || 0,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  context.setDefaultNavigationTimeout(b.navTimeoutMs || 45000);
  context.setDefaultTimeout(b.navTimeoutMs || 45000);

  return context;
}

export async function getPage(context) {
  const pages = context.pages();
  if (pages.length > 0) return pages[0];
  return await context.newPage();
}

/**
 * 判断是否已登录 TikTok 卖家后台。返回 { loggedIn, state }。
 * state ∈ ready | logged_out | captcha | risk_control | loading | blank | unknown
 */
export async function detectLoginState(page) {
  const url = page.url();
  // 页面压根没加载出来(about:blank / 空白),不能当成 ready
  if (!url || url === 'about:blank' || /^chrome-error:/.test(url)) {
    return { loggedIn: false, state: 'blank' };
  }
  // 明显跳到登录页/账号页
  if (/\/account\/(login|register)|\/login|passport/i.test(url)) {
    return { loggedIn: false, state: 'logged_out' };
  }
  let bodyText = '';
  try {
    bodyText = await hardDeadline(
      page.evaluate(() => document.body?.innerText?.slice(0, 4000) || ''),
      15000,
      '读页面文本'
    );
  } catch {
    // 读不出来(页面卡死/正在导航)→ 当成"没加载好",而不是"已登录"
    return { loggedIn: false, state: 'blank' };
  }
  // 白屏:有 URL 但正文几乎没东西 —— 属于"没加载好",不是"登录正常"
  if (bodyText.replace(/\s/g, '').length < 30) {
    return { loggedIn: false, state: 'blank' };
  }
  const t = bodyText.toLowerCase();
  // 验证码/拼图/滑块。覆盖 TikTok 的"请完成下列验证后继续 / 拖动完成上方拼图"这类措辞。
  if (
    /captcha|slide to|puzzle/i.test(bodyText) ||
    /滑块|验证码|拼图|完成下列验证|完成以下验证|请完成验证|拖动.{0,8}(完成|拼图)|按住.{0,8}拖动/.test(
      bodyText
    ) ||
    /xác\s*minh|kéo\s*để|ghép\s*hình|mã\s*xác\s*nhận|verify\s*to\s*continue|drag\s*the\s*puzzle/i.test(
      bodyText
    )
  ) {
    return { loggedIn: false, state: 'captcha' };
  }
  if (
    /log ?in|sign ?in|登录|登入|log in with|đăng\s*nhập/i.test(bodyText) &&
    bodyText.length < 1500
  ) {
    return { loggedIn: false, state: 'logged_out' };
  }
  if (/access denied|risk|异常|blocked|too many requests/i.test(t)) {
    return { loggedIn: false, state: 'risk_control' };
  }
  return { loggedIn: true, state: 'ready' };
}

/**
 * 请求拦截的开关管理。
 *
 * **重要实测结论**:Playwright 只要装了 route,Chromium 的 HTTP 缓存就被整个关掉
 * (本地实测:同一页连开 3 次,不装 route 时 JS 只下载 1 次,装了 route 要下载 3 次)。
 * 老代码把直播日期拦截**永久**装在 page 上,于是每小时每个计划都要把后台几 MB 的 JS
 * 重新下一遍 —— 这多半才是 60 秒导航超时的最大推手。
 *
 * 所以改成按需:
 *  · 直播计划(必须改写 post_creative_list 的日期)→ 开拦截,顺便把图片/字体/视频挡掉当补偿;
 *  · 商品计划(不需要拦截)→ 关掉,让浏览器缓存正常工作。
 * 持久 profile 的磁盘缓存跨轮、跨重启都在,所以商品计划从第二次起基本是秒开。
 */
export async function setLiveInterception(page, liveDate, config) {
  const wantOn = !!liveDate;
  page.__liveDate = liveDate || null;

  if (wantOn && !page.__routeOn) {
    const blockHeavy = config?.browser?.blockHeavyResources !== false;
    const handler = async (route) => {
      const req = route.request();
      if (req.url().includes('post_creative_list')) {
        const ld = page.__liveDate;
        const body = req.postData();
        if (ld && body) {
          try {
            const j = JSON.parse(body);
            j.start_time = ld.start;
            j.end_time = ld.end;
            return route.continue({ postData: JSON.stringify(j) });
          } catch {
            /* 解析失败则原样放行 */
          }
        }
        return route.continue();
      }
      // 反正这段时间缓存已经被关了,干脆把不看的资源挡掉,少下点东西
      if (blockHeavy) {
        const t = req.resourceType();
        if (t === 'image' || t === 'font' || t === 'media') return route.abort();
      }
      return route.continue();
    };
    page.__routeHandler = handler;
    await page.route('**/*', handler);
    page.__routeOn = true;
    info('已开启请求拦截(直播口径改写日期 + 屏蔽图片)');
  } else if (!wantOn && page.__routeOn) {
    try {
      await page.unroute('**/*', page.__routeHandler);
    } catch {
      /* 取消失败不致命,顶多这轮没缓存 */
    }
    page.__routeOn = false;
    page.__routeHandler = null;
    info('已关闭请求拦截(让浏览器 HTTP 缓存生效)');
  }
}

/**
 * 给任何 Playwright 调用套一个硬超时。
 * 必要性:导航卡住时,page.evaluate 之类会无限期等执行上下文 —— 实测能挂 5 分钟以上,
 * 比它本来要防的超时还糟。恢复路径上的每一步都必须有兜底。
 */
export function hardDeadline(promise, ms, tag) {
  promise.catch(() => {}); // 别变成未处理拒绝
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(tag + ' 超时')), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 把页面拽回空白页,清掉卡住的导航。失败也不抛。 */
async function resetToBlank(page) {
  try {
    await hardDeadline(
      page.goto('about:blank', { waitUntil: 'commit', timeout: 8000 }),
      10000,
      '回到空白页'
    );
  } catch {
    /* 拽不回来就算了,下一步会重启浏览器 */
  }
}

/**
 * 探测页面是否还"活着"。专治这种情况:登录没掉、URL 也对,
 * 但页面 JS 已经卡死 —— 点不动、也不再渲染,goto 能过但后面全超时。
 * 在页面里跑一句最简单的 JS,超时就判定为卡死。
 */
export async function isPageResponsive(page, timeoutMs = 8000) {
  try {
    return (await hardDeadline(page.evaluate(() => 1 + 1), timeoutMs, '页面探活')) === 2;
  } catch {
    return false;
  }
}

/** 把 Playwright 那一大坨带 Call log 的错误压成一句人话。 */
export function shortErr(e) {
  const msg = (e && (e.message || String(e))) || '未知错误';
  const first = msg.split('\n')[0].trim();
  if (/Timeout \d+ms exceeded/i.test(first)) return '页面加载超时';
  if (/net::ERR_NAME_NOT_RESOLVED/i.test(msg)) return '域名解析失败(DNS/网络断了)';
  if (/net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED)/i.test(msg)) return '本机网络断开/切换';
  if (/net::ERR_(CONNECTION_|TIMED_OUT|TUNNEL|PROXY)/i.test(msg)) return '连不上 TikTok(网络/代理问题)';
  if (/Target (page|closed)|has been closed/i.test(msg)) return '浏览器页面被关掉了';
  return first.slice(0, 120);
}

/** 目标 URL 的 campaign_id;用来判断"虽然报超时,但其实已经跳到目标页了"。 */
function campaignIdOf(url) {
  try {
    return new URL(url).searchParams.get('campaign_id') || '';
  } catch {
    return '';
  }
}

function alreadyLanded(page, url) {
  const cur = page.url() || '';
  if (!/seller-vn\.tiktok\.com\/ads-creation/.test(cur)) return false;
  const want = campaignIdOf(url);
  return !want || cur.includes(want);
}

/**
 * 带重试的导航。相比原来的"goto 一次、失败就抛异常":
 *  1) waitUntil 用 'commit' —— 服务器一回响应就算导航完成,不等一堆 JS/图片,超时率大降;
 *  2) 超时后先看 URL 是不是其实已经到目标页了(很常见),是就当成功;
 *  3) 否则 window.stop() + 回 about:blank 清掉卡死的渲染,退避后重试;
 *  4) 试满仍失败 → 返回 { ok:false },不抛异常,让上层跳过这个计划继续跑。
 */
export async function gotoWithRetry(page, url, config) {
  const b = config.browser;
  const attempts = Math.max(1, b.gotoRetries || 3);
  const waitUntil = b.waitUntil || 'commit';
  const timeout = b.navTimeoutMs || 45000;
  let lastErr = '未知错误';

  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return { ok: true, attempts: i };
    } catch (e) {
      lastErr = shortErr(e);
      if (alreadyLanded(page, url)) {
        warn(`导航报「${lastErr}」但页面其实已到目标页(第${i}次),继续往下走。`);
        return { ok: true, attempts: i, soft: true };
      }
      warn(`导航失败(第${i}/${attempts}次):${lastErr}`);
      if (i < attempts) {
        // 注意:这里绝不能用 page.evaluate(window.stop) —— 导航卡住时它会无限期等下去。
        // 直接把页面拽回空白页就能取消挂起的导航,实测 0.1 秒返回。
        await resetToBlank(page);
        const back = jitter(3000, 8000) * i; // 退避:约 3~8s、6~16s…
        info(`  ${Math.round(back / 1000)} 秒后重试…`);
        await sleep(back);
      }
    }
  }
  // 全部失败也要把页面清干净,否则挂起的导航会拖死下一个计划的所有操作
  await resetToBlank(page);
  return { ok: false, error: lastErr };
}

/** 轮询等创意表格出现。返回 { ok, rows }。 */
async function waitForTable(page, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const n = await tableRowCount(page);
    if (n >= 1) {
      await sleep(1200); // 缓冲,等 ROI/成本单元格数值渲染完整
      const stable = await tableRowCount(page);
      if (stable >= 1) return { ok: true, rows: stable };
    }
    await sleep(1000);
  }
  return { ok: false, rows: 0 };
}

/**
 * 导航到某 URL 并等创意表格出行。任何情况下都不抛异常。
 * 返回 { ok, rows, reason?('nav'|'table'), error? }
 */
export async function gotoAndWaitTable(page, url, config) {
  const b = config.browser;
  await humanDelay(config);

  const nav = await gotoWithRetry(page, url, config);
  if (!nav.ok) return { ok: false, rows: 0, reason: 'nav', error: nav.error };

  const budget = b.tableTimeoutMs || 60000;
  await sleep(Math.min(b.firstWaitMs || 2500, 5000)); // 给 SPA 一点起步时间
  info(`已导航,等表格出现(最多 ${Math.round(budget / 1000)} 秒)…`);

  let r = await waitForTable(page, budget);
  if (!r.ok) {
    await logRealHeaders(page);
    // SPA 偶发白屏 —— 重来一次整页加载再等一轮
    warn('表格一直没出现,重新加载页面再等一次…');
    const again = await gotoWithRetry(page, url, config);
    if (again.ok) {
      await sleep(Math.min(b.firstWaitMs || 2500, 5000));
      r = await waitForTable(page, budget);
    }
  }
  if (r.ok) {
    info(`表格已加载,行数≈${r.rows}`);
    return { ok: true, rows: r.rows };
  }
  await logRealHeaders(page);
  return { ok: false, rows: 0, reason: 'table', error: '表格始终未加载' };
}

async function tableRowCount(page) {
  try {
    return await hardDeadline(
      page.evaluate(pageWorker, { mode: 'count', RE: COL_RE }),
      15000,
      '读表格行数'
    );
  } catch {
    return 0;
  }
}

/** 表格找不到时,把页面上真实的表头打进日志 —— 一眼能看出这次是中文还是英文界面。 */
async function logRealHeaders(page) {
  try {
    const hs = await hardDeadline(
      page.evaluate(pageWorker, { mode: 'headers', RE: COL_RE }),
      15000,
      '读表头'
    );
    if (hs && hs.length) {
      warn('排障:页面上实际的表头 =', JSON.stringify(hs).slice(0, 600));
    } else {
      warn('排障:页面上一张表格都没有(没加载完 / 白屏 / 被风控挡住)');
    }
  } catch {
    /* 排障失败不影响主流程 */
  }
}

async function humanDelay(config) {
  const b = config.browser;
  const ms = jitter(b.minRandomDelayMs || 600, b.maxRandomDelayMs || 1800);
  await sleep(ms);
}
