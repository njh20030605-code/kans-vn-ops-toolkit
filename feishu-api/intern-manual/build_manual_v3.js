// 生成《KANS 越南广告投放 · 实习生培训手册 v3》到飞书 docx
const { api } = require('/Users/Zhuanz1/Desktop/feishu-api/creative-exclusion/lib.js');
const FOLDER = 'EmnkfFX7olLdS3driGScabKfnxd';

// ---------- 链接 ----------
const L = {
  old: 'https://gvh59x1f62p.feishu.cn/docx/XkJCdj5rzokSiZxxZTKcO4SUnSb',
  kolOfficial: 'https://gvh59x1f62p.feishu.cn/wiki/QwFMw71OSih8BlkMzy1cZCudnaf?table=tblxbapYiZLAruwn&view=vewuXKv226',
  kolGlobe: 'https://gvh59x1f62p.feishu.cn/wiki/QwFMw71OSih8BlkMzy1cZCudnaf?table=tblxbapYiZLAruwn&view=vewTgJTVTM',
  kolError: 'https://gvh59x1f62p.feishu.cn/wiki/QwFMw71OSih8BlkMzy1cZCudnaf?table=tblxbapYiZLAruwn&view=vewGfn7dRe',
  olCode: 'https://gvh59x1f62p.feishu.cn/wiki/V9BMwWjdPiYTG0kP0rccXXCunUf',
  exclBase: 'https://gvh59x1f62p.feishu.cn/base/XijobxWUVaaWbtsAJ6ocbg1Kn2g?table=tblGYc5IntNPGC8D&view=vewYbP4OZx',
  exclOfficial: 'https://gvh59x1f62p.feishu.cn/base/XijobxWUVaaWbtsAJ6ocbg1Kn2g?table=tblGYc5IntNPGC8D&view=vewQorgbL3',
  exclGlobe: 'https://gvh59x1f62p.feishu.cn/base/XijobxWUVaaWbtsAJ6ocbg1Kn2g?table=tblGYc5IntNPGC8D&view=vewalv456g',
  exclOneLeaf: 'https://gvh59x1f62p.feishu.cn/base/XijobxWUVaaWbtsAJ6ocbg1Kn2g?table=tblGYc5IntNPGC8D&view=vew9heRfPX',
  exclGuide: 'https://gvh59x1f62p.feishu.cn/docx/AYsqdxYXxofWMoxDsHLcZ4Evnpg',
  codeSop: 'https://gvh59x1f62p.feishu.cn/docx/S2cAdoGlvonzDrxvlXzcsB2AnJb',
  dailySheet: 'https://gvh59x1f62p.feishu.cn/sheets/B3eWsz6oehcp3GtBGqQctfg2nYb?sheet=W6ek7R',
  dailyTpl: 'https://gvh59x1f62p.feishu.cn/docx/PVRYdTKT3oZ7hExDYBRcGezwnRd',
  adsMgr: 'https://ads.tiktok.com/i18n/manage/adgroup',
  sellerVN: 'https://seller-vn.tiktok.com',
  sellerGlobal: 'https://seller.tiktokshopglobalselling.com',
  playbook: 'https://ads.tiktok.com/resources/help/article/about-gmv-max-pro?lang=zh',
  helpCenter: 'https://ads.tiktok.com/resources/help?lang=zh',
};

// ---------- 迷你标记：**粗体**  [文字](url) ----------
function elems(s) {
  const out = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text_run: { content: s.slice(last, m.index) } });
    if (m[1] !== undefined) out.push({ text_run: { content: m[1], text_element_style: { bold: true } } });
    else out.push({ text_run: { content: m[2], text_element_style: { link: { url: encodeURIComponent(m[3]) } } } });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text_run: { content: s.slice(last) } });
  return out.length ? out : [{ text_run: { content: '' } }];
}

// ---------- 块构造（返回 {node, extra[]} 形式统一交给 flatten） ----------
let seq = 0;
const nid = () => 'b' + (++seq);
const leaf = (type, key, s, style) => ({ block_id: nid(), block_type: type, [key]: { elements: elems(s), ...(style ? { style } : {}) } });
const H1 = (s) => leaf(3, 'heading1', s);
const H2 = (s) => leaf(4, 'heading2', s);
const H3 = (s) => leaf(5, 'heading3', s);
const P = (s) => leaf(2, 'text', s);
const B = (s) => leaf(12, 'bullet', s);
const O = (s) => leaf(13, 'ordered', s);
const TODO = (s) => leaf(17, 'todo', s, { done: false });
const HR = () => ({ block_id: nid(), block_type: 22, divider: {} });

