const { api } = require('./lib');
const FOLDER = '填云盘文件夹token';
const BASE = 'https://你的域名.feishu.cn/base/填多维表格appToken';
const el = (t) => ({ text_run: { content: t } });
const H1 = (t) => ({ block_type: 3, heading1: { elements: [el(t)] } });
const H2 = (t) => ({ block_type: 4, heading2: { elements: [el(t)] } });
const P  = (t) => ({ block_type: 2, text: { elements: [el(t)] } });
const B  = (t) => ({ block_type: 12, bullet: { elements: [el(t)] } });
const O  = (t) => ({ block_type: 13, ordered: { elements: [el(t)] } });
const HR = () => ({ block_type: 22, divider: {} });

const blocks = [
  P('表格 / Table：' + BASE),
  P('你只需要打开自己店的视图（🏬 KANS Official / 🏬 KANS Globe / 🏬 One Leaf），别动其它视图。\nOpen ONLY your own shop view (🏬 KANS Official / 🏬 KANS Globe / 🏬 One Leaf). Leave the other views alone.'),
  HR(),
  H1('一、什么素材要报 / What to report'),
  P('只有两类，其它一律不报。 Only two kinds qualify — nothing else.'),
  B('近 7 天 ROI < 1.5 且 消耗 > 70 元人民币（跨境店按 $1=¥6.8 折，本土店按 ₫3,860=¥1 折）\nLast-7-day ROI < 1.5 AND cost > 70 CNY (Globe: $1 = ¥6.8; local shops: ₫3,860 = ¥1)'),
  B('手摇 / 画面低质，或者机制讲错、产品放错的素材\nShaky or low-quality footage, or wrong mechanism / wrong product in the creative'),
  HR(),
  H1('二、怎么登记 / How to log'),
  O('打开你的店视图，点最下面的 +，新增一行。Shop 会自动带上。\nOpen your shop view, click + at the bottom. Shop fills itself.'),
  O('Creative ID：从广告后台复制那串纯数字，一行一个素材。\nCreative ID: paste the digits from Ads Manager, one creative per row.'),
  O('Campaign：下拉里只有你店的计划，选一个。后台新开的计划下拉里没有？直接打字回车就加上了。\nCampaign: the dropdown shows only your shop\'s campaigns. New campaign missing? Type it and press Enter.'),
  O('Why：三选一。 Why: pick one of the three.'),
  P('就这 3 格，其它列不要碰。 That\'s all — 3 cells. Do not touch other columns.'),
  HR(),
  H1('三、机器人会做什么 / What the robot does'),
  P('每 3 分钟跑一次，你不用管。 Runs every 3 minutes, nothing to do on your side.'),
  B('你报的素材如果 Jasper 以前打过 No，⚠ Robot 列会写「已被驳回 + Jasper 当时的原话」，这行不会进 Jasper 的待审。看完照他说的改，别原样再提。\nIf Jasper already rejected that creative before, the ⚠ Robot column shows "rejected before + his original comment", and the row never reaches his queue. Read it, fix it, do not resubmit.'),
  B('以前已经 Yes 排除过的，⚠ Robot 会写「已排除过」，删掉这行。\nAlready excluded before → ⚠ Robot says so. Delete the row.'),
  B('同一批里报重了，⚠ Robot 会写「重复」，删掉多的那行。\nDuplicate within your batch → ⚠ Robot flags it. Delete the extra row.'),
  B('Jasper 一写 Notice，你会收到一张飞书卡片。\nWhenever Jasper writes a Notice you get a Feishu card.'),
  HR(),
  H1('四、Jasper 审完之后 / After Jasper reviews'),
  P('回到你的店视图，看 Jasper: Exclude? 那一列。 Back in your shop view, look at the Jasper: Exclude? column.'),
  B('Yes → 去广告后台把这条素材排除掉，回来在 Intern: Done 打钩。不打钩 = 没做完。\nYes → exclude the creative in Ads Manager, then tick Intern: Done. No tick = not done.'),
  B('No → 读 Jasper Notice，按他说的处理。这条不用执行，也不要再报。\nNo → read Jasper Notice and act on it. Nothing to execute; do not report it again.'),
  HR(),
  H1('五、别做的事 / Don\'t'),
  B('不要改 Jasper: Exclude?、Jasper Notice、⚠ Robot 三列。 Never edit Jasper: Exclude?, Jasper Notice, ⚠ Robot.'),
  B('不要在别的店的视图里加行。 Never add rows in another shop\'s view.'),
  B('不要删除已经有 Yes / No 的行，那是机器人的记忆。 Never delete rows that already have Yes / No — that is the robot\'s memory.'),
  B('不要改视图的筛选和分组。 Never change view filters or grouping.'),
  HR(),
  H2('一句话版 / One-liner'),
  P('自己店视图 → + 新行 → 填 Creative ID / Campaign / Why → 等 Jasper → Yes 就去排除并打钩，No 就看 Notice 改，⚠ 有字就别再提。\nYour shop view → + row → Creative ID / Campaign / Why → wait for Jasper → Yes: exclude & tick; No: read Notice & fix; ⚠ has text: do not resubmit.'),
];

(async () => {
  const doc = await api('POST', '/open-apis/docx/v1/documents', { title: '素材排除表 · 实习生培训手册 / Creative Exclusion — Intern Guide', folder_token: FOLDER });
  const id = doc.document.document_id;
  for (let i = 0; i < blocks.length; i += 40)
    await api('POST', `/open-apis/docx/v1/documents/${id}/blocks/${id}/children`, { children: blocks.slice(i, i + 40) });
  console.log('https://你的域名.feishu.cn/docx/' + id);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
