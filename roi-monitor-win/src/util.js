import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 代码版本。每次发更新包都改这里。
 * 用途:Node 进程启动时把代码读进内存,之后换 src 里的文件对运行中的进程无效 ——
 * 光看文件日期不知道"跑着的到底是哪版",所以启动时和 version 命令都会打出来。
 */
export const VERSION = '2026-09-21i';

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
export const VERSION_NOTE = '修直播tab丢数根因(超时被谎报成"已到目标页");取不到就歇一会儿再要(每tab5分钟耐心);日志报错回传飞书「运行日志」表';

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

// ---------- 市场(国家)参数 ----------
/**
 * 默认市场 = 越南(KANS 现行值)。config.json 的 market 块可整体换成别国,见 markets.example.json。
 *   code          两位国家码,决定卖家后台域名 seller-<code>.tiktok.com 和 URL 里的 shop_region
 *   name          中文名,用在「XX时间」「XX投放日报」这类文案里
 *   currency      币种代码
 *   symbols       页面上可能出现的货币符号/缩写,用来判断单元格/表头里的金额是不是本币
 *   tzOffsetHours 该国相对 UTC 的小时偏移(泰/越/印尼=7,马/菲/新=8)
 *   rateToCny     1 人民币 = 多少本币(越南盾≈3891)
 * 可选:
 *   sellerHost           后台域名,不填按 code 推
 *   assumeLocalCurrency  单元格/表头都没货币符号时是否直接当本币。不填时:汇率<100 的小面额币种(泰铢/马币等)当本币,
 *                        大面额币种(越南盾/印尼盾)沿用老规则「数值 >5000 才当本币」
 */
export const DEFAULT_MARKET = Object.freeze({
  code: 'VN',
  name: '越南',
  currency: 'VND',
  symbols: ['₫', 'đ', 'VND'],
  tzOffsetHours: 7,
  rateToCny: 3891,
});

let deprecationHinted = false;

/**
 * 从一份配置对象里取出规范化的 market 块。
 *  · 有 market → 缺的字段用默认值补齐
 *  · 没 market 但有老键 vndToCnyRate / timezoneOffsetHours → 按越南推出来(向后兼容)
 *  · 都没有 → 默认越南
 */
export function normalizeMarket(cfg, { hint = false } = {}) {
  const c = cfg || {};
  const m = c.market && typeof c.market === 'object' ? c.market : null;
  const legacy = !m && (c.vndToCnyRate != null || c.timezoneOffsetHours != null);
  const out = {
    ...DEFAULT_MARKET,
    ...(m || {}),
    ...(legacy
      ? {
          rateToCny: c.vndToCnyRate ?? DEFAULT_MARKET.rateToCny,
          tzOffsetHours: c.timezoneOffsetHours ?? DEFAULT_MARKET.tzOffsetHours,
        }
      : {}),
  };
  out.code = String(out.code || DEFAULT_MARKET.code).toUpperCase();
  out.symbols = Array.isArray(out.symbols) && out.symbols.length ? out.symbols.map(String) : [out.currency];
  out.tzOffsetHours = Number(out.tzOffsetHours);
  out.rateToCny = Number(out.rateToCny);
  if (!Number.isFinite(out.tzOffsetHours)) out.tzOffsetHours = DEFAULT_MARKET.tzOffsetHours;
  if (!Number.isFinite(out.rateToCny) || out.rateToCny <= 0) out.rateToCny = DEFAULT_MARKET.rateToCny;
  out.sellerHost = out.sellerHost || `https://seller-${out.code.toLowerCase()}.tiktok.com`;
  if (out.assumeLocalCurrency == null) out.assumeLocalCurrency = out.rateToCny < 100;
  if (legacy && hint && !deprecationHinted) {
    deprecationHinted = true;
    console.log(
      `[提示] config.json 里的 vndToCnyRate / timezoneOffsetHours 已改为 market 块(见 markets.example.json),` +
        `本次按越南 VND 汇率 ${out.rateToCny}、UTC+${out.tzOffsetHours} 继续运行。`
    );
  }
  return out;
}

/** 当前市场(进程启动时读 config.json 一次;读不到就是越南)。用法同 BRAND。 */
export const MARKET = (() => {
  try {
    return normalizeMarket(loadJson('config.json'));
  } catch {
    return normalizeMarket(null);
  }
})();