// 高亮块：color 1红 2橙 3黄 4绿 5蓝 6紫 7灰
function CALLOUT(lines, { color = 5, emoji = 'bulb' } = {}) {
  const kids = lines.map((s) => P(s));
  return {
    node: { block_id: nid(), block_type: 19, callout: { background_color: color, border_color: color, emoji_id: emoji }, children: kids.map((k) => k.block_id) },
    extra: kids,
  };
}

// 表格：rows = [[...],[...]]，第一行为表头
function TABLE(rows, widths) {
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = [], texts = [];
  for (const r of rows) for (let c = 0; c < cols; c++) {
    const t = P(r[c] ?? '');
    const cell = { block_id: nid(), block_type: 32, table_cell: {}, children: [t.block_id] };
    cells.push(cell); texts.push(t);
  }
  const prop = { row_size: rows.length, column_size: cols, header_row: true };
  if (widths) prop.column_width = widths;
  return { node: { block_id: nid(), block_type: 31, table: { property: prop }, children: cells.map((c) => c.block_id) }, extra: [...cells, ...texts] };
}

function flatten(items) {
  const children_id = [], descendants = [];
  for (const it of items) {
    if (it.node) { children_id.push(it.node.block_id); descendants.push(it.node, ...it.extra); }
    else { children_id.push(it.block_id); descendants.push(it); }
  }
  return { children_id, descendants };
}

// ---------- 内容 ----------
const W = 720;                       // 表格总宽
const w = (...parts) => { const s = parts.reduce((a, b) => a + b, 0); return parts.map((p) => Math.round(p / s * W)); };

const sections = [];

// 封面
sections.push([
  CALLOUT([
    '**v3 · 2026-09-15 精简版** · 替代 v2（2026-08）。v2 原文保留在 [这里](' + L.old + ') 作参考，不再更新。',
    '怎么用这本手册：**第 03、04、05 章是每天照着做的**；01、02、06、07、08 第一周要读熟；09–11 是背景知识，随用随查。',
    '权限三色：🟢 只读 = 只看不动 ｜ 🟡 带教陪同 = 带教人在场或屏幕共享才操作 ｜ 🔴 带教审批 = 先登记 / 提方案，批准后才执行。',
  ], { color: 5, emoji: 'books' }),
  H1('v3 相比 v2 改了什么'),
  B('**KANS Official 与 KANS Globe 的 KOL 投流码**改用新表「KOL ADS TRACKING」（达人资源库 KOL Pool 新表），旧 Google 表停用。'),
  B('**KOC 投流码**会用另一张表，制作中；**One Leaf 一叶子**新表也制作中，出来之前继续用原表 [OL] Ads Tracking。'),
  B('**素材巡检改为每天必做**，巡检结果统一登记到多维表格「素材排除 · Creative Exclusion」，旧的「素材排除清单-审核」电子表格停用。'),
  B('排除标准统一为表里的三个 Why（一条数值标准 + 两条质量标准），三家店走同一张表，由 Jasper 统一审批。'),
  B('**品牌广告本阶段不上手**，只保留认知章节，后续单独培训再接手；FB → Shopee 待定，不排进日常。'),
  B('删掉了小测和大段「为什么」，每章只留最多 4 条常见错误。'),
]);

// 01 岗位铁律
sections.push([
  H1('01 岗位铁律'),
  H2('一条汇报线'),
  P('**带教人 = 汇报人 = 杨佳林(Jasper)。** 所有指令、审批、异常都走这一条线。'),
  P('BD / 达人 / 主播 / 其他部门 / 外部合作方 让你改广告、加预算、上素材 → 统一回「我先跟带教人确认」，然后把**原话 + 截图**转给带教人，等指令。你不需要判断对方说得对不对。'),
  P('**唯一可以先动手的紧急情况**：直播断播时暂停直播广告，然后立刻报。方向是省钱、动作可逆，才允许。'),
  H2('哪些事你能做、哪些要批'),
  TABLE([
    ['动作', '权限', '说明'],
    ['看数据、截图、登记、发日报 / 预警', '🟢 只读', '每天的主体工作'],
    ['添加投流码', '🟡 带教陪同', '前两周陪同，熟练后独立；SOP 见 04 章'],
    ['排除素材', '🔴 带教审批', '先登记到巡检表 → Jasper 打 Yes → 你再去后台执行'],
    ['改预算 / 改 ROI 目标 / 新建计划 / 改排期 / 加删素材', '🔴 带教审批', '哪怕你判断对了，没批就是越权'],
    ['账户设置、支付方式、成员权限、换主体', '⛔ 永远不做', '账户级操作不在这个岗位的权限内'],
  ], w(3, 1.2, 3.2)),
  H2('红线（一次即事故）'),
  O('未批准就改预算 / 关素材 / 改 ROI 目标；或动不属于你负责的账户。'),
  O('对外承诺预算、投放量、给达人报价、答应「一定会投你的视频」。'),
  O('把广告数据、素材、达人清单、竞品数据外发 —— 包括发给达人、外部群、个人网盘。'),
  O('把账号密码 / Cookie 贴进任何工具（含 AI）或告诉任何人。'),
  O('编数据、删历史记录。取不到就写「取不到 + 原因」，写错就在下面更正。'),
  O('出错藏着不说。广告的错只有一个救法：早报。'),
  H2('沟通与做事原则'),
  B('简单、高效、直接。问之前先自己试过所有办法；回复要快，前期反应速度决定第一印象。'),
  B('汇报不说模糊词。「ROI 不太好」不是汇报，**数字 + 截图 + 你的判断**才是。'),
  B('所有工作沟通都在有带教人的群里，不和其他同事私聊工作。'),
  B('周末不失联，广告不休假；账户每天都要有人看。'),
  B('计价统一用人民币 / 美元双币并列；所有表格文档只用飞书。'),
  B('接任务先想清：目标是什么、截止什么时候、怎么验收、要先确认什么。不要闷头做完交一个错的。'),
]);

