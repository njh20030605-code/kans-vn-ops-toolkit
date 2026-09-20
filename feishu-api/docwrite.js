/**
 * 飞书文档写入层 —— 解析模型输出里的 ```feishu-action 块并执行。
 *
 * 支持的动作（**只新建和追加/写区域，不删除、不整篇覆盖**）：
 *   create_sheet  新建电子表格   {title, sheets:[{name, rows:[[...],[...]]}]}
 *   create_doc    新建文档       {title, text}
 *   append_doc    追加到已有文档 {url|token, text}
 *   write_sheet   写已有表格区域 {url|token, sheet, start?, rows:[[...]]}
 */

const SETTINGS = require('./settings');
const DEFAULT_FOLDER = SETTINGS.output_folder;   // 新建文档/表格默认放这个云盘文件夹
const MAX_ROWS = 1000;
const MAX_COLS = 60;

const ACTION_RE = /```feishu-action\s*\n([\s\S]*?)\n?```/g;

function colName(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** 从 url 或裸 token 里抠出 token；wiki 链接需要先解析 */
async function resolveToken(api, ref) {
  if (!ref) return null;
  const m = String(ref).match(/\/(wiki|docx|docs|sheets|base)\/([A-Za-z0-9]+)/);
  if (!m) return { type: null, token: String(ref).trim() };
  let [, type, token] = m;
  if (type === 'wiki') {
    const r = await api('GET', `/open-apis/wiki/v2/spaces/get_node?token=${token}&obj_type=wiki`);
    if (r.code !== 0) throw new Error(`wiki 解析失败：${r.msg}`);
    const n = r.data.node;
    return { type: n.obj_type === 'sheet' ? 'sheets' : n.obj_type === 'bitable' ? 'base' : n.obj_type, token: n.obj_token };
  }
  return { type, token };
}

function clampRows(rows) {
  if (!Array.isArray(rows)) throw new Error('rows 必须是二维数组');
  return rows.slice(0, MAX_ROWS).map((r) => (Array.isArray(r) ? r : [r]).slice(0, MAX_COLS)
    .map((c) => (c === null || c === undefined ? '' : String(c))));
}

async function createSheet(api, a) {
  const title = a.title || '未命名表格';
  const c = await api('POST', '/open-apis/sheets/v3/spreadsheets',
    { title, folder_token: a.folder_token || DEFAULT_FOLDER });
  if (c.code !== 0) throw new Error(`建表失败：${c.msg}`);
  const token = c.data.spreadsheet.spreadsheet_token;
  const url = c.data.spreadsheet.url || SETTINGS.url('sheets', token);

  const q = await api('GET', `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`);
  let firstId = q.data?.sheets?.[0]?.sheet_id;

  const list = a.sheets && a.sheets.length ? a.sheets : [{ name: title, rows: a.rows || [] }];
  const written = [];
  for (let i = 0; i < list.length; i++) {
    const sp = list[i];
    let sheetId = firstId;
    if (i > 0) {
      const add = await api('POST', `/open-apis/sheets/v2/spreadsheets/${token}/sheets_batch_update`,
        { requests: [{ addSheet: { properties: { title: sp.name || `Sheet${i + 1}` } } }] });
      sheetId = add.data?.replies?.[0]?.addSheet?.properties?.sheetId;
    } else if (sp.name) {
      await api('POST', `/open-apis/sheets/v2/spreadsheets/${token}/sheets_batch_update`,
        { requests: [{ updateSheet: { properties: { sheetId: firstId, title: sp.name } } }] });
    }
    const rows = clampRows(sp.rows || []);
    if (rows.length) {
      const cols = Math.max(...rows.map((r) => r.length));
      const range = `${sheetId}!A1:${colName(cols)}${rows.length}`;
      const w = await api('PUT', `/open-apis/sheets/v2/spreadsheets/${token}/values`,
        { valueRange: { range, values: rows } });
      if (w.code !== 0) throw new Error(`写入 ${sp.name} 失败：${w.msg}`);
    }
    written.push(`${sp.name || 'Sheet1'}(${rows.length}行)`);
  }
  return { ok: true, what: `新建电子表格《${title}》 ${written.join('、')}`, url };
}

async function createDoc(api, a) {
  const title = a.title || '未命名文档';
  const c = await api('POST', '/open-apis/docx/v1/documents',
    { title, folder_token: a.folder_token || DEFAULT_FOLDER });
  if (c.code !== 0) throw new Error(`建文档失败：${c.msg}`);
  const id = c.data.document.document_id;
  const url = SETTINGS.url('docx', id);
  if (a.text) await appendBlocks(api, id, id, a.text);
  return { ok: true, what: `新建文档《${title}》`, url };
}

async function appendBlocks(api, docId, parent, text) {
  const paras = String(text).split(/\n{1,}/).filter((x) => x.trim() !== '');
  for (let i = 0; i < paras.length; i += 40) {
    const children = paras.slice(i, i + 40).map((p) => ({
      block_type: 2, text: { elements: [{ text_run: { content: p } }] },
    }));
    const r = await api('POST', `/open-apis/docx/v1/documents/${docId}/blocks/${parent}/children`,
      { index: -1, children });
    if (r.code !== 0) throw new Error(`写入正文失败：${r.msg}`);
  }
}

async function appendDoc(api, a) {
  const { type, token } = await resolveToken(api, a.url || a.token);
  if (type && type !== 'docx') throw new Error(`append_doc 只支持新版文档，这个是 ${type}`);
  await appendBlocks(api, token, token, a.text || '');
  return { ok: true, what: '已追加内容到文档', url: a.url || SETTINGS.url('docx', token) };
}

async function writeSheet(api, a) {
  const { token } = await resolveToken(api, a.url || a.token);
  const rows = clampRows(a.rows || []);
  if (!rows.length) throw new Error('没有要写的内容');
  let sheetId = a.sheet;
  if (!sheetId) {
    const q = await api('GET', `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`);
    sheetId = q.data?.sheets?.[0]?.sheet_id;
  } else if (!/^[A-Za-z0-9]{6}$/.test(sheetId)) {
    const q = await api('GET', `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`);
    const hit = (q.data?.sheets || []).find((s) => s.title === sheetId);
    if (!hit) throw new Error(`找不到工作表「${sheetId}」`);
    sheetId = hit.sheet_id;
  }
  const start = (a.start || 'A1').toUpperCase();
  const sm = start.match(/^([A-Z]+)(\d+)$/);
  if (!sm) throw new Error('start 要形如 A1');
  const cols = Math.max(...rows.map((r) => r.length));
  const range = `${sheetId}!${start}:${colName(cols)}${+sm[2] + rows.length - 1}`;
  const w = await api('PUT', `/open-apis/sheets/v2/spreadsheets/${token}/values`,
    { valueRange: { range, values: rows } });
  if (w.code !== 0) throw new Error(`写入失败：${w.msg}`);
  return { ok: true, what: `已写入 ${rows.length} 行到 ${range}`, url: a.url || SETTINGS.url('sheets', token) };
}

const HANDLERS = { create_sheet: createSheet, create_doc: createDoc, append_doc: appendDoc, write_sheet: writeSheet };

/** 执行回复里的所有动作块，返回 {clean, results} */
async function runActions(api, reply) {
  const blocks = [];
  let m;
  ACTION_RE.lastIndex = 0;
  while ((m = ACTION_RE.exec(reply)) !== null) blocks.push(m[1]);
  if (!blocks.length) return { clean: reply, results: [] };

  const results = [];
  for (const raw of blocks.slice(0, 3)) {
    let a;
    try { a = JSON.parse(raw); } catch (e) { results.push({ ok: false, what: 'JSON 解析失败', err: e.message }); continue; }
    const h = HANDLERS[a.action];
    if (!h) { results.push({ ok: false, what: `不支持的动作 ${a.action}`, err: '只支持 create_sheet / create_doc / append_doc / write_sheet' }); continue; }
    try { results.push(await h(api, a)); }
    catch (e) { results.push({ ok: false, what: a.action, err: e.message }); }
  }
  const clean = reply.replace(ACTION_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { clean, results };
}

module.exports = { runActions, DEFAULT_FOLDER };
