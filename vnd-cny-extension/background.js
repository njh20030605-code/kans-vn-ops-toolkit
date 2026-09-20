// background.js — 拉取实时汇率并缓存
// 作者：Jasper Yang · 仅供内部使用，勿外传 / 勿用于盈利
// 汇率来源：open.er-api.com（免费、无需 key、支持 CORS）

const API_URL = "https://open.er-api.com/v6/latest/VND";
const FALLBACK_RATE = 0.000257;
const REFRESH_MS = 6 * 60 * 60 * 1000;

async function fetchRate() {
  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    const data = await res.json();
    const rate = data && data.rates && data.rates.CNY;
    if (typeof rate === "number" && rate > 0) {
      const payload = { rate, updatedAt: Date.now(), source: "open.er-api.com", ok: true };
      await chrome.storage.local.set({ vndCny: payload });
      return payload;
    }
    throw new Error("汇率字段缺失");
  } catch (e) {
    const existing = (await chrome.storage.local.get("vndCny")).vndCny;
    const payload = existing && existing.rate
      ? { ...existing, ok: false, error: String(e) }
      : { rate: FALLBACK_RATE, updatedAt: Date.now(), source: "fallback", ok: false, error: String(e) };
    await chrome.storage.local.set({ vndCny: payload });
    return payload;
  }
}

async function getRate(forceRefresh) {
  const { vndCny } = await chrome.storage.local.get("vndCny");
  const stale = !vndCny || (Date.now() - vndCny.updatedAt) > REFRESH_MS;
  if (forceRefresh || stale) return await fetchRate();
  return vndCny;
}

chrome.runtime.onInstalled.addListener(() => fetchRate());
chrome.runtime.onStartup.addListener(() => fetchRate());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_RATE") {
    getRate(msg.force).then(sendResponse);
    return true;
  }
});
