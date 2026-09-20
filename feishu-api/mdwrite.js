// md -> 飞书 docx blocks（标题/项目符号/有序/分割线/粗体/行内码/图片/表格）
const fs = require('fs'); const path = require('path');
const SETTINGS = require('./settings');
async function token() {
  const c = JSON.parse(fs.readFileSync(process.env.HOME + '/.feishu/credentials.json', 'utf8'));
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: c.app_id || c.appId, app_secret: c.app_secret || c.appSecret }) }).then(r => r.json());
  if (r.code !== 0) throw new Error('token: ' + JSON.stringify(r));
  return r.tenant_access_token;
}
let TK;
async function api(method, p, body) {
  TK = TK || await token();
  return fetch('https://open.feishu.cn' + p, { method,
    headers: { Authorization: 'Bearer ' + TK, 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
}
function runs(s) {
  const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`)/g; let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text_run: { content: s.slice(last, m.index) } });
    const t = m[0];
    if (t.startsWith('**')) out.push({ text_run: { content: t.slice(2, -2), text_element_style: { bold: true } } });
    else out.push({ text_run: { content: t.slice(1, -1), text_element_style: { inline_code: true } } });
    last = m.index + t.length;
  }
  if (last < s.length) out.push({ text_run: { content: s.slice(last) } });
  return out.length ? out : [{ text_run: { content: '' } }];
}
// 解析成段：{kind:'blocks', blocks} | {kind:'image', path} | {kind:'table', rows}
function parse(md) {
  const segs = []; let cur = [];
  const flush = () => { if (cur.length) { segs.push({ kind: 'blocks', blocks: cur }); cur = []; } };
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, ''); let m;
    if (!line.trim()) continue;
    if ((m = line.match(/^!\[[^\]]*\]\(([^)]+)\)$/))) { flush(); segs.push({ kind: 'image', path: m[1] }); continue; }
    if (/^\|/.test(line)) {
      flush(); const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--; segs.push({ kind: 'table', rows }); continue;
    }
    if (/^---+$/.test(line.trim())) { cur.push({ block_type: 22, divider: {} }); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      const lvl = m[1].length; const key = ['heading1', 'heading2', 'heading3', 'heading4'][lvl - 1];
      cur.push({ block_type: 2 + lvl, [key]: { elements: runs(m[2]) } }); continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { cur.push({ block_type: 12, bullet: { elements: runs(m[1]) } }); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { cur.push({ block_type: 13, ordered: { elements: runs(m[1]) } }); continue; }
    cur.push({ block_type: 2, text: { elements: runs(line) } });
  }
  flush(); return segs;
}
async function addChildren(docId, children) {
  const r = await api('POST', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`, { index: -1, children });
  if (r.code !== 0) throw new Error('children: ' + JSON.stringify(r)); return r.data.children;
}
async function addImage(docId, p) {
  const [img] = await addChildren(docId, [{ block_type: 27, image: {} }]);
  const buf = fs.readFileSync(p);
  const fd = new FormData();
  fd.append('file_name', path.basename(p)); fd.append('parent_type', 'docx_image');
  fd.append('parent_node', img.block_id); fd.append('size', String(buf.length));
  fd.append('file', new Blob([buf]), path.basename(p));
  const up = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', { method: 'POST', headers: { Authorization: 'Bearer ' + TK }, body: fd }).then(r => r.json());
  if (up.code !== 0) throw new Error('upload: ' + JSON.stringify(up));
  const r = await api('PATCH', `/open-apis/docx/v1/documents/${docId}/blocks/${img.block_id}`, { replace_image: { token: up.data.file_token } });
  if (r.code !== 0) throw new Error('replace_image: ' + JSON.stringify(r));
}
async function addTable(docId, rows) {
  const cols = Math.max(...rows.map(r => r.length));
  const [tbl] = await addChildren(docId, [{ block_type: 31, table: { property: { row_size: rows.length, column_size: cols, column_width: cols === 5 ? [50, 130, 340, 170, 110] : Array(cols).fill(Math.floor(800 / cols)) } } }]);
  const cells = tbl.children || [];
  for (let i = 0; i < cells.length; i++) {
    const r = Math.floor(i / cols), c = i % cols; const txt = rows[r]?.[c] ?? '';
    const cell = await api('GET', `/open-apis/docx/v1/documents/${docId}/blocks/${cells[i]}`);
    const kid = cell.data?.block?.children?.[0];
    const elements = runs(txt);
    if (kid) {
      const u = await api('PATCH', `/open-apis/docx/v1/documents/${docId}/blocks/${kid}`, { update_text_elements: { elements } });
      if (u.code !== 0) throw new Error('cell: ' + JSON.stringify(u));
    } else {
      const u = await api('POST', `/open-apis/docx/v1/documents/${docId}/blocks/${cells[i]}/children`, { index: 0, children: [{ block_type: 2, text: { elements } }] });
      if (u.code !== 0) throw new Error('cell+: ' + JSON.stringify(u));
    }
  }
}
async function clearDoc(docId) {
  const r = await api('GET', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}`);
  const n = (r.data?.block?.children || []).length; if (!n) return;
  const d = await api('DELETE', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`, { start_index: 0, end_index: n });
  if (d.code !== 0) throw new Error('clear: ' + JSON.stringify(d));
  process.stderr.write(`cleared ${n} blocks\n`);
}
(async () => {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear'); const a = args.filter(x => x !== '--clear');
  const [mdPath, title, docTokenArg] = a;
  let docId = docTokenArg;
  if (!docId) {
    const c = await api('POST', '/open-apis/docx/v1/documents', { title, folder_token: SETTINGS.output_folder });
    if (c.code !== 0) throw new Error('create: ' + JSON.stringify(c)); docId = c.data.document.document_id;
  } else if (clear) { await clearDoc(docId); if (title) await api('PATCH', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}`, { }); }
  for (const seg of parse(fs.readFileSync(mdPath, 'utf8'))) {
    if (seg.kind === 'image') { await addImage(docId, seg.path); process.stderr.write('image ok\n'); }
    else if (seg.kind === 'table') { await addTable(docId, seg.rows); process.stderr.write(`table ${seg.rows.length}x ok\n`); }
    else for (let i = 0; i < seg.blocks.length; i += 40) await addChildren(docId, seg.blocks.slice(i, i + 40));
  }
  console.log(SETTINGS.url('docx', docId));
})().catch(e => { console.error(e.message); process.exit(1); });
