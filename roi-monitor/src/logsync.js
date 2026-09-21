import os from 'node:os';
import { onLog, info, warn, VERSION } from './util.js';
import { feishuEnabled, pushLogRows } from './feishu.js';

/**
 * 把运行日志回传飞书多维表格「运行日志」表。
 *
 * 为什么要有这个:程序跑在那台 Windows 上,人不在旁边。出问题时只能看它的终端 ——
 * 现在同一份日志也进多维表格,联网就能复盘"几点几分卡在哪一步"。
 *
 * 三条硬规矩:
 *  1. 绝不影响主流程 —— 所有失败都吞掉,顶多在本地日志里记一句
 *  2. 不刷屏 —— 只送 WARN/ERROR,加上几条关键的 INFO(开工/收工/读到几条/推送结果)
 *  3. 不丢 —— 发不出去就留在队列里下次一起发(队列最多 500 条,满了丢最老的)
 */

// 值得联网看的 INFO(其余 INFO 只写本地日志,不占表)
const KEY_INFO =
  /=====|已推送|计划读到|命中 \d+ 条|已写出 xlsx|常驻启动|歇 \d+ 秒再要一次|翻了 \d+ 页/;

const MAX_QUEUE = 500;
const BATCH = 50;

let queue = [];
let started = false;
let timer = null;
let sending = false;
let dropped = 0;

function stamp(config) {
  const off = (config?.market?.tzOffsetHours ?? config?.timezoneOffsetHours ?? 7) * 3600e3;
  return new Date(Date.now() + off).toISOString().slice(0, 19).replace('T', ' ');
}

export function queueSize() {
  return queue.length;
}

/** 单纯判断某行日志要不要上传(抽出来是为了自检能直接测)。 */
export function shouldUpload(level, text) {
  if (level === 'WARN' || level === 'ERROR') return true;
  return level === 'INFO' && KEY_INFO.test(text || '');
}

/** 开始回传。everyMs 默认 60 秒攒一批。重复调用无副作用。 */
export function startLogSync(config, everyMs = 60000) {
  if (started) return { ok: true, already: true };
  if (!feishuEnabled(config)) return { ok: false, reason: '飞书没配好,日志只写本地' };
  started = true;
  const host = os.hostname();

  onLog(({ level, text }) => {
    if (!shouldUpload(level, text)) return;
    if (queue.length >= MAX_QUEUE) {
      queue.shift();
      dropped++;
    }
    queue.push({ at: stamp(config), level, text, host, version: VERSION });
  });

  timer = setInterval(() => {
    flush(config).catch(() => {});
  }, everyMs);
  timer.unref?.();
  info('运行日志已接通飞书「运行日志」表(每分钟回传一次)。');
  return { ok: true };
}

/** 把队列里的发出去。失败就原样放回队首,下次再试。 */
export async function flush(config) {
  if (sending || !queue.length) return { ok: true, count: 0 };
  sending = true;
  const batch = queue.slice(0, BATCH);
  try {
    if (dropped) {
      batch.unshift({
        at: stamp(config),
        level: 'WARN',
        text: `日志队列满,丢了 ${dropped} 条没来得及上传的`,
        host: os.hostname(),
        version: VERSION,
      });
      dropped = 0;
    }
    await pushLogRows(config, batch);
    queue = queue.slice(BATCH);
    return { ok: true, count: batch.length };
  } catch (e) {
    // 发不出去(断网/token 过期)就留着,下一轮再来。这里故意不用 warn ——
    // 否则"回传失败"自己又生成一条日志,越堆越多。
    return { ok: false, error: e.message };
  } finally {
    sending = false;
  }
}

/** 退出前尽量把剩下的发完(最多试 3 批,别把关机拖住)。 */
export async function flushAll(config) {
  for (let i = 0; i < 3 && queue.length; i++) {
    const r = await flush(config);
    if (!r.ok) break;
  }
}

/** 只在自检里用:把状态清干净。 */
export function _resetForTest() {
  queue = [];
  started = false;
  dropped = 0;
  if (timer) clearInterval(timer);
  timer = null;
}
