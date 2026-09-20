#!/usr/bin/env node
/**
 * 飞书开放平台 CLI —— 应用「My Claude」(cli_aa030355f5f89cde)
 *
 * 凭证读取顺序：
 *   1) 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET
 *   2) ~/.feishu/credentials.json  { "app_id": "...", "app_secret": "..." }
 *
 * 用法： node feishu.js <命令> [参数...]
 *   node feishu.js selftest                          # 逐条探测哪些权限真的能用
 *   node feishu.js token                             # 取 tenant_access_token（只打印前 12 位）
 *   node feishu.js doc:read   <docToken>             # 读新版文档纯文本
 *   node feishu.js doc:create <标题> [folderToken]   # 新建文档
 *   node feishu.js doc:append <docToken> <文本>      # 往文档末尾追加一段文字
 *   node feishu.js sheet:read  <sheetToken> <A1范围> # 读电子表格，如 Sheet1!A1:D20
 *   node feishu.js sheet:write <sheetToken> <A1范围> <JSON二维数组>
 *   node feishu.js base:tables  <appToken>           # 多维表格：列出数据表
 *   node feishu.js base:fields  <appToken> <tableId> # 列字段
 *   node feishu.js base:records <appToken> <tableId> [页大小]
 *   node feishu.js base:add     <appToken> <tableId> <JSON对象>
 *   node feishu.js chat:history <chatId> [条数]      # 拉群/单聊历史消息
 *   node feishu.js api <METHOD> <路径> [JSON body]   # 万能透传，如 api GET /open-apis/im/v1/chats
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'https://open.feishu.cn';

function creds() {
  let id = process.env.FEISHU_APP_ID;
  let secret = process.env.FEISHU_APP_SECRET;
  if (!id || !secret) {
    const f = path.join(os.homedir(), '.feishu', 'credentials.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      id = id || j.app_id;
      secret = secret || j.app_secret;
    }
  }
  if (!id || !secret) {
    console.error(
      '缺少凭证。任选一种：\n' +
      '  export FEISHU_APP_ID=cli_aa030355f5f89cde\n' +
      '  export FEISHU_APP_SECRET=<你的 App Secret>\n' +
      '或写入 ~/.feishu/credentials.json：{"app_id":"cli_aa030355f5f89cde","app_secret":"..."}'
    );
    process.exit(1);
  }
  return { id, secret };
}

let _token = null;
async function token() {
  if (_token) return _token;
  const { id, secret } = creds();
  const r = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`取 token 失败 code=${j.code} msg=${j.msg}`);
  _token = j.tenant_access_token;
  return _token;
}

async function api(method, urlPath, body) {
  const t = await token();
  const r = await fetch(BASE + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { return { httpStatus: r.status, raw: text }; }
  return j;
}

function out(x) { console.log(JSON.stringify(x, null, 2)); }
function need(v, name) {
  if (v === undefined) { console.error(`缺少参数：${name}`); process.exit(1); }
  return v;
}

// ---- 各命令 ----

async function docRead(docToken) {
  const j = await api('GET', `/open-apis/docx/v1/documents/${docToken}/raw_content`);
  if (j.code === 0) console.log(j.data.content);
  else out(j);
}

async function docCreate(title, folderToken) {
  const body = { title };
  if (folderToken) body.folder_token = folderToken;
  const j = await api('POST', '/open-apis/docx/v1/documents', body);
  if (j.code === 0) {
    const d = j.data.document;
    console.log(`已创建：${d.title}\ndocument_id: ${d.document_id}\nhttps://feishu.cn/docx/${d.document_id}`);
  } else out(j);
}

async function docAppend(docToken, text) {
  // 追加到根块（文档本身）末尾，作为一个普通段落
  const j = await api('POST', `/open-apis/docx/v1/documents/${docToken}/blocks/${docToken}/children`, {
    index: -1,
    children: [{ block_type: 2, text: { elements: [{ text_run: { content: text } }] } }],
  });
  out(j.code === 0 ? { ok: true, 新增块数: j.data.children?.length ?? 0 } : j);
}

async function sheetRead(sheetToken, range) {
  const j = await api('GET', `/open-apis/sheets/v2/spreadsheets/${sheetToken}/values/${encodeURIComponent(range)}`);
  if (j.code === 0) out(j.data.valueRange.values);
  else out(j);
}

async function sheetWrite(sheetToken, range, valuesJson) {
  const values = JSON.parse(valuesJson);
  const j = await api('PUT', `/open-apis/sheets/v2/spreadsheets/${sheetToken}/values`, {
    valueRange: { range, values },
  });
  out(j.code === 0 ? { ok: true, 更新单元格: j.data.updatedCells } : j);
}

async function baseTables(appToken) {
  const j = await api('GET', `/open-apis/bitable/v1/apps/${appToken}/tables?page_size=100`);
  if (j.code === 0) out(j.data.items.map(t => ({ table_id: t.table_id, name: t.name })));
  else out(j);
}

async function baseFields(appToken, tableId) {
  const j = await api('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=200`);
  if (j.code === 0) out(j.data.items.map(f => ({ field_name: f.field_name, type: f.type })));
  else out(j);
}

async function baseRecords(appToken, tableId, pageSize = '20') {
  const j = await api('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${pageSize}`);
  if (j.code === 0) out(j.data.items.map(r => ({ record_id: r.record_id, ...r.fields })));
  else out(j);
}

async function baseAdd(appToken, tableId, fieldsJson) {
  const j = await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    fields: JSON.parse(fieldsJson),
  });
  out(j.code === 0 ? { ok: true, record_id: j.data.record.record_id } : j);
}

async function chatHistory(chatId, size = '50') {
  const j = await api('GET',
    `/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${size}&sort_type=ByCreateTimeDesc`);
  if (j.code !== 0) return out(j);
  const rows = j.data.items.map(m => ({
    时间: new Date(Number(m.create_time)).toLocaleString('zh-CN'),
    发送者: m.sender?.id || m.sender?.sender_type,
    类型: m.msg_type,
    内容: (() => { try { return JSON.parse(m.body.content).text ?? m.body.content; } catch { return m.body.content; } })(),
  }));
  out(rows.reverse());
}

async function selftest() {
  const checks = [
    ['取 tenant_access_token', 'GET', '/open-apis/auth/v3/app_ticket_resend', null, true],
    ['im  列出机器人所在的群 (im:chat:readonly)', 'GET', '/open-apis/im/v1/chats?page_size=1'],
    ['drive 列云空间文件 (drive:drive*)', 'GET', '/open-apis/drive/v1/files?page_size=1'],
    ['wiki 列知识空间 (wiki:wiki*)', 'GET', '/open-apis/wiki/v2/spaces?page_size=1'],
    ['bitable 元信息 (bitable:app*) — 需真实 appToken，此处只看鉴权码', 'GET', '/open-apis/bitable/v1/apps/xxxxxxxxxxxx'],
    ['docx 读文档 (docx:document*) — 需真实 docToken，此处只看鉴权码', 'GET', '/open-apis/docx/v1/documents/xxxxxxxxxxxx/raw_content'],
  ];
  try { await token(); console.log('✅ tenant_access_token 拿到了'); }
  catch (e) { console.log('❌ ' + e.message); return; }
  for (const [name, method, p] of checks.slice(1)) {
    const j = await api(method, p);
    // 99991672 / 99991679 = 权限不足；1254xxx / 91402 = 对象不存在（说明鉴权已过）
    const permDenied = j.code === 99991672 || j.code === 99991679 || j.code === 99991663;
    const flag = j.code === 0 ? '✅ 可用'
      : permDenied ? `❌ 权限不足 (code ${j.code})`
      : `⚠️  鉴权通过但对象无效 (code ${j.code}: ${j.msg})`;
    console.log(`${flag}  ${name}`);
  }
  console.log('\n提示：⚠️ 那几行说明权限是通的，只是我用了假的 token 占位符。');
}

// ---- 入口 ----

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'token':        console.log((await token()).slice(0, 12) + '…（已取到）'); break;
      case 'selftest':     await selftest(); break;
      case 'doc:read':     await docRead(need(a[0], 'docToken')); break;
      case 'doc:create':   await docCreate(need(a[0], '标题'), a[1]); break;
      case 'doc:append':   await docAppend(need(a[0], 'docToken'), need(a[1], '文本')); break;
      case 'sheet:read':   await sheetRead(need(a[0], 'sheetToken'), need(a[1], '范围')); break;
      case 'sheet:write':  await sheetWrite(need(a[0], 'sheetToken'), need(a[1], '范围'), need(a[2], 'JSON二维数组')); break;
      case 'base:tables':  await baseTables(need(a[0], 'appToken')); break;
      case 'base:fields':  await baseFields(need(a[0], 'appToken'), need(a[1], 'tableId')); break;
      case 'base:records': await baseRecords(need(a[0], 'appToken'), need(a[1], 'tableId'), a[2]); break;
      case 'base:add':     await baseAdd(need(a[0], 'appToken'), need(a[1], 'tableId'), need(a[2], 'JSON对象')); break;
      case 'chat:history': await chatHistory(need(a[0], 'chatId'), a[1]); break;
      case 'api':          out(await api(need(a[0], 'METHOD').toUpperCase(), need(a[1], '路径'), a[2] ? JSON.parse(a[2]) : undefined)); break;
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].trim());
    }
  } catch (e) {
    console.error('出错：' + e.message);
    process.exit(1);
  }
})();
