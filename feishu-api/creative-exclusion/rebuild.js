const { api } = require('./lib');
const CFG = require('./config.json');
const APP = CFG.app_token;
const OLD = ['tbl填表ID', 'tbl填表ID', 'tbl填表ID'];
const sel = (o, colors) => ({ options: o.map((n, i) => ({ name: n, color: colors ? colors[i] : [1,4,7,10,2,5,0,3,6,8,9,11,12,13,14,15,16,17][i % 18] })) });

const CAMPAIGNS = {
  'KANS Official': ['MKT-白精华-White Essence-0708','MKT-素颜霜-tone-up cream-0708','MKT-红精华-Red Serum-0708','OL-白精华-White Essence single-0715','MKT-红面霜-Red Cream-0803','MKT-红洁面-Red cleanser-0708','Kans Official Vietnam-0811','KANS khoa học trẻ hóa 0708','KANS SKINCARE VIETNAM 0708'],
  'KANS Globe':    ['MKT-红运粉饼-Red Fortune Powder Palette-0819','MKT-防晒-White sunscreen-0830','MKT-祛痘次抛Anti Acne-0906','MKT-377次抛-377 Serum-0825','377次抛测试','直播间-防晒10条','tiktok-跨境店-0812'],
  'One Leaf':      ['maks buy two get one 买二送一7月10日','One leaf official-0903'],
};
// 店铺 → 计划 的映射以 config.json 的 campaign_shop 为准（上面的常量只是历史示例）
const SHOPS = CFG.shops || [...new Set(Object.values(CFG.campaign_shop))];
const allCamps = Object.keys(CFG.campaign_shop);

const desc = (t) => ({ disable_sync: true, text: t });
const fields = [
  { field_name: 'Creative ID',      type: 1, description: desc('素材ID，后台那串纯数字直接粘 / Creative ID from Ads Manager, digits only') },
  { field_name: 'Shop',             type: 3, property: sel(SHOPS, [1, 4, 7]), description: desc('店铺。在分组下点 + 新增会自动带上，选了 Campaign 机器人也会补 / Shop — auto-filled when you add a row under the group or pick a campaign') },
  { field_name: 'Campaign',         type: 3, property: sel(allCamps), description: desc('广告计划，下拉选；新计划在下拉里输入回车即可新增 / Campaign — pick from list, type + Enter to add a new one') },
  { field_name: 'Why',              type: 3, property: sel(['ROI<1.5 & Cost>70 CNY (7d)', 'Shaky / low-quality footage', 'Wrong mechanism / wrong product'], [1, 4, 7]), description: desc('排除原因，只有三种 / Reason — only these three qualify') },
  { field_name: 'Jasper: Exclude?', type: 3, property: sel(['Yes', 'No'], [8, 1]), description: desc('Jasper 填：Yes 排除 / No 驳回 — Jasper only: Yes = exclude, No = rejected') },
  { field_name: 'Jasper Notice',    type: 1, description: desc('Jasper 填，打 No 必写原因；会自动推给实习生，重复提交时原样弹出 / Jasper only — why No. Auto-sent to intern and shown again if resubmitted') },
  { field_name: 'Intern: Done',     type: 7, description: desc('实习生填，后台真的排除掉了再打钩 / Intern — tick after the creative is actually excluded in Ads Manager') },
  { field_name: '⚠ Robot',          type: 1, description: desc('机器人写，别动。有字 = 这条以前处理过，读完别再提 / Robot-written. Text here = handled before, read it and do not resubmit') },
  { field_name: 'Submitted',        type: 1001, property: { date_formatter: 'yyyy/MM/dd HH:mm' }, description: desc('登记时间，自动 / Auto timestamp') },
];

(async () => {
  const t = await api('POST', `/open-apis/bitable/v1/apps/${APP}/tables`, { table: { name: '素材排除 · Creative Exclusion', default_view_name: '① 登记 · All（按店分组）', fields } });
  const T = t.table_id;
  const fl = await api('GET', `/open-apis/bitable/v1/apps/${APP}/tables/${T}/fields?page_size=50`);
  const fid = (n) => fl.items.find(f => f.field_name === n).field_id;

  // 视图 1：全部，按店分组，最新在上
  await api('PATCH', `/open-apis/bitable/v1/apps/${APP}/tables/${T}/views/${t.default_view_id}`, { property: {
    group_info: [{ field_id: fid('Shop'), desc: false }],
    sort_info: [{ field_id: fid('Submitted'), desc: true }] } });
  // 视图 2：Jasper 待审 = 还没打 Yes/No 且机器人没打⚠
  const v2 = await api('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${T}/views`, { view_name: '② Jasper 待审', view_type: 'grid' });
  await api('PATCH', `/open-apis/bitable/v1/apps/${APP}/tables/${T}/views/${v2.view.view_id}`, { property: {
    filter_info: { conjunction: 'and', conditions: [
      { field_id: fid('Jasper: Exclude?'), operator: 'isEmpty' },
      { field_id: fid('⚠ Robot'), operator: 'isEmpty' } ] },
    group_info: [{ field_id: fid('Shop'), desc: false }] } });

  for (const o of OLD) await api('DELETE', `/open-apis/bitable/v1/apps/${APP}/tables/${o}`);
  console.log(JSON.stringify({ table: T, view_all: t.default_view_id, view_jasper: v2.view.view_id, campaigns: CAMPAIGNS }, null, 2));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
