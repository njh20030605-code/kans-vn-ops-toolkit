#!/usr/bin/env node
/**
 * 投放跟进工作台 · 双向同步引擎
 * ------------------------------------------------------------------
 * 底表（8 张产品表） <——> 投放跟进工作台（Jasper）
 *
 *   拉取口径：源表「投流码 Ad Code」非空 且「投放跟进人」为空  →  进工作台
 *   去重依据：源表 record_id（写在工作台「行号 Row」列），不依赖任何勾选框
 *
 *   状态机：
 *     待填写    ── 我填了备注 ──▶  已退回BD（备注写回源表 + 打同步信号）
 *     已退回BD  ── BD 改了投流码 / 清空源表备注 ──▶  待填写（备注清空，重新排队）
 *     待填写    ── 源表有人认领（投放跟进人非空）──▶  已写回
 *
 * 用法：
 *   node followup-sync.js --once            跑一轮
 *   node followup-sync.js --once --dry-run  只打印将要做什么，不写任何数据
 *   node followup-sync.js --watch [秒]      常驻轮询，默认 30 秒
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'https://open.feishu.cn';
const APP = 'DYfDb1Q7Ea01v7sfeeEcDJwEn4b';
const WB = 'tbldCm2y3S8ZZNhk';           // 投放跟进工作台（Jasper）

// 源表字段名（8 张表结构一致）
const SF = {
  bd:       '媒介执行人 BD',
  product:  '产品分配 Product',
  postDate: '实际发布日期 Release date',
  video:    '素材ID Video',
  adCode:   '投流码 Ad Code',
  buyer:    '投放跟进人',
  remark:   '备注 Remark',
  signal:   '同步信号',
  pulled:   '已汇总到跟进台',
};

// 工作台字段名
const WF = {
  bd:       'BD',
  product:  '产品 Product',
  postDate: '发布时间 Post Date',
  video:    '视频ID Video ID',
  adCode:   '投流码 Ad Code',
  remark:   '备注 Remark',
  row:      '行号 Row',
  buyer:    '投放人 Media Buyer',
  source:   '来源表 Source Sheet',
  status:   '写回状态',
  synced:   '最后同步 Last Sync',
};

const ST = { TODO: '待填写', DONE: '已写回', BOUNCED: '已退回BD' };

// ---------- 基础设施 ----------
function creds() {
  let id = process.env.FEISHU_APP_ID, secret = process.env.FEISHU_APP_SECRET;
  if (!id || !secret) {
    const f = path.join(os.homedir(), '.feishu', 'credentials.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    id = id || j.app_id; secret = secret || j.app_secret;
  }
  return { id, secret };
}

let _tok = null, _tokExp = 0;
async function token() {
  if (_tok && Date.now() < _tokExp) return _tok;
  const { id, secret } = creds();
  const r = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
  }).then(x => x.json());
  if (r.code !== 0) throw new Error('取 token 失败: ' + r.msg);
  _tok = r.tenant_access_token;
  _tokExp = Date.now() + (r.expire - 300) * 1000;
  return _tok;
}

async function api(method, url, body) {
  const t = await token();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + url, {
      method,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(x => x.json());
    if (r.code === 0) return r.data;
    // 频控退避
    if (r.code === 1254290 || r.code === 99991400) { await sleep(1000 * (attempt + 1)); continue; }
    throw new Error(`${method} ${url} → ${r.code} ${r.msg}`);
  }
  throw new Error(`${method} ${url} 连续频控失败`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function allRecords(tableId) {
  const out = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const d = await api('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${tableId}/records/search?${q}`, {});
    out.push(...(d.items || []));
    pageToken = d.has_more ? d.page_token : null;
  } while (pageToken);
  return out;
}

// ---------- 值归一化 ----------
const txt = v => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : x.text ?? x.name ?? '')).join('').trim();
  if (typeof v === 'object') return (v.text ?? v.name ?? '').trim();
  return String(v).trim();
};
const users = v => (Array.isArray(v) ? v.map(u => u.id).filter(Boolean) : []);
const sameUsers = (a, b) => JSON.stringify(users(a)) === JSON.stringify(users(b));
const num = v => (typeof v === 'number' ? v : null);

// 源表「备注」里属于投放的标记块，与 BD 自己写的内容互不覆盖
const MARK = '【投放退回】';
const bdPart  = r => (r.split(MARK)[0] || '').trim();
const adsPart = r => { const i = r.indexOf(MARK); return i < 0 ? '' : r.slice(i + MARK.length).trim(); };
const mergeRemark = (src, mine) => { const b = bdPart(src); return (b ? b + '  ' : '') + MARK + mine; };

function stamp(ts = Date.now()) {
  return new Date(ts).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(/\//g, '-');
}

// ---------- 同步主体 ----------
let lastBeat = 0;
async function syncOnce({ dryRun = false, quiet = false, log = console.log } = {}) {
  const tables = (await api('GET', `/open-apis/bitable/v1/apps/${APP}/tables?page_size=100`)).items;
  const sources = tables.filter(t => t.table_id !== WB);

  const wbRows = await allRecords(WB);
  const byRow = new Map();
  for (const r of wbRows) {
    const key = txt(r.fields[WF.row]);
    if (key) byRow.set(key, r);
  }

  const plan = {
    create: [],                    // 工作台新建
    wbUpdate: [],                  // 工作台更新
    srcUpdate: new Map(),          // tableId -> [{record_id, fields}]
    orphan: [],                    // 源表已找不到的工作台行
  };
  const pushSrc = (tid, rec) => {
    if (!plan.srcUpdate.has(tid)) plan.srcUpdate.set(tid, []);
    plan.srcUpdate.get(tid).push(rec);
  };

  const seen = new Set();
  const now = Date.now();

  for (const t of sources) {
    const rows = await allRecords(t.table_id);
    for (const s of rows) {
      const f = s.fields;
      const rid = s.record_id;
      const adCode = txt(f[SF.adCode]);
      const hasBuyer = users(f[SF.buyer]).length > 0;
      const qualifies = !!adCode && !hasBuyer;
      const w = byRow.get(rid);
      if (w) seen.add(rid);

      // ---- 1. 新增 ----
      if (qualifies && !w) {
        const nf = {
          [WF.row]: rid,
          [WF.source]: t.name,
          [WF.product]: txt(f[SF.product]),
          [WF.video]: txt(f[SF.video]),
          [WF.adCode]: adCode,
          [WF.status]: ST.TODO,
          [WF.synced]: now,
        };
        if (users(f[SF.bd]).length) nf[WF.bd] = users(f[SF.bd]).map(id => ({ id }));
        if (num(f[SF.postDate])) nf[WF.postDate] = num(f[SF.postDate]);
        plan.create.push({ fields: nf, _label: `${t.name} / ${txt(f[SF.video]) || rid}` });
        // 兼容旧按钮的去重勾
        if (f[SF.pulled] !== true) pushSrc(t.table_id, { record_id: rid, fields: { [SF.pulled]: true } });
        continue;
      }
      if (!w) continue;

      const wf = w.fields;
      const status = txt(wf[WF.status]) || ST.TODO;
      const wbRemark = txt(wf[WF.remark]);
      const srcRemark = txt(f[SF.remark]);
      const upd = {};
      const notes = [];

      // ---- 2. 已退回BD：等 BD 修，不覆盖投流码快照 ----
      if (status === ST.BOUNCED) {
        const fixed = !adsPart(srcRemark) || adCode !== txt(wf[WF.adCode]);
        if (fixed) {
          upd[WF.remark] = '';
          upd[WF.status] = qualifies ? ST.TODO : ST.DONE;
          upd[WF.adCode] = adCode;
          notes.push(qualifies ? 'BD 已修正 → 重新排队' : 'BD 已修正且已被认领 → 已写回');
          const cleanup = {};
          if (adsPart(srcRemark)) cleanup[SF.remark] = bdPart(srcRemark);   // 摘掉标记块，保留 BD 原文
          if (txt(f[SF.signal])) cleanup[SF.signal] = '';
          if (Object.keys(cleanup).length) pushSrc(t.table_id, { record_id: rid, fields: cleanup });
        }
      } else {
        // ---- 3. 备注写回：只在「待填写」时生效；已写回 = 有人认领了，闭环并摘掉标记块 ----
        if (status === ST.DONE) {
          if (adsPart(srcRemark)) {
            pushSrc(t.table_id, { record_id: rid, fields: { [SF.remark]: bdPart(srcRemark), [SF.signal]: '' } });
            notes.push('已认领 → 摘掉源表退回标记');
          }
        } else if (wbRemark && wbRemark !== adsPart(srcRemark)) {
          pushSrc(t.table_id, {
            record_id: rid,
            fields: {
              [SF.remark]: mergeRemark(srcRemark, wbRemark),
              [SF.signal]: `投放退回 | ${stamp(now)} | ${wbRemark} | 被退回的码尾号 ${(txt(wf[WF.adCode]) || adCode).slice(-8)}`,
            },
          });
          upd[WF.status] = ST.BOUNCED;
          notes.push(`备注写回源表并退回BD：「${wbRemark}」`);
        }
        if (!upd[WF.status]) {
          // ---- 4. 状态跟随源表 ----
          const want = qualifies ? ST.TODO : ST.DONE;
          if (status !== want) { upd[WF.status] = want; notes.push(`状态 ${status} → ${want}`); }
        }

        // ---- 5. 展示字段跟随源表 ----
        if (txt(wf[WF.product]) !== txt(f[SF.product])) upd[WF.product] = txt(f[SF.product]);
        if (txt(wf[WF.video]) !== txt(f[SF.video])) upd[WF.video] = txt(f[SF.video]);
        if (txt(wf[WF.adCode]) !== adCode) { upd[WF.adCode] = adCode; notes.push('投流码变更'); }
        if (num(wf[WF.postDate]) !== num(f[SF.postDate]) && num(f[SF.postDate])) upd[WF.postDate] = num(f[SF.postDate]);
        if (!sameUsers(wf[WF.bd], f[SF.bd]) && users(f[SF.bd]).length) upd[WF.bd] = users(f[SF.bd]).map(id => ({ id }));
        if (!sameUsers(wf[WF.buyer], f[SF.buyer]) && users(f[SF.buyer]).length) {
          upd[WF.buyer] = users(f[SF.buyer]).slice(0, 1).map(id => ({ id }));
          notes.push('认领人回填');
        }
      }

      if (Object.keys(upd).length) {
        upd[WF.synced] = now;
        plan.wbUpdate.push({ record_id: w.record_id, fields: upd, _label: `${t.name} / ${txt(wf[WF.video]) || rid} :: ${notes.join('；') || '字段同步'}` });
      }
    }
  }

  for (const [rid, w] of byRow) if (!seen.has(rid)) plan.orphan.push(`${txt(w.fields[WF.source])} / ${rid}`);

  // ---------- 执行 ----------
  const srcCount = [...plan.srcUpdate.values()].reduce((a, b) => a + b.length, 0);
  const busy = plan.create.length + plan.wbUpdate.length + srcCount + plan.orphan.length > 0;
  // 无事可做的轮次不写日志，每小时打一次心跳，免得日志被刷爆
  if (busy || !quiet || Date.now() - lastBeat > 3600e3) {
    if (!busy) lastBeat = Date.now();
    log(`[${stamp()}] 新建 ${plan.create.length} · 工作台更新 ${plan.wbUpdate.length} · 源表回写 ${srcCount} · 孤儿行 ${plan.orphan.length}`);
  }
  for (const c of plan.create) log(`   + 新建  ${c._label}`);
  for (const u of plan.wbUpdate) log(`   ~ 更新  ${u._label}`);
  for (const [tid, arr] of plan.srcUpdate) for (const r of arr) log(`   ↩ 回写  ${tid} ${r.record_id} ${JSON.stringify(r.fields).slice(0, 120)}`);
  for (const o of plan.orphan) log(`   ! 孤儿  ${o}（源表已删除，工作台保留）`);

  if (dryRun) { log('   —— dry-run，未写入任何数据 ——'); return plan; }

  const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

  for (const g of chunk(plan.create, 200))
    await api('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${WB}/records/batch_create`,
      { records: g.map(({ fields }) => ({ fields })) });

  for (const g of chunk(plan.wbUpdate, 200))
    await api('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${WB}/records/batch_update`,
      { records: g.map(({ record_id, fields }) => ({ record_id, fields })) });

  for (const [tid, arr] of plan.srcUpdate)
    for (const g of chunk(arr, 200))
      await api('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${tid}/records/batch_update`, { records: g });

  return plan;
}

// ---------- CLI ----------
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  if (args.includes('--watch')) {
    const iv = Number(args[args.indexOf('--watch') + 1]) || 30;
    console.log(`投放跟进同步已启动，每 ${iv} 秒一轮（Ctrl+C 退出）`);
    for (;;) {
      try { await syncOnce({ dryRun, quiet: true }); }
      catch (e) { console.error(`[${stamp()}] 同步失败：${e.message}`); }
      await sleep(iv * 1000);
    }
  } else {
    await syncOnce({ dryRun });
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { syncOnce };
