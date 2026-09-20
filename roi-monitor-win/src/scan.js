import { info, warn, marketOf } from './util.js';
import { COL_RE, pageWorker } from './columns.js';
import { hardDeadline } from './browser.js';

/** 从 config 取页面侧需要的市场参数:汇率(1¥=rate 本币)+ 无符号时是否当本币。 */
export function marketArgs(config) {
  const m = marketOf(config);
  return { rate: m.rateToCny, assumeLocal: m.assumeLocalCurrency === true };
}

/**
 * 在页面上下文执行扫描:归一化¥、阈值判定、翻页、去重。
 * 返回命中数组 [{ workId, acct, costCNY, roi }]。
 * 表头识别/数字解析的多语言规则统一在 columns.js;rate = 1 人民币兑多少本币。
 */
export async function scanCurrentTable(page, { costThreshold, roiThreshold, rate, assumeLocal }) {
  // 页面卡死时 evaluate 会无限期等下去,必须有硬超时(翻页最多 10 页,90 秒绰绰有余)
  try {
    return await hardDeadline(
      page.evaluate(pageWorker, { mode: 'scan', RE: COL_RE, costThreshold, roiThreshold, rate, assumeLocal }),
      90000,
      '扫描表格'
    );
  } catch (e) {
    warn('扫描超时或出错,本计划按空结果处理:', e.message);
    return [];
  }
}

/**
 * 只读取表格前 N 行,用于空结果兜底校验(§3.1)。
 * 返回 [{ workId, acct, costCNY, roi }]。
 */
export async function peekTopRows(page, { rate, assumeLocal, n = 5 }) {
  try {
    return await hardDeadline(
      page.evaluate(pageWorker, { mode: 'peek', RE: COL_RE, rate, assumeLocal, n }),
      20000,
      '读表格前几行'
    );
  } catch {
    return [];
  }
}

/**
 * 计划维度合计:成本 / GMV / ROI。
 * 优先用表格自带的合计行;没有就逐页累加所有素材(会翻完所有页,比普通扫描慢)。
 * 返回 { ok, source:'footer'|'sum', costCNY, gmvCNY, roi, rows }
 */
export async function scanTotals(page, config) {
  try {
    const r = await hardDeadline(
      page.evaluate(pageWorker, { mode: 'totals', RE: COL_RE, ...marketArgs(config) }),
      180000,
      '统计计划合计'
    );
    if (!r || !r.ok) {
      warn('统计计划合计失败:', r?.reason || '未知');
      return { ok: false, reason: r?.reason };
    }
    const roi = r.costCNY > 0 ? Math.round((r.gmvCNY / r.costCNY) * 100) / 100 : 0;
    return { ...r, roi };
  } catch (e) {
    warn('统计计划合计异常:', e.message);
    return { ok: false, reason: e.message };
  }
}

/** 体检:表格找到没、各列落在第几列。用来发现「界面换措辞 → 列识别悄悄失效」。 */
export async function diagColumns(page) {
  try {
    return await hardDeadline(
      page.evaluate(pageWorker, { mode: 'diag', RE: COL_RE }),
      15000,
      '列识别体检'
    );
  } catch {
    return null;
  }
}

/** 排障:把页面上所有表格的表头原文打出来(用来确认当前是中文还是英文界面)。 */
export async function dumpHeaders(page) {
  try {
    return await hardDeadline(
      page.evaluate(pageWorker, { mode: 'headers', RE: COL_RE }),
      15000,
      '读表头'
    );
  } catch {
    return [];
  }
}

/**
 * 扫描单个计划单个口径,带空结果兜底(§3 + §3.1)。
 * 返回 { hits, empty, verified } 。
 */
export async function scanCampaign(page, config) {
  const mk = marketArgs(config);
  const params = {
    costThreshold: config.costThresholdCNY,
    roiThreshold: config.roiThreshold,
    ...mk,
  };
  let hits = await scanCurrentTable(page, params);
  if (hits.length > 0) return { hits, empty: false, verified: true, colWarn: null };

  // 空结果 → 规则兜底:看前几行是否真的都不满足
  const top = await peekTopRows(page, { ...mk, n: 5 });

  // 0 命中时做一次列识别体检 —— 专治"界面换了语言/措辞,列认不出来,于是永远 0 命中"这种闷声出错
  const colWarn = await checkColumns(page, top);

  if (top.length === 0) {
    // 表还没渲染出来,再扫一次
    info('空结果且未读到前几行,重扫一次');
    hits = await scanCurrentTable(page, params);
    return { hits, empty: hits.length === 0, verified: false, colWarn };
  }
  const first = top[0];
  const genuinelyEmpty = first.costCNY <= config.costThresholdCNY || first.roi >= config.roiThreshold;
  if (genuinelyEmpty) {
    return { hits: [], empty: true, verified: true, colWarn };
  }
  // 首行看起来应该命中,但扫描却为空 → 加载竞态,重扫
  info('首行疑似应命中但扫描为空,重扫一次');
  hits = await scanCurrentTable(page, params);
  return { hits, empty: hits.length === 0, verified: false, colWarn };
}

/** 返回一句人话的警告,或 null。顺便把真实表头写进日志方便下次加正则。 */
async function checkColumns(page, top) {
  const d = await diagColumns(page);
  if (!d) return null;
  if (!d.found) {
    warn('排障:页面上找不到创意表格(没加载完 / 白屏 / 改版 / 界面语言不认识)');
    return null; // 表都没有,属于"没加载",交给上层的加载失败逻辑,不重复报
  }
  const miss = [];
  if (d.map.id < 0) miss.push('素材ID列');
  if (d.map.cost < 0) miss.push('成本列');
  if (d.map.roi < 0 && d.map.rev < 0) miss.push('ROI列和总收入列(两者至少要有一个)');
  if (miss.length) {
    warn('排障:真实表头 =', JSON.stringify(d.headers).slice(0, 600));
    return `列识别失败,认不出:${miss.join('、')}。页面措辞/语言可能变了,本计划的结果不可信(表头已写进日志)`;
  }
  if (top.length > 0 && top.every((r) => r.costCNY === 0)) {
    warn('排障:真实表头 =', JSON.stringify(d.headers).slice(0, 600));
    return '前几行成本全是 0(正常几乎不可能),成本列可能认错了,本计划的结果不可信';
  }
  return null;
}
