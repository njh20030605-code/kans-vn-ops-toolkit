import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { scanCurrentTable, peekTopRows, diagColumns, scanTotals } from './scan.js';
import { buildColRe, pageWorker } from './columns.js';
import { markAndSort } from './output.js';
import { gotoWithRetry, gotoAndWaitTable, setLiveInterception, getPage, getBoardPage } from './browser.js';
import { vnDayRanges, buildDashboardUrl, formatDT } from './util.js';
import { launchBrowser } from './browser.js';
import { runOnce } from './run.js';
import { fetchCampaignStats } from './board.js';
import { failurePolicy } from './scheduler.js';
import { buildRedAlertCard } from './report.js';
import { extractCampaigns, mergeCampaigns } from './discover.js';
import { readCampaignTable, pickBaseline, buildBoardCard, buildBoardRows, totals, saveSnapshot, readSnapshots } from './board.js';

/** 没装 Playwright 自带的 Chromium 时,退回用本机 Chrome/Edge,自检照样能跑。 */
async function launchAny() {
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    for (const channel of ['chrome', 'msedge']) {
      try {
        const b = await chromium.launch({ headless: true, channel });
        console.log(`  (提示:未装 Playwright 自带 Chromium,已改用本机 ${channel})`);
        return b;
      } catch {
        /* 换下一个 */
      }
    }
    throw e;
  }
}

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
  }
}

const FAKE_TABLE_HTML = `
<table>
  <thead>
    <tr>
      <th>作品 ID</th>
      <th>成本(₫)</th>
      <th>TikTok账号</th>
      <th>投资回报率(ROI)</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>W1</td><td>500000 ₫</td><td>@alpha</td><td>1.5</td></tr>
    <tr><td>W2</td><td>350000 ₫</td><td>@beta</td><td>0.8</td></tr>
    <tr><td>W3</td><td>300000 ₫</td><td>@gamma</td><td>3.0</td></tr>
    <tr><td>W4</td><td>250000 ₫</td><td>@delta</td><td>1.2</td></tr>
  </tbody>
</table>`;

