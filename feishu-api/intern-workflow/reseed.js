// 用 tasks.js 重灌两张实习生表（先清空再写入）。用法：node reseed.js [InternA|InternB]
const { api } = require('../creative-exclusion/lib.js');
const cfg = require('./config.json'); const T = require('./tasks.js');
const only = process.argv[2];
(async () => {
  for (const it of T.INTERNS) {
    if (only && it.name !== only) continue;
    const tid = cfg.tables[it.name]; const base = `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tid}`;
    const old = (await api('GET', `${base}/records?page_size=500`)).items;
    if (old.length) await api('POST', `${base}/records/batch_delete`, { records: old.map((r) => r.record_id) });
    const today = Date.now();
    const records = T.TASKS.map((t) => ({ fields: {
      '任务 Task': t.task, '✅ 今日完成 Done': false, '优先级 Priority': t.pri, '频率 Frequency': t.freq, '时间点 When': t.when,
      '店铺 Shop': t.shop === '__MY__' ? it.shops : [t.shop], '权限 Permission': t.perm, '怎么做 How': t.how,
      '登记到哪 Output': t.out.replace('{group}', it.group), '手册章节 Manual §': t.sec, '来源 Source': t.src, '序号 #': t.n, '工作日期 Date': today,
    } }));
    await api('POST', `${base}/records/batch_create`, { records });
    console.log(it.name, 'deleted', old.length, 'inserted', records.length);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
