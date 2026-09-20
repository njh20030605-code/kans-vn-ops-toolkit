// markets.js — 市场表：货币、符号、写法习惯、后台域名。换国家只需在这里加一行。
// 同时被 content.js / background.js / popup.js 使用；也可在 Node 里 require（跑测试）。
(function (root) {
  const MARKETS = {
    VN: {
      name: "越南", currency: "VND",
      symbols: ["₫", "đ", "Đ", "VND"],
      // 货币符号位置：TikTok 后缀（62.142.512đ），Shopee 前缀（đ89.684.715）
      symbolPos: { tiktok: "suffix", shopee: "prefix" },
      // 本地缩写：Tr=百万，Tỷ/T=十亿，N/Ng=千；英文 K/M/B 通用（见 fx-core 的 COMMON_MULT）
      mult: { tr: 1e6, "tỷ": 1e9, ty: 1e9, t: 1e9, n: 1e3, ng: 1e3 },
      maxLocal: 1e12,          // 超过视为异常，不换算
      bareMin: 1e6,            // 无符号裸数字 ≥ 此值且卡片标签是钱，才当金额
      tiktok: ["seller-vn.tiktok.com"], shopee: ["shopee.vn"],
    },
    TH: {
      name: "泰国", currency: "THB", symbols: ["฿", "THB"],
      symbolPos: { tiktok: "suffix", shopee: "prefix" },
      mult: {}, maxLocal: 1e10, bareMin: 1e4,
      tiktok: ["seller-th.tiktok.com"], shopee: ["shopee.co.th"],
    },
    ID: {
      name: "印尼", currency: "IDR", symbols: ["Rp", "IDR"],
      symbolPos: { tiktok: "prefix", shopee: "prefix" },
      // rb/ribu=千，jt/juta=百万，miliar=十亿
      mult: { rb: 1e3, ribu: 1e3, jt: 1e6, juta: 1e6, miliar: 1e9 },
      maxLocal: 1e13, bareMin: 1e5,
      tiktok: ["seller-id.tiktok.com"], shopee: ["shopee.co.id"],
    },
    MY: {
      name: "马来西亚", currency: "MYR", symbols: ["RM", "MYR"],
      symbolPos: { tiktok: "prefix", shopee: "prefix" },
      mult: {}, maxLocal: 1e9, bareMin: 1e3,
      tiktok: ["seller-my.tiktok.com"], shopee: ["shopee.com.my"],
    },
    PH: {
      name: "菲律宾", currency: "PHP", symbols: ["₱", "PHP"],
      symbolPos: { tiktok: "prefix", shopee: "prefix" },
      mult: {}, maxLocal: 1e10, bareMin: 1e4,
      tiktok: ["seller-ph.tiktok.com"], shopee: ["shopee.ph"],
    },
    SG: {
      name: "新加坡", currency: "SGD", symbols: ["S$", "SGD"],
      symbolPos: { tiktok: "prefix", shopee: "prefix" },
      mult: {}, maxLocal: 1e9, bareMin: 1e3,
      tiktok: ["seller-sg.tiktok.com"], shopee: ["shopee.sg"],
    },
  };

  // 目标货币：换算成什么显示
  const TARGETS = {
    CNY: { symbol: "¥", name: "人民币", locale: "zh-CN" },
    USD: { symbol: "$", name: "美元", locale: "en-US" },
  };

  /** 按域名识别市场；识别不出返回 null（由用户在弹窗里选）。 */
  function detectMarket(hostname) {
    const h = String(hostname || "").toLowerCase();
    for (const [code, m] of Object.entries(MARKETS)) {
      if (m.tiktok.some((d) => h === d || h.endsWith("." + d))) return code;
      if (m.shopee.some((d) => h === d || h.endsWith("." + d))) return code;
    }
    return null;
  }

  function detectPlatform(hostname) {
    return /(^|\.)shopee\./i.test(String(hostname || "")) ? "shopee" : "tiktok";
  }

  const api = { MARKETS, TARGETS, detectMarket, detectPlatform, DEFAULT_MARKET: "VN", DEFAULT_TARGET: "CNY" };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FX_MARKETS = api;
})(typeof self !== "undefined" ? self : this);
