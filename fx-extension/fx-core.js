// fx-core.js — 纯函数：本地化数字解析 + 金额识别 + 换算格式化。不碰 DOM，可在 Node 里测试。
// 用法：const conv = FX_CORE.createConverter({ market, platform: "tiktok"|"shopee", rate, target })
//   rate   = 1 目标货币 = 多少本地货币（例 1 CNY = 3891 VND）
//   target = FX_MARKETS.TARGETS 里的一项
(function (root) {
  const COMMON_MULT = { k: 1e3, m: 1e6, b: 1e9 };
  const MAX_DIGITS = 13;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // 通用本地化数字解析：自动判断“逗号/点”哪个是小数点、哪个是千分位。
  //   22.653,20 → 22653.20（越南/印尼/欧洲：点千分位、逗号小数）
  //   1,234.5   → 1234.5  （英美/泰/马/菲/新：逗号千分位、点小数）
  //   89.684.715→ 89684715（多个点 = 千分位）
  //   8.7 / 897,7 → 8.7 / 897.7（单个分隔符且小数位≠3位 = 小数）
  function parseNumberLocale(str) {
    let s = String(str).trim().replace(/\s/g, "");
    const hasDot = s.indexOf(".") >= 0, hasComma = s.indexOf(",") >= 0;
    if (hasDot && hasComma) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasComma) {
      const p = s.split(",");
      if (p.length === 2 && p[1].length !== 3) s = s.replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasDot) {
      const p = s.split(".");
      if (!(p.length === 2 && p[1].length !== 3)) s = s.replace(/\./g, "");
    }
    return parseFloat(s);
  }

  function createConverter(opts) {
    const market = opts.market;
    const platform = opts.platform || "tiktok";
    const target = opts.target || { symbol: "¥", locale: "zh-CN" };
    let rate = opts.rate;                       // 本地货币 / 1 目标货币

    const mult = Object.assign({}, COMMON_MULT, market.mult || {});
    // 多字符单位排前面，避免 "tr" 被 "t" 抢先匹配
    const multKeys = Object.keys(mult).sort((a, b) => b.length - a.length);
    const MULT = "(" + multKeys.map(esc).join("|") + ")?";
    const symbols = market.symbols.slice().sort((a, b) => b.length - a.length);
    const CUR = "(?:" + symbols.map(esc).join("|") + ")";
    const CUR_TEST = new RegExp(CUR, "i");
    const pos = (market.symbolPos && market.symbolPos[platform]) || "suffix";

    const SUFFIX_RE = new RegExp("(\\d[\\d.,]*)\\s*" + MULT + "\\s*" + CUR, "gi");
    const PREFIX_RE = new RegExp(CUR + "\\s*(\\d[\\d.,]*)\\s*" + MULT, "gi");
    const VALUE_RE = new RegExp("^\\s*(?:" + CUR + ")?\\s*\\d[\\d.,]*\\s*" + MULT + "\\s*(?:" + CUR + ")?\\s*$", "i");
    const VALUE_CUR_SUF_RE = new RegExp("^\\d[\\d.,]*\\s*" + MULT + "\\s*" + CUR + "$", "i");
    const VALUE_CUR_PRE_RE = new RegExp("^" + CUR + "\\s*\\d[\\d.,]*\\s*" + MULT + "$", "i");
    const EXTRACT_SUF_RE = new RegExp("^(\\d[\\d.,]*)\\s*" + MULT + "\\s*(?:" + CUR + ")?$", "i");
    const EXTRACT_PRE_RE = new RegExp("^" + CUR + "\\s*(\\d[\\d.,]*)\\s*" + MULT + "$", "i");
    const MULT_TAIL_RE = new RegExp("(" + multKeys.map(esc).join("|") + ")(?:" + CUR + ")?$", "i");

    function multFactor(u) { return u ? (mult[u.toLowerCase()] || 1) : 1; }

    function parseAmount(numStr, m) {
      const base = parseNumberLocale(numStr);
      return isNaN(base) ? NaN : base * multFactor(m);
    }

    // 带上限保护
    function safeLocal(numStr, m) {
      const digits = String(numStr).replace(/[^\d]/g, "");
      if (!digits || digits.length > MAX_DIGITS) return NaN;
      const v = parseAmount(numStr, m);
      if (!isFinite(v) || v < 0 || v > market.maxLocal) return NaN;
      return v;
    }

    function fmt(local) {
      const v = local / rate;
      let s;
      if (v >= 100) s = Math.round(v).toLocaleString(target.locale);
      else if (v >= 1) s = v.toLocaleString(target.locale, { maximumFractionDigits: 2 });
      else s = v.toLocaleString(target.locale, { maximumFractionDigits: 3 });
      return target.symbol + s;
    }

    function hasCurrency(text) { return CUR_TEST.test(text); }
    function alreadyConverted(text) { return text.indexOf(target.symbol) >= 0; }

    /** 文本级：把一段文字里所有“数字+符号”换掉 */
    function convertText(text) {
      const RE = pos === "prefix" ? PREFIX_RE : SUFFIX_RE;
      RE.lastIndex = 0;
      return text.replace(RE, (m, a, b) => {
        const num = pos === "prefix" ? a : a;      // 两种正则的捕获顺序一致：(num)(mult)
        const v = safeLocal(num, b);
        return isNaN(v) ? m : fmt(v);
      });
    }

    function looksLikeMoney(t) {
      const s = t.replace(/\s+/g, "");
      if (CUR_TEST.test(s)) return true;
      if (MULT_TAIL_RE.test(s) && /\d/.test(s)) return true;
      if (!/[A-Za-z]/.test(s) && !CUR_TEST.test(s)) {
        const n = parseInt(s.replace(/[^\d]/g, ""), 10);
        return n >= market.bareMin;
      }
      return false;
    }

    /** 从整块文本提取金额（先按平台的符号位置，再兜底无符号裸数值，供卡片模式用） */
    function extractAmount(text) {
      const s = String(text).trim();
      if (alreadyConverted(s)) return NaN;
      let m;
      if (pos === "prefix") {
        m = s.match(EXTRACT_PRE_RE); if (m) return safeLocal(m[1], m[2]);
        m = s.match(EXTRACT_SUF_RE); if (m) return safeLocal(m[1], m[2]);
        return NaN;
      }
      m = s.match(EXTRACT_SUF_RE); if (m) return safeLocal(m[1], m[2]);
      m = s.match(EXTRACT_PRE_RE); if (m) return safeLocal(m[1], m[2]);
      return NaN;
    }

    function isCurAmount(t) { return VALUE_CUR_SUF_RE.test(t) || VALUE_CUR_PRE_RE.test(t); }
    function isValueLike(t) { return VALUE_RE.test(t) && /\d/.test(t); }

    return {
      market, platform, target,
      get rate() { return rate; }, set rate(r) { rate = r; },
      parseNumberLocale, parseAmount, safeLocal, fmt,
      convertText, extractAmount, isCurAmount, isValueLike, looksLikeMoney, hasCurrency, alreadyConverted,
    };
  }

  const api = { parseNumberLocale, createConverter, COMMON_MULT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FX_CORE = api;
})(typeof self !== "undefined" ? self : this);
