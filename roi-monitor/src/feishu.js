import { info, warn } from './util.js';

/**
 * 飞书对接(自建应用「My Claude」)。
 *
 * 这台 Windows 机器直接调飞书开放 API,不经过任何中转 —— 联网就行。
 * 做两件事:
 *   1. 把每轮命中写进多维表格底表(留痕、可筛可透视、给日报/周报当数据源)
 *   2. 往指定群发消息(红色预警即时推 + 每天一份总结)
 *
 * 用的是 Node 自带 fetch,不引入任何新依赖。
 */

const BASE = 'https://open.feishu.cn';

let cachedToken = null; // { token, expireAt }

function cfgOf(config) {
  return config.feishu || {};
}

export function feishuEnabled(config) {
  const f = cfgOf(config);
  return !!(f.enabled && f.appId && f.appSecret && !/\$\{/.test(f.appId));
}

/** 取 tenant_access_token,带缓存(飞书给 2 小时,这里提前 5 分钟换)。 */
async function token(config) {
  const f = cfgOf(config);
  if (cachedToken && Date.now() < cachedToken.expireAt) return cachedToken.token;
  const res = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: f.appId, app_secret: f.appSecret }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`取飞书 token 失败:${j.code} ${j.msg}`);
  cachedToken = { token: j.tenant_access_token, expireAt: Date.now() + (j.expire - 300) * 1000 };
  return cachedToken.token;
}

