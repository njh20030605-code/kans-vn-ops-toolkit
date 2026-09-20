#!/usr/bin/env node
/**
 * 广告实习生每日工作流 · 每日自动刷新
 * ------------------------------------------------------------
 *  每天 00:10（越南时间，本机时区）跑一次：
 *   1) 把「工作日期 < 今天」的行快照进「打卡历史 History」（谁 / 哪天 / 哪项 / 打钩没 / 备注）
 *   2) 清空 ✅ 今日完成 + 今日情况，工作日期 = 今天
 *      · 每周项只在周一清空（其余日子保留勾）
 *  幂等：只处理工作日期 < 今天 的行，重复跑不会重复写历史。
 *
 *  用法：node daily-refresh.js --once [--dry-run]
 */
const { api } = require('/Users/Zhuanz1/Desktop/feishu-api/creative-exclusion/lib.js');
const cfg = require(__dirname + '/config.json');
const DRY = process.argv.includes('--dry-run');
const TZ = 'Asia/Ho_Chi_Minh';

const F = { task: '任务 Task', done: '✅ 今日完成 Done', pri: '优先级 Priority', freq: '频率 Frequency', note: '今日情况 Notes today', date: '工作日期 Date', shop: '店铺 Shop', n: '序号 #' };
const H = { task: '任务 Task', date: '日期 Date', intern: '实习生 Intern', done: '完成 Done', pri: '优先级 Priority', freq: '频率 Frequency', note: '今日情况 Notes', shop: '店铺 Shop', n: '序号 #' };

function vnDate(ts = Date.now()) {  // 越南当地 0 点的时间戳 + weekday
  const d = new Date(ts);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { ymd, midnight: Date.parse(`${ymd}T00:00:00+07:00`), weekday: p.weekday };
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function listAll(tid) {
  const out = []; let pt = '';
  do {
    const r = await api('GET', `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tid}/records?page_size=500${pt ? '&page_token=' + pt : ''}`);
    out.push(...(r.items || [])); pt = r.has_more ? r.page_token : '';
  } while (pt);
  return out;
}
const txt = (v) => Array.isArray(v) ? v.map((x) => x.text ?? x).join('') : (v ?? '');

(async () => {
  const today = vnDate();
  const isMonday = today.weekday === 'Mon';
  log(`today(VN)=${today.ymd} ${today.weekday}${DRY ? ' [dry-run]' : ''}`);
  for (const [intern, tid] of Object.entries(cfg.tables)) {
    const rows = await listAll(tid);
    const stale = rows.filter((r) => typeof r.fields[F.date] === 'number' && r.fields[F.date] < today.midnight);
    log(`${intern}: ${rows.length} rows, ${stale.length} to roll over`);
    if (!stale.length) continue;
    // 1) 快照进历史
    const hist = stale.map((r) => ({ fields: {
      [H.task]: txt(r.fields[F.task]), [H.date]: r.fields[F.date], [H.intern]: intern,
      [H.done]: !!r.fields[F.done], [H.pri]: r.fields[F.pri] || null, [H.freq]: r.fields[F.freq] || null,
      [H.note]: txt(r.fields[F.note]), [H.shop]: (r.fields[F.shop] || []).join(' / '), [H.n]: Number(r.fields[F.n]) || null,
    } }));
    // 2) 重置
    const upd = stale.map((r) => {
      const weekly = (r.fields[F.freq] || '').startsWith('每周');
      const keep = weekly && !isMonday;
      return { record_id: r.record_id, fields: keep ? { [F.date]: today.midnight } : { [F.date]: today.midnight, [F.done]: false, [F.note]: '' } };
    });
    const doneCnt = hist.filter((h) => h.fields[H.done]).length;
    log(`${intern}: snapshot ${hist.length} (done ${doneCnt}), reset ${upd.filter((u) => F.done in u.fields).length}, weekly kept ${upd.length - upd.filter((u) => F.done in u.fields).length}`);
    if (DRY) continue;
    for (let i = 0; i < hist.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.history}/records/batch_create`, { records: hist.slice(i, i + 500) });
    for (let i = 0; i < upd.length; i += 500) await api('POST', `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tid}/records/batch_update`, { records: upd.slice(i, i + 500) });
    log(`${intern}: done`);
  }
})().catch((e) => { log('ERR', e.message); process.exit(1); });
