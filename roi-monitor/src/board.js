import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SELLER_HOST, MARKET, vnDayRanges, vnDateKey, formatDT, info, warn } from './util.js';
import { getBoardPage, gotoWithRetry, setLiveInterception, resetToBlank } from './browser.js';

/**
 * 运营播报:每半小时扫一遍所有计划(当天口径),报「当天累计」+「近1小时」。
 *
 * 数据源是**广告计划列表页的接口返回**,不是把素材逐行加总 ——
 * 之前日报数字不对就栽在"素材层合计 ≠ 计划级官方数字"上。
 * 列表接口给的是后台自己算好的计划级数字,而且一次请求拿全部计划,够快。
 *
 * 「近1小时」是两次快照相减(当前累计 − 约1小时前的累计),
 * 快照存在 data/board-snapshots.jsonl,按市场当地日期分组(跨天不相减)。
 */

// ---------------- 取数 ----------------

/**
 * 取当天各计划的 成本 / 总收入 / ROI。
 *
 * ★ 2026-09-21 用真实后台核对过,以下都是实测结论,不是猜的:
 *   · 列表页 URL 支持 list_start_date / list_end_date(epoch 毫秒),能锁定"当天"
 *   · 商品计划 type=product、直播计划 type=live,是两个分开的列表,要各读一次
 *   · 两张表的**列顺序完全不同**(商品:成本第7列;直播:成本第7列但总收入第17列),
 *     所以只能按列名匹配,绝不能按位置
 *   · 列名有一堆近似项必须避开:
 *       成本   ≠ 净成本 / 优惠券成本 / 平均下单成本 / 目标ROI成本 / 受众加热成本 / 创意作品加热成本
 *       总收入 ≠ 优惠券带来的收入 / 跨广告位优惠券总收入
 *       ROI    ≠ 目标 ROI / ROI 保护 / 基本目标 ROI 成效
 *     所以下面用的是**完全匹配**,不是包含匹配
 *   · **币种会变**:同一个页面,7天视图显示 ¥、当天视图显示 VND。
 *     所以按单元格里的符号逐格判断,绝不能写死除以汇率
 */
