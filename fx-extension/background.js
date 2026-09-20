// background.js — 拉取实时汇率并缓存。
// 汇率来源：open.er-api.com（免费、无需 key、支持 CORS）。以目标货币为基准一次取全所有市场的汇率：
//   GET /v6/latest/CNY → rates.VND = 1 CNY 值多少 VND，rates.THB … 依此类推。
importScripts("markets.js");
const { MARKETS, DEFAULT_TARGET } = self.FX_MARKETS;

const REFRESH_MS = 6 * 60 * 60 * 1000;
// 兜底汇率（1 目标货币 = 多少本地货币），联网失败且无缓存时使用
const FALLBACK = {
  CNY: { VND: 3891, THB: 4.5, IDR: 2250, MYR: 0.6, PHP: 8.0, SGD: 0.18 },
  USD: { VND: 26500, THB: 32, IDR: 16400, MYR: 4.3, PHP: 58, SGD: 1.3 },
};

async function getTarget() {
  const { target } = await chrome.storage.local.get("target");
  return target || DEFAULT_TARGET;
}

async function fetchRates(target) {
  const wanted = Object.values(MARKETS).map((m) => m.currency);
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${target}`, { cache: "no-store" });
    const data = await res.json();
    const rates = {};
    for (const c of wanted) if (typeof data?.rates?.[c] === "number" && data.rates[c] > 0) rates[c] = data.rates[c];
    if (!Object.keys(rates).length) throw new Error("汇率字段缺失");
    const payload = { base: target, rates, updatedAt: Date.now(), source: "open.er-api.com", ok: true };
    await chrome.storage.local.set({ fx: payload });
    return payload;
  } catch (e) {
    const { fx } = await chrome.storage.local.get("fx");
    const payload = fx && fx.base === target && fx.rates
      ? { ...fx, ok: false, error: String(e) }
      : { base: target, rates: FALLBACK[target] || FALLBACK.CNY, updatedAt: Date.now(), source: "fallback", ok: false, error: String(e) };
    await chrome.storage.local.set({ fx: payload });
    return payload;
  }
}

async function getRates(force) {
  const target = await getTarget();
  const { fx } = await chrome.storage.local.get("fx");
  const stale = !fx || fx.base !== target || (Date.now() - fx.updatedAt) > REFRESH_MS;
  return force || stale ? fetchRates(target) : fx;
}

chrome.runtime.onInstalled.addListener(() => getRates(true));
chrome.runtime.onStartup.addListener(() => getRates(true));
chrome.storage.onChanged.addListener((ch) => { if (ch.target) getRates(true); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_RATE") {
    getRates(!!msg.force).then(sendResponse);
    return true;
  }
});
