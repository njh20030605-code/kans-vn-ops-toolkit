// popup.js — 作者：Jasper Yang · 仅供内部使用，勿外传 / 勿盈利
const $ = (id) => document.getElementById(id);

function render(p) {
  if (!p || !p.rate) { $("rate").textContent = "暂无汇率"; return; }
  const vndPerCny = Math.round(1 / p.rate);
  $("rate").innerHTML = `1 元 ≈ ${vndPerCny.toLocaleString("zh-CN")} <span class="u">VND</span>`;
  const t = new Date(p.updatedAt);
  const pad = (x) => String(x).padStart(2, "0");
  $("sub").textContent = `更新：${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())} · 来源 ${p.source}`;
  $("warn").style.display = p.ok === false ? "block" : "none";
  if (p.ok === false) $("warn").textContent = "⚠ 联网取汇率失败，当前用缓存/兜底汇率。";
}

function load(force) {
  chrome.runtime.sendMessage({ type: "GET_RATE", force: !!force }, render);
}

chrome.storage.local.get("enabled", (st) => { $("toggle").checked = st.enabled !== false; });
$("toggle").addEventListener("change", (e) => chrome.storage.local.set({ enabled: e.target.checked }));
$("refresh").addEventListener("click", () => { $("rate").textContent = "刷新中…"; load(true); });
$("close").addEventListener("click", () => window.close());
load(false);
