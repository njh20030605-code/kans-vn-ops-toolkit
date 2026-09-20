import {
  formatDT,
  vnDayRanges,
  vnDateStr,
  buildDashboardUrl,
  info,
  warn,
  error, BRAND, MARKET, marketOf } from './util.js';
import { getPage, gotoAndWaitTable, isPageResponsive, setLiveInterception } from './browser.js';
import { classifyPageState } from './classify.js';
import { scanCampaign } from './scan.js';
import { markAndSort, writeOutput } from './output.js';
import { getTodayPrevIds, hasTodayHistory, appendTodayHits, appendRunMeta, getHistoryStats } from './store.js';
import { notify } from './notify.js';
import { driveEnabled, uploadToDrive, uploadStatusNote, uploadStatusFile } from './gdrive.js';
import { feishuEnabled, pushRowsToBitable, sendCard } from './feishu.js';
import { buildRedAlertCard } from './report.js';

/**
 * 跑一轮完整扫描。只读,绝不修改任何广告。
 * deps: { context 或 getContext, llm, with7d, restartBrowser? }
 */
export async function runOnce(config, campaigns, deps) {
  const { llm, with7d } = deps;
  const context = deps.context || (deps.getContext && deps.getContext());
  if (llm) llm.resetRun();

  const tz = marketOf(config).tzOffsetHours;
  const DT = formatDT(tz);
  const ranges = vnDayRanges(tz);
  const calibers = with7d ? ['当天', '近7天'] : ['当天'];
  info(`===== 本轮 ${DT} 开始,口径:${calibers.join(' / ')} =====`);

  let ctx = context;

  /**
   * 拿页面。直播口径的请求拦截改成按需开关(见 browser.js setLiveInterception):
   * 装着拦截会关掉浏览器 HTTP 缓存,所以商品计划期间要关掉它。
   */
  async function preparePage(c) {
    const pg = await getPage(c);
    await setLiveInterception(pg, null, config);
    return pg;
  }

  let page = await preparePage(ctx);

  // ---- 浏览器自愈:页面卡死(登录没掉但点不动/打不开)时,就地重启浏览器再来 ----
  const maxHeals = config.stability?.maxBrowserRestartsPerRound ?? 1;
  let healsUsed = 0;
  async function healBrowser(why) {
    if (!deps.restartBrowser) {
      warn(`检测到${why},但当前模式不支持重启浏览器(单次扫描请重跑一次)。`);
      return false;
    }
    if (healsUsed >= maxHeals) {
      warn(`检测到${why},但本轮已重启过 ${healsUsed} 次,不再重启,留给下一轮。`);
      return false;
    }
    healsUsed++;
    warn(`检测到${why} —— 自动重启浏览器(本轮第 ${healsUsed} 次)…`);
    try {
      ctx = await deps.restartBrowser();
      page = await preparePage(ctx);
      info('浏览器已重启,继续本轮扫描 ✅');
      return true;
    } catch (e) {
      error('重启浏览器失败:', e.message);
      return false;
    }
  }

  // 先确认登录态:逐个计划探路,直到有一个能打开。
  // (以前固定拿第 1 个计划当探针 —— 它偶发打不开就整轮放弃,等于把 8 个计划绑死在一个单点上)
  const todayStr = vnDateStr(ranges.todayStart, marketOf(config).tzOffsetHours);
  const probeCount = Math.min(campaigns.length, config.stability?.loginProbeCampaigns ?? 3);
  const probeLive = (pc) => (pc.type === 'live' ? { start: todayStr, end: todayStr } : null);
  let first = { ok: false, reason: 'nav', error: '未尝试' };
  let probeIdx = -1;
  let firstUrl = buildDashboardUrl(campaigns[0], ranges.dStart, ranges.dEnd);

  for (let i = 0; i < probeCount; i++) {
    const pc = campaigns[i];
    firstUrl = buildDashboardUrl(pc, ranges.dStart, ranges.dEnd);
    await setLiveInterception(page, probeLive(pc), config);
    first = await gotoAndWaitTable(page, firstUrl, config);
    // 第一个就打不开:可能是浏览器卡住了,重启一次再试同一个
    if (!first.ok && first.reason === 'nav' && i === 0 && (await healBrowser(`首个页面打不开(${first.error})`))) {
      await setLiveInterception(page, probeLive(pc), config);
      first = await gotoAndWaitTable(page, firstUrl, config);
    }
    if (first.ok || first.reason === 'table') {
      // reason='table' 说明页面是打开了的(可能是登录页/验证码),交给下面的状态判定
      probeIdx = first.ok ? i : -1;
      break;
    }
    warn(`探路:计划「${pc.name}」打不开(${first.error}),换下一个试试…`);
  }

  // 打不开 / 白屏 / 页面没响应 —— 当成网络或浏览器问题
  let stuckWhy = null;
  if (!first.ok && first.reason === 'nav') {
    stuckWhy = `连试 ${probeCount} 个计划都打不开(${first.error})`;
  } else if (!(await isPageResponsive(page))) {
    stuckWhy = '页面无响应(JS 卡死)';
    if (await healBrowser(stuckWhy)) {
      await setLiveInterception(page, probeLive(campaigns[Math.max(probeIdx, 0)]), config);
      first = await gotoAndWaitTable(page, firstUrl, config);
      stuckWhy = first.ok || first.reason === 'table' ? null : `重启后仍打不开(${first.error})`;
    }
  }
  if (stuckWhy) {
    // 重启后还是不行 —— 网络/TikTok 后台抽风,不是登录掉了。
    // 不推手机告警(否则一天能响好几次),只记日志,交给调度器几分钟后自动重试。
    const msg = `${stuckWhy}。判断为网络/后台临时故障,本轮跳过,稍后自动重试。`;
    warn(msg);
    appendRunMeta({ DT, calibers, aborted: true, state: 'network_error' });
    return { aborted: true, state: 'network_error', softFail: true, reason: msg };
  }

  let { state, source } = await classifyPageState(page, llm);
  if (state === 'blank' && (await healBrowser('页面白屏没内容'))) {
    await gotoAndWaitTable(page, firstUrl, config);
    ({ state, source } = await classifyPageState(page, llm));
  }
  if (state === 'blank') {
    const msg = '页面打开了但一直是白屏/没内容,判断为临时故障,本轮跳过,稍后自动重试。';
    warn(msg);
    appendRunMeta({ DT, calibers, aborted: true, state: 'blank' });
    return { aborted: true, state: 'blank', softFail: true, reason: msg };
  }
  if (state !== 'ready') {
    const msg = `页面状态为「${state}」(判定来源:${source})。需人工介入:请手动重新登录 TikTok 卖家后台一次。`;
    error(msg);
    await notify(config, {
      level: 'alert',
      title: `⛔ ${BRAND} 预警程序无法扫描(${DT})`,
      body: msg,
    });
    // 在 Google 文件夹里新建情况说明文件(满足"登录掉了就在云端说明情况")
    if (driveEnabled(config)) {
      await uploadStatusNote(config, DT, state, msg).catch((e) => warn('情况说明上传失败:', e.message));
    }
    appendRunMeta({ DT, calibers, aborted: true, state });
    return { aborted: true, state };
  }

  const allHits = [];
  const runResults = []; // {caliber, campaign, loaded, hits, error}
  const anomalies = [];
  let failStreak = 0; // 连续失败的计划数,用来判断"是不是浏览器整个卡了"
  const off = tz;

  // 软预算:网络差的时候,16 次导航 × 每次最多重试 3 遍,理论上能跑到 90 分钟,
  // 会被调度器的看门狗硬砍掉、什么都拿不到。所以这里自己先收工,保住已扫到的部分。
  const softBudgetMs = (config.stability?.roundSoftBudgetMinutes ?? 25) * 60000;
  const abortAfterFailed = config.stability?.abortAfterFailedCampaigns ?? 4;
  const roundStart = Date.now();
  let bailReason = null;
  let skipped = 0;

  outer: for (const caliber of calibers) {
    const [start, end] = caliber === '当天' ? [ranges.dStart, ranges.dEnd] : [ranges.d7Start, ranges.d7End];
    // 直播口径的日期字符串(拦截时写入接口体):当天=今天;近7天=6天前→今天
    const liveStart = caliber === '当天' ? vnDateStr(ranges.todayStart, off) : vnDateStr(ranges.d7Start, off);
    const liveEnd = vnDateStr(ranges.todayStart, off);
    for (const c of campaigns) {
      const usedMin = Math.round((Date.now() - roundStart) / 60000);
      if (Date.now() - roundStart > softBudgetMs) {
        bailReason = `本轮已跑 ${usedMin} 分钟(超过软预算 ${Math.round(softBudgetMs / 60000)} 分钟),剩下的计划留到下一轮`;
      } else if (failStreak >= abortAfterFailed) {
        bailReason = `连续 ${failStreak} 个计划失败,判定为网络/后台整体故障,提前结束本轮`;
      }
      if (bailReason) {
        skipped = campaigns.length * calibers.length - runResults.length;
        warn(bailReason);
        break outer;
      }
      // 直播计划开拦截改写日期;商品计划关掉拦截(走 URL 日期 + 让 HTTP 缓存生效)
      await setLiveInterception(page, c.type === 'live' ? { start: liveStart, end: liveEnd } : null, config);
      const url = buildDashboardUrl(c, start, end);
      // 第一个计划的当天口径已经导航过,避免重复导航(直播计划必须重新导航以触发日期拦截)
        // 只有"探针恰好就是第 1 个计划"时才能复用那次导航 —— 否则中间那些失败的导航
      // 已经把页面重置成空白页了,复用会把这个计划误判成 0 命中。
      const alreadyThere =
        probeIdx === 0 && caliber === '当天' && c === campaigns[0] && c.type !== 'live';
      if (!alreadyThere) {
        let loaded = await gotoAndWaitTable(page, url, config);
        if (!loaded.ok) {
          failStreak++;
          // 连着两个计划都打不开/等不到表 → 多半是浏览器整个卡住了(登录还在,但页面不动了)
          if (failStreak >= 2 && (await healBrowser(`连续 ${failStreak} 个计划都打不开`))) {
            await setLiveInterception(page, c.type === 'live' ? { start: liveStart, end: liveEnd } : null, config);
            loaded = await gotoAndWaitTable(page, url, config);
          }
        }
        if (!loaded.ok) {
          const why = loaded.reason === 'nav' ? `页面打不开(${loaded.error})` : '表格始终未加载';
          warn(`计划「${c.name}」(${caliber})${why},跳过。`);
          appendRunMeta({ DT, campaign: c.name, caliber, loaded: false, why });
          runResults.push({ caliber, campaign: c.name, loaded: false, hits: 0, error: why });
          continue;
        }
      }
      let result;
      try {
        result = await scanCampaign(page, config);
      } catch (e) {
        failStreak++;
        warn(`计划「${c.name}」(${caliber})扫描异常,跳过:`, e.message);
        appendRunMeta({ DT, campaign: c.name, caliber, scanError: e.message });
        runResults.push({ caliber, campaign: c.name, loaded: true, hits: 0, error: '扫描异常:' + e.message });
        if (failStreak >= 2) await healBrowser(`连续 ${failStreak} 个计划扫描出错`);
        continue;
      }
      failStreak = 0;
      if (result.colWarn) anomalies.push(`「${c.name}」[${caliber}] ${result.colWarn}`);
      const tagged = result.hits.map((h) => ({ ...h, caliber, campaign: c.name }));
      info(`  ${c.name} [${caliber}] 命中 ${tagged.length} 条${result.verified ? '' : '(未完全确认)'}`);
      runResults.push({ caliber, campaign: c.name, loaded: true, hits: tagged.length, error: null });
      allHits.push(...tagged);
    }
  }

  // 本轮已被看门狗判超时作废、新一轮已经开跑 → 这里就别再出表和推送了,免得重复打扰
  if (deps.isStale && deps.isStale()) {
    warn('本轮已超时作废(新一轮已开始),放弃出表与推送。');
    appendRunMeta({ DT, calibers, aborted: true, state: 'stale' });
    return { aborted: true, state: 'stale' };
  }

  // 🆕 判定(仅当天口径)
  const prevIds = getTodayPrevIds();
  const todayHasHistory = hasTodayHistory();
  const rows = markAndSort(allHits, prevIds, todayHasHistory);

  // ---- 体检:发现"闷声出错" ----
  const nonCardHits = allHits.filter((h) => h.workId);
  if (nonCardHits.length >= 5 && nonCardHits.every((h) => h.roi === 0)) {
    anomalies.push(
      `疑似列映射失效:${nonCardHits.length} 条命中的 ROI 全为 0(正常几乎不可能),页面可能改版,请检查`
    );
  }
  const failed = runResults.filter((r) => r.error);

  // 素材的历史预警情况,必须在 appendTodayHits 之前取 —— 否则今天刚写的会把"首次"算掉
  const histStats = getHistoryStats(rows.map((r) => r.workId));

  // ---- 出表 + 上传(仅有命中时)----
  let file = null;
  let driveNote = '';
  if (rows.length > 0) {
    file = await writeOutput(config, DT, rows);
    appendTodayHits(rows.filter((r) => r.caliber === '当天'));
    // 每轮都把命中写进飞书底表(静默,不推消息)——日报/周报都从这张表取数
    await pushRowsToBitable(config, DT, rows).catch((e) => warn('写飞书底表异常:', e.message));
    if (driveEnabled(config)) {
      const up = await uploadToDrive(config, file);
      if (up.ok) driveNote = '☁️ 已上传 Google Drive';
      else if (up.authFail) {
        driveNote = '⛔ Google Drive 授权失效,未上传';
        await notify(config, {
          level: 'alert',
          title: `⛔ Google Drive 授权可能失效(${DT})`,
          body: `本地表已生成:${file}\n上传失败:${up.error}\n请重新授权:rclone authorize "drive"。`,
        });
      } else driveNote = `⚠️ Google Drive 上传失败:${up.error}`;
    }
  }

  // ---- 心跳/健康文件(每轮都更新)----
  if (driveEnabled(config)) {
    const statusText = buildStatusText({
      DT, calibers, runResults, hitCount: rows.length, driveNote, anomalies, failed, bailReason, skipped,
    });
    await uploadStatusFile(config, statusText).catch((e) => warn('状态文件上传失败:', e.message));
  }

  // ---- 一个计划都没扫成 → 交给调度器 ----
  // 这种情况几乎一定是网络/后台整体抽风。以前这里每轮直接发一条告警,
  // 完全绕过了"连续 N 轮才打扰人"的闸门 —— 网络抖一下就响,正是要治的毛病。
  // 现在标成软失败原样返回:调度器会几分钟后补跑,连续失败到阈值才推手机。
  if (!runResults.some((r) => !r.error)) {
    const why =
      bailReason ||
      (failed.length ? `${failed.length} 个计划全部失败,典型原因:${failed[0].error}` : '本轮没有成功扫描任何计划');
    warn(`本轮一个计划都没扫成(${why}),安静退出,等调度器补跑。`);
    appendRunMeta({ DT, calibers, aborted: true, state: 'all_failed', why });
    return { aborted: true, state: 'all_failed', softFail: true, reason: why, DT };
  }

  // ---- 异常/部分计划失败告警(单独推送,不只埋在文件里)----
  const bailLine = bailReason ? `\n⏹ 本轮提前结束:${bailReason}(跳过约 ${skipped} 个计划-口径)` : '';
  if (anomalies.length || failed.length) {
    const body =
      [
        ...anomalies.map((a) => '❗ ' + a),
        ...failed.map((f) => `❌ 计划「${f.campaign}」[${f.caliber}] ${f.error}`),
      ].join('\n') + bailLine;
    await notify(config, { level: 'alert', title: `⚠️ ${BRAND} 扫描有异常(${DT})`, body });
  } else if (bailReason) {
    await notify(config, {
      level: 'info',
      title: `⏹ ${BRAND} 本轮提前结束(${DT})`,
      body: `${bailReason}(跳过约 ${skipped} 个计划-口径)。已扫到的部分照常出表,剩下的下一轮补。`,
    });
  }

  // ---- 命中 / 无命中 通知 ----
  if (rows.length === 0) {
    const warnLine = failed.length ? `(注意:${failed.length} 个计划未成功扫描)\n` : '';
    const line = `✅ 本次(${DT})${calibers.join('/')}均无高成本低ROI素材`;
    info(line);
    await notify(config, { level: 'info', title: `${BRAND} 预警扫描完成`, body: warnLine + line });
    appendRunMeta({ DT, calibers, hits: 0, failed: failed.length, anomalies: anomalies.length });
    return { aborted: false, hits: 0, DT };
  }

  const partialNote = bailReason ? `⚠️ 注意:本轮提前结束,这是部分结果(跳过约 ${skipped} 个计划-口径)\n` : '';
  const body = partialNote + (driveNote ? driveNote + '\n' : '') + buildNotifyBody(rows, file);
  await notify(config, { level: 'info', title: `🚨 ${BRAND} 高成本低ROI 命中(${DT})`, body });

  // ---- 红色预警:高耗+极低ROI,单独推手机 ----
  // 口径的真实日期范围 —— 卡片上要标出来,不然看不出是单日还是 7 天累计
  const md = (ms) => {
    const d = vnDateStr(ms, off);
    return `${+d.slice(5, 7)}月${+d.slice(8, 10)}日`;
  };
  const dateLabels = {
    当天: md(ranges.todayStart),
    近7天: `${md(ranges.d7Start)} ~ ${md(ranges.todayStart)}`,
  };

  const R = config.notify?.redAlert || { costThresholdCNY: 200, roiThreshold: 1 };
  const redHits = rows
    .filter((r) => r.costCNY > R.costThresholdCNY && r.roi < R.roiThreshold)
    .sort((a, b) => b.costCNY - a.costCNY); // 按消耗从高到低排名
  if (redHits.length > 0) {
    let cardSent = false;
    if (feishuEnabled(config)) {
      const card = buildRedAlertCard(config, DT, redHits, histStats, dateLabels);
      const r = await sendCard(config, card).catch((e) => {
        warn('发红警卡片失败:', e.message);
        return { ok: false };
      });
      cardSent = !!r.ok;
    }
    const rb = redHits
      .map((r, i) => {
        const h = r.workId ? histStats.get(r.workId) : null;
        const age =
          r.caliber === '近7天' || !r.workId ? '' : h ? ` [老素材·第${h.days.size + 1}天]` : ' [🆕新素材·需关注]';
        const cal = `[${r.caliber}${r.caliber === '近7天' ? ' ' + dateLabels['近7天'] : ''}]`;
        return `${i + 1}. ${cal} ${r.campaign} | ${r.acct || '-'} | ${r.workId || '商品卡片(无作品ID)'} | ¥${r.costCNY} | ROI ${r.roi}${age}`;
      })
      .join('\n');
    await notify(config, {
      level: 'alert',
      title: `🔴 ${BRAND} 红色预警:${redHits.length} 条高耗低效素材(${DT})`,
      body: `条件:消耗 > ¥${R.costThresholdCNY} 且 ROI < ${R.roiThreshold}\n(计划 | 素材ID | 消耗 | ROI,按消耗排名)\n${rb}`,
      exclude: cardSent ? ['feishuApp'] : [], // 卡片已经推过群了,别再发一条纯文本
    });
  }

  appendRunMeta({ DT, calibers, hits: rows.length, file, drive: driveNote, failed: failed.length, anomalies: anomalies.length, red: redHits.length });
  info(`===== 本轮 ${DT} 完成,命中 ${rows.length} 条,输出:${file} ${driveNote} =====`);
  return { aborted: false, hits: rows.length, file, DT };
}

