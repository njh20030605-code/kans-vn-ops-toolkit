// 把 v3.1 增补内容就地插进现有手册文档（保留用户手改过的部分）
const { api } = require('/Users/Zhuanz1/Desktop/feishu-api/creative-exclusion/lib.js');
const { build } = require('./additions_v31.js');
const DOC = process.argv[2] || 'Aqw3dzlsvoGWrHxY50DcJKeYn2e';

// ---- 与 build_manual_v3.js 相同的块构造 ----
function elems(s) {
  const out = []; const re = /\*\*(.+?)\*\*|\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g; let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text_run: { content: s.slice(last, m.index) } });
    if (m[1] !== undefined) out.push({ text_run: { content: m[1], text_element_style: { bold: true } } });
    else out.push({ text_run: { content: m[2], text_element_style: { link: { url: encodeURIComponent(m[3]) } } } });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text_run: { content: s.slice(last) } });
  return out.length ? out : [{ text_run: { content: '' } }];
}
let seq = 0; const nid = () => 'p' + (++seq);
const leaf = (type, key, s, style) => ({ block_id: nid(), block_type: type, [key]: { elements: elems(s), ...(style ? { style } : {}) } });
const H2 = (s) => leaf(4, 'heading2', s), P = (s) => leaf(2, 'text', s), B = (s) => leaf(12, 'bullet', s), O = (s) => leaf(13, 'ordered', s);
function CALLOUT(lines, { color = 5, emoji = 'bulb' } = {}) {
  const kids = lines.map((s) => P(s));
  return { node: { block_id: nid(), block_type: 19, callout: { background_color: color, border_color: color, emoji_id: emoji }, children: kids.map((k) => k.block_id) }, extra: kids };
}
function TABLE(rows, widths) {
  const cols = Math.max(...rows.map((r) => r.length)); const cells = [], texts = [];
  for (const r of rows) for (let c = 0; c < cols; c++) { const t = P(r[c] ?? ''); cells.push({ block_id: nid(), block_type: 32, table_cell: {}, children: [t.block_id] }); texts.push(t); }
  const prop = { row_size: rows.length, column_size: cols, header_row: true }; if (widths) prop.column_width = widths;
  return { node: { block_id: nid(), block_type: 31, table: { property: prop }, children: cells.map((c) => c.block_id) }, extra: [...cells, ...texts] };
}
function flatten(items) {
  const children_id = [], descendants = [];
  for (const it of items) { if (it.node) { children_id.push(it.node.block_id); descendants.push(it.node, ...it.extra); } else { children_id.push(it.block_id); descendants.push(it); } }
  return { children_id, descendants };
}
const W = 720, w = (...parts) => { const s = parts.reduce((a, b) => a + b, 0); return parts.map((p) => Math.round(p / s * W)); };

async function allBlocks(doc) {
  const out = []; let pt = '';
  do { const r = await api('GET', `/open-apis/docx/v1/documents/${doc}/blocks?page_size=500&document_revision_id=-1${pt ? '&page_token=' + pt : ''}`); out.push(...r.items); pt = r.has_more ? r.page_token : ''; } while (pt);
  return out;
}
const headText = (b) => { const k = { 3: 'heading1', 4: 'heading2' }[b.block_type]; return k && b[k] ? b[k].elements.map((e) => e.text_run ? e.text_run.content : '').join('') : ''; };

(async () => {
  const blocks = await allBlocks(DOC);
  const root = blocks.find((b) => b.block_type === 1); const byId = Object.fromEntries(blocks.map((b) => [b.block_id, b]));
  const heads = root.children.map((id, i) => ({ i, t: headText(byId[id]), type: byId[id].block_type }));
  const idxOf = (prefix, type) => { const h = heads.find((x) => x.type === type && x.t.startsWith(prefix)); if (!h) throw new Error('找不到标题 ' + prefix); return h.i; };
  if (heads.some((x) => x.t.startsWith('3.1 每日工作流表'))) { console.log('已打过补丁，跳过'); return; }
  const a = build({ H2, P, B, O, CALLOUT, TABLE, w });
  // 从下往上插，索引才不漂移
  const plan = [
    { index: root.children.length, items: a.appendix, tag: '附录' },
    { index: idxOf('11 ', 3), items: a.s10, tag: '10.1' },
    { index: idxOf('规范', 4), items: a.s07, tag: '07' },
    { index: idxOf('06 ', 3), items: a.s55, tag: '5.5-5.7' },
    { index: idxOf('04 ', 3), items: a.s31, tag: '3.1' },
    { index: idxOf('01 ', 3), items: a.cover, tag: '封面' },
  ];
  for (const p of plan) {
    const { children_id, descendants } = flatten(p.items);
    await api('POST', `/open-apis/docx/v1/documents/${DOC}/blocks/${DOC}/descendant`, { children_id, index: p.index, descendants });
    console.log('inserted', p.tag, 'at', p.index, 'blocks', descendants.length);
  }
  console.log('done https://gvh59x1f62p.feishu.cn/docx/' + DOC);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
