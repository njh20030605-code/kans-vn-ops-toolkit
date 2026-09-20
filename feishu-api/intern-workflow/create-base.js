// 一次性：创建「广告实习生每日工作流」多维表格（Ryan / Pham 各一张 + 打卡历史）
const { api } = require('/Users/Zhuanz1/Desktop/feishu-api/creative-exclusion/lib.js');
const fs = require('fs');
const T = require('./tasks.js');
const FOLDER = 'EmnkfFX7olLdS3driGScabKfnxd';
const CFG = __dirname + '/config.json';

const opt = (names, colors) => ({ options: names.map((n, i) => ({ name: n, color: colors ? colors[i] : i % 10 })) });
const PRI_OPTS = opt([T.P0, T.P1, T.P2], [0, 1, 4]);           // 红 / 橙 / 蓝
const FREQ_OPTS = opt([T.HOURLY, T.TWICE, T.DAILY, T.WEEKLY], [2, 3, 5, 6]);
const PERM_OPTS = opt([T.RO, T.WITH, T.APPR], [4, 3, 0]);
const SRC_OPTS = opt([T.MANUAL, T.CHAT16, T.CHAT17, T.CHAT18], [7, 5, 5, 5]);
const SHOP_OPTS = opt(['KANS Globe', 'One Leaf', 'KANS Official', '全部 All'], [4, 4, 0, 7]);

function internFields() {
  return [
    { field_name: '任务 Task', type: 1 },
    { field_name: '✅ 今日完成 Done', type: 7 },
    { field_name: '优先级 Priority', type: 3, property: PRI_OPTS },
    { field_name: '频率 Frequency', type: 3, property: FREQ_OPTS },
    { field_name: '时间点 When', type: 1 },
    { field_name: '店铺 Shop', type: 4, property: SHOP_OPTS },
    { field_name: '权限 Permission', type: 3, property: PERM_OPTS },
    { field_name: '怎么做 How', type: 1 },
    { field_name: '登记到哪 Output', type: 1 },
    { field_name: '今日情况 Notes today', type: 1 },
    { field_name: '工作日期 Date', type: 5, property: { date_formatter: 'yyyy/MM/dd' } },
    { field_name: '手册章节 Manual §', type: 1 },
    { field_name: '来源 Source', type: 3, property: SRC_OPTS },
    { field_name: '序号 #', type: 2, property: { formatter: '0' } },
    { field_name: '最后更新 Updated', type: 1002, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
  ];
}
function historyFields() {
  return [
    { field_name: '任务 Task', type: 1 },
    { field_name: '日期 Date', type: 5, property: { date_formatter: 'yyyy/MM/dd' } },
    { field_name: '实习生 Intern', type: 3, property: opt(T.INTERNS.map((i) => i.name), [4, 6]) },
    { field_name: '完成 Done', type: 7 },
    { field_name: '优先级 Priority', type: 3, property: PRI_OPTS },
    { field_name: '频率 Frequency', type: 3, property: FREQ_OPTS },
    { field_name: '今日情况 Notes', type: 1 },
    { field_name: '店铺 Shop', type: 1 },
    { field_name: '序号 #', type: 2, property: { formatter: '0' } },
  ];
}

(async () => {
  const app = await api('POST', '/open-apis/bitable/v1/apps', { name: '广告实习生每日工作流 · Ads Intern Daily Workflow', folder_token: FOLDER });
  const appToken = app.app.app_token;
  console.log('app', appToken, app.app.url);
  const cfg = { appToken, url: app.app.url, tables: {}, history: null, createdAt: new Date().toISOString() };

  // 原始默认表稍后删
  const t0 = (await api('GET', `/open-apis/bitable/v1/apps/${appToken}/tables`)).items.map((t) => t.table_id);

  for (const it of T.INTERNS) {
    const r = await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables`, {
      table: { name: `${it.name} · 每日工作流 Daily`, default_view_name: '📋 今日清单 Today', fields: internFields() },
    });
    cfg.tables[it.name] = r.table_id;
    console.log('table', it.name, r.table_id);
    const today = Date.now();
    const records = T.TASKS.map((t) => ({
      fields: {
        '任务 Task': t.task,
        '✅ 今日完成 Done': false,
        '优先级 Priority': t.pri,
        '频率 Frequency': t.freq,
        '时间点 When': t.when,
        '店铺 Shop': t.shop === '__MY__' ? it.shops : [t.shop],
        '权限 Permission': t.perm,
        '怎么做 How': t.how,
        '登记到哪 Output': t.out.replace('Ryan 工作群', it.group),
        '手册章节 Manual §': t.sec,
        '来源 Source': t.src,
        '序号 #': t.n,
        '工作日期 Date': today,
      },
    }));
    await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${r.table_id}/records/batch_create`, { records });
    console.log('  records', records.length);
    // 视图：按优先级看板 + 未完成
    for (const v of [{ view_name: '🗂 按优先级 By priority', view_type: 'kanban' }, { view_name: '⏳ 未完成 Not done', view_type: 'grid' }]) {
      const vr = await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${r.table_id}/views`, v).catch((e) => ({ err: e.message }));
      console.log('  view', v.view_name, vr.view ? vr.view.view_id : vr.err);
    }
  }
  const h = await api('POST', `/open-apis/bitable/v1/apps/${appToken}/tables`, {
    table: { name: '打卡历史 History', default_view_name: '全部 All', fields: historyFields() },
  });
  cfg.history = h.table_id;
  console.log('history', h.table_id);
  for (const id of t0) await api('DELETE', `/open-apis/bitable/v1/apps/${appToken}/tables/${id}`).catch((e) => console.log('del default fail', e.message));
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  console.log('config saved', CFG);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