// 02 战线地图
sections.push([
  H1('02 战线地图'),
  P('看到任何一个数字，先问「这是哪条战线的」。答不出来，这个数字就不能用。**四条战线永远分表分行，不做总 ROI。**'),
  TABLE([
    ['#', '店铺 / 战线', '广告类型', '看什么', '你现在的角色'],
    ['1', 'KANS Official（本土店，₫）', 'GMV Max 商品卡 + 直播', '消耗 / GMV / ROI / 素材集中度', '先了解，逐步接手投流码与巡检'],
    ['2', 'KANS Globe（跨境店，USD）', 'GMV Max', '同 1；体量不同，经验不能照搬；退款口径与本土不同', '**前期重点**'],
    ['3', 'One Leaf 一叶子（本土店，₫）', 'GMV Max', '同 1；预算小、波动大，单日 ROI 波动不算异常', '**前期重点**'],
    ['4', 'KANS Official 品牌广告（C-ads）', '种草广告', 'CPCo / 意向人群 / 频次 / 漏斗，**不看当天 ROI**', '只了解，不操作（见 11 章）'],
    ['5', 'FB → Shopee', 'Facebook 广告', '待定', '不排进日常'],
  ], w(0.4, 2.2, 1.6, 3, 2)),
  CALLOUT(['一句话记住：**GMV Max 赚今天的钱（收割），品牌广告修明天的转化率（种草）。** 种草是地基，收割是增长。'], { color: 4, emoji: 'seedling' }),
  H2('常见错误'),
  B('用一个总 ROI 描述几条战线 —— 没有这个数，别造它。'),
  B('一叶子某天 ROI 掉了就报异常 —— 先看消耗量级和订单数，样本太小不叫异常；任何砍预算建议都要带近 7 天数据。'),
  B('拿品牌广告的消耗算 ROI 然后说它亏 —— 口径错了。'),
  B('跨境店 ROI 高就建议加预算 —— 先看退款率和物流投诉。'),
]);

// 03 每天怎么干
sections.push([
  H1('03 每天怎么干'),
  P('按时间线走。**前期先做 KANS Globe 和 One Leaf，KANS Official 边看边熟。** 一件事做稳了再加下一件，不要求第一周全做完，但每周要有进度。'),
  TABLE([
    ['时间', '做什么', '店铺', '登记到哪', '权限'],
    ['09:15 前', '发昨日数据日报：商品卡、直播分开写；周一加周报', '你负责的店', '[ads广告Intern-日报登记表](' + L.dailySheet + ')', '🟢'],
    ['11:00 / 17:00', '添加投流码 + 三一致检查（04 章）', 'Official / Globe 用 KOL 新表；One Leaf 用原表', '投流码表里勾状态 / 写反馈', '🟡'],
    ['每小时', '素材巡检（05 章）：跑飞、近 7 天低效、手摇 / 错机制 / 过期活动', '全部', '[素材排除 · Creative Exclusion](' + L.exclBase + ') 自己店的视图', '🔴 登记后等审批'],
    ['每天 1 次', '广告余额：余额 ÷ 近 7 天日均消耗 < 7 天 → 立刻报（06 章）', '全部账户', '群里，带截图', '🟢'],
    ['每天 2 次', '专查过期活动 / 错误机制素材（例：9.9 期间还挂 8.8 机制）', '全部', '巡检表，Why 选 Wrong mechanism', '🔴'],
    ['下班前', '日报总结（07 章模板）。巡检无异常也写「已巡检，无异常」', '全部', '群 + 日报模板', '🟢'],
  ], w(1.1, 3.2, 1.8, 2.4, 1)),
  H2('每次取数前确认三件事'),
  B('**时区**：越南时间 UTC+7，后台时区设好后不要再改。'),
  B('**日期范围**：「昨天」「近 7 天」「本月」是三个不同结论，报数必须写清。判断素材一律用近 7 天。'),
  B('**币种**：后台是 ₫ 还是 USD？折人民币按内部汇率 ₫3,860 ≈ ¥1、$1 = ¥6.8，不要自己上网查。'),
  H2('浏览器书签命名'),
  P('格式「店铺-用途」，例：KANS本土-GMVMax、跨境-卖家中心、一叶子-CODE表。几个店的后台长得一样，不按店铺命名，早晚在错的店里改东西。**操作前后各截一张图。**'),
]);

