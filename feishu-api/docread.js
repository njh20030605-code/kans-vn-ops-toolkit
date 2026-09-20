/**
 * 飞书文档读取层 —— 从消息里认出飞书链接，取回内容给模型。
 * 支持：wiki 节点（自动解析成底层对象）/ 新版文档 docx / 旧版文档 docs
 *       / 电子表格 sheets / 多维表格 base
 */

const DOC_TOTAL_MAX = 40 * 1024;   // 所有文档合计注入上限
const SHEET_MAX_ROWS = 200;
const SHEET_MAX_COLS = 26;

/** 从文本里认出飞书云文档链接（丢掉 disposable_login_token 这类隐私参数） */
function extractLinks(text) {
  const out = [];
  const re = /https?:\/\/([a-z0-9-]+)\.(feishu\.cn|larkoffice\.com|larksuite\.com)\/(wiki|docx|docs|sheets|base|file)\/([A-Za-z0-9]+)([^\s)）】]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, host, domain, type, token, rest] = m;
    const q = {};
    for (const kv of (rest || '').replace(/^\?/, '').split('&')) {
      const [k, v] = kv.split('=');
      if (['sheet', 'table', 'view'].includes(k) && v) q[k] = v;   // 只留这几个，其它（含登录 token）一律丢弃
    }
    out.push({ host, domain, type, token, q, url: `https://${host}.${domain}/${type}/${token}` });
  }
  // 去重
  const seen = new Set();
  return out.filter((l) => { const k = l.type + l.token; if (seen.has(k)) return false; seen.add(k); return true; });
}

function colName(n) {           // 1 → A, 27 → AA
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function cellText(c) {
  if (c === null || c === undefined) return '';
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? (x.text ?? x.link ?? '') : String(x))).join('');
  if (typeof c === 'object') return String(c.text ?? c.link ?? '');
  return String(c);
}

/** 主入口：给一个链接，返回 {title, kind, text} 或 {err} */
async function readOne(api, link) {
  let { type, token, q } = link;

  // wiki 节点 → 解析出底层对象
  let title = null;
  if (type === 'wiki') {
    const r = await api('GET', `/open-apis/wiki/v2/spaces/get_node?token=${token}&obj_type=wiki`);
    if (r.code !== 0) return { err: `wiki 节点解析失败：${r.msg}` };
    const n = r.data.node;
    title = n.title;
    token = n.obj_token;
    type = n.obj_type === 'sheet' ? 'sheets' : n.obj_type === 'bitable' ? 'base' : n.obj_type;   // docx/sheet/bitable/doc
  }

  if (type === 'docx') {
    const r = await api('GET', `/open-apis/docx/v1/documents/${token}/raw_content`);
    if (r.code !== 0) return { err: `读文档失败：${r.msg}` };
    return { title: title || '(新版文档)', kind: '文档', text: r.data.content || '' };
  }

  if (type === 'docs' || type === 'doc') {
    const r = await api('GET', `/open-apis/doc/v2/${token}/raw_content`);
    if (r.code !== 0) return { err: `读旧版文档失败：${r.msg}` };
    return { title: title || '(旧版文档)', kind: '文档', text: r.data.content || '' };
  }

  if (type === 'sheets' || type === 'sheet') {
    const meta = await api('GET', `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`);
    if (meta.code !== 0) return { err: `读表格失败：${meta.msg}` };
    let sheets = meta.data.sheets || [];
    if (q.sheet) {
      const hit = sheets.filter((s) => s.sheet_id === q.sheet);
      if (hit.length) sheets = hit;                      // 链接指定了某个 sheet 就只读那个
    }
    const chunks = [];
    for (const s of sheets) {
      const g = s.grid_properties || {};
      const rows = Math.min(g.row_count || 100, SHEET_MAX_ROWS);
      const cols = Math.min(g.column_count || 20, SHEET_MAX_COLS);
      const range = `${s.sheet_id}!A1:${colName(cols)}${rows}`;
      const v = await api('GET', `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}`);
      if (v.code !== 0) { chunks.push(`## 工作表：${s.title}\n(读取失败：${v.msg})`); continue; }
      const values = v.data?.valueRange?.values || [];
      const lines = [];
      for (const row of values) {
        const cells = row.map(cellText).map((x) => x.replace(/\s*\n\s*/g, ' ⏎ ').trim());
        if (cells.every((x) => !x)) continue;            // 跳过全空行
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        lines.push(cells.join(' | '));
      }
      chunks.push(`## 工作表：${s.title}（${lines.length} 行有内容${(g.row_count || 0) > rows ? `，原表 ${g.row_count} 行已截断到 ${rows}` : ''}）\n${lines.join('\n')}`);
    }
    return { title: title || '(电子表格)', kind: '电子表格', text: chunks.join('\n\n') };
  }

  if (type === 'base' || type === 'bitable') {
    const tb = await api('GET', `/open-apis/bitable/v1/apps/${token}/tables?page_size=100`);
    if (tb.code !== 0) return { err: `读多维表格失败：${tb.msg}` };
    let tables = tb.data.items || [];
    if (q.table) { const hit = tables.filter((t) => t.table_id === q.table); if (hit.length) tables = hit; }
    const chunks = [];
    for (const t of tables.slice(0, 3)) {
      const rec = await api('GET', `/open-apis/bitable/v1/apps/${token}/tables/${t.table_id}/records?page_size=100`);
      if (rec.code !== 0) { chunks.push(`## 数据表：${t.name}（读取失败：${rec.msg}）`); continue; }
      const items = rec.data.items || [];
      const lines = items.map((r) => JSON.stringify(r.fields));
      chunks.push(`## 数据表：${t.name}（${items.length} 条记录${rec.data.has_more ? '，还有更多未取' : ''}）\n${lines.join('\n')}`);
    }
    return { title: title || '(多维表格)', kind: '多维表格', text: chunks.join('\n\n') };
  }

  if (type === 'file') return { err: '这是一个上传的文件（非在线文档），暂不支持读取内容' };
  return { err: `暂不支持的类型：${type}` };
}

/** 读消息里所有飞书链接，拼成一个注入块 */
async function readLinks(api, text) {
  const links = extractLinks(text);
  if (!links.length) return null;
  const parts = [];
  const meta = [];
  let used = 0;
  for (const l of links.slice(0, 3)) {
    let r;
    try { r = await readOne(api, l); } catch (e) { r = { err: e.message }; }
    if (r.err) { parts.push(`【飞书文档 · ${l.url}】\n读取失败：${r.err}`); meta.push({ url: l.url, ok: false, err: r.err }); continue; }
    let body = r.text || '(空)';
    const budget = DOC_TOTAL_MAX - used;
    let truncated = false;
    if (Buffer.byteLength(body) > budget) { body = body.slice(0, Math.max(0, budget)) + '\n…[内容过长已截断]'; truncated = true; }
    used += Buffer.byteLength(body);
    parts.push(`【飞书${r.kind} · 《${r.title}》 · ${l.url}】\n${body}`);
    meta.push({ url: l.url, ok: true, title: r.title, kind: r.kind, bytes: Buffer.byteLength(body), truncated });
    if (used >= DOC_TOTAL_MAX) break;
  }
  return { text: parts.join('\n\n'), meta };
}

module.exports = { extractLinks, readLinks };
