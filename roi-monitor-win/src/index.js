#!/usr/bin/env node
import 'dotenv/config';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig, loadCampaigns, info, warn, error, formatDT, VERSION, VERSION_NOTE, ROOT,
  BRAND, MARKET, SELLER_HOST, toBeijingHour, marketOf, normalizeMarket,
} from './util.js';
import { launchBrowser, getPage, detectLoginState, hardDeadline } from './browser.js';
import { classifyPageState } from './classify.js';
import { runOnce } from './run.js';
import { startScheduler } from './scheduler.js';
import { LlmClient } from './llm.js';
import { selftest } from './selftest.js';

/** data 目录下的文件路径(data 不存在就建)。 */
function pathJoinData(name) {
  // 用 util.js 的 ROOT(它走的是 fileURLToPath,Windows 上不会变成 /C:/... 这种坏路径)
  const dir = process.env.KANS_DATA_DIR ? path.resolve(process.env.KANS_DATA_DIR) : path.join(ROOT, 'data');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不了就让写文件那步自己报错 */
  }
  return path.join(dir, name);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

async function cmdLogin(config) {
  const context = await launchBrowser(config);
  const page = await getPage(context);
  info('打开 TikTok 卖家后台,请在弹出的浏览器里手动完成登录…');
  await page.goto(`${SELLER_HOST}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('\n────────────────────────────────────────────');
  console.log(' 请在浏览器窗口里完成登录(含验证码/二次验证)。');
  console.log(' 登录成功、能看到卖家后台首页后,回到这里按 Enter。');
  console.log('────────────────────────────────────────────\n');
  await ask('登录完成后按 Enter 检查登录态… ');
  const st = await detectLoginState(page);
  if (st.loggedIn) info('✅ 检测到已登录,登录态已保存到持久 profile。以后可直接 scan/start。');
  else warn(`⚠️ 仍未检测到登录成功(state=${st.state})。可再登录一次后重跑 login。`);
  await context.close();
}

/** 等页面正文渲染出东西(最多 ms 毫秒)。等不到也照常返回,由调用方判断。 */
async function waitForBodyText(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const n = await hardDeadline(
        page.evaluate(() => (document.body?.innerText || '').trim().length),
        5000,
        '读正文长度'
      );
      if (n > 30) return true;
    } catch {
      /* 读不到就再等 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function cmdScan(config, campaigns, with7d) {
  const llm = new LlmClient(config.llm);
  let context = await launchBrowser(config);
  // 单次扫描也允许自愈重启(页面卡死时)
  const deps = {
    llm,
    with7d,
    getContext: () => context,
    restartBrowser: async () => {
      await context.close().catch(() => {});
      context = await launchBrowser(config);
      return context;
    },
  };
  try {
    await runOnce(config, campaigns, deps);
  } finally {
    await context.close().catch(() => {});
  }
}

async function cmdStart(config, campaigns) {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log(`  ${BRAND} 预警 · 代码版本 ${VERSION}`);
  console.log(`  ${VERSION_NOTE}`);
  console.log(`  市场:${MARKET.name}(${MARKET.code})· ${MARKET.currency} 汇率 ${MARKET.rateToCny} · UTC+${MARKET.tzOffsetHours}`);
  console.log('  (换过 src 里的文件后必须重开本窗口才生效)');
  console.log('══════════════════════════════════════════════');
  console.log('');
  info(`常驻启动,代码版本 ${VERSION}`);
  const llm = new LlmClient(config.llm);
  let context = await launchBrowser(config);
  // 启动即做一次登录态自检
  const page = await getPage(context);
  await page
    .goto(`${SELLER_HOST}/`, { waitUntil: 'commit', timeout: 45000 })
    .catch(() => {});
  // commit 只等到"服务器回了响应",正文还没渲染 —— 先等出内容再判断,否则必然误判白屏
  await waitForBodyText(page, 20000);
  const st = await classifyPageState(page, llm);
  if (st.state === 'ready') {
    info('启动自检:已登录 ✅');
  } else if (st.state === 'blank') {
    warn('启动自检:页面没加载出来(网络慢?),先照常调度,第一轮扫描会自己重试。');
  } else {
    warn(`启动自检:当前状态 ${st.state}。请先运行 "npm run login" 手动登录一次。仍会继续调度,但扫描会告警。`);
  }

  // 浏览器句柄交给调度器按需重启(卡死/长跑保养时用)
  const deps = {
    llm,
    getContext: () => context,
    restartBrowser: async () => {
      const old = context;
      await old.close().catch(() => {});
      context = await launchBrowser(loadConfig());
      return context;
    },
  };

  // 写 PID 文件:更新脚本靠它精确找到"正在跑的那个进程"。
  // (光看命令行找不到 —— 启动命令就是 node src/index.js start,不含目录名)
  const pidFile = pathJoinData('running.pid');
  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch (e) {
    warn('写 PID 文件失败(不影响运行):', e.message);
  }
  const clearPid = () => {
    try {
      if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      /* 删不掉就算了 */
    }
  };

  startScheduler(config, campaigns, deps);
  // 保持进程存活
  process.stdin.resume();
  const shutdown = async () => {
    info('收到退出信号,关闭浏览器…');
    clearPid();
    await context.close().catch(() => {});
    process.exit(0);
  };
  process.on('exit', clearPid);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 未捕获异常不要让常驻进程直接死掉
  process.on('unhandledRejection', (e) => error('未处理的异步异常(已忽略):', e?.message || String(e)));
  process.on('uncaughtException', (e) => error('未捕获异常(已忽略):', e?.message || String(e)));
}

async function main() {
  const cmd = process.argv[2] || 'help';
  const flags = process.argv.slice(3);
  const with7d = flags.includes('--with-7d');

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(`${BRAND} ${MARKET.name} GMV Max 高成本低ROI 素材预警(只读)

用法:
  node src/index.js login          # 一次性手动登录 TikTok 卖家后台(持久 profile)
  node src/index.js scan           # 立即扫描一次(仅当天口径)
  node src/index.js scan --with-7d # 立即扫描一次(当天 + 近7天)
  node src/index.js start          # 常驻:每小时扫当天,${MARKET.name}10/14点加扫近7天
  node src/index.js status         # 查看今天历史命中概况
  node src/index.js set roi 2.5    # 改阈值:roi=ROI阈值 cost=成本¥ rate=汇率(${MARKET.currency}→¥)(不带参数=交互式)
  node src/index.js test-notify    # 发一条测试红色预警,验证手机/通知通道是否打通
  node src/index.js version        # 看代码版本(排查"更新了怎么没生效")
  node src/index.js selftest       # 离线自检:验证扫描/排序/时间逻辑(无需登录)
  node src/index.js feishu-setup   # 配飞书:粘 appId/appSecret,开启推送
  node src/index.js feishu-check   # 体检飞书配置:凭据格式对不对、能不能取到 token
  node src/index.js feishu-test    # 测飞书:发一条测试卡片到群 + 写一条测试记录再删掉
  node src/index.js daily off      # 停掉每天的日报推送(红色预警不受影响)
  node src/index.js daily on 9     # 恢复日报推送,${MARKET.name}时间 9 点
  node src/index.js daily-report   # 手动跑一次:采集昨天各计划合计 → 出日报 → 推群
                                   #   --no-collect 只出报告不重新采集
                                   #   --days-ago=2 改成采集前天

配置:config.json(阈值/market 市场块:币种·时区·汇率/输出/LLM)、campaigns.json(计划清单)、.env(密钥)
换国家:把 markets.example.json 里对应国家的块复制到 config.json 的 market 字段
输出:output/<时间串>.xlsx;告警:output/ALERTS.log`);
    return;
  }

  if (cmd === 'selftest') {
    await selftest();
    return;
  }

  const config = loadConfig();
  const campaigns = loadCampaigns();

  switch (cmd) {
    case 'login':
      await cmdLogin(config);
      break;
    case 'scan':
      await cmdScan(config, campaigns, with7d);
      break;
    case 'start':
      await cmdStart(config, campaigns);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'dump':
      await cmdDump(config, campaigns);
      break;
    case 'set':
      await cmdSet(flags);
      break;
    case 'test-notify':
      await cmdTestNotify(config);
      break;
    case 'feishu-setup':
      await cmdFeishuSetup();
      break;
    case 'feishu-test':
      await cmdFeishuTest(config);
      break;
    case 'feishu-check':
      await cmdFeishuCheck();
      break;
    case 'daily-report':
      await cmdDailyReport(config, campaigns, flags);
      break;
    case 'daily':
      await cmdDailySwitch(flags);
      break;
    case 'version':
    case '-v':
    case '--version':
      console.log(`\n代码版本:${VERSION}`);
      console.log(`本版内容:${VERSION_NOTE}`);
      console.log('\n⚠️ 这是【磁盘上】代码的版本。');
      console.log('   如果常驻窗口是在替换文件之前打开的,它跑的还是旧代码 —— 必须重启那个窗口。');
      break;
    default:
      error(`未知命令:${cmd}。运行 "node src/index.js help" 查看用法。`);
      process.exit(1);
  }
}

/**
 * 清洗粘贴进来的凭据。用户很可能整行复制,像:
 *   "app_id": "cli_xxxx",
 * 这里把引号、逗号、冒号前缀、空格、看不见的零宽字符全去掉,只留值本身。
 */
function clean(raw) {
  let v = String(raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // 零宽字符(从网页复制最容易带)
    .trim();
  // 去掉 "app_id": 这种前缀
  v = v.replace(/^["']?\s*app_?(id|secret)\s*["']?\s*[:=]\s*/i, '');
  v = v.replace(/^["'`]+/, '').replace(/["'`,;]+$/, '').trim();
  return v;
}

// 飞书那几个固定 token(群、底表)由我这边建好,用户不用管,缺了就自动补上
const FEISHU_DEFAULTS = {
  enabled: false,
  appId: '',
  appSecret: '',
  chatId: 'oc_填你的飞书群ID',
  chatName: '越南韩束ROI预警',
  bitable: {
    appToken: '填多维表格appToken',
    tableId: 'tblT9nDZFnVa90qO', // 命中明细
    dailyTableId: 'tblhTnhAwHQVB8ad', // 计划日汇总
  },
  dailySummaryHour: 9, // 市场当地时间。越南 9 点 = 北京时间 10 点;想北京 9 点就填 8
};

async function cmdFeishuSetup() {
  const { readConfigRaw, writeConfigRaw } = await import('./util.js');
  const cfg = readConfigRaw();
  // 老的 config.json 里没有 feishu 段(比如只覆盖了 src 的情况)→ 自动补齐,
  // 这样就不用覆盖用户自己的 config.json、不会弄丢他们配好的通知渠道和阈值。
  cfg.feishu = { ...FEISHU_DEFAULTS, ...(cfg.feishu || {}) };
  cfg.feishu.bitable = { ...FEISHU_DEFAULTS.bitable, ...(cfg.feishu.bitable || {}) };
  console.log('\n==== 配置飞书推送 ====\n');
  console.log('要填的两个值在你 Mac 上,终端里跑这一行就能看到:');
  console.log('  cat ~/.feishu/credentials.json\n');
  console.log('(整行粘进来也行,比如 "app_id": "cli_xxx", —— 我会自动清掉引号逗号)\n');
  const id = clean(await ask(`app_id(当前 ${cfg.feishu.appId ? '已填' : '空'}),直接回车=不改: `));
  if (id) cfg.feishu.appId = id;
  const sec = clean(await ask(`app_secret(当前 ${cfg.feishu.appSecret ? '已填' : '空'}),直接回车=不改: `));
  if (sec) cfg.feishu.appSecret = sec;

  // 当场校验格式,别等到用的时候才报 10003
  const bad = [];
  if (!/^cli_[A-Za-z0-9]{16}$/.test(cfg.feishu.appId)) {
    bad.push(`app_id 格式不对(应该是 cli_ 开头共 20 位,现在是 ${cfg.feishu.appId.length} 位)`);
  }
  if (!/^[A-Za-z0-9]{32}$/.test(cfg.feishu.appSecret)) {
    bad.push(`app_secret 格式不对(应该是 32 位字母数字,现在是 ${cfg.feishu.appSecret.length} 位)`);
  }
  if (bad.length) {
    console.log('\n⚠️ 值看起来有问题:');
    bad.forEach((b) => console.log('   · ' + b));
    console.log('   常见原因:粘贴时带了引号/逗号/空格,或者没粘全。');
    console.log('   已经按你输入的存下了,但多半会报 10003。建议重跑一次这个脚本重新粘。\n');
  }
  const hour = (await ask(`每天几点推日报(${MARKET.name}时间 0-23,当前 ${cfg.feishu.dailySummaryHour ?? 21}),回车=不改: `)).trim();
  if (hour && !Number.isNaN(Number(hour))) cfg.feishu.dailySummaryHour = Number(hour);

  if (cfg.feishu.appId && cfg.feishu.appSecret) {
    cfg.feishu.enabled = true;
    console.log('\n✅ 已开启飞书推送。');
    console.log(`   推送群:${cfg.feishu.chatName || cfg.feishu.chatId}`);
    console.log(`   底表:https://你的域名.feishu.cn/base/${cfg.feishu.bitable?.appToken}`);
    console.log(`   日报时间:${MARKET.name}时间 ${cfg.feishu.dailySummaryHour ?? 21} 点`);
    console.log('\n   下一步:跑「测试飞书.bat」验证一下通不通。');
  } else {
    cfg.feishu.enabled = false;
    console.log('\n⚠️ appId / appSecret 还没填全,飞书推送保持关闭。');
  }
  writeConfigRaw(cfg);
}

/** 开关每日日报。off = 不再自动采集也不再推送;红色预警不受影响。 */
async function cmdDailySwitch(flags) {
  const { readConfigRaw, writeConfigRaw } = await import('./util.js');
  const cfg = readConfigRaw();
  cfg.feishu = cfg.feishu || {};
  const action = (flags[0] || '').toLowerCase();

  if (action === 'off') {
    cfg.feishu.dailyReportEnabled = false;
    cfg.feishu.dailySummaryHour = null;
    writeConfigRaw(cfg);
    console.log('\n✅ 每日日报已停止推送。');
    console.log('   · 不再自动采集各计划的日合计,也不再往群里推日报');
    console.log('   · 🔴 红色预警照常推,每轮命中照常写飞书底表 —— 这两个不受影响');
    console.log('   · 下一个整点生效,不用重启');
    console.log('\n   想恢复:node src/index.js daily on 9(或双击「恢复日报.bat」)');
    return;
  }
  if (action === 'on') {
    const h = Number(flags[1]);
    const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
    cfg.feishu.dailyReportEnabled = true;
    cfg.feishu.dailySummaryHour = hour;
    writeConfigRaw(cfg);
    console.log(`\n✅ 每日日报已恢复,${MARKET.name}时间 ${hour} 点推(= 北京时间 ${toBeijingHour(hour)} 点)。`);
    console.log('   下一个整点生效,不用重启。');
    return;
  }

  const cur = cfg.feishu.dailySummaryHour;
  const on = cfg.feishu.dailyReportEnabled === true && cur != null;
  console.log('\n当前日报状态:' + (on ? `开启,每天${MARKET.name}时间 ${cur} 点推(= 北京时间 ${toBeijingHour(cur)} 点)` : '已停止'));
  console.log('\n用法:');
  console.log('  node src/index.js daily off     停止推送');
  console.log(`  node src/index.js daily on 9    恢复,${MARKET.name}时间 9 点`);
}

async function cmdFeishuCheck() {
  const { readConfigRaw } = await import('./util.js');
  const cfg = readConfigRaw();
  const f = cfg.feishu || {};
  console.log('\n==== 飞书配置体检 ====\n');

  const show = (label, v, re, hint) => {
    const s = String(v ?? '');
    const ok = re.test(s);
    console.log(`${ok ? '✅' : '❌'} ${label}`);
    console.log(`   长度 ${s.length}${s ? `,前 6 位 ${JSON.stringify(s.slice(0, 6))},后 2 位 ${JSON.stringify(s.slice(-2))}` : ''}`);
    if (!ok) {
      console.log(`   应该是:${hint}`);
      const junk = [];
      if (/\s/.test(s)) junk.push('空格或换行');
      if (/["'`]/.test(s)) junk.push('引号');
      if (/[,;:]/.test(s)) junk.push('逗号/冒号');
      if (/[\u4e00-\u9fa5]/.test(s)) junk.push('中文字符');
      if (/[\u200B-\u200D\uFEFF]/.test(s)) junk.push('看不见的零宽字符');
      if (junk.length) console.log(`   ⚠️ 里面混进了:${junk.join('、')} —— 这就是报 10003 的原因`);
      else if (s.length === 0) console.log('   ⚠️ 是空的,还没配');
      else console.log('   ⚠️ 位数不对,多半是没粘全(cmd 窗口粘贴有时会截断)');
    }
    return ok;
  };

  const a = show('app_id', f.appId, /^cli_[A-Za-z0-9]{16}$/, 'cli_ 开头,一共 20 位字母数字');
  const b = show('app_secret', f.appSecret, /^[A-Za-z0-9]{32}$/, '32 位字母数字,没有其它符号');
  console.log(`${f.enabled ? '✅' : '❌'} enabled = ${f.enabled}`);
  console.log(`${f.chatId ? '✅' : '❌'} 推送群 = ${f.chatName || f.chatId || '(未配)'}`);
  console.log(`${f.bitable?.appToken ? '✅' : '❌'} 底表 = ${f.bitable?.appToken || '(未配)'}`);
  console.log(`   日报时间:${MARKET.name}时间 ${f.dailySummaryHour ?? 9} 点(= 北京时间 ${toBeijingHour(f.dailySummaryHour ?? 9)} 点)`);

  if (!a || !b) {
    console.log('\n👉 凭据格式不对,先重跑「配置飞书.bat」把值重新粘一次。');
    console.log('   值在 Mac 上:cat ~/.feishu/credentials.json');
    console.log('   只粘引号里面那一串,别带引号和逗号。');
    return;
  }

  console.log('\n正在真的去换一次 token…');
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: f.appId, app_secret: f.appSecret }),
    });
    const j = await res.json();
    if (j.code === 0) {
      console.log('✅ 取到 token 了,凭据没问题。可以跑「测试飞书.bat」了。');
    } else {
      console.log(`❌ 飞书返回:${j.code} ${j.msg}`);
      if (j.code === 10003) console.log('   → 参数不对:app_id 或 app_secret 的值不对(不是格式,是值本身)。确认复制的是同一个应用的。');
      else if (j.code === 10012 || j.code === 10013) console.log('   → app_secret 不对,或者应用的密钥被重置过。去飞书开放平台重新复制。');
      else console.log('   → 把这条错误发给 Jasper 或 Claude。');
    }
  } catch (e) {
    console.log('❌ 连不上飞书:', e.message);
    console.log('   → 这台电脑可能上不了 open.feishu.cn,检查网络/代理。');
  }
}