// 04 投流码
sections.push([
  H1('04 投流码添加 SOP'),
  H2('4.1 码从哪来（2026-09 更新）'),
  TABLE([
    ['店铺 · 达人类型', '用哪张表', '打开哪个视图', '状态'],
    ['KANS Official · KOL', '[KOL ADS TRACKING](' + L.kolOfficial + ')（达人资源库 KOL Pool 新表）', 'ADS working-OFFICIAL', '✅ 已启用；旧 Google 表停用'],
    ['KANS Globe · KOL', '同一张表', '[Ads working-Globe](' + L.kolGlobe + ')', '✅ 已启用'],
    ['Official / Globe · KOC', 'KOC 投流码表', '—', '🛠 制作中，上线前听带教人现场安排'],
    ['One Leaf 一叶子', '[OL Ads Tracking 原表](' + L.olCode + ')', '—', '🛠 新表制作中，出来前继续用原表'],
    ['直播间素材', '不归你', '—', '由剪辑老师添加'],
  ], w(1.8, 3, 1.8, 2.4)),
  H2('4.2 新表怎么用（Official / Globe）'),
  P('视图逻辑：一行出现在「ADS working」视图 = **已有 Ad Code**，且你**还没勾「Paid traffic -ROI」**，且**「Ad Code Feedback」为空**。视图是实时筛选，处理完的行自动消失。'),
  O('打开自己店的视图，从上往下逐行处理。'),
  O('每一行先做**三一致检查**（4.3）。'),
  O('通过 → 去对应店铺的 GMV Max 后台添加投流码。后台按钮位置见 [商品卡CODE添加GMVMAX-操作SOP](' + L.codeSop + ')。'),
  O('加完回到表里：勾 **Paid traffic -ROI**、填 **Ad Placement Date** = 今天、**Ads planner** 选自己。这行会自动从视图消失。'),
  O('不通过 → 在 **Ad Code Feedback** 写清哪条码、哪里不一致，截图发群里；**不要勾选**。这行会自动移到 [错误待修改](' + L.kolError + ') 视图，BD 改好并清空反馈后会自动回到 ADS working，等你二次处理。'),
  CALLOUT(['你只动 4 格：Paid traffic -ROI / Ad Placement Date / Ads planner / Ad Code Feedback。其他列都是 BD 的，不改、不填、不猜。'], { color: 2, emoji: 'warning' }),
  H2('4.3 三一致检查'),
  TABLE([
    ['#', '检查什么', '怎么验', '不一致怎么办'],
    ['1', '投流码 ↔ 达人 / 视频', '打开投流码链接，视频内容和达人账号与表里一致', '写反馈，不改、不猜'],
    ['2', '视频 ↔ 产品', '视频里讲的产品、卖点、赠品 = 表里 Product 列要投的产品', '写反馈 + 报带教人'],
    ['3', '投放链接 ↔ 店铺 / SKU / 价格', '点开商品链接：正确店铺（本土 / 跨境不能混）、正确 SKU、价格和活动一致', '停止添加，写反馈 + 报带教人'],
  ], w(0.4, 2, 3.6, 2.4)),
  P('为什么三条要一起验：视频讲 A 产品、链接挂 B 产品，用户点进来发现不对 → 转化率崩、退款率涨，而后台 ROI 只会告诉你「这条素材不行」，不会告诉你「链接挂错了」。这类错只能在添加时拦住。'),
  P('和 BD 的边界：CODE、达人、素材来源、授权归 BD。你只做 **验 → 反馈 → 登记 → 等更正后再加**。BD 不回或坚持要你照原样加 → 转给带教人。'),
  H2('常见错误'),
  B('只核对码，不打开看视频和链接 —— 九成隐性错误藏在这里。'),
  B('发现链接不对，自己顺手换一条「看起来对」的 —— 越权，而且你不知道该达人授权的是哪条。'),
  B('在跨境店后台加本土店的码 —— 后台界面一样，靠书签名和店铺名核对。'),
  B('加完不回表勾选 —— 第二天你和 BD 都不知道哪条加过了，重复添加。'),
]);

