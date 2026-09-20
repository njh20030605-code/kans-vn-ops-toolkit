import cron from 'node-cron';
import { runOnce } from './run.js';
import { loadConfig, loadCampaigns, vnNow, formatDT, info, warn, error, srcFingerprint, VERSION, BRAND, MARKET, SELLER_HOST, marketOf } from './util.js';
import { notify } from './notify.js';
import { driveEnabled, uploadStatusNote } from './gdrive.js';
import { feishuEnabled, sendCard, vnDateOf } from './feishu.js';
import { buildDailyReport } from './report.js';
import { collectDailyTotals } from './daily.js';
import { getLastSummaryDate, setLastSummaryDate } from './store.js';
import { shortErr } from './browser.js';

/**
 * 每小时整点触发一次。判断当地(市场时区)小时是否落在 sevenDayHours(默认 10/14)决定是否加近7天口径。
 * 每轮都重新读 config.json / campaigns.json —— 所以改阈值、加计划无需重启,下一轮自动生效。
 *
 * 稳定性策略(2026-09 加固):
 *  · 同一时刻只允许一轮在跑,上一轮没跑完就跳过本次整点,避免叠加把浏览器拖死;
 *  · 单轮有看门狗(默认 40 分钟),超时就强制结束并重启浏览器;
 *  · 失败不再干等一小时 —— 默认 6 分钟后自动补跑一次(每小时最多补 2 次);
 *  · 偶发失败只写日志,连续失败 N 次(默认 2)才推手机,免得网络抖一下就响;
 *  · 跑满 N 轮(默认 12)主动重启一次浏览器,清掉 Chromium 长跑后的内存/渲染残留。
 */