async function cmdFeishuTest(config) {
  const { feishuEnabled, sendCard, pushRowsToBitable } = await import('./feishu.js');
  if (!feishuEnabled(config)) {
    console.log('⚠️ 飞书推送没开启或凭据没填。先跑「配置飞书.bat」。');
    return;
  }
  console.log('1) 往群里发一张测试卡片…');
  const r1 = await sendCard(config, {
    title: `✅ ${BRAND} 预警 · 飞书通道测试`,
    template: 'green',
    lines: [
      '这是一条测试消息,看到它说明**推送通道已打通**。',
      '',
      `推送群:${config.feishu.chatName || config.feishu.chatId}`,
      `日报时间:${MARKET.name}时间 ${config.feishu.dailySummaryHour ?? 21} 点`,
      `底表:https://你的域名.feishu.cn/base/${config.feishu.bitable?.appToken}`,
    ],
  });
  console.log(r1.ok ? '   ✅ 群消息发送成功' : `   ❌ 失败:${r1.error || '(看上面的日志)'}`);

  console.log('2) 往底表写一条测试记录…');
  const r2 = await pushRowsToBitable(config, '测试', [
    { workId: 'TEST-可以删掉', acct: '@测试', costCNY: 0, roi: 0, caliber: '当天', campaign: '通道测试', mark: '测试数据' },
  ]);
  console.log(r2.ok ? `   ✅ 写入成功(${r2.count} 条,去底表里可以手动删掉这行)` : `   ❌ 失败:${r2.error}`);
  console.log(`\n底表地址:https://你的域名.feishu.cn/base/${config.feishu.bitable?.appToken}`);
}

