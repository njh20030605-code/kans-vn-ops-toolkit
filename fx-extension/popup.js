// popup.js — 弹窗：选市场、选目标货币、看汇率、开关、刷新
const { MARKETS, TARGETS, detectMarket, DEFAULT_MARKET, DEFAULT_TARGET } = self.FX_MARKETS;
const $ = (id) => document.getElementById(id);

let state = { market: DEFAULT_MARKET, target: DEFAULT_TARGET, autoMarket: null };

function fillSelects() {
  $("market").innerHTML = Object.entries(MARKETS).map(([c, m]) => `<option value="${c}">${m.name} · ${m.currency}</option>`).join("");
  $("target").innerHTML = Object.entries(TARGETS).map(([c, t]) => `<option value="${c}">${t.name} ${t.symbol}</option>`).join("");
}

function render(fx) {
  const code = state.autoMarket || state.market;
  const m = MARKETS[code], t = TARGETS[state.target];
  $("market").value = code;
  $("target").value = state.target;
  $("auto").textContent = state.autoMarket ? `当前页面已识别为 ${m.name}` : "当前页面无法识别市场，按上面选的来";
  $("market").disabled = !!state.autoMarket;
  const rate = fx && fx.base === state.target && fx.rates && fx.rates[m.currency];
  if (!rate) { $("rate").textContent = "暂无汇率"; return; }
  const shown = rate >= 100 ? Math.round(rate).toLocaleString("zh-CN") : rate.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  $("rate").innerHTML = `1 ${t.symbol} ≈ ${shown} <span class="u">${m.currency}</span>`;
  const d = new Date(fx.updatedAt), pad = (x) => String(x).padStart(2, "0");
  $("sub").textContent = `更新：${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · 来源 ${fx.source}`;
  $("warn").style.display = fx.ok === false ? "block" : "none";
  if (fx.ok === false) $("warn").textContent = "⚠ 联网取汇率失败，当前用缓存 / 兜底汇率。";
}

function load(force) {
  chrome.runtime.sendMessage({ type: "GET_RATE", force: !!force }, render);
}

fillSelects();
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  try { state.autoMarket = detectMarket(new URL(tabs[0].url).hostname); } catch (e) { state.autoMarket = null; }
  chrome.storage.local.get(["enabled", "market", "target"], (st) => {
    $("toggle").checked = st.enabled !== false;
    if (st.market && MARKETS[st.market]) state.market = st.market;
    if (st.target && TARGETS[st.target]) state.target = st.target;
    load(false);
  });
});

$("market").addEventListener("change", (e) => { state.market = e.target.value; chrome.storage.local.set({ market: state.market }); load(false); });
$("target").addEventListener("change", (e) => { state.target = e.target.value; $("rate").textContent = "切换中…"; chrome.storage.local.set({ target: state.target }); setTimeout(() => load(true), 200); });
$("toggle").addEventListener("change", (e) => chrome.storage.local.set({ enabled: e.target.checked }));
$("refresh").addEventListener("click", () => { $("rate").textContent = "刷新中…"; load(true); });
$("close").addEventListener("click", () => window.close());
