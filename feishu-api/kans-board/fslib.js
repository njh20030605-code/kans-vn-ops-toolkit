// 飞书最小客户端（复用 ~/.feishu/credentials.json）
const fs = require('fs');
const os = require('os');
const path = require('path');
const BASE = 'https://open.feishu.cn';

function creds() {
  let id = process.env.FEISHU_APP_ID, secret = process.env.FEISHU_APP_SECRET;
  if (!id || !secret) {
    const f = path.join(os.homedir(), '.feishu', 'credentials.json');
    if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); id = id || j.app_id; secret = secret || j.app_secret; }
  }
  if (!id || !secret) throw new Error('缺少飞书凭证 ~/.feishu/credentials.json');
  return { id, secret };
}

let _t = null;
async function token() {
  if (_t) return _t;
  const { id, secret } = creds();
  const r = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`取 token 失败 code=${j.code} ${j.msg}`);
  _t = j.tenant_access_token;
  return _t;
}

async function api(method, urlPath, body) {
  const t = await token();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(BASE + urlPath, {
      method,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`非JSON响应: ${text.slice(0, 300)}`); }
    if (j.code === 0) return j.data;
    // 频控/瞬时错误重试
    if ([1254290, 1254291, 99991400].includes(j.code) && attempt < 3) {
      await new Promise(s => setTimeout(s, 1200 * attempt));
      continue;
    }
    throw new Error(`API ${method} ${urlPath} 失败 code=${j.code} msg=${j.msg}`);
  }
}

// 拉全表（自动翻页）
async function listAll(appToken, tableId, extra = '') {
  const out = [];
  let pageToken = '';
  do {
    const qs = `page_size=500${pageToken ? `&page_token=${pageToken}` : ''}${extra}`;
    const d = await api('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${qs}`);
    for (const it of (d.items || [])) out.push({ record_id: it.record_id, f: it.fields });
    pageToken = d.has_more ? d.page_token : '';
  } while (pageToken);
  return out;
}

const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

async function batchCreate(appToken, tableId, records) {
  for (const g of chunk(records, 400)) {
    await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, { records: g.map(f => ({ fields: f })) });
  }
}
async function batchDelete(appToken, tableId, ids) {
  for (const g of chunk(ids, 400)) {
    await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, { records: g });
  }
}

// 取纯文本（多维表格字段值可能是 string / 数字 / [{text}]）
function txt(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : '';
  if (Array.isArray(v)) return v.map(x => (x && (x.text ?? x.name)) ?? String(x)).join(',');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}
const num = v => { const n = parseFloat(txt(v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

module.exports = { api, listAll, batchCreate, batchDelete, txt, num, chunk };
