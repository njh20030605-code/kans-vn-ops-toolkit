import fs from 'node:fs';
import path from 'node:path';
import { ROOT, vnDateKey } from './util.js';

// 数据目录默认在项目下;自检/测试可用 KANS_DATA_DIR 指到临时目录,
// 免得把假数据写进真实的命中历史(会影响 🆕 新素材判定)。
function dataDir() {
  return process.env.KANS_DATA_DIR ? path.resolve(process.env.KANS_DATA_DIR) : path.join(ROOT, 'data');
}
function historyFile() {
  return path.join(dataDir(), 'history.json');
}

function ensureDir() {
  const d = dataDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readHistory() {
  ensureDir();
  if (!fs.existsSync(historyFile())) return [];
  try {
    return JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
  } catch {
    return [];
  }
}

function writeHistory(rows) {
  ensureDir();
  fs.writeFileSync(historyFile(), JSON.stringify(rows, null, 2));
}

/**
 * 今天此前所有「当天」口径命中过的素材ID集合,用于 🆕 判定。
 * 字段:date, ts, caliber, campaign, acct, workId, costCNY, roi
 */
export function getTodayPrevIds() {
  const today = vnDateKey();
  const rows = readHistory();
  const ids = new Set();
  for (const r of rows) {
    if (r.date === today && r.caliber === '当天' && r.workId) ids.add(r.workId);
  }
  return ids;
}

/** 今天是否已有任何历史记录(用于首轮不打 🆕)。 */
export function hasTodayHistory() {
  const today = vnDateKey();
  return readHistory().some((r) => r.date === today);
}

/** 追加本轮「当天」口径命中到历史库。 */
export function appendTodayHits(hits) {
  const today = vnDateKey();
  const ts = new Date().toISOString();
  const rows = readHistory();
  for (const h of hits) {
    if (h.caliber !== '当天') continue;
    rows.push({
      date: today,
      ts,
      caliber: h.caliber,
      campaign: h.campaign,
      acct: h.acct,
      workId: h.workId,
      costCNY: h.costCNY,
      roi: h.roi,
    });
  }
  writeHistory(rows);
}

/**
 * 查一批素材的历史预警情况(跨天,不只今天)。
 * ⚠️ 必须在 appendTodayHits **之前**调用,否则今天刚写进去的会把"首次"算掉。
 * 返回 Map(workId → { firstDate, days, count })。没查到的 key 不会出现在 Map 里。
 */
export function getHistoryStats(workIds) {
  const want = new Set((workIds || []).filter(Boolean));
  const out = new Map();
  if (!want.size) return out;
  for (const r of readHistory()) {
    if (!r.workId || !want.has(r.workId)) continue;
    const e = out.get(r.workId) || { firstDate: r.date, days: new Set(), count: 0 };
    if (r.date < e.firstDate) e.firstDate = r.date;
    e.days.add(r.date);
    e.count++;
    out.set(r.workId, e);
  }
  return out;
}

/** 记录一轮运行的元信息(即使无命中也留痕,便于排查)。 */
export function appendRunMeta(meta) {
  ensureDir();
  const f = path.join(dataDir(), 'runs.jsonl');
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...meta }) + '\n');
}

// ---------------- 日报去重 ----------------
// 记住今天的日报推过没有,免得进程在那个整点重启一次就重复推。

function stateFile() {
  return path.join(dataDir(), 'state.json');
}

function readState() {
  ensureDir();
  if (!fs.existsSync(stateFile())) return {};
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function getLastSummaryDate() {
  return readState().lastSummaryDate || null;
}

export function setLastSummaryDate(dateKey) {
  ensureDir();
  const st = readState();
  st.lastSummaryDate = dateKey;
  fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2));
}