// 05 巡检与排除
sections.push([
  H1('05 素材巡检与排除（每天必做）'),
  H2('5.1 每小时看什么'),
  TABLE([
    ['类型', '怎么认', '为什么危险'],
    ['跑飞素材', '**当天**：半小时左右突然消耗几百、上千（¥），ROI < 1', '吸走整个计划的日预算，好素材拿不到量'],
    ['低效素材', '**近 7 天**：消耗 > ¥70 且 ROI < 1.5', '持续漏钱'],
    ['低质 / 错误素材', '手摇晃动、模糊、无字幕、纯搬运；机制讲错、产品放错；活动已过期', '拉低账户质量、误导用户、合规风险'],
  ], w(1.4, 4, 3)),
  P('巡检路线：素材报表 → 日期选**近 7 天** → 按**消耗降序** → 从上往下筛；再切「今天」看有没有消耗陡增。'),
  P('换算：¥70 ≈ 270K₫（₫3,860 ≈ ¥1）≈ $10.3（$1 = ¥6.8）。跨境店按 USD 折。'),
  H2('5.2 排除标准 = 表里的三个 Why'),
  TABLE([
    ['Why（表里原文）', '条件', '说明'],
    ['ROI<1.5 & Cost>70 CNY (7d)', '近 7 天**同时**满足', '三店统一门槛。KOL 达人素材也照样登记，是否排除由 Jasper 结合商务关系决定'],
    ['Shaky / low-quality footage', '手摇、模糊、无字幕、纯搬运', '不看数据，直接登记'],
    ['Wrong mechanism / wrong product', '机制 / 价格 / 赠品与当前活动不一致，或产品放错', '不看数据，直接登记'],
  ], w(2.6, 2.4, 3.6)),
  P('不在这三条里的，不登记。消耗没过门槛的低 ROI 没有统计意义。'),
  H2('5.3 登记流程'),
  P('表格：**素材排除 · Creative Exclusion**。只用自己店的视图：[🔥 KANS Official](' + L.exclOfficial + ') ／ [🌍 KANS Globe](' + L.exclGlobe + ') ／ [🍃 One Leaf](' + L.exclOneLeaf + ')。'),
  O('在自己店的视图底部点 **+** 新增一行，Shop 会自动带上。'),
  O('**Creative ID**：从广告后台复制那串纯数字，一行一条素材。'),
  O('**Campaign**：下拉里只有你店的计划，选一个；新计划没有就直接打字回车。'),
  O('**Why**：三选一。就这 3 格，其他列不碰。'),
  O('等 Jasper 审。**Exclude? = Yes** → 去后台把这条素材排除 → 回来勾 **Intern: Done**（不打钩 = 没做完）。**= No** → 读 **Jasper Notice** 照他说的处理，这条不执行、不再提。'),
  O('**⚠ Robot 有字** = 以前处理过（被驳回 / 已排除 / 本批重复）。读完别再提；重复的那行删掉。'),
  CALLOUT([
    '机器人每 3 分钟跑一次，你不用管。Jasper 一写 Notice，你会收到一张飞书卡片。',
    '别做的事：不改 Jasper: Exclude? / Jasper Notice / ⚠ Robot 三列；不在别的店视图加行；不删已有 Yes / No 的行（那是机器人的记忆）；不改视图筛选和分组。',
  ], { color: 2, emoji: 'robot_face' }),
  H2('5.4 排除的纪律'),
  B('排除有代价：系统会丢掉已学到的信号，量和 ROI 短期会抖。单个计划单日一般不超过 2–3 条，排完观察 24 小时。'),
  B('只用近 7 天判断，不用单日。刚上线 3 天内的素材在学习期，登记时在群里备注「上线 X 天」。'),
  B('退款率高但转化率正常 → 是商品 / 物流问题，转运营，不是排除素材。'),
  B('预警程序或看板的输出只是**候选清单**，不是判决书，仍要过 5.2 的标准再登记。'),
  H2('常见错误'),
  B('ROI 低就报，不看消耗门槛。'),
  B('没批准就先排除，事后报备 —— 排除不在你的授权范围。'),
  B('一次登记十几条同一计划的素材 —— 广告会剧烈波动，之后分不清原因。'),
  B('无异常就不发消息 —— 带教人分不清「今天没事」和「今天没查」。'),
]);