export async function selftest() {
  console.log('\n== 离线自检 ==\n');

  // 1) 时间 / URL / DT 纯函数
  console.log('[1] 时间与 URL 逻辑');
  const r = vnDayRanges(7);
  check('当天区间长度为 86399000ms', r.dEnd - r.dStart === 86399000);
  check('近7天起点比当天早 6 天', r.dStart - r.d7Start === 6 * 86400e3);
  const url = buildDashboardUrl({ campaign_id: 'CID', product_id: 'PID' }, r.dStart, r.dEnd);
  check('URL 含 campaign_id', url.includes('campaign_id=CID'));
  check('URL 含 product_id', url.includes('product_id=PID'));
  check('URL 含 list_start_date', url.includes(`list_start_date=${r.dStart}`));
  check('DT 形如 X月X日-HH.MM', /^\d+月\d+日-\d{2}\.\d{2}$/.test(formatDT(7)));

  // 2) 排序与标记 (§6.1)
  console.log('\n[2] 排序与标记逻辑');
  const hits = [
    { caliber: '当天', campaign: 'A计划', acct: '@a1', workId: 'X1', costCNY: 80, roi: 1.5 },
    { caliber: '当天', campaign: 'B计划', acct: '@b1', workId: 'X2', costCNY: 200, roi: 0.5 },
    { caliber: '当天', campaign: 'A计划', acct: '@a2', workId: 'X3', costCNY: 150, roi: 1.9 },
    { caliber: '近7天', campaign: 'A计划', acct: '@a1', workId: 'X1', costCNY: 300, roi: 1.1 },
  ];
  const prev = new Set(['X1']); // X1 今天出现过 → 非新;X2/X3 是新素材
  const sorted = markAndSort(hits, prev, true);
  check('当天块整体排在近7天块前', sorted[sorted.length - 1].caliber === '近7天');
  // 当天块内:B计划(最高200)在 A计划(最高150)前
  const dayRows = sorted.filter((x) => x.caliber === '当天');
  check('当天块内 B计划(最高成本)排在 A计划前', dayRows[0].campaign === 'B计划');
  check('同计划连续不跨计划混排', dayRows[1].campaign === 'A计划' && dayRows[2].campaign === 'A计划');
  check('A计划组内成本降序(150 在 80 前)', dayRows[1].costCNY === 150 && dayRows[2].costCNY === 80);
  check('ROI<1 打 ⚠️', sorted.find((x) => x.workId === 'X2').mark.includes('⚠️ROI<1'));
  check('X1 已出现过 → 不打 🆕', !sorted.find((x) => x.workId === 'X1' && x.caliber === '当天').mark.includes('🆕'));
  check('X3 未出现过 → 打 🆕', sorted.find((x) => x.workId === 'X3').mark.includes('🆕新素材'));
  check('近7天口径不打 🆕', !sorted.find((x) => x.caliber === '近7天').mark.includes('🆕'));

  // 首轮无历史不打 🆕
  const firstRound = markAndSort(hits, new Set(), false);
  check('今天首轮(无历史)全部不打 🆕', firstRound.every((x) => !x.mark.includes('🆕')));

  // 3) 真实浏览器里跑注入扫描脚本(合成表格)
  console.log('\n[3] 注入扫描脚本(合成表格,headless)');
  let browser;
  try {
    browser = await launchAny();
    const page = await browser.newPage();
    await page.setContent(`<html><body>${FAKE_TABLE_HTML}</body></html>`);
    const params = { costThreshold: 70, roiThreshold: 2, rate: 3891 };
    const scanned = await scanCurrentTable(page, params);
    check('命中 2 条(W1,W2)', scanned.length === 2);
    check('命中含 W1', scanned.some((x) => x.workId === 'W1'));
    check('命中含 W2', scanned.some((x) => x.workId === 'W2'));
    check('W3 因 ROI≥2 未命中', !scanned.some((x) => x.workId === 'W3'));
    check('W4 因成本≤¥70 未命中(且触发提前停止)', !scanned.some((x) => x.workId === 'W4'));
    const w1 = scanned.find((x) => x.workId === 'W1');
    check('归一化¥ 正确(500000/3891≈129)', w1 && w1.costCNY === 129);
    check('账号取第3列', w1 && w1.acct === '@alpha');
    const top = await peekTopRows(page, { rate: 3891, n: 3 });
    check('peekTopRows 读到首行 W1', top[0] && top[0].workId === 'W1');

    // 真实 dashboard 布局:无 ROI 列,ROI 由 总收入/成本 计算
    console.log('\n[4] 计算型 ROI(总收入/成本,还原真实 dashboard)');
    await page.setContent(`<html><body><table>
      <thead><tr>
        <th>创意素材</th><th>作品 ID</th><th>TikTok 账号</th><th>成本</th><th>总收入</th>
      </tr></thead>
      <tbody>
        <tr><td>vid1</td><td>A1</td><td>@x</td><td>2,000,000 VND</td><td>7,000,000 VND</td></tr>
        <tr><td>vid2</td><td>A2</td><td>@y</td><td>1,000,000 VND</td><td>1,000,000 VND</td></tr>
        <tr><td>vid3</td><td>A3</td><td>@z</td><td>1,000,000 VND</td><td>500,000 VND</td></tr>
        <tr><td>vid4</td><td>A4</td><td>@w</td><td>100,000 VND</td><td>50,000 VND</td></tr>
      </tbody></table></body></html>`);
    const scanned2 = await scanCurrentTable(page, params);
    check('A1 因 ROI=3.5(≥2)未命中', !scanned2.some((x) => x.workId === 'A1'));
    check('命中 A2(ROI=1.0<2)', scanned2.some((x) => x.workId === 'A2'));
    check('命中 A3(ROI=0.5<2)', scanned2.some((x) => x.workId === 'A3'));
    check('A4 因成本≤¥70 未命中', !scanned2.some((x) => x.workId === 'A4'));
    const a3 = scanned2.find((x) => x.workId === 'A3');
    check('A3 的 ROI 计算为 0.5', a3 && a3.roi === 0.5);
    const a2 = scanned2.find((x) => x.workId === 'A2');
    check('A2 的 ROI 计算为 1', a2 && a2.roi === 1);
    check('acct 取第3列(@z)', a3 && a3.acct === '@z');

    // 直播布局:ID列=视频ID,账号列不在第3列(夹了发布时间/探索状态),按表头找账号
    console.log('\n[5] 直播布局(视频ID + 账号列位置不同)');
    await page.setContent(`<html><body><table>
      <thead><tr>
        <th>作品</th><th>视频 ID</th><th>发布时间</th><th>TikTok 账号</th><th>探索状态</th><th>成本</th><th>总收入</th><th>ROI</th>
      </tr></thead>
      <tbody>
        <tr><td>livevid1</td><td>V1</td><td>2026-07-23</td><td>@liveA</td><td>已探索</td><td>500,000 VND</td><td>600,000 VND</td><td>1.2</td></tr>
        <tr><td>livevid2</td><td>V2</td><td>2026-07-23</td><td>@liveB</td><td>已探索</td><td>400,000 VND</td><td>4,000,000 VND</td><td>10.0</td></tr>
        <tr><td>livevid3</td><td>V3</td><td>2026-07-23</td><td>@liveC</td><td>已探索</td><td>50,000 VND</td><td>10,000 VND</td><td>0.2</td></tr>
      </tbody></table></body></html>`);
    const live = await scanCurrentTable(page, params);
    check('命中 V1(¥128>70,ROI≈1.2<2)', live.some((x) => x.workId === 'V1'));
    check('V2 因 ROI=10(≥2)未命中', !live.some((x) => x.workId === 'V2'));
    check('V3 因成本≤¥70 未命中', !live.some((x) => x.workId === 'V3'));
    const v1 = live.find((x) => x.workId === 'V1');
    check('直播账号按表头取对(@liveA,不是发布时间)', v1 && v1.acct === '@liveA');
    check('视频ID 被识别为素材ID(V1)', v1 && v1.workId === 'V1');

    // 直播:页面自带 ROI 列 与 总收入/成本 不一致时,必须用页面的 ROI(和后台一致)
    console.log('\n[6] 直播 ROI 以页面自带列为准(≠ 总收入/成本)');
    await page.setContent(`<html><body><table>
      <thead><tr>
        <th>作品</th><th>视频 ID</th><th>TikTok 账号</th><th>成本</th><th>总收入</th><th>基本目标 ROI</th>
      </tr></thead>
      <tbody>
        <tr><td>vid</td><td>Z1</td><td>@z1</td><td>500,000 VND</td><td>5,000,000 VND</td><td>1.5</td></tr>
      </tbody></table></body></html>`);
    const zr = await scanCurrentTable(page, params);
    const z1 = zr.find((x) => x.workId === 'Z1');
    check('Z1 命中(用页面 ROI=1.5<2,而非算出来的 10)', !!z1);
    check('Z1 的 ROI 取页面自带的 1.5(不是 总收入/成本=10)', z1 && z1.roi === 1.5);

    // 界面语言换成英文 / 越南语时,表头和数字格式都变了,必须照样认得
    console.log('\n[7] 英文界面(English UI)');
    await page.setContent(`<html><body><table>
      <thead><tr>
        <th>Creative</th><th>Video ID</th><th>TikTok account</th><th>Cost (₫)</th><th>Gross revenue (₫)</th><th>Cost per order</th>
      </tr></thead>
      <tbody>
        <tr><td>v1</td><td>E1</td><td>@en1</td><td>2,000,000</td><td>2,000,000</td><td>30,000</td></tr>
        <tr><td>v2</td><td>E2</td><td>@en2</td><td>1,500,000</td><td>6,000,000</td><td>20,000</td></tr>
        <tr><td>v3</td><td>E3</td><td>@en3</td><td>100,000</td><td>10,000</td><td>90,000</td></tr>
      </tbody></table></body></html>`);
    const en = await scanCurrentTable(page, params);
    const e1 = en.find((x) => x.workId === 'E1');
    check('英文界面能找到表格并识别列', en.length > 0);
    check('E1 命中(¥514,ROI=1<2)', !!e1);
    check('E1 成本解析正确(2,000,000₫ → ¥514)', e1 && e1.costCNY === 514);
    check('英文账号列按表头取对(@en1)', e1 && e1.acct === '@en1');
    check('E2 因 ROI=4(≥2)未命中', !en.some((x) => x.workId === 'E2'));
    check('成本列没被 "Cost per order" 抢走', e1 && e1.costCNY > 100);

    console.log('\n[8] 越南语界面(千分位是"点",最容易读错一百万倍)');
    await page.setContent(`<html><body><table>
      <thead><tr>
        <th>Video</th><th>ID video</th><th>Tài khoản</th><th>Chi phí (₫)</th><th>Doanh thu (₫)</th>
      </tr></thead>
      <tbody>
        <tr><td>v1</td><td>N1</td><td>@vn1</td><td>2.000.000</td><td>2.000.000</td></tr>
        <tr><td>v2</td><td>N2</td><td>@vn2</td><td>1.500.000</td><td>6.000.000</td></tr>
      </tbody></table></body></html>`);
    const vn = await scanCurrentTable(page, params);
    const n1 = vn.find((x) => x.workId === 'N1');
    check('越南语界面能找到表格', vn.length > 0);
    check('"2.000.000" 读成 2000000 而不是 2(→ ¥514)', n1 && n1.costCNY === 514);
    check('N1 命中(ROI=1<2)', !!n1);
    check('N2 因 ROI=4 未命中', !vn.some((x) => x.workId === 'N2'));

    // 换国家:同一套代码,只换 market 块。泰铢是小面额币种,逗号千分位、点小数,表头是泰语。
    console.log('\n[8.5] 换市场(泰国 THB:小面额 + 逗号千分位 + 泰语表头)');
    const thMarket = { code: 'TH', name: '泰国', currency: 'THB', symbols: ['฿', 'THB'], tzOffsetHours: 7, rateToCny: 4.5 };
    const thRe = buildColRe(thMarket);
    const thArgs = { rate: thMarket.rateToCny, assumeLocal: true };
    await page.setContent(`<html><body><table>
      <thead><tr>
        <th>รหัสวิดีโอ</th><th>บัญชี</th><th>ค่าใช้จ่าย (฿)</th><th>รายได้ (฿)</th>
      </tr></thead>
      <tbody>
        <tr><td>T1</td><td>@th1</td><td>฿1,350.00</td><td>฿1,350.00</td></tr>
        <tr><td>T2</td><td>@th2</td><td>฿2,000.00</td><td>฿20,000.00</td></tr>
        <tr><td>T3</td><td>@th3</td><td>฿90.00</td><td>฿90.00</td></tr>
      </tbody></table></body></html>`);
    const th = await page.evaluate(pageWorker, { mode: 'scan', RE: thRe, costThreshold: 70, roiThreshold: 2, ...thArgs });
    const t1 = th.find((x) => x.workId === 'T1');
    check('泰语表头能识别列', th.length > 0);
    check('"฿1,350.00" → ¥300(逗号是千分位,点是小数)', t1 && t1.costCNY === 300);
    check('T1 命中(ROI=1<2)', !!t1);
    check('T2 因 ROI=10 未命中', !th.some((x) => x.workId === 'T2'));
    check('T3 因成本 ¥20≤70 未命中', !th.some((x) => x.workId === 'T3'));
    check('泰国账号列取对(@th1)', t1 && t1.acct === '@th1');

    // 导航容错:页面永远不响应时,不能抛异常把整轮打死
    console.log('\n[9] 导航容错(页面卡住不响应)');
    const hang = http.createServer(() => { /* 永远不回应 */ });
    await new Promise((r) => hang.listen(0, '127.0.0.1', r));
    const hangUrl = `http://127.0.0.1:${hang.address().port}/stuck`;
    const cfgFast = { browser: { navTimeoutMs: 3000, gotoRetries: 2, waitUntil: 'commit', firstWaitMs: 100, tableTimeoutMs: 2000, minRandomDelayMs: 1, maxRandomDelayMs: 2 } };
    const navRes = await gotoWithRetry(page, hangUrl, cfgFast);
    check('打不开的页面返回 ok:false 而不是抛异常', navRes.ok === false);
    check('失败原因是人话(不是一坨 Call log)', typeof navRes.error === 'string' && navRes.error.length < 60);
    const tblRes = await gotoAndWaitTable(page, hangUrl, cfgFast);
    check('gotoAndWaitTable 也不抛异常,标明 reason=nav', tblRes.ok === false && tblRes.reason === 'nav');

    // 表格慢慢才渲染出来 → 轮询要等得到(以前是死等固定 10 秒)
    const slow = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body><div id=h></div><script>
        setTimeout(function(){ document.getElementById('h').innerHTML =
          '<table><thead><tr><th>Video ID</th><th>TikTok account</th><th>Cost (₫)</th><th>Gross revenue (₫)</th></tr></thead>' +
          '<tbody><tr><td>S1</td><td>@slow</td><td>2,000,000</td><td>1,000,000</td></tr></tbody></table>'; }, 4000);
      </script></body></html>`);
    });
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    const slowUrl = `http://127.0.0.1:${slow.address().port}/late`;
    const slowRes = await gotoAndWaitTable(page, slowUrl, { browser: { navTimeoutMs: 8000, gotoRetries: 2, waitUntil: 'commit', firstWaitMs: 500, tableTimeoutMs: 15000, minRandomDelayMs: 1, maxRandomDelayMs: 2 } });
    check('表格 4 秒后才渲染,轮询能等到', slowRes.ok === true && slowRes.rows === 1);
    hang.close();
    slow.close();

    // 扫描和播报必须各用各的页面 —— 共用一个的话,扫描跑得久时会被播报的导航顶掉
    console.log('\n[9.5] 扫描页 / 播报页 互不打扰');
    const ctx2 = await browser.newContext();
    try {
      const scanPage = await getPage(ctx2);
      const boardPage = await getBoardPage(ctx2);
      check('播报页和扫描页不是同一个', scanPage !== boardPage);
      check('上下文里确实有两个页面', ctx2.pages().length === 2);
      check('getPage 不会把播报页当主页面返回', (await getPage(ctx2)) === scanPage);
      check('getBoardPage 复用同一个播报页,不会越开越多', (await getBoardPage(ctx2)) === boardPage && ctx2.pages().length === 2);
      // 两边同时导航,各自落在各自的地址上
      await Promise.all([
        scanPage.setContent('<h1 id=t>SCAN</h1>'),
        boardPage.setContent('<h1 id=t>BOARD</h1>'),
      ]);
      check('并发设置内容后,扫描页没被顶掉', (await scanPage.textContent('#t')) === 'SCAN');
      check('并发设置内容后,播报页也没被顶掉', (await boardPage.textContent('#t')) === 'BOARD');
      await boardPage.setContent('<h1 id=t>BOARD2</h1>');
      check('播报页再次导航不影响扫描页', (await scanPage.textContent('#t')) === 'SCAN');
    } finally {
      await ctx2.close().catch(() => {});
    }

    // 按需拦截:直播口径要改写接口日期;商品口径必须关掉拦截,否则 HTTP 缓存被禁、每次重下几 MB JS
    console.log('\n[10] 请求拦截按需开关(改写直播日期 + 不误伤缓存)');
    let bodies = [];
    let jsHits = 0;
    const app = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/api/post_creative_list') {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
          bodies.push(raw);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":1}');
        });
        return;
      }
      if (u === '/big.js') {
        jsHits++;
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
        res.end('window.__big=1;'.repeat(500));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(`<html><head><script src="/big.js"></script></head><body>
        <script>fetch('/api/post_creative_list',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({start_time:'1999-01-01',end_time:'1999-01-01'})});</script>
        <p>page</p></body></html>`);
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    const appUrl = `http://127.0.0.1:${app.address().port}/`;
    const cfgLive = { browser: { blockHeavyResources: true } };

    // 直播口径:开拦截 → 接口请求体里的日期应被改写
    await setLiveInterception(page, { start: '2026-09-11', end: '2026-09-11' }, cfgLive);
    await page.goto(appUrl, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 800));
    check('直播口径:拦截已开启', page.__routeOn === true);
    check('直播口径:接口日期被改写成当天', bodies.length > 0 && bodies[0].includes('2026-09-11'));
    check('直播口径:原来的 1999 日期已被换掉', bodies.length > 0 && !bodies[0].includes('1999-01-01'));

    // 关拦截 → 浏览器缓存恢复工作:连开两次,big.js 最多再下 1 次
    await setLiveInterception(page, null, cfgLive);
    check('商品口径:拦截已关闭', page.__routeOn === false);
    jsHits = 0;
    await page.goto(appUrl, { waitUntil: 'load' });
    await page.goto(appUrl, { waitUntil: 'load' });
    const offHits = jsHits;
    // 开拦截 → 缓存被 Playwright 关掉,同样两次导航必须每次都重下
    await setLiveInterception(page, { start: '2026-09-11', end: '2026-09-11' }, cfgLive);
    jsHits = 0;
    await page.goto(appUrl, { waitUntil: 'load' });
    await page.goto(appUrl, { waitUntil: 'load' });
    const onHits = jsHits;
    await setLiveInterception(page, null, cfgLive);
    check(`不拦截时 JS 走缓存(两次导航只下载 ${offHits} 次)`, offHits <= 1);
    check(`拦截时缓存确实被禁(两次导航下载 ${onHits} 次)`, onHits === 2);
    check('→ 证明:商品计划期间必须关掉拦截,否则每次都重下整包 JS', offHits < onHits);
    app.close();

    // 列识别体检:界面换措辞导致认不出列时,必须能自己发现,而不是静悄悄 0 命中
    console.log('\n[11] 列识别体检(闷声出错的最后一道闸)');
    await page.setContent(`<html><body><table>
      <thead><tr><th>Video ID</th><th>TikTok account</th><th>Cost (₫)</th><th>Gross revenue (₫)</th></tr></thead>
      <tbody><tr><td>D1</td><td>@d</td><td>2,000,000</td><td>1,000,000</td></tr></tbody></table></body></html>`);
    const dGood = await diagColumns(page);
    check('正常表:表格找得到', dGood && dGood.found === true);
    check('正常表:成本列定位到第 2 列', dGood && dGood.map.cost === 2);
    check('正常表:ID 列定位到第 0 列', dGood && dGood.map.id === 0);

    await page.setContent(`<html><body><table>
      <thead><tr><th>Video ID</th><th>TikTok account</th><th>Куда</th><th>Сколько</th></tr></thead>
      <tbody><tr><td>D2</td><td>@d</td><td>2,000,000</td><td>1,000,000</td></tr></tbody></table></body></html>`);
    const dBad = await diagColumns(page);
    check('认不出的措辞:表格还找得到(ID 列在)', dBad && dBad.found === true);
    check('认不出的措辞:成本列标记为未识别(-1),会触发告警', dBad && dBad.map.cost === -1);

    // 计划维度合计(日报的数据来源):成本 / GMV / ROI
    console.log('\n[11.2] 计划维度合计取数(日报数据源)');
    // ① 表格自带「合计」行 → 优先用它
    await page.setContent(`<html><body><table>
      <thead><tr><th>作品 ID</th><th>TikTok 账号</th><th>成本(₫)</th><th>总收入(₫)</th></tr></thead>
      <tbody>
        <tr><td>合计</td><td>-</td><td>10,000,000</td><td>30,000,000</td></tr>
        <tr><td>A1</td><td>@a</td><td>6,000,000</td><td>18,000,000</td></tr>
        <tr><td>A2</td><td>@b</td><td>4,000,000</td><td>12,000,000</td></tr>
      </tbody></table></body></html>`);
    const tf = await scanTotals(page, { vndToCnyRate: 3891 });
    check('识别到表格自带的合计行', tf.ok && tf.source === 'footer');
    check(`成本 = 10,000,000₫ → ¥2570(实际 ${Math.round(tf.costCNY)})`, Math.round(tf.costCNY) === 2570);
    check(`GMV = 30,000,000₫ → ¥7710(实际 ${Math.round(tf.gmvCNY)})`, Math.round(tf.gmvCNY) === 7710);
    check(`ROI = 3(实际 ${tf.roi})`, tf.roi === 3);

    // ② 没有合计行 → 逐行累加(顺便验证越南语千分位)
    await page.setContent(`<html><body><table>
      <thead><tr><th>ID video</th><th>Tài khoản</th><th>Chi phí (₫)</th><th>Doanh thu (₫)</th></tr></thead>
      <tbody>
        <tr><td>B1</td><td>@a</td><td>6.000.000</td><td>18.000.000</td></tr>
        <tr><td>B2</td><td>@b</td><td>4.000.000</td><td>8.000.000</td></tr>
      </tbody></table></body></html>`);
    const ts = await scanTotals(page, { vndToCnyRate: 3891 });
    check('没有合计行时改为逐行累加', ts.ok && ts.source === 'sum');
    check(`累加成本 = ¥2570(实际 ${Math.round(ts.costCNY)})`, Math.round(ts.costCNY) === 2570);
    check(`累加 GMV = ¥6682(实际 ${Math.round(ts.gmvCNY)})`, Math.round(ts.gmvCNY) === 6682);
    check(`ROI = 26,000,000/10,000,000 = 2.6(实际 ${ts.roi})`, ts.roi === 2.6);
    check('统计到 2 条素材', ts.rows === 2);

    // ③ 认不出成本列 → 明确报失败,而不是返回 0 冒充数据
    await page.setContent(`<html><body><table>
      <thead><tr><th>Video ID</th><th>@acct</th><th>Куда</th><th>Сколько</th></tr></thead>
      <tbody><tr><td>C1</td><td>@a</td><td>1,000</td><td>2,000</td></tr></tbody></table></body></html>`);
    const tn = await scanTotals(page, { vndToCnyRate: 3891 });
    check('列认不出时明确失败(不会拿 0 冒充)', tn.ok === false && tn.reason === 'no_cost_col');

    // 运营播报读的是「广告计划列表」那张表。下面的列名和数值是 2026-09-21
    // 从真实后台抄下来的,重点验证那一堆近似列名不会被误匹配。
    console.log('\n[11.3] 播报 · 读计划列表表格(中英文真实结构 + 认表 + 翻页)');

    // 以下列名全部是 2026-09-21 从真实后台抄的(中文版/英文版各一份)
    const PH_ZH = ['开/关','广告计划名称','状态','广告计划预算','健康状态与洞察','权益','成本','总收入','优惠券成本','ROI 保护','有效升级功能','排期时间','创意作品加热预算','目标 ROI','净成本','SKU 订单数','平均下单成本','ROI','优惠券带来的收入','跨广告位优惠券总收入'];
    const PH_EN = ['On/Off','Campaign name','Status','Campaign budget','Health and insights','Offers','Cost','Gross revenue','Coupon cost','ROI protection','Active upgrades','Schedule time','Creative boost budget','Target ROI','Net Cost','SKU orders','Cost per order','ROI','Revenue from coupons','Cross-placement coupon gross revenue'];
    const LH_ZH = ['开/关','广告计划名称','状态','日预算','健康状态与洞察','权益','成本','可用的 TikTok 账号','ROI 保护','有效升级功能','排期时间','目标 ROI','最大投放量预算','总预算','净成本','优惠券成本','总收入','优惠券带来的收入','跨广告位优惠券总收入','ROI','SKU 订单数','平均下单成本','直播播放量','目标 ROI 成本','基本目标 ROI 成效','受众加热预算','受众加热成本','创意作品加热预算','创意作品加热成本'];
    const LH_EN = ['On/Off','Campaign name','Status','Target ROI budget','Health and insights','Offers','Cost','Available TikTok accounts','ROI protection','Active upgrades','Schedule time','Target ROI','Max delivery budget','Total budget','Net Cost','Coupon cost','Gross revenue','Revenue from coupons','Cross-placement coupon gross revenue','ROI','SKU orders','Cost per order','LIVE views','Target ROI cost','Base target ROI result','Viewer boost budget','Viewer boost cost','Creative boost budget','Creative boost cost'];

    const mkT = (heads, rows, extra = '') =>
      `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>${extra}`;
    // 商品 20 列:成本=6 总收入=7 目标ROI=13 净成本=14 ROI=17
    const pRow = (n, cost, gmv, roi) => ['on', `<div>${n}</div><div><a>数据分析</a></div>`, '已生效',
      '606,000,000 VND', '良好', '-', cost, gmv, '0 VND', '符合资格', '-', '2026-09-16', '-', '3.20',
      '17,956,410 VND', '2,682', '69,732 VND', roi, '0 VND', '0 VND'];
    // 直播 29 列:成本=6 总预算=13 净成本=14 总收入=16 ROI=19
    const lRow = (n, cost, gmv, roi) => ['on', `<div>${n}</div><div><a>数据分析</a></div>`, '已生效',
      '200,000,000 VND', '良好', '-', cost, 'KANS SKINCARE VIETNAM', '符合资格', '-', '2026-07-08', '5.30',
      '-', '200,000,000 VND', '3,857,772 VND', '0 VND', gmv, '0 VND', '0 VND', roi, '775', '28,732 VND',
      '16,490', '22,267,631 VND', '5.35', '0 VND', '0 VND', '0 VND', '0 VND'];

    for (const [lang, ph, lh] of [['中文', PH_ZH, LH_ZH], ['英文', PH_EN, LH_EN]]) {
      await page.setContent(`<html><body>${mkT(ph, [
        pRow('MKT-377次抛-377 Serum-0916', '187,021,290 VND', '527,536,078 VND', '2.82'),
        pRow('MKT-白精华-White Essence-0708', '28,929,879 VND', '102,384,304 VND', '3.54'),
      ])}</body></html>`);
      const pr = await page.evaluate(readCampaignTable, { expect: 'product' });
      check(`[${lang}] 商品表读到 2 行`, pr.rows && pr.rows.length === 2);
      check(`[${lang}] 认出这是商品 tab`, pr.sawKind === 'product' && !pr.tabMismatch);
      const a = pr.rows && pr.rows[0];
      check(`[${lang}] 计划名只取第一行,不带「数据分析」`, a && a.name === 'MKT-377次抛-377 Serum-0916');
      check(`[${lang}] 成本取「成本」187,021,290,不是净成本 17,956,410`, a && a.cost.num === 187021290);
      check(`[${lang}] 总收入取「总收入」527,536,078,不是优惠券收入`, a && a.revenue.num === 527536078);
      check(`[${lang}] ROI 取 2.82,不是「目标 ROI」3.20`, a && a.roi.num === 2.82);
      check(`[${lang}] 币种识别 VND`, a && a.cost.currency === 'VND');

      await page.setContent(`<html><body>${mkT(lh, [
        lRow('KANS SKINCARE VIETNAM 0708', '22,267,631 VND', '119,160,272 VND', '5.35'),
      ])}</body></html>`);
      const lr = await page.evaluate(readCampaignTable, { expect: 'live' });
      check(`[${lang}] 直播表读到 1 行(列顺序和商品完全不同)`, lr.rows && lr.rows.length === 1);
      check(`[${lang}] 认出这是直播 tab`, lr.sawKind === 'live' && !lr.tabMismatch);
      check(`[${lang}] 直播总收入取 119,160,272,没被「总预算」200,000,000 带偏`, lr.rows && lr.rows[0].revenue.num === 119160272);
      check(`[${lang}] 直播 ROI 5.35,不是目标 ROI 5.30`, lr.rows && lr.rows[0].roi.num === 5.35);

      // ★ 要商品却停在直播 tab —— 必须报错,不能把直播数据当商品上报
      const wrong = await page.evaluate(readCampaignTable, { expect: 'product' });
      check(`[${lang}] ★ 要商品却读到直播表 → 报 tabMismatch,不会混数据`, wrong.tabMismatch === true && wrong.sawKind === 'live');

      // ★★ 这次翻车的原因:特征列没渲染出来时,绝不能一口咬定"那就是另一种表"
      // 只留最基本的几列(既没有直播特征列、也没有商品特征列)
      const barebone = mkT(['广告计划名称', '状态', '成本', '总收入', 'ROI'],
        [['某计划', '已生效', '1,000,000 VND', '3,000,000 VND', '3.00']]);
      await page.setContent(`<html><body>${barebone}</body></html>`);
      const amb1 = await page.evaluate(readCampaignTable, { expect: 'live' });
      check(`[${lang}] ★★ 认不出是哪张表时要「放行」,不能判直播失败`, !amb1.tabMismatch && amb1.rows.length === 1);
      const amb2 = await page.evaluate(readCampaignTable, { expect: 'product' });
      check(`[${lang}] ★★ 同一张表要商品也放行(拿不准就别丢数据)`, !amb2.tabMismatch && amb2.rows.length === 1);
    }

    // ★ 翻页:后台每页固定 10 条(URL 参数改不动),第 11 条起必须靠点「下一页」
    const pg1 = Array.from({ length: 10 }, (_, i) => pRow(`计划${i + 1}`, '1,000,000 VND', '3,000,000 VND', '3.00'));
    const pg2 = [pRow('计划11', '2,000,000 VND', '6,000,000 VND', '3.00')];
    await page.setContent(`<html><body><div id=host>${mkT(PH_ZH, pg1)}</div>
      <ul class="core-pagination"><li class="core-pagination-item-next" id=nx>下一页</li></ul>
      <script>document.getElementById('nx').addEventListener('click', function () {
        document.getElementById('host').innerHTML = ${JSON.stringify(mkT(PH_ZH, pg2))};
        document.getElementById('nx').className = 'core-pagination-item-next disabled';
      });</script></body></html>`);
    const paged = await page.evaluate(readCampaignTable, { expect: 'product' });
    check(`★ 翻页:10+1 条全读到(实际 ${paged.rows && paged.rows.length})`, paged.rows && paged.rows.length === 11);
    check('★ 翻页:第 11 条确实拿到了', paged.rows && paged.rows.some((r) => r.name === '计划11'));
    check('★ 翻页:翻了 2 页', paged.pages === 2);
    check('★ 翻页:没有重复计数', paged.rows && new Set(paged.rows.map((r) => r.name)).size === 11);

    await page.setContent(`<html><body>${mkT(PH_ZH, pg2)}</body></html>`);
    const single = await page.evaluate(readCampaignTable, { expect: 'product' });
    check('只有一页时 pages=1,不会空转', single.pages === 1 && single.rows.length === 1);

    // 币种:有人 Chrome 装了汇率插件会把数字变成 ¥,也要认
    await page.setContent(`<html><body>${mkT(['广告计划名称','状态','成本','总收入','ROI'],
      [['某计划', '已生效', '¥66,082', '¥237,004', '3.59']])}</body></html>`);
    const cny = await page.evaluate(readCampaignTable, { expect: 'product' });
    check('人民币显示时币种识别为 CNY', cny.rows[0].cost.currency === 'CNY');
    check('人民币数值原样 66082', cny.rows[0].cost.num === 66082);

    await page.setContent(`<html><body>${mkT(['广告计划名称','状态','成本','总收入','ROI'],
      [['无币种', '已生效', '28,929,879', '102,384,304', '3.54']])}</body></html>`);
    const bare = await page.evaluate(readCampaignTable, { expect: 'product' });
    check('没有币种标记时 currency 为空', bare.rows[0].cost.currency === '');


  } catch (e) {
    check(`浏览器扫描无异常(${e.message})`, false);
  } finally {
    if (browser) await browser.close();
  }

  // 4) 连续失败时的打扰频率(用户最烦"网络抖一下手机就响")
  console.log('\n[11.5] 连续失败的告警/重启退避策略');
  const P = (n) => failurePolicy({ consecutiveFailures: n, alertAfter: 2, alertRepeatEvery: 6 });
  check('第 1 次失败不打扰(先安静补跑)', !P(1).alert);
  check('第 2 次失败才推手机', P(2).alert);
  check('第 3~7 次不再重复推', [3, 4, 5, 6, 7].every((n) => !P(n).alert));
  check('第 8 次再提醒一次(隔 6 次)', P(8).alert);
  const alertsIn20 = Array.from({ length: 20 }, (_, i) => P(i + 1).alert).filter(Boolean).length;
  check(`连挂 20 轮总共只推 4 条(实际 ${alertsIn20} 条)`, alertsIn20 === 4);
  check('卡死时立刻重启浏览器', failurePolicy({ consecutiveFailures: 1, needRestart: true }).restart);
  check('第 2 次失败重启一次', P(2).restart);
  check('第 3、4 次不重复重启', !P(3).restart && !P(4).restart);
  check('之后每 5 次重启一次(第 5、10 次)', P(5).restart && P(10).restart);

  // 4.5) 红警卡片:素材ID 要在、新素材/连续几天要标对
  console.log('\n[11.6] 红色预警卡片(素材ID + 新素材标记)');
  const rcfg = { notify: { redAlert: { costThresholdCNY: 200, roiThreshold: 1 } } };
  const rhist = new Map([
    ['W-OLD', { firstDate: '2026-09-09', days: new Set(['2026-09-09', '2026-09-10']), count: 5 }],
  ]);
  // 故意让"老素材"消耗最高,验证新素材还是能排到前面
  const rcard = buildRedAlertCard(rcfg, '9月12日-11.00', [
    { campaign: '商品计划', acct: '@x', workId: 'W-OLD', costCNY: 1180, roi: 0.6 },
    { campaign: '直播计划', acct: 'KANS Khoa học', workId: 'W-NEW', costCNY: 699, roi: 0.44 },
    { campaign: '卡片计划', acct: '', workId: '', costCNY: 260, roi: 0.8 },
  ], rhist);
  const rtext = rcard.lines.join('\n');
  check('素材ID 出现在卡片里(能拿去后台定位)', rtext.includes('W-NEW') && rtext.includes('W-OLD'));
  check('账号和素材ID 同时显示,不是二选一', rtext.includes('KANS Khoa học | W-NEW'));
  check('没历史的标「新素材 · 需重点关注」', /W-NEW[\s\S]{0,90}🆕 新素材 · 需重点关注/.test(rtext));
  check('有历史的标「老素材 · 已连续第 3 天」', rtext.includes('老素材 · 已连续第 3 天'));
  check('首次日期格式是 9月9日 不是 09月09日', rtext.includes('首次 9月9日'));
  // 方向很重要:新素材才是要盯的(红),老素材是已接受的(灰) —— 别再搞反
  check('新素材标红(需关注)', /color='red'>🆕 新素材/.test(rtext));
  check('老素材标灰(已接受,不催人)', /color='grey'>老素材/.test(rtext));
  check('卡片里不该再出现绿色的新素材标记', !/color='green'>🆕/.test(rtext));
  check('新素材排在老素材前面(哪怕老素材消耗更高)', rtext.indexOf('W-NEW') < rtext.indexOf('W-OLD'));
  check('商品卡片(没素材ID)不乱标新旧', rtext.includes('商品卡片(无作品ID)') && !/商品卡片[\s\S]{0,60}新素材/.test(rtext));

  // 口径必须标出来 —— 10点/14点那两轮当天和近7天混在一张卡片里,不标就分不清是单日还是7天累计
  console.log('\n[11.7] 红警卡片按口径分组 + 标日期范围');
  const ccard = buildRedAlertCard(
    rcfg,
    '9月16日-14.00',
    [
      { caliber: '当天', campaign: '直播计划', acct: 'A', workId: 'D1', costCNY: 1779, roi: 0.89 },
      { caliber: '近7天', campaign: '直播计划', acct: 'A', workId: 'D1', costCNY: 8940, roi: 0.77 },
      { caliber: '近7天', campaign: '商品计划', acct: 'B', workId: 'D2', costCNY: 2210, roi: 0.62 },
    ],
    new Map(),
    { 当天: '9月16日', 近7天: '9月10日 ~ 9月16日' }
  );
  const ctext = ccard.lines.join('\n');
  check('有【当天】分组标题', ctext.includes('【当天】'));
  check('有【近7天】分组标题', ctext.includes('【近7天】'));
  check('当天标出具体日期', ctext.includes('9月16日'));
  check('近7天标出日期范围', ctext.includes('9月10日 ~ 9月16日'));
  check('近7天明确写「7天累计,不是单日」', ctext.includes('7天累计,不是单日'));
  check('近7天不标新旧(口径不同,标了会误导)', !/近7天[\s\S]*新素材/.test(ctext));
  check(
    '近7天组内按消耗降序(¥8940 在 ¥2210 前)',
    ctext.indexOf('¥8940') < ctext.indexOf('¥2210')
  );
  check('当天组排在近7天组前面', ctext.indexOf('【当天】') < ctext.indexOf('【近7天】'));

  // 4.8) 自动发现广告计划:从接口返回里挖 id,并安全合并进 campaigns.json
  console.log('\n[11.8] 自动发现广告计划(解析 + 合并)');
  const fakeResp = [
    {
      url: 'https://seller-vn.tiktok.com/api/v1/ads/campaign/list',
      body: {
        code: 0,
        data: {
          campaign_list: [
            { campaign_id: '1880000000000009', campaign_name: 'MKT-白精华-White Essence-0708', product_id: '1740000000000000009', budget: 51600 },
            { campaign_id: '1880000000000001', campaign_name: 'MKT-377次抛-377 Serum-0916', product_id: '1740000000000000001' },
            { campaign_id: '1880000000000002', campaign_name: 'MKT-红面霜-Red Cream-0803', product_id: '1740000000000000002' },
            { campaign_id: '1880000000000008', campaign_name: 'KANS SKINCARE VIETNAM 0708' },
          ],
          page_info: { total: 4, page: 1 },
        },
      },
    },
    // 另一个接口只给了部分字段,不该覆盖掉已有的完整信息
    { url: 'https://seller-vn.tiktok.com/api/v1/ads/overview', body: { data: { items: [{ campaign_id: '1880000000000001', name: 'MKT-377次抛-377 Serum-0916' }] } } },
    // 干扰项:id 太短、不像计划ID,不该被当成计划
    { url: 'https://x/api/other', body: { data: [{ campaign_id: '123', campaign_name: '噪音' }] } },
  ];
  const got = extractCampaigns(fakeResp);
  check(`从接口返回里挖出 4 条(实际 ${got.length})`, got.length === 4);
  check('短 id 的噪音没被当成计划', !got.some((g) => g.campaign_id === '123'));
  const s377 = got.find((g) => g.campaign_id === '1880000000000001');
  check('377次抛 的 product_id 没被第二个接口冲掉', s377 && s377.product_id === '1740000000000000001');
  const live = got.find((g) => g.campaign_id === '1880000000000008');
  check('没有 product_id 的那条,product_id 为空', live && live.product_id === '');

  const existing = [
    { name: 'MKT-白精华-0708', campaign_id: '1880000000000009', product_id: '1740000000000000009' },
    { name: 'KANS SKINCARE VIETNAM 0708(直播)', campaign_id: '1880000000000008', type: 'live' },
  ];
  const { merged, added } = mergeCampaigns(existing, got);
  check(`只新增 2 条(实际 ${added.length})`, added.length === 2);
  check('合并后共 4 条', merged.length === 4);
  check('已有的计划名字没被后台名覆盖', merged[0].name === 'MKT-白精华-0708');
  check('已有的 type:live 没被弄丢', merged[1].type === 'live');
  check('新增的商品计划带 product_id', added.every((a) => a.product_id || a.type === 'live'));
  const again = mergeCampaigns(merged, got);
  check('再跑一次不会重复添加(幂等)', again.added.length === 0);

  // 4.9) 运营播报:按真实后台表格结构读数
  // 下面这张表是 2026-09-21 从真实后台抄下来的列名和数值(商品 GMV Max 那张),
  // 重点是那一堆容易误匹配的近似列名必须避开。
  const boardCfg = { vndToCnyRate: 3891, roiThreshold: 2, timezoneOffsetHours: 7 };
  console.log('\n[11.9] 运营播报 · 卡片与近1小时增量');
  // 卡片 + 近1小时增量(这部分不依赖浏览器)
  const st = [
    { campaign_id: 'A', name: 'MKT-白精华-0708', kind: 'product', costCNY: 2000, gmvCNY: 6000, roi: 3 },
    { campaign_id: 'B', name: 'MKT-377次抛-0916', kind: 'product', costCNY: 1000, gmvCNY: 1000, roi: 1 },
    { campaign_id: 'C', name: 'MKT-红面霜-0803', kind: 'product', costCNY: 0, gmvCNY: 0, roi: 0 },
  ];
  const tt = totals(st);
  check(`合计消耗 ¥3000(实际 ${Math.round(tt.cost)})`, Math.round(tt.cost) === 3000);
  check(`合计 ROI = 7000/3000 = 2.33(实际 ${tt.roi})`, tt.roi === 2.33);

  const nowTs = Date.now();
  const snapOk = { ts: nowTs - 60 * 60000, date: 'x', rows: [
    { id: 'A', n: 'A', c: 1500, g: 4000 }, { id: 'B', n: 'B', c: 900, g: 700 },
  ] };
  const snapTooOld = { ts: nowTs - 5 * 60 * 60000, date: 'x', rows: [] };
  check('能挑到约1小时前的快照', pickBaseline([snapTooOld, snapOk], 60) === snapOk);
  check('只有很久以前的快照时不硬凑', pickBaseline([snapTooOld], 60) === null);
  check('一份快照都没有时返回 null', pickBaseline([], 60) === null);

  const bcard = buildBoardCard(boardCfg, st, snapOk);
  const btext = bcard.lines.join('\n').replace(/<font color='\w+'>(.*?)<\/font>/g, '$1').replace(/\*\*/g, '');
  check('卡片有「当天累计」', btext.includes('当天累计'));
  check('当天累计消耗 ¥3,000', btext.includes('消耗 ¥3,000'));
  check('近1小时消耗 = ¥600', btext.includes('消耗 ¥600'));
  check('近1小时成交 = ¥2,300', btext.includes('成交 ¥2,300'));
  check('近1小时 ROI = 3.83', btext.includes('ROI 3.83'));
  check('没有基准快照时明说"数据还没攒够"', buildBoardCard(boardCfg, st, null).lines.join('\n').includes('还没攒够'));
  const backwards = buildBoardCard(boardCfg, st, { ts: nowTs - 60 * 60000, date: 'x', rows: [{ id: 'A', n: 'A', c: 2500, g: 7000 }] }).lines.join('\n');
  check('累计倒退时增量按 0 算,不出负数', !/消耗 ¥-/.test(backwards) && !/成交 ¥-/.test(backwards));

  // 三层结构:全部 / 商品卡 / 直播间 / 单条计划,而且 0 消耗的计划也要列出来
  const mixed = [
    { campaign_id: 'P1', name: 'MKT-377次抛-0916', kind: 'product', status: '已生效', costCNY: 51221, gmvCNY: 144045, roi: 2.81 },
    { campaign_id: 'P2', name: 'MKT-白精华-0708', kind: 'product', status: '已生效', costCNY: 7719, gmvCNY: 28007, roi: 3.63 },
    { campaign_id: 'P3', name: 'MKT-闪充棒-0916', kind: 'product', status: '已暂停', costCNY: 0, gmvCNY: 0, roi: 0 },
    { campaign_id: 'L1', name: 'KANS SKINCARE VIETNAM 0708', kind: 'live', status: '已生效', costCNY: 5950, gmvCNY: 32321, roi: 5.43 },
    { campaign_id: 'L2', name: 'Kans Official Vietnam-0811', kind: 'live', status: '未投放', costCNY: 0, gmvCNY: 231, roi: 0 },
  ];
  const mBase = { ts: Date.now() - 60 * 60000, date: 'x', rows: [
    { id: 'P1', n: '', c: 45000, g: 130000 }, { id: 'P2', n: '', c: 7000, g: 25000 },
    { id: 'L1', n: '', c: 5000, g: 28000 },
  ] };
  const mCard = buildBoardCard(boardCfg, mixed, mBase);
  const mText = mCard.lines.join('\n').replace(/<font color='\w+'>(.*?)<\/font>/g, '$1').replace(/\*+/g, '');
  check('卡片有「全部 GMV Max」汇总', mText.includes('全部 GMV Max'));
  check('卡片有「商品卡 GMV Max」汇总', mText.includes('商品卡 GMV Max'));
  check('卡片有「直播间 GMV Max」汇总', mText.includes('直播间 GMV Max'));
  check('顺序是 全部 → 商品卡 → 直播间',
    mText.indexOf('全部 GMV Max') < mText.indexOf('商品卡 GMV Max') &&
    mText.indexOf('商品卡 GMV Max') < mText.indexOf('直播间 GMV Max'));
  // 商品卡合计 51221+7719=58940;直播合计 5950
  check(`商品卡合计消耗 ¥58,940(实际文本含)`, mText.includes('¥58,940'));
  check(`直播间合计消耗 ¥5,950`, mText.includes('¥5,950'));
  check(`全部合计消耗 ¥64,890`, mText.includes('¥64,890'));
  check('★ 0 消耗的计划也要列出来(以前会被过滤掉)', mText.includes('MKT-闪充棒-0916') && mText.includes('今天没有消耗'));
  check('未投放但有成交的直播计划也列出来', mText.includes('Kans Official Vietnam-0811'));
  check('明细里 5 条计划一条不少',
    ['MKT-377次抛-0916','MKT-白精华-0708','MKT-闪充棒-0916','KANS SKINCARE VIETNAM 0708','Kans Official Vietnam-0811']
      .every((n) => mText.includes(n)));

  const bRows = buildBoardRows(boardCfg, mixed, mBase);
  check(`底表行数 = 3 层汇总 + 5 条计划 = 8(实际 ${bRows.length})`, bRows.length === 8);
  check('前三行层级依次是 全部/商品卡/直播间',
    bRows[0].level === '全部' && bRows[1].level === '商品卡' && bRows[2].level === '直播间');
  check('其余行层级都是「计划」', bRows.slice(3).every((r) => r.level === '计划'));
  check(`全部层消耗 64890(实际 ${bRows[0].costCNY})`, bRows[0].costCNY === 64890);
  check(`商品卡层消耗 58940(实际 ${bRows[1].costCNY})`, bRows[1].costCNY === 58940);
  check('计划行带上状态(已暂停/未投放)', bRows.some((r) => r.status === '已暂停') && bRows.some((r) => r.status === '未投放'));
  // 近1小时:商品卡 (51221-45000)+(7719-7000)=6940
  check(`商品卡近1小时消耗 6940(实际 ${bRows[1].h1cost})`, bRows[1].h1cost === 6940);
  const noBaseRows = buildBoardRows(boardCfg, mixed, null);
  check('没有基准快照时,近1小时字段留空而不是写 0', noBaseRows[0].h1cost === null);

  // ★ 某个 tab 取数失败时,绝不能显示成 ¥0(那会被当成"今天没花钱")
  const failCard = buildBoardCard(boardCfg, mixed.filter((r) => r.kind === 'product'), null, ['live']);
  const failText = failCard.lines.join('\n').replace(/<font color='\w+'>(.*?)<\/font>/g, '$1').replace(/\*+/g, '');
  check('直播取数失败时明说「取数失败」,不显示 ¥0', /直播间 GMV Max[\s\S]{0,60}取数失败/.test(failText));
  check('失败时不会出现"直播间 当天累计 消耗 ¥0"这种误导',
    !/直播间 GMV Max[\s\S]{0,80}当天累计　消耗 \*?\*?¥0/.test(failText));
  check('全部汇总旁边会提示"不含直播间"', failText.includes('这次没取到'));
  // 新版 config 把汇率搬进了 market 块,卡片脚注不能再直接读老键,否则印出「₫/undefined」
  const noteCard = buildBoardCard({ roiThreshold: 2, timezoneOffsetHours: 7 }, st, null, []);
  check('★ 卡片脚注的汇率不会是 undefined', !noteCard.lines.join('\n').includes('undefined'));
  check('商品卡那一层照常显示', /商品卡 GMV Max[\s\S]{0,80}当天累计/.test(failText));

  const prevDD = process.env.KANS_DATA_DIR;
  const tmpDD = fs.mkdtempSync(path.join(os.tmpdir(), 'kans-board-'));
  process.env.KANS_DATA_DIR = tmpDD;
  saveSnapshot(st, boardCfg);
  check('快照能存能读回', readSnapshots(boardCfg).length === 1);
  if (prevDD === undefined) delete process.env.KANS_DATA_DIR;
  else process.env.KANS_DATA_DIR = prevDD;
  fs.rmSync(tmpDD, { recursive: true, force: true });

  // 4.9) 日志回传飞书:只测"哪些要传 / 没配飞书会不会闹",不真连网
  console.log('\n[13.5] 运行日志回传飞书');
  {
    const ls = await import('./logsync.js');
    check('WARN 一定上传', ls.shouldUpload('WARN', '直播计划列表取数失败'));
    check('ERROR 一定上传', ls.shouldUpload('ERROR', '崩了'));
    check('关键 INFO 上传(读到几条)', ls.shouldUpload('INFO', '直播计划读到 3 条'));
    check('关键 INFO 上传(开工收工)', ls.shouldUpload('INFO', '===== 本轮 9月21日-18.30 开始 ====='));
    check('关键 INFO 上传(歇一会儿再要)', ls.shouldUpload('INFO', '直播:页面打不开,歇 20 秒再要一次(第2/5次)…'));
    check('★ 普通 INFO 不上传(别把表刷爆)', !ls.shouldUpload('INFO', '已关闭请求拦截(让浏览器 HTTP 缓存生效)'));
    ls._resetForTest();
    const off = ls.startLogSync({ feishu: { enabled: false } });
    check('★ 飞书没配时安静跳过,不影响程序', off.ok === false && !!off.reason);
    ls._resetForTest();
  }

  // 5) 端到端:拿假后台完整跑一轮 runOnce(最能挡住"改一处坏一片")
  await boardPipelineTests();
  await integrationTests();

  console.log(`\n== 自检结果:${passed} 通过 / ${failed} 失败 ==\n`);
  if (failed > 0) process.exitCode = 1;
}