async function cmdDailyReport(config, campaigns, flags) {
  const { feishuEnabled, sendCard } = await import('./feishu.js');
  const { buildDailyReport } = await import('./report.js');
  const { collectDailyTotals } = await import('./daily.js');
  if (!feishuEnabled(config)) {
    console.log('⚠️ 飞书推送没开启。先跑「配置飞书.bat」。');
    return;
  }
  const daysAgo = Number((flags || []).find((f) => /^--days-ago=/.test(f))?.split('=')[1] || 1);

  if (!(flags || []).includes('--no-collect')) {
    console.log(`正在采集 ${daysAgo} 天前各计划的 成本/GMV/ROI(要把每个计划翻一遍,请稍等)…`);
    const { launchBrowser } = await import('./browser.js');
    let context = await launchBrowser(config);
    try {
      const got = await collectDailyTotals(config, campaigns, {
        getContext: () => context,
        restartBrowser: async () => {
          await context.close().catch(() => {});
          context = await launchBrowser(config);
          return context;
        },
      }, daysAgo);
      console.log(got.ok ? `采集完成:${got.count} 个计划(${got.dateKey})` : '采集失败,下面用表里已有的数据出报告');
    } finally {
      await context.close().catch(() => {});
    }
  }

  console.log('正在生成日报…');
  const card = await buildDailyReport(config);
  if (!card) {
    console.log('今天底表里没有数据,没什么可报的。');
    return;
  }
  console.log('\n---- 日报预览 ----');
  console.log(card.title);
  console.log(card.lines.join('\n').replace(/\*\*/g, ''));
  console.log('------------------\n');
  const r = await sendCard(config, card);
  console.log(r.ok ? '✅ 已推送到群' : `❌ 推送失败:${r.error}`);
}

