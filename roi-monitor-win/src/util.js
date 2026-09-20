import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 代码版本。每次发更新包都改这里。
 * 用途:Node 进程启动时把代码读进内存,之后换 src 里的文件对运行中的进程无效 ——
 * 光看文件日期不知道"跑着的到底是哪版",所以启动时和 version 命令都会打出来。
 */
export const VERSION = '2026-09-16b';

/**
 * src 目录下所有 .js 的"指纹"(大小+修改时间)。
 * 用途:Node 启动时就把代码读进内存了,覆盖文件对运行中的进程无效。
 * 常驻进程每轮比一下指纹,发现代码被换过就主动退出,
 * 由「启动-常驻扫描.bat」的守护循环自动重启 —— 于是覆盖完就自动生效,不用人去关窗口。
 */
export function srcFingerprint() {
  try {
    const dir = path.join(ROOT, 'src');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${Math.round(st.mtimeMs)}`;
      })
      .join('|');
  } catch {
    return ''; // 读不到就当没变,不影响主流程
  }
}
export const VERSION_NOTE = '红警卡片按口径分组(当天/近7天)并标日期范围';

/** 把 "${VAR}" 形式的字符串替换成 process.env.VAR;非字符串或无匹配原样返回。 */
function expandEnv(value) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (!m) return value;
  return process.env[m[1]] ?? '';
}

function deepExpandEnv(obj) {
  if (Array.isArray(obj)) return obj.map(deepExpandEnv);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepExpandEnv(v);
    return out;
  }
  return expandEnv(obj);
}

export function loadJson(relOrAbs) {
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 品牌名，用在通知标题里；config.json 的 brand 字段，默认 KANS。 */
export const BRAND = (() => { try { return loadJson('config.json').brand || 'KANS'; } catch { return 'KANS'; } })();

export function loadConfig() {
  const raw = loadJson('config.json');
  return deepExpandEnv(raw);
}

export function loadCampaigns() {
  // 允许用环境变量指定别的清单文件(测试/演示用)
  const override = process.env.KANS_CAMPAIGNS_FILE;
  return loadJson(override || 'campaigns.json');
}

/** 读取配置原文(不做 ${ENV} 展开),用于就地修改后写回。 */
export function readConfigRaw() {
  return loadJson('config.json');
}

export function writeConfigRaw(obj) {
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(obj, null, 2) + '\n');
}

export function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

// ---------- 越南时间 (UTC+7) ----------
export function vnNow(offsetHours = 7) {
  return new Date(Date.now() + offsetHours * 3600e3);
}

/** 越南当天 00:00 对应的真实 epoch(毫秒),用于 URL 的 list_start_date。 */
export function vnDayRanges(offsetHours = 7) {
  const day = 86400e3;
  const off = offsetHours * 3600e3;
  const todayStart = Math.floor((Date.now() + off) / day) * day - off;
  return {
    todayStart,
    dStart: todayStart,
    dEnd: todayStart + 86399000,
    d7Start: todayStart - 6 * day,
    d7End: todayStart + 86399000,
  };
}

/**
 * 某一天(相对今天偏移 daysAgo 天)的越南时间区间 + 日期串。
 * daysAgo=1 就是昨天。用于每天早上采集"昨天一整天"的计划合计。
 */
export function vnDayOf(offsetHours = 7, daysAgo = 1) {
  const day = 86400e3;
  const off = offsetHours * 3600e3;
  const todayStart = Math.floor((Date.now() + off) / day) * day - off;
  const start = todayStart - daysAgo * day;
  const d = new Date(start + off);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start, end: start + 86399000, key };
}

/** DT 时间串:例 "7月23日-13.00"。表标题恒等于此串。 */
export function formatDT(offsetHours = 7) {
  const vn = vnNow(offsetHours);
  const M = vn.getUTCMonth() + 1;
  const D = vn.getUTCDate();
  const hh = String(vn.getUTCHours()).padStart(2, '0');
  const mm = String(vn.getUTCMinutes()).padStart(2, '0');
  return `${M}月${D}日-${hh}.${mm}`;
}

/** 把一个 VN 零点对齐的 epoch 毫秒转成 "YYYY-MM-DD"(用于直播接口的 start_time/end_time)。 */
export function vnDateStr(epochMs, offsetHours = 7) {
  const d = new Date(epochMs + offsetHours * 3600e3);
  const y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${M}-${D}`;
}

/** 越南当天日期键,例 "2026-07-23",用于本地历史库按天归组。 */
export function vnDateKey(offsetHours = 7) {
  const vn = vnNow(offsetHours);
  const y = vn.getUTCFullYear();
  const M = String(vn.getUTCMonth() + 1).padStart(2, '0');
  const D = String(vn.getUTCDate()).padStart(2, '0');
  return `${y}-${M}-${D}`;
}

export function buildDashboardUrl(campaign, start, end) {
  const base = 'https://seller-vn.tiktok.com/ads-creation/dashboard';
  const params = {
    origin: 'SC_ads_tab_button_PC',
    type: campaign.type || 'product', // 商品广告=product;直播=live
    mpa: '1',
    campaign_id: campaign.campaign_id,
    activated_tab_id: '1',
    shop_region: 'VN',
    list_start_date: String(start),
    list_end_date: String(end),
  };
  if (campaign.product_id) params.product_id = campaign.product_id; // 直播计划可能没有
  const qs = new URLSearchParams(params);
  return `${base}?${qs.toString()}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function jitter(min, max) {
  // 无需密码学随机;用时间做轻微抖动,避免固定节奏被风控识别。
  const span = Math.max(0, max - min);
  const frac = (Date.now() % 1000) / 1000;
  return Math.round(min + span * frac);
}

// ---------- 日志 ----------
const LOG_DIR = path.join(ROOT, 'logs');

export function log(level, ...args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  // 控制台
  (level === 'ERROR' ? console.error : console.log)(line);
  // 落盘(按天)
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const f = path.join(LOG_DIR, `${vnDateKey()}.log`);
    fs.appendFileSync(f, line + '\n');
  } catch {
    /* 日志写盘失败不应中断主流程 */
  }
}

export const info = (...a) => log('INFO', ...a);
export const warn = (...a) => log('WARN', ...a);
export const error = (...a) => log('ERROR', ...a);