/** 卖家后台域名,例 https://seller-vn.tiktok.com */
export const SELLER_HOST = MARKET.sellerHost;

/** 从一份 config 对象取 market(已经过 loadConfig 的直接返回;老形状/测试用的裸对象也能算出来)。 */
export function marketOf(config) {
  if (config && config.market && config.market.sellerHost) return config.market;
  return normalizeMarket(config);
}

/** 把本地整点换算成北京时间整点(北京 = UTC+8)。 */
export function toBeijingHour(hour, offsetHours = MARKET.tzOffsetHours) {
  return (((Number(hour) + (8 - offsetHours)) % 24) + 24) % 24;
}

export function loadConfig() {
  const raw = loadJson('config.json');
  const cfg = deepExpandEnv(raw);
  cfg.market = normalizeMarket(cfg, { hint: true });
  return cfg;
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

// ---------- 市场当地时间(默认 MARKET.tzOffsetHours;越南 = UTC+7) ----------
// 函数名沿用 vn* 前缀以免大面积改动;语义是「市场当地」,不是特指越南。
export function vnNow(offsetHours = MARKET.tzOffsetHours) {
  return new Date(Date.now() + offsetHours * 3600e3);
}

/** 当地当天 00:00 对应的真实 epoch(毫秒),用于 URL 的 list_start_date。 */
export function vnDayRanges(offsetHours = MARKET.tzOffsetHours) {
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
 * 某一天(相对今天偏移 daysAgo 天)的当地时间区间 + 日期串。
 * daysAgo=1 就是昨天。用于每天早上采集"昨天一整天"的计划合计。
 */
export function vnDayOf(offsetHours = MARKET.tzOffsetHours, daysAgo = 1) {
  const day = 86400e3;
  const off = offsetHours * 3600e3;
  const todayStart = Math.floor((Date.now() + off) / day) * day - off;
  const start = todayStart - daysAgo * day;
  const d = new Date(start + off);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start, end: start + 86399000, key };
}

/** DT 时间串(当地时间):例 "7月23日-13.00"。表标题恒等于此串。 */
export function formatDT(offsetHours = MARKET.tzOffsetHours) {
  const vn = vnNow(offsetHours);
  const M = vn.getUTCMonth() + 1;
  const D = vn.getUTCDate();
  const hh = String(vn.getUTCHours()).padStart(2, '0');
  const mm = String(vn.getUTCMinutes()).padStart(2, '0');
  return `${M}月${D}日-${hh}.${mm}`;
}

/** 把一个当地零点对齐的 epoch 毫秒转成 "YYYY-MM-DD"(用于直播接口的 start_time/end_time)。 */
export function vnDateStr(epochMs, offsetHours = MARKET.tzOffsetHours) {
  const d = new Date(epochMs + offsetHours * 3600e3);
  const y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${M}-${D}`;
}

/** 当地当天日期键,例 "2026-07-23",用于本地历史库按天归组。 */
export function vnDateKey(offsetHours = MARKET.tzOffsetHours) {
  const vn = vnNow(offsetHours);
  const y = vn.getUTCFullYear();
  const M = String(vn.getUTCMonth() + 1).padStart(2, '0');
  const D = String(vn.getUTCDate()).padStart(2, '0');
  return `${y}-${M}-${D}`;
}

export function buildDashboardUrl(campaign, start, end) {
  const base = `${SELLER_HOST}/ads-creation/dashboard`;
  const params = {
    origin: 'SC_ads_tab_button_PC',
    type: campaign.type || 'product', // 商品广告=product;直播=live
    mpa: '1',
    campaign_id: campaign.campaign_id,
    activated_tab_id: '1',
    shop_region: MARKET.code,
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

// 日志旁路:注册进来的函数会收到每一行日志(用来回传飞书)。
// 这里只负责"喊一声",发不发、怎么发都在 logsync.js —— util 不认识飞书,免得循环引用。
const logSinks = [];
export function onLog(fn) {
  if (typeof fn === 'function') logSinks.push(fn);
}

export function log(level, ...args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  for (const fn of logSinks) {
    try {
      fn({ level, text, ts });
    } catch {
      /* 旁路挂了绝不能影响打日志本身 */
    }
  }
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