export async function fetchCampaignStats(config, deps, opts = {}) {
  const ctx = deps.context || (deps.getContext && deps.getContext());
  if (!ctx) return { ok: false, reason: '没有可用的浏览器' };

  const page = await getBoardPage(ctx); // 播报用自己的页面,不跟素材扫描抢
  await setLiveInterception(page, null, config);

  const r = vnDayRanges(config.timezoneOffsetHours);
  const rate = config.vndToCnyRate || MARKET.rateToCny || 3891;
  const budget = config.browser?.boardTableTimeoutMs || 90000;
  // 单个 tab 最多磨这么久(含重试和中间的歇气);两个 tab 加起来约等于一轮的上限
  const tabBudget = config.browser?.boardTabBudgetMs || 5 * 60000;
  const maxTries = Math.max(2, config.browser?.boardTabTries || 5);
  const coolDown = config.browser?.boardRetryWaitMs || 20000; // 第2次歇20s、第3次40s…
  const all = [];
  const debug = [];
  const failed = [];
  const notes = [];
  const whys = [];

  for (const kind of ['product', 'live']) {
    const label = kind === 'live' ? '直播' : '商品';
    let rows = null;
    let lastWhy = '';

    // 不着急 —— 取不到就歇一会儿再来一次,直到把这个 tab 的时间预算(默认 5 分钟)用完。
    // 后台这个列表页本来就重,赶着连试三下没用,隔一会儿再要往往就出来了。
    const tabDeadline = Date.now() + tabBudget;
    for (let attempt = 1; attempt <= maxTries && !rows; attempt++) {
      if (attempt > 1) {
        // 歇多久:第2次 20 秒、第3次 40 秒…最多歇 60 秒(再久就把预算全睡掉了)
        const rest = Math.min(coolDown * (attempt - 1), 60000);
        // 剩下的时间够不够"歇完再完整等一次表格"?不够就收手,
        // 别硬凑一次"歇 9 秒、等 10 秒"的无效尝试(那次必然失败,纯浪费)
        const needed = rest + Math.min(budget, 15000);
        if (tabDeadline - Date.now() < needed) {
          lastWhy = lastWhy || '时间预算用完了';
          break;
        }
        info(`${label}:${lastWhy},歇 ${Math.round(rest / 1000)} 秒再要一次(第${attempt}/${maxTries}次)…`);
        await sleep(rest);
      }
      // 先把页面拽回空白页再导航。商品和直播是**同一个地址只差 type=**,
      // 不清干净的话上一个 tab 的表格还挂在 DOM 上 —— 新页面还没渲染完,
      // waitForRows 就会拿旧表当成"已经出行了",接着读到的就是上一个 tab 的数。
      await resetToBlank(page);
      const nav = await gotoWithRetry(page, buildListUrl(kind, r), config);
      if (!nav.ok) {
        lastWhy = `页面打不开(${nav.error})`;
        continue;
      }
      // 等多久:第一次等 budget,之后等 2 倍;但绝不超过这个 tab 剩下的预算
      const left = tabDeadline - Date.now();
      const thisBudget = Math.max(3000, Math.min(budget * Math.min(attempt, 2), left));
      const got = await waitForRows(page, thisBudget);
      if (!got) {
        lastWhy = `等了 ${Math.round(thisBudget / 1000)} 秒表格还没出行`;
        continue;
      }
      const read = await page
        .evaluate(readCampaignTable, { expect: kind })
        .catch((e) => ({ error: e.message }));
      if (!read || read.error) {
        lastWhy = `读表出错(${(read && read.error) || '未知'})`;
        continue;
      }
      // 读到的是不是"对的那张表" —— 两个 tab 共用一个页面,切错了会把直播数据
      // 当成商品数据上报,那比取不到还糟
      if (read.tabMismatch) {
        lastWhy = `页面停在「${read.sawKind === 'live' ? '直播' : '商品'}」tab,不是要的「${label}」`;
        continue;
      }
      if (!read.rows.length) {
        lastWhy = '表格里一行都没有';
        continue;
      }
      rows = read.rows;
      if (read.pages > 1) notes.push(`${label}翻了 ${read.pages} 页`);
      if (read.pageStuck) notes.push(`⚠️ ${label}还有下一页但翻不动,数字可能不全`);
    }

    if (!rows) {
      warn(`${label}计划列表取数失败:${lastWhy}`);
      failed.push(kind);
      whys.push(`${label}:${lastWhy}`);
      // 失败时自动把看到的东西记进日志,省得还要专门再跑一次诊断
      const seen = await dumpTable(page);
      if (seen) warn(`  ${label} 当时页面上的表头 = ${JSON.stringify(seen.head).slice(0, 400)}`);
      else warn(`  ${label} 当时页面上一张表格都没有`);
      if (opts.diag) debug.push({ kind, why: lastWhy, table: seen });
      continue;
    }

    if (opts.diag) debug.push({ kind, table: await dumpTable(page) });
    info(`${label}计划读到 ${rows.length} 条`);
    for (const x of rows) {
      all.push({
        campaign_id: x.campaignId || `${kind}:${x.name}`,
        name: x.name,
        kind,
        status: x.status,
        costCNY: toCny(x.cost, rate),
        gmvCNY: toCny(x.revenue, rate),
        roi: x.roi && x.roi.num > 0 ? round2(x.roi.num) : null,
      });
    }
  }

  for (const x of all) {
    if (x.roi == null) x.roi = x.costCNY > 0 ? round2(x.gmvCNY / x.costCNY) : 0;
  }
  if (failed.length) warn(`有 tab 没取到:${failed.join('、')} —— 本次不存快照,避免污染"近1小时"基准`);
  for (const n of notes) info(n);

  // 两边都废了要给个人话的原因 —— 以前这里没填,上层打印出来就是"没跑成:undefined"
  const reason =
    failed.length >= 2
      ? `商品和直播两个列表都没取到(${whys.join(' / ') || '原因不明'})`
      : undefined;
  return { ok: failed.length < 2, rows: all, failed, notes, debug, reason };
}

