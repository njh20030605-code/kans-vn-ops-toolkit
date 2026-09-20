import { buildDashboardUrl, vnDayOf, info, warn, marketOf } from './util.js';
import { getPage, gotoAndWaitTable, setLiveInterception } from './browser.js';
import { scanTotals } from './scan.js';
import { upsertDailyTotals } from './feishu.js';

/**
 * 采集「昨天一整天」各计划的 成本 / GMV / ROI,写进飞书的「计划日汇总」表。
 * 每天早上跑一次(日报之前),大概 8 个计划 × 每个十几秒。
 *
 * 数据来源:创意表格。优先用表格自带的「合计」行;没有就把所有分页逐行累加。
 * 所以这是**素材层合计**,如果 TikTok 后台另有计划级官方数字,以后端口对上再换。
 */
export async function collectDailyTotals(config, campaigns, deps, daysAgo = 1) {
  const ctx = deps.context || (deps.getContext && deps.getContext());
  if (!ctx) return { ok: false, reason: '没有可用的浏览器' };
  const day = vnDayOf(marketOf(config).tzOffsetHours, daysAgo);
  info(`===== 采集 ${day.key} 各计划合计(成本/GMV/ROI)=====`);

  const page = await getPage(ctx);
  const totals = [];
  for (const c of campaigns) {
    await setLiveInterception(page, c.type === 'live' ? { start: day.key, end: day.key } : null, config);
    const url = buildDashboardUrl(c, day.start, day.end);
    const loaded = await gotoAndWaitTable(page, url, config);
    if (!loaded.ok) {
      warn(`「${c.name}」${day.key} 页面没打开(${loaded.error}),这个计划跳过。`);
      continue;
    }
    const t = await scanTotals(page, config);
    if (!t.ok) {
      warn(`「${c.name}」${day.key} 合计取数失败(${t.reason}),跳过。`);
      continue;
    }
    info(
      `  ${c.name}:成本 ¥${Math.round(t.costCNY)} / GMV ¥${Math.round(t.gmvCNY)} / ROI ${t.roi}` +
        `(${t.source === 'footer' ? '表格合计行' : `逐行累加 ${t.rows} 条`})`
    );
    totals.push({
      campaign: c.name,
      dateKey: day.key,
      costCNY: t.costCNY,
      gmvCNY: t.gmvCNY,
      roi: t.roi,
      rows: t.rows,
      source: t.source,
    });
  }
  await setLiveInterception(page, null, config);

  if (!totals.length) {
    warn('一个计划的合计都没取到,不写表。');
    return { ok: false, dateKey: day.key, count: 0 };
  }
  const w = await upsertDailyTotals(config, totals);
  return { ok: w.ok, dateKey: day.key, count: totals.length, totals };
}