async function cmdTestNotify(config) {
  const { notify } = await import('./notify.js');
  const n = config.notify || {};
  console.log('alert 级通知会走这些通道:', (n.alertChannels || n.channels || ['log']).join(', '));
  console.log('企业微信机器人已配置:', !!(n.wecomWebhook && !/\$\{/.test(n.wecomWebhook)));
  console.log('企业微信应用已配置:', !!(n.wecomApp?.corpid && !/\$\{/.test(n.wecomApp.corpid)));
  await notify(config, {
    level: 'alert',
    title: `🔴 ${BRAND} 红色预警(测试)`,
    body: '这是一条测试通知。若你在手机上看到它,说明手机推送已打通 ✅\n示例:MKT-白精华-0708 | @某达人 | ¥286 | ROI 0.4',
  });
  console.log('已发送测试通知。请查看手机/日志/output/ALERTS.log。');
}

/** 按 "a.b.c" 路径读/写嵌套字段(set 命令改 market.rateToCny 用)。 */
const getPath = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, key, val) => {
  const ks = key.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[ks[ks.length - 1]] = val;
};

/**
 * 老 config.json 没有 market 块时,就地把 vndToCnyRate / timezoneOffsetHours 迁成 market 块
 * (只在用户主动改设置时做,平时读配置不写回)。
 */
function ensureMarketBlock(cfg) {
  if (cfg.market && typeof cfg.market === 'object') return false;
  const m = normalizeMarket(cfg);
  cfg.market = {
    code: m.code,
    name: m.name,
    currency: m.currency,
    symbols: m.symbols,
    tzOffsetHours: m.tzOffsetHours,
    rateToCny: m.rateToCny,
  };
  delete cfg.vndToCnyRate;
  delete cfg.timezoneOffsetHours;
  return true;
}

async function cmdSet(flags) {
  const { readConfigRaw, writeConfigRaw } = await import('./util.js');
  const cfg = readConfigRaw();
  const migrated = ensureMarketBlock(cfg);
  const cur = cfg.market.currency || MARKET.currency;
  const alias = { roi: 'roiThreshold', cost: 'costThresholdCNY', rate: 'market.rateToCny' };
  const label = {
    roiThreshold: 'ROI 阈值(命中条件:ROI < 此值)',
    costThresholdCNY: '成本阈值 ¥(命中条件:成本 > 此值)',
    'market.rateToCny': `汇率 ${cur}→¥(1 元人民币 = 多少 ${cur})`,
  };
  const migratedNote = migrated ? '(顺便把旧的 vndToCnyRate / timezoneOffsetHours 迁成了 market 块)' : '';

  // 直接形式:set roi 2.5 / set cost 70 / set rate 3891
  if (flags.length >= 2) {
    const key = alias[flags[0]] || flags[0];
    const num = Number(flags[1]);
    if (getPath(cfg, key) === undefined || Number.isNaN(num)) {
      console.log('用法:node src/index.js set roi 2.5  |  set cost 70  |  set rate 3891');
      return;
    }
    const old = getPath(cfg, key);
    setPath(cfg, key, num);
    writeConfigRaw(cfg);
    console.log(`✅ 已修改 ${label[key] || key}:${old} → ${num}(下一轮扫描自动生效,无需重启)${migratedNote}`);
    return;
  }

  // 交互形式(双击"修改设置"时用)
  console.log('\n当前阈值设置:');
  console.log(`  1) ${label.roiThreshold}     当前 = ${cfg.roiThreshold}`);
  console.log(`  2) ${label.costThresholdCNY}    当前 = ${cfg.costThresholdCNY}`);
  console.log(`  3) ${label['market.rateToCny']}    当前 = ${cfg.market.rateToCny}`);
  const pick = (await ask('\n要改哪个?输入 1 / 2 / 3(直接回车=不改): ')).trim();
  const map = { 1: 'roiThreshold', 2: 'costThresholdCNY', 3: 'market.rateToCny' };
  const key = map[pick];
  if (!key) {
    if (migrated) writeConfigRaw(cfg);
    console.log('未改动。' + migratedNote);
    return;
  }
  const nv = (await ask(`输入新的值(当前 ${getPath(cfg, key)}): `)).trim();
  const num = Number(nv);
  if (Number.isNaN(num)) {
    if (migrated) writeConfigRaw(cfg);
    console.log('不是有效数字,未改动。' + migratedNote);
    return;
  }
  const old = getPath(cfg, key);
  setPath(cfg, key, num);
  writeConfigRaw(cfg);
  console.log(`\n✅ 已修改 ${label[key]}:${old} → ${num}。${migratedNote}`);
  console.log('下一轮扫描自动生效(常驻程序每小时读一次配置,无需重启)。');
}

async function cmdStatus() {
  const { getTodayPrevIds, hasTodayHistory } = await import('./store.js');
  const ids = getTodayPrevIds();
  console.log(`今天(${MARKET.name})是否已有历史命中:${hasTodayHistory() ? '是' : '否'}`);
  console.log(`今天「当天」口径累计命中过的素材ID数:${ids.size}`);
  console.log(`当前时间串 DT:${formatDT()}`);
}

async function cmdDump(config, campaigns) {
  const { launchBrowser, getPage, gotoAndWaitTable } = await import('./browser.js');
  const { buildDashboardUrl, vnDayRanges } = await import('./util.js');
  const r = vnDayRanges(marketOf(config).tzOffsetHours);
  const c = campaigns[0];
  const url = buildDashboardUrl(c, r.dStart, r.dEnd);
  const context = await launchBrowser(config);
  try {
    const page = await getPage(context);
    console.log('导航到:', c.name);
    await gotoAndWaitTable(page, url, config);
    const info = await page.evaluate(() => {
      const table = [...document.querySelectorAll('table')].find((t) =>
        [...t.querySelectorAll('thead th,thead td')].some((h) => /作品\s*ID|视频\s*ID/.test(h.innerText))
      );
      if (!table) return { error: '未找到创意表格' };
      const headersRaw = [...table.querySelectorAll('thead th,thead td')].map((h) => h.innerText);
      const rows = [...table.querySelectorAll('tbody tr')].slice(0, 4).map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\n/g, '⏎').slice(0, 40))
      );
      return { headersRaw, rows };
    });
    console.log('\n==== 表头(带索引,原文)====');
    (info.headersRaw || []).forEach((h, i) => console.log(`  [${i}] ${JSON.stringify(h)}`));
    console.log('\n==== 前几行每个单元格(带索引)====');
    (info.rows || []).forEach((row, ri) => {
      console.log(`  行${ri}:`);
      row.forEach((cell, ci) => console.log(`     [${ci}] ${JSON.stringify(cell)}`));
    });
    if (info.error) console.log('⚠️', info.error);
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  error('致命错误:', e.stack || e.message || String(e));
  process.exit(1);
});