// 06 余额与预警
sections.push([
  H1('06 广告余额与预警'),
  B('**每天 1 次**：可跑天数 = 当前余额 ÷ 近 7 天日均消耗。**< 7 天立刻报**，周末和大促前要留更多。'),
  B('断流比多花钱严重：广告重新进入学习期，恢复起量的损失通常大于省下的预算。所以提前报，不要等到 0。'),
  B('预警四要素：**数字 + 截图 + 你的判断 + 建议动作**。「余额好像不多了」不算预警。'),
  B('分级：🔴 立刻（断流 / 账户异常 / 单素材暴烧）→ 电话或直接 @ ｜ 🟡 当天（ROI 持续低于目标）→ 日报标红 ｜ 🟢 趋势问题 → 周报。'),
  B('宁可多报一次，不要漏报一次。误报的成本是带教人看一眼；漏报的成本是烧掉的钱。'),
  CALLOUT([
    '【广告余额】9/15 · KANS Official：余额 X₫ / ¥X · 近 7 天日均消耗 ¥X · 可跑约 X 天 → 🟢 正常 / 🟡 建议本周充值 / 🔴 三天内断流',
    '建议：请在 9/18 前充值，否则周末会断流（周末消耗更高）。截图：余额页 1 张。',
  ], { color: 3, emoji: 'memo' }),
]);

// 07 汇报与日报
sections.push([
  H1('07 汇报与日报'),
  H2('报数的标准句'),
  P('**战线 · 日期（越南时间）· 口径 · 数字 · 截图**，五样缺一不可。'),
  P('例：「KANS Official · 商品卡 · 9/14 · GMV 口径 · 消耗 386K₫ / ¥100 · ROI 2.4 · 订单 XX · 退款率 X%（截图见附件）」。'),
  H2('日报怎么写'),
  P('模板在 [每日 日报模版](' + L.dailyTpl + ')，可以自己改，但结构不变：'),
  O('各店 **商品卡 / 直播** 昨日消耗、GMV、ROI —— 一店一行，不合并。'),
  O('投流码：今天加了几条、退回几条、退回原因。'),
  O('巡检：登记几条、Jasper 批了几条、执行了几条。无异常也写「已巡检，无异常」。'),
  O('余额：各账户可跑天数。'),
  O('问题与需要带教人决定的事。'),
  H2('规范'),
  B('截图要带日期和店铺名；不用手机拍屏（不算交付物，也有泄密风险）。'),
  B('取不到的数写「取不到 —— 原因」，不留空、不估。留空会被当成 0，估数会污染后面所有分析。'),
  B('周一日报加周报：本周 vs 上周环比。'),
]);

// 08 出错怎么办
sections.push([
  H1('08 出错怎么办'),
  P('三条职业底线：**不编数 · 不藏错 · 不越权。** 守住这三条，其他都能教。'),
  P('发现错误**立刻**报（现在，不是等日报）。烧一小时能救，藏得越久越救不回来。先偷偷改回来再不报，是比犯错严重得多的事。'),
  CALLOUT([
    '【异常 / 失误上报】9/15 15:40 · KANS Official · 商品广告',
    '发生了什么：我把广告组 1234567890 的日预算从 500K₫ 误改为 5,000K₫',
    '什么时候发现：15:35（改动时间 09:20）',
    '影响：期间多消耗约 X₫ / ¥X（截图）',
    '我已经做了：立即改回 500K₫（操作前后各一张截图）',
    '需要你决定：是否停投观察 / 是否上报',
    '复盘：哪一步跳过了对照检查，之后怎么防',
  ], { color: 1, emoji: 'rotating_light' }),
]);

// 09 必背概念
sections.push([
  H1('09 必背概念（第一周背完）'),
  TABLE([
    ['指标', '一句话', '类别'],
    ['消耗 Cost', '广告花掉的钱，注意币种', '花钱'],
    ['CPM / CPC', '千次曝光成本 / 单次点击成本', '花钱'],
    ['CPCo', '每获得一个意向受众的成本，品牌广告核心指标', '花钱'],
    ['GMV', '成交金额，**含退款**', '成交'],
    ['NMV', '扣掉退款取消后的净额，这才是真钱', '成交'],
    ['ROI（ROAS）', 'GMV ÷ 消耗。ROI 2 = 花 1 块回 2 块 GMV', '效率'],
    ['CTR / CVR', '点击率 / 点击后的转化率', '效率'],
    ['GPM', '每千次曝光产出的 GMV，直播常看', '效率'],
    ['退款率', '退款金额 ÷ GMV，能把好看的 ROI 全吃掉', '效率'],
    ['频次', '同一个人平均被触达几次，品广看它判断有没有白花钱', '效率'],
  ], w(1.6, 5, 1)),
  H2('单位与汇率'),
  B('K₫ = 千越南盾，M₫ = 百万越南盾，1M₫ = 1,000K₫。后台里的 1.427K 是 1,427 ₫ 还是 1,427,000 ₫，看列的表头。'),
  B('内部汇率：₫3,860 ≈ ¥1；$1 = ¥6.8。所以 ¥70 ≈ 270K₫ ≈ $10.3。报数双币并列。'),
  H2('四个口径坑'),
  B('**GMV ≠ NMV。** 报 ROI 必须说清分子是哪个。退款率 35% 时，ROI 1.8 的有效 ROI 只有约 1.17。'),
  B('**广告后台 GMV ≠ 商家后台 GMV。** 归因规则不同，天生不一样，不用对平，每次用同一来源就行。'),
  B('**7 天归因 vs 30 天 O5A 是两本账。** GMV Max 看 7 天归因；品广看 TTMS 的 30 天 O5A，两个数不能互比。'),
  B('**越南时间 vs 北京时间差 1 小时**，跨天数据会错位；跨月取数注意月末最后一天。'),
]);