// ---------------- 端到端:播报取数链路 ----------------

/**
 * 用假后台把 fetchCampaignStats 整条链路跑一遍:
 * 导航 → 等表格 → 认表(防商品/直播串台)→ 翻页(每页10条的坑)→ VND换算。
 * 单独测 readCampaignTable 是不够的 —— 串台和翻页只有整条跑才验得出来。
 */
async function boardPipelineTests() {
  console.log('\n[14] 端到端:播报取数链路(认表 / 翻页 / 换算 / 半边失败)');
  const PH = ['开/关','广告计划名称','状态','广告计划预算','健康状态与洞察','权益','成本','总收入','优惠券成本','ROI 保护','有效升级功能','排期时间','创意作品加热预算','目标 ROI','净成本','SKU 订单数','平均下单成本','ROI','优惠券带来的收入','跨广告位优惠券总收入'];
  const LH = ['开/关','广告计划名称','状态','日预算','健康状态与洞察','权益','成本','可用的 TikTok 账号','ROI 保护','有效升级功能','排期时间','目标 ROI','最大投放量预算','总预算','净成本','优惠券成本','总收入','优惠券带来的收入','跨广告位优惠券总收入','ROI','SKU 订单数','平均下单成本','直播播放量','目标 ROI 成本','基本目标 ROI 成效','受众加热预算','受众加热成本','创意作品加热预算','创意作品加热成本'];
  const T = (h, rows, extra = '') =>
    `<table><thead><tr>${h.map((x) => `<th>${x}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>${extra}`;
  const pR = (n, c, g, roi) => ['on', `<div>${n}</div><div><a>数据分析</a></div>`, '已生效', '606,000,000 VND', '良好', '-', c, g, '0 VND', '符合', '-', '2026-09-16', '-', '3.20', '17,956,410 VND', '2,682', '69,732 VND', roi, '0 VND', '0 VND'];
  const lR = (n, c, g, roi) => ['on', `<div>${n}</div><div><a>数据分析</a></div>`, '已生效', '200,000,000 VND', '良好', '-', c, 'ACC', '符合', '-', '2026-07-08', '5.30', '-', '200,000,000 VND', '3,857,772 VND', '0 VND', g, '0 VND', '0 VND', roi, '775', '28,732 VND', '16,490', '22,267,631 VND', '5.35', '0 VND', '0 VND', '0 VND', '0 VND'];

  const cfg = {
    vndToCnyRate: 3891, roiThreshold: 2, timezoneOffsetHours: 7,
    // 自检里把"耐心"调小(真实默认是 5 分钟预算 / 歇 20 秒),否则一条用例就要跑几分钟
    browser: { headless: true, navTimeoutMs: 8000, gotoRetries: 1, waitUntil: 'commit',
               boardTableTimeoutMs: 8000, boardTabBudgetMs: 40000, boardTabTries: 3, boardRetryWaitMs: 800,
               minRandomDelayMs: 1, maxRandomDelayMs: 2, blockHeavyResources: false },
  };

  const scenario = async (title, handler, assertFn) => {
    let browser = null;
    try {
      browser = await launchAny();
      const ctx = await browser.newContext();
      await ctx.route('https://seller-vn.tiktok.com/**', handler);
      const res = await fetchCampaignStats(cfg, { context: ctx });
      await assertFn(res);
      await ctx.close();
    } catch (e) {
      check(`${title}(${e.message.split('\n')[0]})`, false);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  };

  await scenario('正常取数', async (route) => {
    const live = /type=live/.test(route.request().url());
    const body = live
      ? `<html><body>${T(LH, [lR('直播A', '22,267,631 VND', '119,160,272 VND', '5.35'), lR('直播B', '16,089,887 VND', '79,124,158 VND', '4.92')])}</body></html>`
      : `<html><body><div id=h>${T(PH, Array.from({ length: 10 }, (_, i) => pR('商品' + (i + 1), '1,000,000 VND', '3,000,000 VND', '3.00')))}</div>
         <ul><li class="core-pagination-item-next" id=nx>下一页</li></ul>
         <script>document.getElementById('nx').addEventListener('click',function(){
           document.getElementById('h').innerHTML=${JSON.stringify(T(PH, [pR('商品11', '2,000,000 VND', '6,000,000 VND', '3.00')]))};
           this.className='core-pagination-item-next disabled';});</script></body></html>`;
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  }, (res) => {
    check('取数成功且没有失败的 tab', res.ok === true && (res.failed || []).length === 0);
    check(`商品11条+直播2条 = 13(实际 ${res.rows.length})`, res.rows.length === 13);
    const p = res.rows.filter((r) => r.kind === 'product');
    check('★ 翻页拿到了第 11 条', p.length === 11 && p.some((r) => r.name === '商品11'));
    check('直播 2 条,kind 没串', res.rows.filter((r) => r.kind === 'live').length === 2);
    const a = p.find((r) => r.name === '商品1');
    check(`VND→¥ 换算对(1,000,000/3891=257,实际 ${Math.round(a.costCNY)})`, Math.round(a.costCNY) === 257);
    const lv = res.rows.find((r) => r.name === '直播A');
    check(`直播总收入取对(实际 ¥${Math.round(lv.gmvCNY)})`, Math.round(lv.gmvCNY) === 30625);
  });

  await scenario('商品打不开', async (route) => {
    if (!/type=live/.test(route.request().url())) return; // 商品:永不响应
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: `<html><body>${T(LH, [lR('直播A', '22,267,631 VND', '119,160,272 VND', '5.35')])}</body></html>` });
  }, (res) => {
    check('商品打不开时标记为失败', (res.failed || []).includes('product'));
    check('★ 商品一条都不给(绝不拿 0 冒充)', res.rows.filter((r) => r.kind === 'product').length === 0);
    check('直播照常取到,半边数据仍可用', res.rows.filter((r) => r.kind === 'live').length === 1);
  });

  // ★★ 2026-09-21 线上故障回归:商品先读成功 → 页面停在 type=product →
  // 去 type=live 超时 → 旧代码的 alreadyLanded 因为列表页没有 campaign_id 就谎报"已到目标页",
  // 于是读到的还是商品表 → tabMismatch → 直播 tab 整个丢掉,而且重试一次都没跑。
  // 正确表现:识破没到目标页 → 重试 → 第二次就拿到直播数据。
  let liveHits = 0;
  await scenario('★★ 直播第一次超时,重试要能救回来(不能谎报已到目标页)', async (route) => {
    const isLive = /type=live/.test(route.request().url());
    if (isLive && ++liveHits === 1) return; // 第一次:永不响应,制造导航超时
    const body = isLive
      ? `<html><body>${T(LH, [lR('直播A', '22,267,631 VND', '119,160,272 VND', '5.35'), lR('直播B', '16,089,887 VND', '79,124,158 VND', '4.92')])}</body></html>`
      : `<html><body>${T(PH, [pR('商品1', '1,000,000 VND', '3,000,000 VND', '3.00')])}</body></html>`;
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  }, (res) => {
    check('★★ 直播超时后重试成功,没有丢 tab', (res.failed || []).length === 0);
    check(`★★ 直播 2 条都拿到了(实际 ${res.rows.filter((r) => r.kind === 'live').length} 条)`,
      res.rows.filter((r) => r.kind === 'live').length === 2);
    check('★★ 绝不把商品表当成直播上报', !res.rows.some((r) => r.kind === 'live' && r.name.startsWith('商品')));
    check('商品那边照常', res.rows.filter((r) => r.kind === 'product').length === 1);
  });

  // ★★ 真实后台实测:行是一条一条冒出来的。只要看到 1 行就读,直播 3 条会只读到 1 条 ——
  // 数字悄悄少一截,比取不到更坑。所以要等行数稳住再读。
  await scenario('★★ 行分批渲染时要等全(不能读半张表)', async (route) => {
    const isLive = /type=live/.test(route.request().url());
    const body = isLive
      ? `<html><body><div id=h>${T(LH, [lR('直播A', '22,267,631 VND', '119,160,272 VND', '5.35')])}</div>
         <script>setTimeout(function(){ document.getElementById('h').innerHTML=${JSON.stringify(
           T(LH, [
             lR('直播A', '22,267,631 VND', '119,160,272 VND', '5.35'),
             lR('直播B', '16,089,887 VND', '79,124,158 VND', '4.92'),
             lR('直播C', '10,000,000 VND', '50,000,000 VND', '5.00'),
           ])
         )}; }, 2200);</script></body></html>`
      : `<html><body>${T(PH, [pR('商品1', '1,000,000 VND', '3,000,000 VND', '3.00')])}</body></html>`;
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  }, (res) => {
    const live = res.rows.filter((r) => r.kind === 'live');
    check(`★★ 等到 3 条全渲染完才读(实际 ${live.length} 条)`, live.length === 3);
    check('★★ 没有把半张表当成全部', live.some((r) => r.name === '直播C'));
  });

  await scenario('两个tab都返回直播表', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: `<html><body>${T(LH, [lR('直播A', '22,267,631 VND', '119,160,272 VND', '5.35')])}</body></html>` });
  }, (res) => {
    check('★ SPA 没切 tab 时判商品失败,不把直播当商品', (res.failed || []).includes('product'));
    check('★ 结果里没有假的 product 行', res.rows.filter((r) => r.kind === 'product').length === 0);
  });
}

// ---------------- 端到端集成自检 ----------------

const FAKE_PAGE = (rows) =>
  `<html><body><h1>KANS 卖家后台 创意作品管理 数据总览 广告计划</h1><table>
<thead><tr><th>作品 ID</th><th>TikTok 账号</th><th>成本(₫)</th><th>总收入(₫)</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;

function itConfig(outDir, profile) {
  return {
    costThresholdCNY: 70,
    roiThreshold: 2,
    vndToCnyRate: 3891,
    timezoneOffsetHours: 7,
    browser: {
      headless: true,
      userDataDir: profile,
      navTimeoutMs: 3000,
      gotoRetries: 1,
      waitUntil: 'commit',
      firstWaitMs: 200,
      tableTimeoutMs: 4000,
      minRandomDelayMs: 1,
      maxRandomDelayMs: 2,
    },
    output: { mode: 'local', dir: outDir, format: 'xlsx', gdrive: { enabled: false } },
    llm: { enabled: false },
    notify: { channels: [], alertChannels: [], redAlert: { costThresholdCNY: 200, roiThreshold: 1 } },
    stability: { roundSoftBudgetMinutes: 25, abortAfterFailedCampaigns: 3, maxBrowserRestartsPerRound: 0, loginProbeCampaigns: 3 },
  };
}

async function integrationTests() {
  console.log('\n[12] 端到端:拿假后台完整跑一轮(有命中 / 无命中 / 打不开 各一个)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kans-selftest-'));
  const prevDataDir = process.env.KANS_DATA_DIR;
  process.env.KANS_DATA_DIR = path.join(tmp, 'data'); // 别把假数据写进真实命中历史
  const outDir = path.join(tmp, 'out');
  let ctx = null;
  try {
    const config = itConfig(outDir, path.join(tmp, 'profile'));
    const campaigns = [
      { name: '计划A-有命中', campaign_id: 'AAA', product_id: 'p1' },
      { name: '计划B-无命中', campaign_id: 'BBB', product_id: 'p2' },
      { name: '计划C-打不开', campaign_id: 'CCC', product_id: 'p3' },
    ];
    ctx = await launchAnyContext(config);
    await ctx.route('https://seller-vn.tiktok.com/**', async (route) => {
      const u = route.request().url();
      if (u.includes('campaign_id=CCC')) return; // 永不响应 → 模拟页面打不开
      // 注意 A 计划用越南语千分位写法,顺便验证真实链路上的数字解析
      const rows = u.includes('campaign_id=AAA')
        ? '<tr><td>W-HIT</td><td>@a</td><td>2.000.000</td><td>1.000.000</td></tr>' +
          '<tr><td>W-LOW</td><td>@b</td><td>100.000</td><td>50.000</td></tr>'
        : '<tr><td>W-OK</td><td>@c</td><td>2,000,000</td><td>9,000,000</td></tr>';
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FAKE_PAGE(rows) });
    });
    const res = await runOnce(config, campaigns, { context: ctx, llm: null, with7d: false });
    check('整轮没被中止', res.aborted !== true);
    check('命中 1 条(只有 W-HIT:¥514 且 ROI 0.5)', res.hits === 1);
    const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.xlsx')) : [];
    check('出了 1 个 xlsx,文件名是时间串', files.length === 1 && /^\d+月\d+日-\d{2}\.\d{2}\.xlsx$/.test(files[0]));
    const runs = fs.readFileSync(path.join(tmp, 'data', 'runs.jsonl'), 'utf8');
    check('打不开的计划C被记为失败,但没拖垮 A/B', runs.includes('计划C-打不开') && runs.includes('"loaded":false'));
    await ctx.close();
    ctx = null;

    console.log('\n[13] 端到端:全部计划都打不开时要"安静收敛",不是每轮刷告警');
    const cfg2 = itConfig(path.join(tmp, 'out2'), path.join(tmp, 'profile2'));
    ctx = await launchAnyContext(cfg2);
    await ctx.route('https://seller-vn.tiktok.com/**', () => {}); // 全部永不响应
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `计划${i + 1}`, campaign_id: 'X' + i, product_id: 'p' }));
    const t0 = Date.now();
    const r2 = await runOnce(cfg2, many, { context: ctx, llm: null, with7d: false });
    const secs = (Date.now() - t0) / 1000;
    check('标成软失败(交给调度器补跑,连续失败才告警)', r2.softFail === true);
    check('没有出表(不会落下假数据)', !fs.existsSync(path.join(tmp, 'out2')));
    check(`探路失败就提前收工,没硬扛完 8 个计划(用时 ${secs.toFixed(0)}s)`, secs < 60);
  } catch (e) {
    check(`端到端集成自检无异常(${e.message.split('\n')[0]})`, false);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (prevDataDir === undefined) delete process.env.KANS_DATA_DIR;
    else process.env.KANS_DATA_DIR = prevDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 和 launchAny 同理:没装 Playwright 自带 Chromium 就退回本机 Chrome/Edge。 */
async function launchAnyContext(config) {
  try {
    return await launchBrowser(config);
  } catch {
    for (const channel of ['chrome', 'msedge']) {
      try {
        return await launchBrowser({ ...config, browser: { ...config.browser, channel } });
      } catch {
        /* 换下一个 */
      }
    }
    throw new Error('本机找不到可用的 Chromium/Chrome/Edge');
  }
}
