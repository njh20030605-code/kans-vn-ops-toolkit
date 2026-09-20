// content.js — 把 TikTok / Shopee 越南后台的 VND 金额按实时汇率替换成人民币（¥）
// 作者：Jasper Yang · 仅供内部使用，勿外传 / 勿用于盈利
(() => {
  let RATE = 0.000257;
  let ENABLED = true;

  // 按域名分流：Shopee 一套、TikTok 一套，互不干扰（数字解析仍共用底层函数）
  //   Shopee 越南：货币符号在【前】，如 đ89.684.715 / đ22.653,20K（逗号小数、K）
  //   TikTok 越南：货币符号在【后】，如 62.142.512đ / 897,7Trđ / 3,9Tđ
  const IS_SHOPEE = /(^|\.)shopee\./i.test(location.hostname);

  const CUR = "(?:VND|vnd|₫|đ|Đ)";
  // 倍数单位：英文 K/M/B + 越南文 N/Ng(千) / Tr(百万) / T/Tỷ/Ty(十亿)。多字符排前面。
  const MULT = "(Tr|tr|TR|Tỷ|tỷ|Ty|ty|TY|Ng|ng|NG|K|k|M|m|B|b|N|n|T|t)?";
  // 后缀式：12.345,6K đ（TikTok）
  const SUFFIX_RE = new RegExp("(\\d[\\d.,]*)\\s*" + MULT + "\\s*" + CUR, "g");
  // 前缀式：đ 12.345,6K（Shopee）
  const PREFIX_RE = new RegExp(CUR + "\\s*(\\d[\\d.,]*)\\s*" + MULT, "g");

  const MAX_VND = 1e12;
  const MAX_DIGITS = 13;

  function multFactor(u) {
    if (u === "tr") return 1e6;
    if (u === "t" || u === "ty" || u === "tỷ") return 1e9;
    if (u === "n" || u === "ng") return 1e3;
    if (u === "k") return 1e3;
    if (u === "m") return 1e6;
    if (u === "b") return 1e9;
    return 1;
  }

  // 通用本地化数字解析：自动判断“逗号/点”哪个是小数点、哪个是千分位。
  //   22.653,20 → 22653.20（越南/欧洲：点千分位、逗号小数）
  //   1,234.5   → 1234.5  （英美：逗号千分位、点小数）
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

  function parseAmount(numStr, mult) {
    const base = parseNumberLocale(numStr);
    if (isNaN(base)) return NaN;
    return base * (mult ? multFactor(mult.toLowerCase()) : 1);
  }

  function fmtCny(vnd) {
    const v = vnd * RATE;
    let s;
    if (v >= 100) s = Math.round(v).toLocaleString("zh-CN");
    else if (v >= 1) s = v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
    else s = v.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
    return "¥" + s;
  }

  // 带上限保护的换算
  function safeVnd(numStr, mult) {
    const digits = numStr.replace(/[^\d]/g, "");
    if (!digits || digits.length > MAX_DIGITS) return NaN;
    const vnd = parseAmount(numStr, mult);
    if (!isFinite(vnd) || vnd < 0 || vnd > MAX_VND) return NaN;
    return vnd;
  }

  // ===== 文本模式：Shopee 只跑前缀式，TikTok 只跑后缀式 =====
  function convertText(text) {
    const RE = IS_SHOPEE ? PREFIX_RE : SUFFIX_RE;
    return text.replace(RE, (m, num, mult) => {
      const vnd = safeVnd(num, mult);
      return isNaN(vnd) ? m : fmtCny(vnd);
    });
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "NOSCRIPT", "SVG"]);
  function shouldSkip(node) {
    let p = node.parentElement;
    while (p) {
      if (SKIP_TAGS.has(p.tagName)) return true;
      if (p.isContentEditable) return true;
      p = p.parentElement;
    }
    return false;
  }

  function processNode(node) {
    const val = node.nodeValue;
    if (!val || val.indexOf("¥") >= 0) return;
    if (!/VND|vnd|₫|đ|Đ/.test(val)) return;
    if (shouldSkip(node)) return;
    const next = convertText(val);
    if (next !== val) node.nodeValue = next;
  }

  function walkAndConvert(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const batch = [];
    let n;
    while ((n = walker.nextNode())) batch.push(n);
    batch.forEach(processNode);
  }

  // ===== 卡片模式（数值无货币符号，靠标签判断） =====
  const CURRENCY_LABEL_RES = [
    /\(\s*(?:₫|đ|VND)\s*\)/i,
    /attributed\s*gmv/i, /\bgmv\b/i, /gross\s*revenue/i, /\brevenue\b/i, /\bsales?\b/i,
    /ads?\s*cost/i, /\bcost\b/i, /cost\s*per/i, /spend/i,
    /per\s*hour/i, /\/\s*hour/i,
    /\bgpm\b/i, /watch\s*gpm/i, /show\s*gpm/i,
    /\baov\b/i, /average\s*order\s*value/i, /per\s*order/i,
    /成本|花费|消耗/, /收入|营收|销售额|营业额|成交额|支付金额/, /客单价|每单|每笔/, /每小时/, /千次|每千/
  ];
  const NON_CURRENCY_RES = [
    /impression|曝光|展现/i, /view|观看|观众/i, /\bctr\b|\bctor\b|点击率|转化率/i,
    /rate|率|percent/i, /order[s]?\b(?!\s*value)/i, /items?\s*sold|已售|销量/i, /\bpin\b/i,
    /\bmax\b|\bactive\b|活动中|进行中/i, /click|点击/i, /follower|粉丝/i,
    /成交件|件数|访客|客户数|订单数|人数|次数|个数/
  ];
  const VALUE_RE = new RegExp("^\\s*\\d[\\d.,]*\\s*" + MULT + "\\s*(?:₫|đ|VND)?\\s*$");
  const VALUE_CUR_SUF_RE = new RegExp("^\\d[\\d.,]*\\s*" + MULT + "\\s*(?:₫|đ|VND)$");
  const VALUE_CUR_PRE_RE = new RegExp("^(?:₫|đ|VND)\\s*\\d[\\d.,]*\\s*" + MULT + "$");
  const EXTRACT_SUF_RE = new RegExp("^(\\d[\\d.,]*)\\s*" + MULT + "\\s*(?:₫|đ|VND)?$");
  const EXTRACT_PRE_RE = new RegExp("^(?:₫|đ|VND)\\s*(\\d[\\d.,]*)\\s*" + MULT + "$");
  const VAL_TAGS = "div,span,p,b,strong,em,td,h1,h2,h3,h4";

  function directText(el) {
    let s = "";
    for (const c of el.childNodes) if (c.nodeType === 3) s += c.nodeValue;
    return s.trim();
  }

  function isCurrencyLabel(txt) {
    if (NON_CURRENCY_RES.some((r) => r.test(txt))) return false;
    return CURRENCY_LABEL_RES.some((r) => r.test(txt));
  }

  function looksLikeMoney(t) {
    const s = t.replace(/\s+/g, "");
    if (/₫|đ|VND/i.test(s)) return true;
    if (/(Tr|tr|TR|Tỷ|tỷ|Ty|ty|TY|[MmBbTt])(?:₫|đ|VND)?$/.test(s)) return true;
    if (!/[A-Za-z₫đ]/.test(s)) {
      const n = parseInt(s.replace(/[^\d]/g, ""), 10);
      return n >= 1000000;
    }
    return false;
  }

  // 从整块文本安全提取金额（按平台选择前缀/后缀；无符号也可，供卡片模式用）
  function extractAmount(text) {
    const s = text.trim();
    if (s.indexOf("¥") >= 0) return NaN;
    if (IS_SHOPEE) {
      let m = s.match(EXTRACT_PRE_RE);
      if (m) return safeVnd(m[1], m[2]);
      m = s.match(EXTRACT_SUF_RE);           // 兜底：无符号裸数值（卡片）
      if (m) return safeVnd(m[1], m[2]);
      return NaN;
    }
    const m = s.match(EXTRACT_SUF_RE);        // TikTok：后缀 / 无符号
    return m ? safeVnd(m[1], m[2]) : NaN;
  }

  function convertValueEl(el) {
    const vnd = extractAmount(el.textContent);
    if (isNaN(vnd)) return;
    const out = fmtCny(vnd);
    if (el.textContent !== out) el.textContent = out;
  }

  function isCurAmount(t) {
    return IS_SHOPEE ? VALUE_CUR_PRE_RE.test(t) : VALUE_CUR_SUF_RE.test(t);
  }

  // ① 元素级：整块就是“数字+货币符号”（含 Shopee 的 đ 前缀、拆 span）
  function elementConvert(root) {
    const els = root.querySelectorAll(VAL_TAGS);
    for (const el of els) {
      const t = el.textContent.trim();
      if (!t || !isCurAmount(t)) continue;
      const p = el.parentElement;
      if (p && isCurAmount(p.textContent.trim())) continue;
      convertValueEl(el);
    }
  }

  function findValueForLabel(labelEl) {
    let scope = labelEl.parentElement;
    for (let i = 0; i < 4 && scope; i++, scope = scope.parentElement) {
      const cands = [];
      scope.querySelectorAll(VAL_TAGS).forEach((el) => {
        if (el === labelEl || el.contains(labelEl) || labelEl.contains(el)) return;
        const t = el.textContent.trim();
        if (!t || !VALUE_RE.test(t) || !/\d/.test(t)) return;
        const p = el.parentElement;
        if (p && VALUE_RE.test(p.textContent.trim())) return;
        if (!looksLikeMoney(t)) return;
        cands.push(el);
      });
      if (cands.length) {
        for (const el of cands) {
          const pos = labelEl.compareDocumentPosition(el);
          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return el;
        }
      }
    }
    return null;
  }

  function cardConvert(root) {
    const labels = root.querySelectorAll("div,span,p,label,th,td");
    for (const el of labels) {
      const txt = directText(el);
      if (!txt || txt.length > 42) continue;
      if (!isCurrencyLabel(txt)) continue;
      const valEl = findValueForLabel(el);
      if (valEl) convertValueEl(valEl);
    }
  }

  function fullScan(root) {
    walkAndConvert(root);
    elementConvert(root);
    cardConvert(root);
  }

  // ===== 观察器：修改期间断开，避免自己的改动又触发扫描（防叠加放大） =====
  let observer = null;
  let scheduled = false;
  let lastRun = 0;

  function applyPass() {
    if (!ENABLED || !document.body) return;
    if (observer) observer.disconnect();
    try { fullScan(document.body); }
    finally {
      lastRun = Date.now();
      if (ENABLED && document.body && observer) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const wait = Math.max(0, 300 - (Date.now() - lastRun));
    setTimeout(() => { scheduled = false; requestAnimationFrame(applyPass); }, wait);
  }

  function start() {
    if (!document.body) { setTimeout(start, 200); return; }
    observer = new MutationObserver(() => { if (ENABLED) schedule(); });
    applyPass();
  }

  chrome.storage.local.get(["vndCny", "enabled"], (st) => {
    if (typeof st.enabled === "boolean") ENABLED = st.enabled;
    if (st.vndCny && st.vndCny.rate) RATE = st.vndCny.rate;
    chrome.runtime.sendMessage({ type: "GET_RATE" }, (payload) => {
      if (payload && payload.rate) RATE = payload.rate;
      if (ENABLED) start();
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.vndCny && changes.vndCny.newValue) {
      RATE = changes.vndCny.newValue.rate;
      if (ENABLED) applyPass();
    }
    if (changes.enabled) {
      ENABLED = changes.enabled.newValue;
      if (ENABLED) start(); else location.reload();
    }
  });
})();