// 10 GMV Max
sections.push([
  H1('10 GMV Max 怎么想（了解）'),
  P('GMV Max 是自动化投放：人群、出价、版位、素材分发都由系统决定。你不是在「操盘」，很多新人的错误动作其实是在不停打断系统学习。'),
  TABLE([
    ['旋钮', '作用', '动它的后果', '权限'],
    ['日预算', '今天最多花多少', '加太猛会重新进入学习期，ROI 短期波动', '🔴'],
    ['ROI 目标', '告诉系统至少要赚回几倍', '调高 → 量变少甚至不花钱；调低 → 量涨但 ROI 掉', '🔴'],
    ['素材池（加 / 排除）', '给系统可用的弹药', '唯一的长期变量；排除有信号损失', '🔴'],
  ], w(1.6, 2.4, 3.6, 0.8)),
  B('**跷跷板**：预算和 ROI 目标不可能都要。「要 ROI 3 而且要花完 5000 万盾」在系统里不存在，必须选一个优先。'),
  B('**一天最多调一次**，调完至少观察 24 小时（小预算战线 48 小时）。预算单次 ±20%~30% 以内。'),
  B('**三个假象**：① 1 小时数据下结论（订单有延迟，早上 ROI 天生偏低）② 「加预算那一小时 GMV 涨了」是时段本身流量高 ③ 素材相关性当因果（系统本来就把预算喂给已在转化的素材）。'),
  B('定价、库存、退款、直播间表现出问题，不要用广告去救，报运营。'),
]);

// 11 品牌广告
sections.push([
  H1('11 品牌广告 · 先了解，暂不接手'),
  CALLOUT(['**本阶段你不做任何品广操作，品广也不排进每日清单。** 这一章只要求看懂，带教人后续单独培训后再接手。'], { color: 7, emoji: 'eyes' }),
  P('只有 KANS Official 有品牌广告（C-ads / 种草广告）。它买的不是今天的成交，是**「看过并且产生兴趣的人」**，所以是几条战线里唯一不看当天 ROI 的，也最容易被误判为「没效果」。'),
  TABLE([
    ['指标', '含义', '怎么用'],
    ['CPCo', '获取一个意向受众的成本', '越低越有效率，但不能单独看'],
    ['意向人群规模（Co）', '累积了多少有意向的人', '这是「资产」，看增量'],
    ['触达 / 频次', '触达多少人、平均看几次', '频次不足 = 白花钱'],
    ['漏斗 A → C → V', '认知 → 意向 → 下单', '品广买 A→C，GMV Max 收 C→V；看哪一层塌了'],
  ], w(2, 2.6, 3.4)),
  P('已确认的结论：我们 A→C 的种草效率是强项，瓶颈在 C→V（收割端），头部同行的 C→V 约是我们的 1.6 倍。所以「修流转率」比「加种草预算」更值钱。这个结论会随季度复盘更新，以带教人当期口径为准。'),
  P('接手后你会做的（先预习）：每日巡查在投品广素材的**状态 / 条数 / 是否 0 消耗 / 排期 / 余额**五项，只看不动，异常截图报带教人。素材被拒不要自己重提。'),
]);