/**
 * 列表页 URL。
 * 分页参数名是实测的(product_campaign_page_size / live_campaign_page_size),
 * 但**后台会把它强行改回 10** —— 所以真正管用的是 readCampaignTable 里的翻页。
 * 这两个参数只是"能大就大"顺手一试,不指望它。
 */
function buildListUrl(kind, r) {
  const sizeParam =
    kind === 'live'
      ? 'live_campaign_page=1&live_campaign_page_size=100'
      : 'product_campaign_page=1&product_campaign_page_size=100';
  return (
    `${SELLER_HOST}/ads-creation/dashboard?origin=SC_ads_tab_button_PC&mpa=1` +
    `&type=${kind}&shop_region=${MARKET.code}` +
    `&list_start_date=${r.dStart}&list_end_date=${r.dEnd}&${sizeParam}`
  );
}

/**
 * 单元格里带 VND/₫ 就换成人民币;带 ¥ 就本来就是人民币。
 *
 * 注:后台原生显示的是 VND。之所以也认 ¥,是因为有人的 Chrome 装了汇率转换插件会把数字改成 ¥ ——
 * 跑程序那台 Windows 是干净的 Playwright,没有插件,读到的一定是 VND。
 * 万一哪天连币种标记都没有:数值大得离谱(>10万)的只可能是 VND,按 VND 处理,
 * 免得把一亿越南盾当成一亿人民币报出去。
 */
function toCny(cell, rate) {
  if (!cell || !Number.isFinite(cell.num)) return 0;
  if (cell.currency === 'VND') return cell.num / rate;
  if (cell.currency === 'CNY') return cell.num;
  return cell.num > 100000 ? cell.num / rate : cell.num;
}

/**
 * 等表格出行 —— 而且要等它**不再变**。
 *
 * ★ 2026-09-21 真实后台实测:这个列表页的行是一条一条冒出来的(眼看着 0 行 → 3 行)。
 *   原来只要看到 1 行就走,正好撞上渲染到一半,直播 3 个计划可能只读到 1 个 ——
 *   数字不是"没取到",而是**悄悄少了一截**,比取不到更坑。
 *   现在要求行数连续 2.5 秒不变才算稳,不稳就一直等到预算用完(用完算失败,让上层重试)。
 */
async function waitForRows(page, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const countRows = () =>
    page
      .evaluate(() => {
        const t = [...document.querySelectorAll('table')].sort(
          (a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length
        )[0];
        return t ? t.querySelectorAll('tbody tr').length : 0;
      })
      .catch(() => 0);

  let last = -1;
  let sameSince = 0;
  while (Date.now() < deadline) {
    const n = await countRows();
    if (n >= 1) {
      if (n === last) {
        if (Date.now() - sameSince >= 2500) {
          await sleep(1200); // 行数稳了,再给单元格里的数字一点时间
          return true;
        }
      } else {
        last = n;
        sameSince = Date.now();
      }
    }
    await sleep(800);
  }
  return false;
}

async function dumpTable(page) {
  return await page
    .evaluate(() => {
      const t = [...document.querySelectorAll('table')].sort(
        (a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length
      )[0];
      if (!t) return null;
      return {
        head: [...t.querySelectorAll('thead th,thead td')].map((h) => h.innerText.replace(/\s+/g, ' ').trim()),
        rows: [...t.querySelectorAll('tbody tr')].slice(0, 3).map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim().slice(0, 50))
        ),
      };
    })
    .catch(() => null);
}

/**
 * 在页面里读广告计划列表。自包含函数(要丢给 page.evaluate)。
 * args: { expect: 'product' | 'live' }
 *
 * 做三件事:
 *  ① 认列:按列名**完全匹配**,避开 净成本/目标ROI/优惠券收入 这些近似列(中英文都实测过)
 *  ② 认表:校验这张表是不是要的那个 tab —— 两个 tab 共用一个页面,切错了会把
 *     直播数据当成商品数据上报,那比取不到还糟
 *  ③ 翻页:后台每页固定 10 条(URL 参数改不动,实测会被改回 10),
 *     超过 10 条必须点下一页,不然第 11 条起被静默漏掉
 */
