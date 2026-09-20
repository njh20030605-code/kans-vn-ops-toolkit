// content.js — 在 TikTok / Shopee 卖家后台页面里，把本地货币金额就地替换成目标货币。
// 解析与换算逻辑在 fx-core.js；市场表在 markets.js；本文件只负责找 DOM、监听变化。
(() => {
  const { MARKETS, TARGETS, detectMarket, detectPlatform, DEFAULT_MARKET, DEFAULT_TARGET } = self.FX_MARKETS;
  const { createConverter } = self.FX_CORE;

  let ENABLED = true;
  let conv = null;            // 当前 converter（市场 / 平台 / 汇率 / 目标货币）
  const platform = detectPlatform(location.hostname);
  const autoMarket = detectMarket(location.hostname);

  function buildConverter(st) {
    const marketCode = autoMarket || st.market || DEFAULT_MARKET;
    const targetCode = st.target || DEFAULT_TARGET;
    const market = MARKETS[marketCode] || MARKETS[DEFAULT_MARKET];
    const target = TARGETS[targetCode] || TARGETS[DEFAULT_TARGET];
    const fx = st.fx || {};
    const rate = fx.base === targetCode && fx.rates && fx.rates[market.currency];
    if (!rate) return null;   // 汇率还没到，先不动页面
    return createConverter({ market, platform, rate, target });
  }

  // ===== 文本节点 =====
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "NOSCRIPT", "SVG"]);
  function shouldSkip(node) {
    let p = node.parentElement;
    while (p) {
      if (SKIP_TAGS.has(p.tagName) || p.isContentEditable) return true;
      p = p.parentElement;
    }
    return false;
  }
  function processNode(node) {
    const val = node.nodeValue;
    if (!val || conv.alreadyConverted(val) || !conv.hasCurrency(val)) return;
    if (shouldSkip(node)) return;
    const next = conv.convertText(val);
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
    /\(\s*(?:₫|đ|VND|฿|THB|Rp|IDR|RM|MYR|₱|PHP|S\$|SGD)\s*\)/i,
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
  function convertValueEl(el) {
    const v = conv.extractAmount(el.textContent);
    if (isNaN(v)) return;
    const out = conv.fmt(v);
    if (el.textContent !== out) el.textContent = out;
  }

  // ① 元素级：整块就是“数字+货币符号”（含拆 span 的情况）
  function elementConvert(root) {
    for (const el of root.querySelectorAll(VAL_TAGS)) {
      const t = el.textContent.trim();
      if (!t || !conv.isCurAmount(t)) continue;
      const p = el.parentElement;
      if (p && conv.isCurAmount(p.textContent.trim())) continue;
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
        if (!t || !conv.isValueLike(t)) return;
        const p = el.parentElement;
        if (p && conv.isValueLike(p.textContent.trim())) return;
        if (!conv.looksLikeMoney(t)) return;
        cands.push(el);
      });
      for (const el of cands) {
        if (labelEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return el;
      }
    }
    return null;
  }
  function cardConvert(root) {
    for (const el of root.querySelectorAll("div,span,p,label,th,td")) {
      const txt = directText(el);
      if (!txt || txt.length > 42 || !isCurrencyLabel(txt)) continue;
      const valEl = findValueForLabel(el);
      if (valEl) convertValueEl(valEl);
    }
  }

  function fullScan(root) {
    walkAndConvert(root);
    elementConvert(root);
    cardConvert(root);
  }

  // ===== 观察器：修改期间断开，避免自己的改动又触发扫描 =====
  let observer = null, scheduled = false, lastRun = 0;
  function applyPass() {
    if (!ENABLED || !conv || !document.body) return;
    if (observer) observer.disconnect();
    try { fullScan(document.body); }
    finally {
      lastRun = Date.now();
      if (ENABLED && document.body && observer) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
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
    if (!observer) observer = new MutationObserver(() => { if (ENABLED) schedule(); });
    applyPass();
  }

  const KEYS = ["fx", "enabled", "market", "target"];
  chrome.storage.local.get(KEYS, (st) => {
    if (typeof st.enabled === "boolean") ENABLED = st.enabled;
    conv = buildConverter(st);
    chrome.runtime.sendMessage({ type: "GET_RATE" }, (fx) => {
      if (fx) conv = buildConverter({ ...st, fx });
      if (ENABLED && conv) start();
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      ENABLED = changes.enabled.newValue;
      if (!ENABLED) { location.reload(); return; }
    }
    if (changes.fx || changes.market || changes.target || changes.enabled) {
      chrome.storage.local.get(KEYS, (st) => {
        conv = buildConverter(st);
        if (ENABLED && conv) start();
      });
    }
  });
})();
