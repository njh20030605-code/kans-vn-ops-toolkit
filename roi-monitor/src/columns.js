/**
 * 表头识别 + 数字解析 + 页面侧扫描,统一收口在这里。
 *
 * 为什么要有这个文件:
 *  1) 后台界面语言会变(中文 / English / Tiếng Việt / ไทย / Bahasa / Filipino)。以前表头正则全写死中文
 *     (作品ID / 成本 / 账号),页面一显示英文就找不到表格 → 误报"表格始终未加载"。
 *  2) 数字格式也跟着语言变。越南语/印尼语千分位用点:"1.234.567 ₫" / "Rp1.234.567"。
 *     旧写法 parseFloat(去掉非数字和点) 会把它读成 1.234 —— 差一百万倍,成本永远不达阈值。
 *  3) 币种随市场变(₫ / ฿ / Rp / RM / ₱ / S$),货币判断正则从 config.json 的 market.symbols 生成。
 *
 * pageWorker 是"自包含"函数(所有 helper 都嵌在里面),
 * 这样可以直接丢给 page.evaluate,不需要 eval,也不受页面 CSP 影响 —— 所以它不能 import,
 * 市场相关的东西(RE.cur / rate / assumeLocal)都通过 args 传进去。
 */
import { MARKET } from './util.js';

const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 各语言表头关键词。比对前会把表头去掉所有空白并转小写:"Video ID" → "videoid","Chi phí (₫)" → "chiphí(₫)"
// 顺序:中 / 英 / 越 / 泰 / 印尼 / 马来 / 菲律宾
const W = {
  id: '作品id|视频id|videoid|idvideo|idngvideo|creativeid|postid|itemid|mãvideo|รหัสวิดีโอ|รหัส|^id$',
  acct: '账号|帐号|account|tàikhoản|taikhoan|nhàsángtạo|creator|username|handle|บัญชี|akun|akaun',
  cost: '成本|cost|chiphí|chiphi|spend|amountspent|tổngchiphí|ค่าใช้จ่าย|biaya|kos|gastos',
  costLoose: '成本|cost|chiphí|chiphi|spend|ค่าใช้จ่าย|biaya|kos|gastos',
  roi: '投资回报率|\\broas\\b|\\broi\\b|lợitứcđầutư|tỷsuấthoànvốn|ผลตอบแทน|imbalhasil|pulangan',
  rev: '总收入|总收益|grossrevenue|revenue|totalrevenue|doanhthu|tổngdoanhthu|gmv|รายได้|pendapatan|totalpendapatan|hasil|jumlahhasil|kita|kabuuangkita',
  total: '合计|总计|汇总|total|tổng|รวม|jumlah|kabuuan',
};

/**
 * 按市场生成一套表头/货币正则(全是正则源码字符串,给 pageWorker 用)。
 * 默认市场取 config.json 的 market;自检/别国可传自己的 market 块。
 */
export function buildColRe(market = MARKET) {
  const syms = (market.symbols || []).map((x) => escapeRe(String(x).toLowerCase())).filter(Boolean);
  const cur = syms.length ? syms.join('|') : escapeRe(String(market.currency || '').toLowerCase());
  return {
    id: W.id,
    acct: W.acct,
    // 成本列先用严格版(词后面紧跟括号 / 货币符号 / 结尾,避免匹配到 "Cost per xxx"),找不到再退宽松版
    cost: `^(${W.cost})([(（]|${cur}|$)`,
    costLoose: `^(${W.costLoose})`,
    // 用词边界而不是锚在开头 —— 直播页的列叫「基本目标 ROI」,开头锚死就认不到了
    roi: W.roi,
    rev: `^(${W.rev})`,
    // 表尾合计行首列的措辞
    total: `^(${W.total})`,
    // 本币判断:单元格或表头里出现任一货币符号/缩写(大小写不敏感)
    cur,
  };
}

export const COL_RE = buildColRe(MARKET);

/**
 * 在页面上下文执行。mode:
 *   'count'   → 返回表格行数(0 = 还没加载出来)
 *   'headers' → 返回页面上所有表格的表头原文(排障用:看看这次到底显示成什么语言了)
 *   'peek'    → 返回前 n 行(空结果兜底校验)
 *   'scan'    → 全量扫描 + 翻页 + 阈值判定 + 去重
 */