export function readCampaignTable(args) {
  const expect = (args && args.expect) || '';
  const norm = (s) => (s || '').replace(/\s+/g, '').trim().toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const EXACT = {
    name: ['广告计划名称', 'campaignname'],
    status: ['状态', 'status'],
    cost: ['成本', 'cost'],
    revenue: ['总收入', 'grossrevenue', 'totalrevenue'],
    roi: ['roi'],
  };
  // 两张表各自独有的列(中英文都从真实后台抄的),用来判断当前停在哪个 tab
  const LIVE_ONLY = [
    '可用的tiktok账号', 'availabletiktokaccounts',
    '直播播放量', 'liveviews',
    '最大投放量预算', 'maxdeliverybudget',
    '受众加热预算', 'viewerboostbudget',
  ];
  const PRODUCT_ONLY = ['广告计划预算', 'campaignbudget'];

  const getTable = () =>
    [...document.querySelectorAll('table')].sort(
      (a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length
    )[0];
  const headsOf = (t) => [...t.querySelectorAll('thead th,thead td')].map((h) => norm(h.innerText));

  const t0 = getTable();
  if (!t0) return { rows: [], pages: 0, error: '页面上没有表格' };
  const heads0 = headsOf(t0);

  // ⚠️ 这里必须"只在明确看到是另一种时才判失败"。
  // 早先写成 `有直播特征列 ? live : product` —— 等于把"没看到直播列"当成"这是商品表",
  // 结果直播表只要有一列没渲染出来就被误判成商品表,整个 tab 白白失败。
  const hasLive = heads0.some((h) => LIVE_ONLY.includes(h));
  const hasProduct = heads0.some((h) => PRODUCT_ONLY.includes(h));
  let sawKind = hasLive && !hasProduct ? 'live' : hasProduct && !hasLive ? 'product' : '';
  if (!sawKind) {
    // 列名判断不出来,就看 URL —— 这个地址是我们自己导航过去的,最可靠
    const m = (location.href || '').match(/[?&]type=(live|product)/);
    sawKind = m ? m[1] : '';
  }
  // 只有"确凿地看到是另一种"才失败;拿不准一律放行(宁可多读一次,也别白白丢一整个 tab)
  if (expect && sawKind && sawKind !== expect) {
    return { rows: [], pages: 0, sawKind, tabMismatch: true };
  }

  const idxOf = (heads) => {
    const o = {};
    for (const [k, names] of Object.entries(EXACT)) o[k] = heads.findIndex((h) => names.includes(h));
    return o;
  };
  if (idxOf(heads0).name < 0 || idxOf(heads0).cost < 0) {
    return { rows: [], pages: 0, sawKind, error: '认不出「广告计划名称」或「成本」列' };
  }

  const cellNum = (td) => {
    if (!td) return null;
    const first = (td.innerText || '').split('\n')[0].trim();
    const m = first.match(/-?[\d.,]+/);
    if (!m) return null;
    const num = parseFloat(m[0].replace(/,/g, ''));
    if (!Number.isFinite(num)) return null;
    return { num, currency: /VND|₫/i.test(first) ? 'VND' : /¥|CNY|RMB/i.test(first) ? 'CNY' : '' };
  };

  const readPage = () => {
    const t = getTable();
    if (!t) return [];
    const ix = idxOf(headsOf(t));
    if (ix.name < 0 || ix.cost < 0) return [];
    return [...t.querySelectorAll('tbody tr')]
      .map((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        const nameCell = tds[ix.name];
        if (!nameCell) return null;
        const name = (nameCell.innerText || '').split('\n')[0].trim();
        if (!name) return null;
        let campaignId = '';
        const m = (nameCell.innerHTML || '').match(/campaign_id[=":\s]+(\d{12,20})/);
        if (m) campaignId = m[1];
        return {
          name,
          status: ix.status >= 0 && tds[ix.status] ? (tds[ix.status].innerText || '').split('\n')[0].trim() : '',
          campaignId,
          cost: cellNum(tds[ix.cost]),
          revenue: ix.revenue >= 0 ? cellNum(tds[ix.revenue]) : null,
          roi: ix.roi >= 0 ? cellNum(tds[ix.roi]) : null,
        };
      })
      .filter(Boolean);
  };

  /** 找「下一页」。几种写法都试;拿不准就返回 null —— 宁可少翻,也别乱点别的按钮。 */
  const nextBtn = () => {
    const sel =
      'li.core-pagination-item-next, [class*=pagination] [class*=next], ' +
      '[aria-label*="ext page"], [aria-label*="下一页"], [class*=Pagination] [class*=next]';
    for (const el of document.querySelectorAll(sel)) {
      const cls = '' + (el.className || '');
      const disabled =
        cls.includes('disabled') || el.getAttribute('aria-disabled') === 'true' || el.disabled === true;
      if (!disabled) return el;
    }
    return null;
  };

  return (async () => {
    const seen = new Map();
    let pages = 0;
    let pageStuck = false;
    while (pages < 12) {
      for (const row of readPage()) if (!seen.has(row.name)) seen.set(row.name, row);
      pages++;
      const nx = nextBtn();
      if (!nx) break;
      const before = readPage().map((x) => x.name).join('|');
      nx.click();
      let waited = 0;
      let changed = false;
      while (waited < 8000) {
        await sleep(300);
        waited += 300;
        if (readPage().map((x) => x.name).join('|') !== before) { changed = true; break; }
      }
      if (!changed) { pageStuck = true; break; }
      await sleep(400);
    }
    return { rows: [...seen.values()], pages, sawKind, pageStuck };
  })();
}

export function diagnoseFields(captured) {
  const out = [];
  const seen = new Set();
  const walk = (node, url, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, url, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const cid = node.campaign_id || node.campaignId;
    if (cid && /^\d{12,20}$/.test(String(cid))) {
      const nums = {};
      for (const [k, v] of Object.entries(node)) {
        const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?[\d.]+$/.test(v) ? parseFloat(v) : null;
        if (n !== null && Number.isFinite(n)) nums[k] = n;
      }
      const sig = url + '|' + Object.keys(nums).sort().join(',');
      if (Object.keys(nums).length && !seen.has(sig)) {
        seen.add(sig);
        out.push({
          url,
          campaign_id: String(cid),
          name: String(node.campaign_name || node.campaignName || node.name || ''),
          numericFields: nums,
        });
      }
    }
    for (const v of Object.values(node)) walk(v, url, depth + 1);
  };
  for (const c of captured) walk(c.body, c.url);
  return out;
}

// ---------------- 快照 ----------------

function snapFile() {
  const dir = process.env.KANS_DATA_DIR ? path.resolve(process.env.KANS_DATA_DIR) : path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'board-snapshots.jsonl');
}

export function saveSnapshot(rows, config) {
  const rec = {
    ts: Date.now(),
    date: vnDateKey(config?.timezoneOffsetHours),
    rows: rows.map((r) => ({ id: r.campaign_id, n: r.name, c: round2(r.costCNY), g: round2(r.gmvCNY) })),
  };
  try {
    fs.appendFileSync(snapFile(), JSON.stringify(rec) + '\n');
  } catch (e) {
    warn('快照写盘失败:', e.message);
  }
  return rec;
}

/** 读今天的快照(顺带把 3 天前的老记录清掉,免得文件越长越大)。 */
export function readSnapshots(config) {
  const today = vnDateKey(config?.timezoneOffsetHours);
  let lines = [];
  try {
    lines = fs.readFileSync(snapFile(), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const keep = [];
  const all = [];
  const cutoff = Date.now() - 3 * 86400e3;
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (r.ts >= cutoff) keep.push(l);
      if (r.date === today) all.push(r);
    } catch {
      /* 坏行丢掉 */
    }
  }
  if (keep.length !== lines.length) {
    try {
      fs.writeFileSync(snapFile(), keep.join('\n') + (keep.length ? '\n' : ''));
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
  return all.sort((a, b) => a.ts - b.ts);
}

/** 找"最接近 minutesAgo 分钟前"的那份快照;偏差超过 ±20 分钟就不用(宁可不报也别报错的数)。 */
export function pickBaseline(snaps, minutesAgo = 60, toleranceMin = 20) {
  const target = Date.now() - minutesAgo * 60000;
  let best = null;
  let bestDiff = Infinity;
  for (const s of snaps) {
    const d = Math.abs(s.ts - target);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  if (!best || bestDiff > toleranceMin * 60000) return null;
  return best;
}

// ---------------- 出卡片 ----------------

/**
 * 播报卡片。结构按 Jasper 要的三层:
 *   ① 全部 GMV Max 汇总(当天累计 + 近1小时)
 *   ② 商品卡 / 直播间 分别汇总(当天累计 + 近1小时)
 *   ③ 单条计划明细(全部列出,消耗为 0 的也列,只是排在后面)
 */
export function buildBoardCard(config, rows, baseline, failed = []) {
  const DT = formatDT(config.timezoneOffsetHours);
  const prev = baseline ? new Map(baseline.rows.map((r) => [r.id, r])) : null;
  const mins = baseline ? Math.round((Date.now() - baseline.ts) / 60000) : 0;

  const pick = (kind) => (kind ? rows.filter((r) => r.kind === kind) : rows);
  const sum = (arr) => {
    const cost = arr.reduce((s, r) => s + r.costCNY, 0);
    const gmv = arr.reduce((s, r) => s + r.gmvCNY, 0);
    return { cost, gmv, roi: cost > 0 ? round2(gmv / cost) : 0 };
  };
  const delta = (arr) => {
    if (!prev) return null;
    const d = arr.reduce(
      (a, r) => {
        const p = prev.get(r.campaign_id);
        a.cost += Math.max(0, r.costCNY - (p ? p.c : 0));
        a.gmv += Math.max(0, r.gmvCNY - (p ? p.g : 0));
        return a;
      },
      { cost: 0, gmv: 0 }
    );
    d.roi = d.cost > 0 ? round2(d.gmv / d.cost) : 0;
    return d;
  };

  const block = (title, arr, kind) => {
    // 这个 tab 没取到数,就直说 —— 显示 ¥0 会被当成"今天没花钱",那是误导
    if (kind && failed.includes(kind)) {
      return [`**${title}**`, `<font color='red'>⚠️ 本次取数失败,数字暂缺(下次播报会重试)</font>`];
    }
    const t = sum(arr);
    const d = delta(arr);
    const out = [`**${title}**`, `当天累计　消耗 **¥${fmt(t.cost)}**　成交 **¥${fmt(t.gmv)}**　ROI **${t.roi}**`];
    if (d) out.push(`近 ${mins} 分钟　消耗 ¥${fmt(d.cost)}　成交 **¥${fmt(d.gmv)}**　ROI **${d.roi}**`);
    else out.push(`近 1 小时　数据还没攒够(跑满一小时才有对比)`);
    return out;
  };

  const lines = [];
  lines.push(...block('📊 全部 GMV Max', rows));
  if (failed.length) {
    lines.push(`<font color='red'>(注意:${failed.map((k) => (k === 'live' ? '直播间' : '商品卡')).join('、')}这次没取到,上面的"全部"不含它)</font>`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(...block('🛒 商品卡 GMV Max', pick('product'), 'product'));
  lines.push('');
  lines.push(...block('🎬 直播间 GMV Max', pick('live'), 'live'));
  lines.push('');
  lines.push('---');
  lines.push('');

  // ③ 单条计划明细 —— 全部列出,不过滤。有消耗的排前面,没消耗的排后面。
  lines.push('**分计划明细**(当天累计,按消耗排)');
  for (const [label, kind] of [['🛒 商品卡', 'product'], ['🎬 直播间', 'live']]) {
    const arr = [...pick(kind)].sort((a, b) => b.costCNY - a.costCNY);
    if (!arr.length) continue;
    lines.push('');
    lines.push(`*${label}*`);
    for (const r of arr) {
      if (r.costCNY <= 0 && r.gmvCNY <= 0) {
        lines.push(`· ${r.name}　<font color='grey'>今天没有消耗</font>`);
      } else {
        lines.push(`· **${r.name}**　消耗 ¥${fmt(r.costCNY)}　成交 ¥${fmt(r.gmvCNY)}　ROI ${roiTag(r.roi, config)}`);
      }
    }
  }

  lines.push('');
  lines.push('---');
  // 汇率取跟取数时同一套(新版 config 放在 market 块里,老键只是兼容),
  // 否则这里会印出「₫/undefined」
  const shownRate = config.vndToCnyRate || MARKET.rateToCny || 3891;
  lines.push(`口径:越南时间当天 00:00 至今,数字取自后台「广告计划列表」,已按 ₫/${shownRate} 折人民币。`);
  if (config.feishu?.bitable?.appToken) {
    lines.push(`[点开底表看流水](https://你的域名.feishu.cn/base/${config.feishu.bitable.appToken})`);
  }

  const all = sum(rows);
  return {
    title: `📺 KANS 越南投放播报 · ${DT}`,
    template: all.roi > 0 && all.roi < (config.roiThreshold ?? 2) ? 'orange' : 'blue',
    lines,
  };
}

/** 三个层级的汇总数字,写底表用。 */
export function buildBoardRows(config, rows, baseline) {
  const prev = baseline ? new Map(baseline.rows.map((r) => [r.id, r])) : null;
  const sum = (arr) => {
    const cost = arr.reduce((s, r) => s + r.costCNY, 0);
    const gmv = arr.reduce((s, r) => s + r.gmvCNY, 0);
    return { cost, gmv, roi: cost > 0 ? round2(gmv / cost) : 0 };
  };
  const delta = (arr) => {
    if (!prev) return { cost: 0, gmv: 0, roi: 0, has: false };
    const d = arr.reduce(
      (a, r) => {
        const p = prev.get(r.campaign_id);
        a.cost += Math.max(0, r.costCNY - (p ? p.c : 0));
        a.gmv += Math.max(0, r.gmvCNY - (p ? p.g : 0));
        return a;
      },
      { cost: 0, gmv: 0 }
    );
    return { ...d, roi: d.cost > 0 ? round2(d.gmv / d.cost) : 0, has: true };
  };

  const mk = (level, name, arr, status = '') => {
    const t = sum(arr);
    const d = delta(arr);
    return {
      level,
      name,
      status,
      costCNY: round2(t.cost),
      gmvCNY: round2(t.gmv),
      roi: t.roi,
      h1cost: d.has ? round2(d.cost) : null,
      h1gmv: d.has ? round2(d.gmv) : null,
      h1roi: d.has ? d.roi : null,
    };
  };

  const out = [
    mk('全部', '全部 GMV Max', rows),
    mk('商品卡', '商品卡 GMV Max', rows.filter((r) => r.kind === 'product')),
    mk('直播间', '直播间 GMV Max', rows.filter((r) => r.kind === 'live')),
  ];
  for (const r of [...rows].sort((a, b) => b.costCNY - a.costCNY)) {
    out.push(mk('计划', r.name, [r], r.status || ''));
  }
  return out;
}

export function totals(rows) {
  const cost = rows.reduce((s, r) => s + r.costCNY, 0);
  const gmv = rows.reduce((s, r) => s + r.gmvCNY, 0);
  return { cost, gmv, roi: cost > 0 ? round2(gmv / cost) : 0 };
}

// ---------------- 小工具 ----------------
const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bar(v, max, width = 10) {
  const n = Math.max(v > 0 ? 1 : 0, Math.round((v / max) * width));
  return '▇'.repeat(n) + '·'.repeat(Math.max(0, width - n));
}
function roiTag(roi, config) {
  const th = config.roiThreshold ?? 2;
  return roi < th ? `<font color='red'>**${roi}**</font>` : `**${roi}**`;
}