// 12 第一天与第一个月
sections.push([
  H1('12 第一天 · 第一个月'),
  H2('第一天要完成'),
  TODO('准备自己的邮箱，用于开不同店铺的账号。'),
  TODO('拿到权限：所属店铺 / 广告账户 / 飞书表编辑权。权限由带教人开，不私下找别人要账号。'),
  TODO('1v1 过后台：每个后台从登录到取数的路径，自己截图做笔记。'),
  TODO('书签按「店铺-用途」命名存好（附录里的全部链接）。'),
  TODO('背 09 章指标表，能张口说出 GMV / NMV / ROI / CTR / CVR / 退款率 / CPCo 是什么。'),
  TODO('找带教人要汇率换算插件。'),
  TODO('通读 GMV Max 官方 playbook：[入门手册](' + L.playbook + ') · [帮助中心](' + L.helpCenter + ')。'),
  H2('成长节奏'),
  TABLE([
    ['阶段', '目标'],
    ['前 2 天', '只读看数 + 背指标 + 过后台'],
    ['第 1 周', '独立发日报；独立添加投流码（Globe / One Leaf）；独立按标准登记巡检'],
    ['第 2 周', '独立执行 Jasper 已批准的排除；开始接触 KANS Official'],
    ['第 3–4 周', '独立拉投后结案；用 AI 工具跑日常报表'],
  ], w(1.2, 5)),
  P('你虽然是实习生，但目标是转正，所以从第一天起就按正式员工的责任心要求。是先有了正式员工的能力和责任心再转正，不是转正了再像正式员工一样工作。这些技能都不难，难的是愿意学并且做好的心态。'),
]);

// 附录
sections.push([
  H1('附录 · 链接总表'),
  TABLE([
    ['用途', '链接', '备注'],
    ['广告管理平台', '[ads.tiktok.com/i18n/manage/adgroup](' + L.adsMgr + ')', '改预算、看广告组数据；广告组 ID = 名称末尾那串数字'],
    ['卖家中心 · 本土（Official / One Leaf）', '[seller-vn.tiktok.com](' + L.sellerVN + ')', 'GMV Max 面板、创意作品、订单售后'],
    ['卖家中心 · 跨境（Globe）', '[seller.tiktokshopglobalselling.com](' + L.sellerGlobal + ')', '与本土不是同一个入口，不要混登'],
    ['KOL 投流码新表 · Official 视图', '[ADS working-OFFICIAL](' + L.kolOfficial + ')', '✅ 在用'],
    ['KOL 投流码新表 · Globe 视图', '[Ads working-Globe](' + L.kolGlobe + ')', '✅ 在用'],
    ['KOL 投流码新表 · 错误待修改', '[错误待修改](' + L.kolError + ')', '写了反馈的行会自动到这里'],
    ['KOC 投流码表', '制作中', '上线后补链接'],
    ['One Leaf 投流码原表', '[OL Ads Tracking](' + L.olCode + ')', '新表制作中，出来前用这张'],
    ['素材巡检登记表 · Jasper 待审', '[素材排除 · Creative Exclusion](' + L.exclBase + ')', '实习生用自己店的视图（05 章链接）'],
    ['素材巡检登记表 · 使用说明（中英）', '[Creative Exclusion — Intern Guide](' + L.exclGuide + ')', '与 05 章 5.3 一致'],
    ['商品卡 CODE 添加操作 SOP', '[商品卡CODE添加GMVMAX-操作SOP](' + L.codeSop + ')', '后台按钮位置'],
    ['日报登记表', '[ads广告Intern-日报登记表](' + L.dailySheet + ')', '每天 09:15 前'],
    ['日报模板', '[每日 日报模版](' + L.dailyTpl + ')', '下班前'],
    ['GMV Max 官方 playbook', '[入门手册](' + L.playbook + ') · [帮助中心](' + L.helpCenter + ')', '第一周通读'],
    ['旧手册 v2', '[v2 原文](' + L.old + ')', '仅参考，不再更新'],
    ['已停用', '旧 Google 版 KANS Official CODE 表；旧「素材排除清单-审核」电子表格', '不要再往里填'],
  ], w(2.2, 3.4, 3.4)),
]);

// ---------- v3.1 增补（2026-09-18，见 additions_v31.js；现网文档已用 patch_manual_v31.js 就地打过补丁） ----------
require('./additions_v31.js').apply(sections, { H1, H2, P, B, O, CALLOUT, TABLE, w });

// ---------- 写入 ----------
(async () => {
  const doc = await api('POST', '/open-apis/docx/v1/documents', {
    title: 'KANS 越南广告投放 · 实习生培训手册 v3（2026-09 精简版）',
    folder_token: FOLDER,
  });
  const id = doc.document.document_id;
  console.log('doc', id);
  let n = 0;
  for (const sec of sections) {
    const { children_id, descendants } = flatten(sec);
    await api('POST', `/open-apis/docx/v1/documents/${id}/blocks/${id}/descendant`, { children_id, index: -1, descendants });
    n += descendants.length;
    console.log('section ok, blocks so far', n);
  }
  console.log('https://gvh59x1f62p.feishu.cn/docx/' + id);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