export function startScheduler(config, campaigns, deps) {
  info(`调度启动:每小时整点扫描(当天);${MARKET.name} ${(config.sevenDayHours || [10, 14]).join('/')} 点加扫近7天。`);
  info('提示:改 config.json 阈值或 campaigns.json 计划后,下一轮自动生效,无需重启。');

  const bootFingerprint = srcFingerprint(); // 启动那一刻的代码指纹
  let running = false;
  let roundSeq = 0; // 轮次号:看门狗砍掉一轮后,那一轮的残余任务靠它自知作废
  let consecutiveFailures = 0;
  let alerted = false; // 是否已经因为连续失败推过告警(用来决定恢复时要不要报平安)
  let retriesThisHour = 0;
  let retryTimer = null;
  let roundsSinceRestart = 0;

  async function restartBrowser(why) {
    if (!deps.restartBrowser) return false;
    try {
      warn(`重启浏览器(原因:${why})…`);
      await deps.restartBrowser();
      info('浏览器已重启 ✅');
      return true;
    } catch (e) {
      error('重启浏览器失败:', shortErr(e));
      return false;
    }
  }

  async function tick({ isRetry = false } = {}) {
    if (running) {
      warn('上一轮还在跑,跳过本次触发(避免两轮叠在一起)。');
      return;
    }
    if (!isRetry) {
      retriesThisHour = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }
    running = true;

    // 热加载最新配置与计划清单
    let freshConfig = config;
    let freshCampaigns = campaigns;
    try {
      freshConfig = loadConfig();
      freshCampaigns = loadCampaigns();
    } catch (e) {
      error('重新读取配置失败,沿用启动时的配置:', e.message);
    }
    const S = freshConfig.stability || {};
    const roundTimeoutMs = (S.roundTimeoutMinutes || 40) * 60000;
    const retryDelayMs = (S.retryDelayMinutes || 6) * 60000;
    const maxRetries = S.maxRetriesPerHour ?? 2;
    const alertAfter = S.alertAfterConsecutiveFailures || 2;
    const alertRepeatEvery = S.alertRepeatEveryFailures || 6; // 一直不恢复时,隔几次再提醒一次
    const restartEvery = S.restartBrowserEveryRounds || 12;

    const vh = vnNow(marketOf(freshConfig).tzOffsetHours).getUTCHours();
    const with7d = (freshConfig.sevenDayHours || [10, 14]).includes(vh);
    info(`${isRetry ? '补跑触发' : '整点触发'}:${MARKET.name} ${vh} 点,${with7d ? '当天+近7天' : '仅当天'}`);

    let failureMsg = null;
    let needRestart = false;
    try {
      const myRound = ++roundSeq;
      const isStale = () => myRound !== roundSeq;
      const res = await withTimeout(
        runOnce(freshConfig, freshCampaigns, { ...deps, with7d, isStale }),
        roundTimeoutMs,
        `本轮超过 ${S.roundTimeoutMinutes || 40} 分钟还没跑完,已强制结束`
      );
      if (res && res.softFail) {
        // 网络/白屏这类临时故障:runOnce 自己判定的软失败
        failureMsg = res.reason || `本轮未能扫描(${res.state})`;
      } else {
        // 从"连续失败并且已经告警过"里恢复 → 报一声平安,免得人一直悬着
        if (alerted) {
          await notify(freshConfig, {
            level: 'alert',
            title: `✅ ${BRAND} 预警已恢复正常`,
            body: `之前连续 ${consecutiveFailures} 轮没扫成,现在已经恢复,本轮扫描完成。`,
          }).catch(() => {});
          alerted = false;
        }
        consecutiveFailures = 0;
      }
    } catch (e) {
      failureMsg = shortErr(e);
      needRestart = /强制结束|浏览器页面被关掉/.test(failureMsg);
      error('本轮运行异常(已捕获):', e.stack || e.message || String(e));
    }

    roundsSinceRestart++;

    if (failureMsg) {
      consecutiveFailures++;
      warn(`本轮失败(连续第 ${consecutiveFailures} 次):${failureMsg}`);

      const policy = failurePolicy({
        consecutiveFailures,
        alertAfter,
        alertRepeatEvery,
        needRestart,
      });
      if (policy.restart) {
        await restartBrowser(needRestart ? '本轮卡死' : `连续失败 ${consecutiveFailures} 次`);
        roundsSinceRestart = 0;
      }
      if (policy.alert) {
        // 连续失败才惊动人,并且说人话、不贴堆栈
        const body =
          `已连续 ${consecutiveFailures} 轮没扫成,最近一次原因:${failureMsg}\n` +
          `程序还在运行,会继续自动重试。若一直不恢复,请检查:\n` +
          `  1) 这台电脑网络是否正常(能不能打开 ${SELLER_HOST.replace(/^https?:\/\//, '')})\n` +
          `  2) 登录是否掉了 —— 双击「启动-登录」重登一次\n` +
          `  3) 电脑是否休眠/被关机`;
        await notify(freshConfig, {
          level: 'alert',
          title: `⚠️ ${BRAND} 预警连续 ${consecutiveFailures} 轮没扫成`,
          body,
        }).catch(() => {});
        alerted = true;
        if (driveEnabled(freshConfig)) {
          await uploadStatusNote(
            freshConfig,
            formatDT(marketOf(freshConfig).tzOffsetHours),
            '连续失败',
            body
          ).catch(() => {});
        }
      } else {
        info(`失败但未到提醒条件(连续 ${consecutiveFailures} 次),先不打扰手机,安排补跑。`);
      }

      // 安排补跑(不用干等一小时)
      if (retriesThisHour < maxRetries) {
        retriesThisHour++;
        info(`将在 ${Math.round(retryDelayMs / 60000)} 分钟后补跑一次(本小时第 ${retriesThisHour}/${maxRetries} 次)。`);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          tick({ isRetry: true }).catch((e) => error('补跑异常:', shortErr(e)));
        }, retryDelayMs);
      } else {
        info('本小时补跑次数已用完,等下一个整点。');
      }
    } else if (restartEvery > 0 && roundsSinceRestart >= restartEvery) {
      // 长跑保养:Chromium 跑久了会变慢,主动重启一次
      await restartBrowser(`已连续跑 ${roundsSinceRestart} 轮,例行保养`);
      roundsSinceRestart = 0;
    }

    // ---- 每天一份总结(到点推一次,数据从飞书底表取,中途重启过也不影响)----
    await maybeDailySummary(freshConfig, freshCampaigns).catch((e) => warn('日报推送异常:', shortErr(e)));

    running = false;

    maybeSelfRestart();
  }

  /**
   * 代码被覆盖了就自我重启。
   * Node 启动时把代码读进内存,换文件对当前进程无效 —— 以前只能让人手动关窗口重开,
   * 这一步老是被漏掉。现在发现 src 变了就主动退出,由启动脚本的守护循环拉起新代码。
   */
  function maybeSelfRestart() {
    if (running) return; // 扫描中不打断,等这轮跑完
    const now = srcFingerprint();
    if (!bootFingerprint || !now || now === bootFingerprint) return;
    info('检测到 src 里的代码被更新过,退出以加载新代码(启动脚本会自动重开)…');
    console.log('');
    console.log('══════════════════════════════════════════════');
    console.log('   检测到程序已被更新');
    console.log(`   当前跑的是 ${VERSION},正在重启加载新版本…`);
    console.log('   (本窗口会自动重开,不用管)');
    console.log('══════════════════════════════════════════════');
    console.log('');
    if (retryTimer) clearTimeout(retryTimer);
    setTimeout(() => process.exit(0), 1500);
  }

  /**
   * 每天早上一次:先把「昨天」各计划的 成本/GMV/ROI 采下来写进飞书,再推日报。
   * 采集要把每个计划的昨日页面翻一遍,比普通扫描慢,所以一天只跑一次。
   */
  async function maybeDailySummary(cfg, freshCampaigns) {
    if (!feishuEnabled(cfg)) return;
    // 日报默认关闭(2026-09-12:数字口径有问题,先停掉)。
    // 必须在 config.json 里显式写 "dailyReportEnabled": true 才会跑 —— 所以只替换 src 就等于停了。
    if (cfg.feishu?.dailyReportEnabled !== true) return;
    const hour = cfg.feishu?.dailySummaryHour;
    if (hour == null) return;
    const vh = vnNow(marketOf(cfg).tzOffsetHours).getUTCHours();
    if (vh < hour) return; // 还没到点
    const today = vnDateOf(cfg);
    if (getLastSummaryDate() === today) return; // 今天已经推过

    // ① 采集昨天各计划合计
    info('到点了,开始采集昨天各计划的 成本/GMV/ROI …');
    const got = await collectDailyTotals(cfg, freshCampaigns, deps, 1).catch((e) => {
      warn('采集昨日合计异常:', shortErr(e));
      return { ok: false };
    });
    if (!got.ok) {
      warn('昨日合计没采到,日报先不推,下一轮再试。');
      return; // 不标记,下个整点会重试
    }

    // ② 出日报并推群
    const card = await buildDailyReport(cfg);
    if (!card) {
      info('日报:昨天没有可用数据,不推。');
      setLastSummaryDate(today);
      return;
    }
    const r = await sendCard(cfg, card);
    if (r.ok) {
      setLastSummaryDate(today);
      info(`已推送每日数据通报(${MARKET.name} ${vh} 点)。`);
    } else {
      warn('日报推送失败,下一轮再试。');
    }
  }

  cron.schedule('0 * * * *', () => {
    tick().catch((e) => error('调度异常:', shortErr(e)));
  });

  // 每 2 分钟看一眼代码有没有被覆盖过,有就自我重启(扫描进行中会跳过,等下次)
  setInterval(maybeSelfRestart, 2 * 60 * 1000).unref?.();

  info('调度已就绪,进程保持运行中。Ctrl+C 退出。');
}

/**
 * 连续失败时「什么时候重启浏览器 / 什么时候打扰人」的策略。抽成纯函数是为了能自检:
 * 用户最烦的就是网络抖一下手机就响,这段逻辑必须看得见、测得到。
 *
 * 告警:第 alertAfter 次响一次,之后每 alertRepeatEvery 次才再响一次
 *      (alertAfter=2 / repeat=6 → 在第 2、8、14、20 次响,断网一下午也就 3~4 条)。
 * 重启:卡死时立刻重启;否则第 2 次失败重启一次,之后每 5 次重启一次
 *      (别每 6 分钟就重开一次浏览器)。
 */
export function failurePolicy({ consecutiveFailures: n, alertAfter = 2, alertRepeatEvery = 6, needRestart = false }) {
  return {
    restart: !!needRestart || n === 2 || (n > 2 && n % 5 === 0),
    alert: n === alertAfter || (n > alertAfter && (n - alertAfter) % alertRepeatEvery === 0),
  };
}

/** 给一个 promise 套看门狗。超时后原 promise 仍在后台跑,但它的异常会被吞掉不影响进程。 */
function withTimeout(promise, ms, label) {
  let timer = null;
  promise.catch(() => {}); // 防止超时后原 promise 变成未处理拒绝
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
