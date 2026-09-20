#!/usr/bin/env node
/**
 * 素材排除表 · 机器人（每 3 分钟）
 *  1) Shop 空 -> 按 Campaign 补
 *  2) 同 Shop+Creative ID 以前被 Jasper 打过 No/Yes -> 在「⚠ Robot」写明，
 *     该行自动从「② Jasper 待审」视图消失（视图筛选 ⚠ 为空）
 *  3) Jasper Notice 新写了内容 -> 飞书卡片推给实习生（本地 notified.json 防重发）
 */
const fs = require('fs'), path = require('path');
const { api } = require('./lib');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { app_token: APP, table: T } = CFG;
const STATE = path.join(__dirname, 'notified.json');
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const txt = v => v == null ? '' : typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.map(x => x && x.text || '').join('').trim() : String(v.text || v).trim();
const day = ms => ms ? new Date(ms).toLocaleDateString('zh-CN') : '';

async function listAll() {
  const out = []; let tok;
  do { const d = await api('GET', `/open-apis/bitable/v1/apps/${APP}/tables/${T}/records?page_size=500${tok ? '&page_token=' + tok : ''}`);
       out.push(...(d.items || [])); tok = d.has_more ? d.page_token : null; } while (tok);
  return out;
}

async function push(items) {
  const n = CFG.notify || {};
  if (!n.enabled || !n.intern_open_id || !items.length) return false;
  const no = items.filter(i => i.verdict === 'No').length;
  const card = {
    config: { wide_screen_mode: true },
    header: { template: no ? 'red' : 'green', title: { tag: 'plain_text', content: no ? `⛔ Jasper 驳回了 ${no} 条素材 / ${no} creative(s) rejected` : `✅ Jasper 有 ${items.length} 条新反馈 / new feedback` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: items.map(i => `**${i.verdict === 'No' ? '⛔ No' : '✅ Yes'}** · ${i.shop} · ${i.campaign}\n素材ID \`${i.cid}\`\nJasper：${i.notice}`).join('\n\n---\n\n') } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '打 No 的看完就改，别再原样提交 / Fix rejected ones, do not resubmit. 打 Yes 的去后台排除完打钩 Intern: Done / Exclude approved ones and tick.' } },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '打开表格 / Open' }, url: n.base_url }] },
    ],
  };
  await api('POST', '/open-apis/im/v1/messages?receive_id_type=open_id', { receive_id: n.intern_open_id, msg_type: 'interactive', content: JSON.stringify(card) });
  return true;
}

(async () => {
  const recs = (await listAll()).sort((a, b) => (a.fields.Submitted || 0) - (b.fields.Submitted || 0));
  const notified = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const decided = new Map(), pending = new Set(), updates = [], toPush = [];

  for (const r of recs) {
    const f = r.fields, patch = {};
    const cid = txt(f['Creative ID']).replace(/\s+/g, '');
    // 三店各一列 Campaign，哪列有值就是哪个店
    const SHOPS = ['KANS Official', 'KANS Globe', 'One Leaf'];
    let camp = '', campShop = '';
    for (const s of SHOPS) { const v = txt(f['Campaign · ' + s]); if (v) { camp = v; campShop = s; break; } }
    let shop = txt(f.Shop);
    if (!shop && campShop) { shop = campShop; patch.Shop = shop; }
    if (camp && txt(f.Campaign) !== camp) patch.Campaign = camp;   // 汇总列（单选）跟各店列同步
    const verdict = txt(f['Jasper: Exclude?']), notice = txt(f['Jasper Notice']);
    const key = `${shop}|${cid}`;

    let robot = '';
    if (cid && !verdict) {
      const p = decided.get(key);
      if (p && p.verdict === 'No') robot = `⛔ ${day(p.at)} 已被驳回，Jasper 说：${p.notice || '(无)'} —— 改完再说，别重复提 / Rejected before, do not resubmit`;
      else if (p && p.verdict === 'Yes') robot = `✔ ${day(p.at)} 已经排除过了，不用再报 / Already excluded`;
      else if (pending.has(key)) robot = `↺ 这批里重复了，删掉这行 / Duplicate row in this batch`;
      if (!p) pending.add(key);
    }
    if (txt(f['⚠ Robot']) !== robot) patch['⚠ Robot'] = robot;
    if (cid && verdict) decided.set(key, { verdict, notice, at: f.Submitted });

    if (verdict && notice && notified[r.record_id] !== notice) toPush.push({ id: r.record_id, cid, shop, campaign: camp, verdict, notice });
    if (Object.keys(patch).length) updates.push({ record_id: r.record_id, fields: patch });
  }

  if (toPush.length) {
    try { if (await push(toPush)) { toPush.forEach(i => notified[i.id] = i.notice); fs.writeFileSync(STATE, JSON.stringify(notified)); log(`pushed ${toPush.length} to intern`); } }
    catch (e) { log('push failed, retry next run:', e.message.slice(0, 160)); }
  }
  for (let i = 0; i < updates.length; i += 500)
    await api('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${T}/records/batch_update`, { records: updates.slice(i, i + 500) });
  log(updates.length ? `updated ${updates.length}/${recs.length}` : `no change (${recs.length} rows)`);
  updates.slice(0, 10).forEach(u => log('  ·', JSON.stringify(u.fields)));
})().catch(e => { log('ERR', e.message); process.exit(1); });