export function pageWorker(args) {
  const { mode, RE, costThreshold, roiThreshold, n } = args;
  const rate = Number(args.rate) || 1; // 1 人民币 = rate 本币
  const assumeLocal = args.assumeLocal === true; // 没货币符号时是否一律当本币(小面额币种)
  const bigUnit = rate >= 100; // 越南盾/印尼盾这类大面额币种,才启用「数值大得离谱 → 必是本币」的兜底

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkRe = (src) => new RegExp(src, 'i');
  const normHeader = (s) => (s || '').replace(/\s+/g, '').toLowerCase();

  /** 语言无关的数字解析:千分位是点还是逗号都认得。 */
  const parseLocaleNum = (t) => {
    if (!t && t !== 0) return 0;
    let s = String(t).replace(/[^\d.,]/g, '');
    if (!s) return 0;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      // 两种分隔符都出现 → 靠后的那个才是小数点
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma >= 0) {
      const pc = s.split(',');
      // 出现多次,或最后一段正好 3 位 → 千分位;否则当小数点
      if (pc.length > 2 || pc[pc.length - 1].length === 3) s = s.replace(/,/g, '');
      else s = s.replace(',', '.');
    } else if (lastDot >= 0) {
      const pd = s.split('.');
      if (pd.length > 2 || pd[pd.length - 1].length === 3) s = s.replace(/\./g, '');
    }
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  };

  const getTable = () => {
    const idRe = mkRe(RE.id);
    return [...document.querySelectorAll('table')].find((t) =>
      [...t.querySelectorAll('thead th,thead td')].some((h) => idRe.test(normHeader(h.innerText)))
    );
  };

  const colMap = (table) => {
    if (!table) return { id: -1, acct: -1, cost: -1, roi: -1, rev: -1, costHeader: '' };
    const hs = [...table.querySelectorAll('thead th,thead td')].map((h) => normHeader(h.innerText));
    const f = (src) => {
      const re = mkRe(src);
      return hs.findIndex((h) => re.test(h));
    };
    let cost = f(RE.cost);
    if (cost < 0) cost = f(RE.costLoose);
    return {
      id: f(RE.id),
      acct: f(RE.acct),
      cost,
      roi: f(RE.roi),
      rev: f(RE.rev),
      costHeader: cost >= 0 ? hs[cost] : '',
    };
  };

  /** 金额归一化成人民币。货币符号可能在单元格里,也可能只写在表头上。 */
  const curRe = RE.cur ? mkRe(RE.cur) : null;
  const totalRe = mkRe(RE.total || '^(合计|总计|汇总|total|tổng)');
  const toCNY = (cellText, costHeader) => {
    const v = parseLocaleNum(cellText);
    if (!v) return 0;
    const hay = (cellText || '') + ' ' + (costHeader || '');
    const isLocal = curRe ? curRe.test(hay) : false;
    // 没标货币但数值大得离谱 → 只可能是本币(单素材消耗不可能有 ¥5000+);仅对大面额币种成立
    if (isLocal || assumeLocal || (bigUnit && v > 5000)) return v / rate;
    return v;
  };

  const readRows = (limit) => {
    const t = getTable();
    if (!t) return [];
    const m = colMap(t);
    let trs = [...t.querySelectorAll('tbody tr')];
    if (limit) trs = trs.slice(0, limit);
    return trs.map((tr) => {
      const d = [...tr.querySelectorAll('td')];
      const g = (i) => (i >= 0 && d[i] ? d[i].innerText.trim().replace(/\s+/g, ' ') : '');
      const costCNY = toCNY(g(m.cost), m.costHeader);
      const roiCell = m.roi >= 0 ? g(m.roi) : '';
      const roiCol = parseLocaleNum(roiCell);
      let roi;
      if (roiCell !== '' && roiCell !== '-' && roiCol > 0) {
        roi = roiCol; // 优先:页面自带 ROI 列(直播),与后台显示一致
      } else if (m.rev >= 0 && costCNY > 0) {
        roi = Math.round((toCNY(g(m.rev), m.costHeader) / costCNY) * 100) / 100; // 兜底:收入/成本
      } else {
        roi = 0;
      }
      return { workId: g(m.id), acct: g(m.acct >= 0 ? m.acct : 2), costCNY, roi };
    });
  };

  // ---- 分派 ----
  if (mode === 'count') {
    const t = getTable();
    return t ? t.querySelectorAll('tbody tr').length : 0;
  }

  if (mode === 'headers') {
    // 排障:表格认不出来时,把页面上所有表头原样吐出来看看是什么语言/什么措辞
    return [...document.querySelectorAll('table')].map((t) =>
      [...t.querySelectorAll('thead th,thead td')].map((h) => h.innerText.replace(/\s+/g, ' ').trim())
    );
  }

  if (mode === 'totals') {
    // 计划维度合计:成本 / GMV(总收入) / ROI。
    // 先找表格自带的「合计」行(最权威);没有就把所有分页加起来。
    return (async () => {
      let tries = 0;
      while (!getTable() && tries < 20) {
        await sleep(500);
        tries++;
      }
      const t = getTable();
      if (!t) return { ok: false, reason: 'no_table' };
      const m = colMap(t);
      if (m.cost < 0) return { ok: false, reason: 'no_cost_col' };

      // ① 表尾合计行(tfoot 或含 合计/总计/Total 的行)
      const footRow = (() => {
        const cands = [...t.querySelectorAll('tfoot tr')];
        for (const tr of cands) return tr;
        for (const tr of [...t.querySelectorAll('tbody tr')]) {
          const first = (tr.querySelector('td')?.innerText || '').replace(/\s+/g, '');
          if (totalRe.test(first)) return tr;
        }
        return null;
      })();
      if (footRow) {
        const d = [...footRow.querySelectorAll('td')];
        const g = (i) => (i >= 0 && d[i] ? d[i].innerText.trim() : '');
        const cost = toCNY(g(m.cost), m.costHeader);
        const rev = m.rev >= 0 ? toCNY(g(m.rev), m.costHeader) : 0;
        if (cost > 0) {
          return { ok: true, source: 'footer', costCNY: cost, gmvCNY: rev, rows: null };
        }
      }

      // ② 逐页累加(最多翻 40 页,足够覆盖)
      let costSum = 0;
      let gmvSum = 0;
      let rowCount = 0;
      let pages = 0;
      const seen = new Set();
      while (pages < 40) {
        const tb = getTable();
        if (!tb) break;
        const mm = colMap(tb);
        for (const tr of [...tb.querySelectorAll('tbody tr')]) {
          const d = [...tr.querySelectorAll('td')];
          const g = (i) => (i >= 0 && d[i] ? d[i].innerText.trim() : '');
          const first = (d[0]?.innerText || '').replace(/\s+/g, '');
          if (totalRe.test(first)) continue; // 别把合计行也加进去
          const id = g(mm.id) || g(0);
          const key = id + '|' + g(mm.cost);
          if (seen.has(key)) continue;
          seen.add(key);
          costSum += toCNY(g(mm.cost), mm.costHeader);
          if (mm.rev >= 0) gmvSum += toCNY(g(mm.rev), mm.costHeader);
          rowCount++;
        }
        const nx = document.querySelector('li.core-pagination-item-next');
        if (!nx || ('' + nx.className).includes('disabled')) break;
        const before = [...getTable().querySelectorAll('tbody tr')].map((r) => r.innerText).join('|');
        nx.click();
        let w = 0;
        let changed = false;
        while (w < 8000) {
          await sleep(300);
          w += 300;
          const now = [...(getTable()?.querySelectorAll('tbody tr') || [])].map((r) => r.innerText).join('|');
          if (now !== before) {
            changed = true;
            break;
          }
        }
        if (!changed) break;
        await sleep(300);
        pages++;
      }
      return { ok: true, source: 'sum', costCNY: costSum, gmvCNY: gmvSum, rows: rowCount, pages: pages + 1 };
    })();
  }

  if (mode === 'diag') {
    // 体检:表格找到了没、各列分别落在第几列。用来发现"界面换了措辞→列识别悄悄失效"
    const t = getTable();
    return {
      found: !!t,
      map: colMap(t),
      headers: t
        ? [...t.querySelectorAll('thead th,thead td')].map((h) => h.innerText.replace(/\s+/g, ' ').trim())
        : [],
    };
  }

  if (mode === 'peek') {
    return readRows(n || 5);
  }

  // mode === 'scan'
  return (async () => {
    let tries = 0;
    while (!getTable() && tries < 20) {
      await sleep(500);
      tries++;
    }
    const acc = [];
    let p = 0;
    const sig = () => readRows().map((x) => x.workId + ':' + Math.round(x.costCNY)).join('|');
    while (p < 10) {
      readRows().forEach((r) => {
        if (r.costCNY > costThreshold && r.roi < roiThreshold) acc.push(r);
      });
      const rs = readRows();
      const last = rs[rs.length - 1];
      if (!last || last.costCNY <= costThreshold) break; // 成本已≤阈值,后面只会更低,停
      const nx = document.querySelector('li.core-pagination-item-next');
      if (!nx || ('' + nx.className).includes('disabled')) break;
      const before = sig();
      nx.click();
      let w = 0;
      let changed = false;
      while (w < 8000) {
        await sleep(300);
        w += 300;
        if (sig() !== before) {
          changed = true;
          break;
        }
      }
      if (!changed) break;
      await sleep(400);
      p++;
    }
    const seen = new Set();
    return acc
      .filter((r) => {
        const k = r.workId + r.acct;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((r) => ({ workId: r.workId, acct: r.acct, costCNY: Math.round(r.costCNY), roi: r.roi }));
  })();
}