function buildStatusText({ DT, calibers, runResults, hitCount, driveNote, anomalies, failed, bailReason, skipped }) {
  const uploadState =
    hitCount > 0 ? (driveNote.includes('已上传') ? '✅ 已上传' : '⚠️ ' + (driveNote || '未上传')) : '(无命中,不出表)';
  const lines = [
    `${BRAND} 高成本低ROI 预警 · 运行状态(心跳)`,
    `最近运行(${MARKET.name}时间):${DT}`,
    `口径:${calibers.join(' + ')}`,
    `命中:${hitCount} 条    上传 Google:${uploadState}`,
    '',
    '各计划扫描结果(当天口径):',
  ];
  for (const r of runResults.filter((x) => x.caliber === '当天')) {
    lines.push(`  ${r.error ? '❌' : '✅'} ${r.campaign}${r.error ? ' —— ' + r.error : `(命中 ${r.hits})`}`);
  }
  if (calibers.includes('近7天')) lines.push('  (本轮含"近7天"口径,已一并扫描)');
  if (bailReason) lines.push(`  ⏹ 本轮提前结束:${bailReason}(跳过约 ${skipped} 个计划-口径)`);
  lines.push('');
  lines.push(`异常:${anomalies.length ? anomalies.join('; ') : failed.length ? `${failed.length} 个计划未扫到` : '无'}`);
  lines.push('');
  lines.push(
    '说明:若本文件的"最近运行"时间超过约 1 小时没更新,说明程序可能已停止/卡住/Mac 休眠 —— 请到 Mac 上查看"启动-常驻扫描"窗口是否还开着。'
  );
  return lines.join('\n');
}

function buildNotifyBody(rows, file) {
  const lines = [`输出文件:${file}`, ''];
  let lastCaliber = null;
  let lastCampaign = null;
  for (const r of rows) {
    if (r.caliber !== lastCaliber) {
      lines.push(`【${r.caliber}】`);
      lastCaliber = r.caliber;
      lastCampaign = null;
    }
    if (r.campaign !== lastCampaign) {
      lines.push(`  · ${r.campaign}`);
      lastCampaign = r.campaign;
    }
    const acct = r.workId ? r.acct : '商品卡片(无作品ID)';
    lines.push(`     ${acct} | ${r.workId || '-'} | ¥${r.costCNY} | ROI ${r.roi} ${r.mark || ''}`.trimEnd());
  }
  return lines.join('\n');
}
