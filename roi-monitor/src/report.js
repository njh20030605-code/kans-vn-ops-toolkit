import { readDailyTotals, vnDateOf } from './feishu.js';

/**
 * 每日数据通报(默认越南时间早上 9 点推)。
 *
 * 早上发,所以报告对象是**昨天一整天**。只看三个字段,按广告计划维度:
 *   成本 / GMV / ROI
 *   · 日环比 = 昨天 vs 前天
 *   · 周环比 = 近 7 天(截至昨天) vs 再往前 7 天
 *
 * 数据源是飞书「计划日汇总」表(每天早上由 daily.js 采集写入),
 * 不是本地文件 —— 中途重启过也不影响。
 */
export async function buildDailyReport(config) {
  const today = vnDateOf(config);
  const d1 = shift(today, -1); // 昨天 = 报告对象
  const d2 = shift(today, -2); // 前天 = 日环比基准

  const cache = new Map();
  const load = async (day) => {
    if (!cache.has(day)) cache.set(day, normalize(await readDailyTotals(config, day)));
    return cache.get(day);
  };
  const days = [];
  for (let i = 1; i <= 14; i++) days.push(shift(today, -i));
  for (const d of days) await load(d);

  const y = cache.get(d1) || [];
  if (y.length === 0) return null; // 昨天没采到数,不推(多半是程序没跑)

  const yPrev = cache.get(d2) || [];
  const week = days.slice(0, 7).flatMap((d) => cache.get(d) || []);
  const weekPrev = days.slice(7, 14).flatMap((d) => cache.get(d) || []);

  const agg = (rows) => {
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    const gmv = rows.reduce((s, r) => s + r.gmv, 0);
    return { cost, gmv, roi: cost > 0 ? Math.round((gmv / cost) * 100) / 100 : 0 };
  };
  const A = agg(y);
  const Ap = agg(yPrev);
  const W = agg(week);
  const Wp = agg(weekPrev);

  const lines = [];

  // ---- 总览 ----
  lines.push(`**全部计划合计**`);
  lines.push(`成本 **¥${fmt(A.cost)}**   GMV **¥${fmt(A.gmv)}**   ROI **${A.roi}**`);
  lines.push(
    `日环比　成本 ${arrow(A.cost, Ap.cost, 'cost')}　GMV ${arrow(A.gmv, Ap.gmv, 'gmv')}　ROI ${arrow(A.roi, Ap.roi, 'roi')}`
  );
  lines.push(
    `周环比　成本 ${arrow(W.cost, Wp.cost, 'cost')}　GMV ${arrow(W.gmv, Wp.gmv, 'gmv')}　ROI ${arrow(W.roi, Wp.roi, 'roi')}`
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---- 分计划 ----
  const prevBy = keyBy(yPrev);
  const weekBy = groupSum(week);
  const weekPrevBy = groupSum(weekPrev);
  const maxCost = Math.max(1, ...y.map((r) => r.cost));
  const sorted = [...y].sort((a, b) => b.cost - a.cost);

  lines.push('**分计划(按成本排)**');
  lines.push('');
  for (const r of sorted) {
    const p = prevBy.get(r.campaign);
    const w = weekBy.get(r.campaign);
    const wp = weekPrevBy.get(r.campaign);
    lines.push(`**${r.campaign}**`);
    lines.push(`${bar(r.cost, maxCost)}  成本 ¥${fmt(r.cost)}　GMV ¥${fmt(r.gmv)}　ROI ${roiTag(r.roi, config)}`);
    lines.push(
      `　日环比 成本 ${arrow(r.cost, p?.cost, 'cost')}　GMV ${arrow(r.gmv, p?.gmv, 'gmv')}　ROI ${arrow(r.roi, p?.roi, 'roi')}`
    );
    if (w && wp) {
      lines.push(
        `　周环比 成本 ${arrow(w.cost, wp.cost, 'cost')}　GMV ${arrow(w.gmv, wp.gmv, 'gmv')}　ROI ${arrow(w.roi, wp.roi, 'roi')}`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`口径:越南时间 ${d1} 全天,金额已按 ₫/${config.vndToCnyRate} 折成人民币。`);
  lines.push('数字来自创意表格合计(素材层),ROI = GMV ÷ 成本。');
  if (config.feishu?.bitable?.appToken) {
    lines.push(`[点开底表看明细](https://gvh59x1f62p.feishu.cn/base/${config.feishu.bitable.appToken})`);
  }

  return {
    title: `📊 KANS 越南投放日报 · ${d1}`,
    template: A.roi > 0 && Ap.roi > 0 && A.roi < Ap.roi * 0.8 ? 'orange' : 'blue',
    lines,
  };
}

/**
 * 红色预警卡片(即时推)。
 * histStats: Map(workId → {firstDate, days:Set, count}),来自 store.getHistoryStats,
 * 必须是 appendTodayHits **之前**取的,否则"首次"会被今天自己的记录顶掉。
 */
export function buildRedAlertCard(config, DT, redHits, histStats = new Map(), dateLabels = {}) {
  const R = config.notify?.redAlert || { costThresholdCNY: 200, roiThreshold: 1 };
  const lines = [`条件:消耗 > ¥${R.costThresholdCNY} 且 ROI < ${R.roiThreshold}`, ''];

  // 按口径分组。越南 10 点和 14 点那两轮会同时扫「当天」和「近7天」,
  // 不分开的话 ¥1779 到底是一天烧的还是七天累计的,完全看不出来。
  const ORDER = ['当天', '近7天'];
  const groups = ORDER.map((c) => [c, redHits.filter((r) => r.caliber === c)]).filter(([, a]) => a.length);
  const other = redHits.filter((r) => !ORDER.includes(r.caliber));
  if (other.length) groups.push(['', other]);

  for (const [caliber, arr] of groups) {
    if (caliber) {
      const range = dateLabels[caliber] ? ` · ${dateLabels[caliber]}` : '';
      const note = caliber === '近7天' ? '  (7天累计,不是单日)' : '';
      lines.push(`**【${caliber}】**${range}${note}`);
    }
    // 「当天」:新素材排前面(要重点关注的放最上面),同为新/老再按消耗降序。
    // 「近7天」:不显示新旧标记,所以纯按消耗降序 —— 否则会出现"小额排在大额前面"看着像乱排。
    const sorted = [...arr].sort((a, b) => {
      if (caliber !== '近7天') {
        const na = isNew(a, histStats) ? 0 : 1;
        const nb = isNew(b, histStats) ? 0 : 1;
        if (na !== nb) return na - nb;
      }
      return b.costCNY - a.costCNY;
    });
    sorted.forEach((r, i) => {
      // 账号和素材ID都要给 —— 光有账号名没法去后台定位到具体那条素材
      const who = [r.acct, r.workId].filter(Boolean).join(' | ') || '商品卡片(无作品ID)';
      // 只对「近7天」不标新旧(历史库记的是当天口径,跨口径标会误导);其余一律正常标
      const tag = caliber !== '近7天' ? '　' + ageTag(r, histStats) : '';
      lines.push(`${i + 1}. **${r.campaign}**\n   ${who}\n   消耗 **¥${r.costCNY}**　ROI **${r.roi}**${tag}`);
    });
    lines.push('');
  }

  if (config.feishu?.bitable?.appToken) {
    lines.push(`[点开底表看明细](https://gvh59x1f62p.feishu.cn/base/${config.feishu.bitable.appToken})`);
  }
  return { title: `🔴 KANS 红色预警:${redHits.length} 条高耗低效素材(${DT})`, template: 'red', lines };
}

/**
 * 这条素材是新冒出来的,还是已经跑了好几天的老素材。
 *
 * ⚠️ 方向别搞反(2026-09-12 按 Jasper 的口径修正):
 *   · 新素材 = **需要重点关注** → 标红。还没被验证就在烧钱,该尽快判断留不留。
 *   · 老素材 = 已经连着跑了好几天还留着,说明这条已经被认可了,低 ROI 是可接受的
 *     → 标灰,只是陈述事实,不催人。
 */
/** 有素材ID 且 历史里没出现过 = 新素材。商品卡片没ID,不算新也不算老。 */
function isNew(r, histStats) {
  if (!r.workId) return false;
  const h = histStats.get(r.workId);
  return !h || h.days.size === 0;
}

function ageTag(r, histStats) {
  if (!r.workId) return ''; // 商品卡片没有素材ID,判断不了
  const h = histStats.get(r.workId);
  if (!h || h.days.size === 0) return "<font color='red'>🆕 新素材 · 需重点关注</font>";
  const n = h.days.size + 1; // 加上今天
  const first = h.firstDate ? `${+h.firstDate.slice(5, 7)}月${+h.firstDate.slice(8, 10)}日` : '';
  return `<font color='grey'>老素材 · 已连续第 ${n} 天(首次 ${first})</font>`;
}

// ---------------- 小工具 ----------------

function normalize(rows) {
  return rows.map((r) => ({
    campaign: txt(r['广告计划']),
    cost: num(r['成本¥']),
    gmv: num(r['GMV¥']),
    roi: num(r['ROI']),
  }));
}

const keyBy = (rows) => new Map(rows.map((r) => [r.campaign, r]));

function groupSum(rows) {
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.campaign) || { cost: 0, gmv: 0 };
    e.cost += r.cost;
    e.gmv += r.gmv;
    m.set(r.campaign, e);
  }
  for (const [, e] of m) e.roi = e.cost > 0 ? Math.round((e.gmv / e.cost) * 100) / 100 : 0;
  return m;
}

const txt = (v) =>
  v == null ? '' : Array.isArray(v) ? v.map((x) => x?.text ?? x).join('') : typeof v === 'object' ? v.text ?? '' : String(v);
const num = (v) => (typeof v === 'number' ? v : parseFloat(txt(v)) || 0);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** 文字条形图 —— 飞书卡片里最稳的"可视化",不依赖任何图表组件。 */
function bar(v, max, width = 12) {
  const n = Math.max(v > 0 ? 1 : 0, Math.round((v / max) * width));
  return '▇'.repeat(n) + '·'.repeat(Math.max(0, width - n));
}

/**
 * 涨跌标记。注意方向含义不同:
 *   成本涨 = 中性偏警惕(灰);GMV 涨 = 好(绿);ROI 涨 = 好(绿),跌 = 坏(红)。
 */
function arrow(now, prev, kind) {
  if (prev == null || prev === 0) return '<font color=\'grey\'>—</font>';
  const pct = Math.round(((now - prev) / prev) * 100);
  if (Math.abs(pct) < 3) return '<font color=\'grey\'>持平</font>';
  const up = pct > 0;
  const sign = `${up ? '↑' : '↓'}${Math.abs(pct)}%`;
  if (kind === 'cost') return `<font color='grey'>${sign}</font>`;
  const good = up; // GMV / ROI 涨都是好事
  return `<font color='${good ? 'green' : 'red'}'>${sign}</font>`;
}

/** ROI 低于阈值标红,一眼能看出哪个计划有问题。 */
function roiTag(roi, config) {
  const th = config.roiThreshold ?? 2;
  return roi < th ? `<font color='red'>**${roi}**</font>` : `**${roi}**`;
}

function shift(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400e3);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