async function api(config, method, path, body) {
  const t = await token(config);
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status} 返回不是 JSON` }));
  if (j.code !== 0) throw new Error(`${path} → ${j.code} ${j.msg}`);
  return j.data;
}

// ---------------- 多维表格 ----------------

/**
 * 把命中行写进底表。rows 来自 output.js 的 markAndSort 结果。
 * 失败不抛异常 —— 写表挂了不能影响扫描本身。
 */
export async function pushRowsToBitable(config, DT, rows) {
  const f = cfgOf(config);
  if (!feishuEnabled(config) || !f.bitable?.appToken || !f.bitable?.tableId) return { ok: false, skipped: true };
  if (!rows.length) return { ok: true, count: 0 };

  const R = config.notify?.redAlert || { costThresholdCNY: 200, roiThreshold: 1 };
  const now = Date.now();
  const dateKey = vnDateOf(config);
  const records = rows.map((r) => ({
    fields: {
      素材ID: String(r.workId || '商品卡片(无作品ID)'),
      扫描时间: now,
      日期: dateKey,
      口径: r.caliber,
      广告计划: r.campaign,
      达人账号: String(r.acct || ''),
      '成本¥': Number(r.costCNY) || 0,
      ROI: Number(r.roi) || 0,
      标记: r.mark || '',
      红色预警: r.costCNY > R.costThresholdCNY && r.roi < R.roiThreshold,
    },
  }));

  try {
    // 一次最多 500 条,这里按 200 分批稳妥些
    let done = 0;
    for (let i = 0; i < records.length; i += 200) {
      const batch = records.slice(i, i + 200);
      await api(
        config,
        'POST',
        `/open-apis/bitable/v1/apps/${f.bitable.appToken}/tables/${f.bitable.tableId}/records/batch_create`,
        { records: batch }
      );
      done += batch.length;
    }
    info(`已写入飞书底表 ${done} 条(${DT})`);
    return { ok: true, count: done };
  } catch (e) {
    warn('写飞书底表失败(不影响本地出表):', e.message);
    return { ok: false, error: e.message };
  }
}

/** 通用:按「日期」字段读某张表某天的记录。失败返回 []。 */
async function readTableByDate(config, tableId, dateKey) {
  const f = cfgOf(config);
  if (!feishuEnabled(config) || !f.bitable?.appToken || !tableId) return [];
  const out = [];
  let pageToken = null;
  try {
    do {
      const q = new URLSearchParams({ page_size: '500' });
      if (pageToken) q.set('page_token', pageToken);
      const d = await api(
        config,
        'POST',
        `/open-apis/bitable/v1/apps/${f.bitable.appToken}/tables/${tableId}/records/search?${q}`,
        { filter: { conjunction: 'and', conditions: [{ field_name: '日期', operator: 'is', value: [dateKey] }] } }
      );
      for (const it of d.items || []) out.push(it.fields || {});
      pageToken = d.has_more ? d.page_token : null;
    } while (pageToken);
  } catch (e) {
    warn('读飞书表失败:', e.message);
  }
  return out;
}

/**
 * 写「计划日汇总」。同一天同一计划只留一条 —— 先删旧的再写,避免重复跑出重复行。
 * totals: [{ campaign, dateKey, costCNY, gmvCNY, roi, rows, source }]
 */
export async function upsertDailyTotals(config, totals) {
  const f = cfgOf(config);
  const tid = f.bitable?.dailyTableId;
  if (!feishuEnabled(config) || !f.bitable?.appToken || !tid) return { ok: false, skipped: true };
  if (!totals.length) return { ok: true, count: 0 };
  const dateKey = totals[0].dateKey;
  try {
    // 先清掉这一天的旧记录(重跑覆盖)
    const old = await readRecordsRaw(config, tid, dateKey);
    if (old.length) {
      await api(config, 'POST', `/open-apis/bitable/v1/apps/${f.bitable.appToken}/tables/${tid}/records/batch_delete`, {
        records: old.map((r) => r.record_id),
      });
    }
    const now = Date.now();
    await api(config, 'POST', `/open-apis/bitable/v1/apps/${f.bitable.appToken}/tables/${tid}/records/batch_create`, {
      records: totals.map((t) => ({
        fields: {
          键: `${t.dateKey}|${t.campaign}`,
          日期: t.dateKey,
          广告计划: t.campaign,
          '成本¥': Math.round(t.costCNY * 100) / 100,
          'GMV¥': Math.round(t.gmvCNY * 100) / 100,
          ROI: t.roi,
          素材数: t.rows ?? 0,
          取数方式: t.source === 'footer' ? '表格合计行' : '素材逐行累加',
          采集时间: now,
        },
      })),
    });
    info(`已写入飞书「计划日汇总」${totals.length} 条(${dateKey})`);
    return { ok: true, count: totals.length };
  } catch (e) {
    warn('写计划日汇总失败:', e.message);
    return { ok: false, error: e.message };
  }
}

async function readRecordsRaw(config, tableId, dateKey) {
  const f = cfgOf(config);
  try {
    const d = await api(
      config,
      'POST',
      `/open-apis/bitable/v1/apps/${f.bitable.appToken}/tables/${tableId}/records/search?page_size=500`,
      { filter: { conjunction: 'and', conditions: [{ field_name: '日期', operator: 'is', value: [dateKey] }] } }
    );
    return d.items || [];
  } catch {
    return [];
  }
}

/** 读「计划日汇总」某天的数据。 */
export async function readDailyTotals(config, dateKey) {
  return await readTableByDate(config, cfgOf(config).bitable?.dailyTableId, dateKey);
}

/** 读回底表里某天的记录,用来出日报。失败返回 []。 */
export async function readBitableByDate(config, dateKey) {
  return await readTableByDate(config, cfgOf(config).bitable?.tableId, dateKey);
}

// ---------------- 群消息 ----------------

/** 往指定群发纯文本。失败不抛。 */
export async function sendToChat(config, text) {
  const f = cfgOf(config);
  if (!feishuEnabled(config) || !f.chatId) return { ok: false, skipped: true };
  try {
    await api(config, 'POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: f.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: text.slice(0, 9000) }),
    });
    return { ok: true };
  } catch (e) {
    warn('发飞书群消息失败:', e.message);
    return { ok: false, error: e.message };
  }
}

/** 往指定群发卡片(标题带颜色,正文 markdown)。失败自动退回纯文本。 */
export async function sendCard(config, { title, template = 'blue', lines }) {
  const f = cfgOf(config);
  if (!feishuEnabled(config) || !f.chatId) return { ok: false, skipped: true };
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
  };
  try {
    await api(config, 'POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      receive_id: f.chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    return { ok: true };
  } catch (e) {
    warn('发飞书卡片失败,改发纯文本:', e.message);
    return await sendToChat(config, `${title}\n${lines.join('\n').replace(/\*\*/g, '')}`);
  }
}

// ---------------- 工具 ----------------

function vnDateOf(config) {
  const off = (config.timezoneOffsetHours ?? 7) * 3600e3;
  const d = new Date(Date.now() + off);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export { vnDateOf };
