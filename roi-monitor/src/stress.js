import { chromium } from 'playwright';
import { fetchCampaignStats } from './board.js';
import { gotoWithRetry } from './browser.js';

/**
 * 暴力测试:拿一个**会故意抽风**的假后台,把播报取数反复捶打几十轮。
 *
 * 抽风的花样(每轮给商品/直播各随机抽一种):
 *   ok      正常
 *   hang    永不响应(导航超时)
 *   flaky   前 1~2 次不响应,之后正常  ← 线上直播间就是这样挂的
 *   slow    表格晚几秒才渲染
 *   drip    行一条一条往外冒(最坑:容易读到半张表)
 *   wrong   永远返回**另一种**表(SPA 没切过来)
 *   empty   表格出来了但一行都没有
 *   err500  服务器报错
 *
 * 只认一条铁律 —— **要么给出完整且正确的数,要么明确报失败**:
 *   ① 上报的每一行,kind 必须和它真实所属的那张表一致(绝不串台)
 *   ② 某个 tab 算成功 → 它的计划必须**一条不少**,金额换算必须对
 *   ③ 某个 tab 没取到 → 必须出现在 failed 里,且结果里该 kind 一行都没有
 *   ④ 全程不许抛异常
 */

/** 和自检一样:没装 Playwright 自带 Chromium 就退回本机 Chrome / Edge(那台 Windows 靠这个)。 */
async function launchAny() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    for (const channel of ['chrome', 'msedge']) {
      try {
        const b = await chromium.launch({ headless: true, channel });
        console.log(`  (提示:未装 Playwright 自带 Chromium,已改用本机 ${channel})`);
        return b;
      } catch {
        /* 换下一个 */
      }
    }
    throw new Error('本机既没有 Playwright 自带 Chromium,也没有 Chrome/Edge,跑不了暴力测试');
  }
}

const OK_KINDS = ['ok', 'flaky', 'slow', 'drip']; // 这些最终应该取全
const BAD_KINDS = ['hang', 'wrong', 'empty', 'err500']; // 这些应该明确失败
const ALL = [...OK_KINDS, ...BAD_KINDS];

const PH = ['开/关','广告计划名称','状态','广告计划预算','健康状态与洞察','权益','成本','总收入','优惠券成本','ROI 保护','有效升级功能','排期时间','创意作品加热预算','目标 ROI','净成本','SKU 订单数','平均下单成本','ROI','优惠券带来的收入','跨广告位优惠券总收入'];
const LH = ['开/关','广告计划名称','状态','日预算','健康状态与洞察','权益','成本','可用的 TikTok 账号','ROI 保护','有效升级功能','排期时间','目标 ROI','最大投放量预算','总预算','净成本','优惠券成本','总收入','优惠券带来的收入','跨广告位优惠券总收入','ROI','SKU 订单数','平均下单成本','直播播放量','目标 ROI 成本','基本目标 ROI 成效','受众加热预算','受众加热成本','创意作品加热预算','创意作品加热成本'];

const RATE = 3891;
const PRODUCTS = [
  { name: 'MKT-377次抛', cost: 222174182, rev: 614022726, roi: '2.76' },
  { name: 'MKT-白精华', cost: 32406733, rev: 118305989, roi: '3.65' },
  { name: 'MKT-红精华', cost: 18000000, rev: 54000000, roi: '3.00' },
];
const LIVES = [
  { name: 'KANS SKINCARE VIETNAM 0708', cost: 25876715, rev: 137805172, roi: '5.33' },
  { name: 'KANS khoa học trẻ hóa 0708', cost: 16971548, rev: 83747182, roi: '4.93' },
  { name: 'Kans Official Vietnam-0811', cost: 0, rev: 896996, roi: '0' },
];

const vnd = (n) => `${n.toLocaleString('en-US')} VND`;
const td = (v) => `<td>${v}</td>`;

function rowHtml(kind, c) {
  const cells =
    kind === 'live'
      ? ['on', `<div>${c.name}</div>`, '已生效', vnd(200000000), '良好', '-', vnd(c.cost), 'ACC', '符合', '-', '2026-07-08', '5.30', '-', vnd(200000000), vnd(0), vnd(0), vnd(c.rev), vnd(0), vnd(0), c.roi, '775', vnd(28732), '16,490', vnd(0), '5.35', vnd(0), vnd(0), vnd(0), vnd(0)]
      : ['on', `<div>${c.name}</div>`, '已生效', vnd(606000000), '良好', '-', vnd(c.cost), vnd(c.rev), vnd(0), '符合', '-', '2026-09-16', '-', '3.20', vnd(0), '2,682', vnd(69732), c.roi, vnd(0), vnd(0)];
  return `<tr>${cells.map(td).join('')}</tr>`;
}

function tableHtml(kind, list) {
  const h = kind === 'live' ? LH : PH;
  return (
    `<table><thead><tr>${h.map((x) => `<th>${x}</th>`).join('')}</tr></thead>` +
    `<tbody>${list.map((c) => rowHtml(kind, c)).join('')}</tbody></table>`
  );
}

/** 造一个页面。behaviour 决定它怎么抽风。 */
function pageHtml(kind, behaviour) {
  const list = kind === 'live' ? LIVES : PRODUCTS;
  const full = tableHtml(kind, list);
  if (behaviour === 'empty') return `<html><body>${tableHtml(kind, [])}</body></html>`;
  if (behaviour === 'wrong') {
    const other = kind === 'live' ? 'product' : 'live';
    return `<html><body>${tableHtml(other, other === 'live' ? LIVES : PRODUCTS)}</body></html>`;
  }
  if (behaviour === 'slow') {
    return `<html><body><div id=h></div><script>setTimeout(function(){
      document.getElementById('h').innerHTML=${JSON.stringify(full)};},1500);</script></body></html>`;
  }
  if (behaviour === 'drip') {
    // 一条一条往外冒 —— 这是最坑的那种,读早了就只拿到半张表
    const steps = list.map((_, i) => tableHtml(kind, list.slice(0, i + 1)));
    return (
      `<html><body><div id=h>${steps[0]}</div><script>` +
      steps
        .slice(1)
        .map((h, i) => `setTimeout(function(){document.getElementById('h').innerHTML=${JSON.stringify(h)};},${(i + 1) * 800});`)
        .join('') +
      `</script></body></html>`
    );
  }
  return `<html><body>${full}</body></html>`;
}

const cfg = {
  vndToCnyRate: RATE,
  roiThreshold: 2,
  timezoneOffsetHours: 7,
  browser: {
    headless: true,
    navTimeoutMs: 2500,
    gotoRetries: 1,
    waitUntil: 'commit',
    boardTableTimeoutMs: 5000,
    boardTabBudgetMs: 20000,
    boardTabTries: 4,
    boardRetryWaitMs: 400,
    minRandomDelayMs: 1,
    maxRandomDelayMs: 2,
    blockHeavyResources: false,
  },
};

let passed = 0;
let failed = 0;
const problems = [];
function check(ok, msg) {
  if (ok) passed++;
  else {
    failed++;
    problems.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

/** 跑一轮:商品用 pb 抽风、直播用 lb 抽风,然后按铁律验收。 */
async function oneRound(browser, n, pb, lb) {
  const ctx = await browser.newContext();
  const hits = { product: 0, live: 0 };
  await ctx.route('https://seller-vn.tiktok.com/**', async (route) => {
    const url = route.request().url();
    const kind = /type=live/.test(url) ? 'live' : 'product';
    const b = kind === 'live' ? lb : pb;
    hits[kind]++;
    if (b === 'hang') return; // 永不响应
    if (b === 'flaky' && hits[kind] <= 2) return; // 前两次不响应,第三次才给
    if (b === 'err500') return route.fulfill({ status: 500, contentType: 'text/html', body: 'boom' });
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml(kind, b) });
  });

  let res;
  try {
    res = await fetchCampaignStats(cfg, { context: ctx });
  } catch (e) {
    check(false, `第${n}轮(商品=${pb}/直播=${lb}) 抛异常了:${e.message}`);
    await ctx.close();
    return;
  }
  await ctx.close();

  const tag = `第${n}轮(商品=${pb}/直播=${lb})`;
  const got = { product: res.rows.filter((x) => x.kind === 'product'), live: res.rows.filter((x) => x.kind === 'live') };
  const want = { product: PRODUCTS, live: LIVES };

  for (const kind of ['product', 'live']) {
    const b = kind === 'live' ? lb : pb;
    const mine = got[kind];
    const otherNames = new Set(want[kind === 'live' ? 'product' : 'live'].map((x) => x.name));

    // ① 绝不串台
    check(!mine.some((r) => otherNames.has(r.name)), `${tag} ★ ${kind} 里混进了另一张表的计划`);

    if (OK_KINDS.includes(b)) {
      // ② 算成功就必须一条不少、数值对
      check(!(res.failed || []).includes(kind), `${tag} ${kind}(${b})本该取到却报了失败`);
      check(mine.length === want[kind].length, `${tag} ★ ${kind}(${b})只取到 ${mine.length}/${want[kind].length} 条 —— 数字少一截`);
      for (const w of want[kind]) {
        const r = mine.find((x) => x.name === w.name);
        if (!r) {
          check(false, `${tag} ★ ${kind} 少了「${w.name}」`);
          continue;
        }
        const wantCny = Math.round(w.cost / RATE);
        check(Math.round(r.costCNY) === wantCny, `${tag} ${kind}「${w.name}」消耗换算错:${Math.round(r.costCNY)} ≠ ${wantCny}`);
        check(Math.round(r.gmvCNY) === Math.round(w.rev / RATE), `${tag} ${kind}「${w.name}」成交换算错`);
      }
    } else {
      // ③ 取不到就必须明说,而且一行都不许给
      check((res.failed || []).includes(kind), `${tag} ★ ${kind}(${b})没取到却没报失败`);
      check(mine.length === 0, `${tag} ★★ ${kind}(${b})没取到却上报了 ${mine.length} 行假数据`);
    }
  }

  // ④ 两边都废了才算整体失败;有一边好就还能用
  const bothBad = BAD_KINDS.includes(pb) && BAD_KINDS.includes(lb);
  check(res.ok === !bothBad, `${tag} ok 标记不对(ok=${res.ok},两边都废=${bothBad})`);
  console.log(
    `  ✅ ${tag} → 商品 ${got.product.length} 条 / 直播 ${got.live.length} 条 / 失败 [${(res.failed || []).join(',') || '无'}]`
  );
}

/** 页面被关掉时,导航绝不能说"其实已经到了" —— 不然会去死页面上读表。 */
async function closedPageCase(browser) {
  const ctx = await browser.newContext();
  await ctx.route('https://seller-vn.tiktok.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml('live', 'ok') })
  );
  const page = await ctx.newPage();
  const url = 'https://seller-vn.tiktok.com/ads-creation/dashboard?type=live&list_start_date=1&list_end_date=2';
  await gotoWithRetry(page, url, cfg);
  await page.close();
  const r = await gotoWithRetry(page, url, cfg).catch(() => ({ ok: false, error: 'threw' }));
  check(r.ok === false, '★ 页面已关闭时,导航不能报成功(否则会去死页面上读表)');
  console.log(`  ✅ 页面被关掉 → 导航返回 ok=${r.ok}`);
  await ctx.close().catch(() => {});
}

export async function stress(rounds = 10) {
  console.log('\n══════════════════════════════════════════════');
  console.log('  播报取数 · 暴力测试(会故意让后台抽风)');
  console.log('══════════════════════════════════════════════\n');
  const t0 = Date.now();
  const browser = await launchAny();
  try {
    await closedPageCase(browser);

    // 先跑一遍**必考题**:线上真实挂过的那几种组合,一个都不能漏
    const fixed = [
      ['ok', 'flaky'], // ← 0921 线上:商品先成功、直播超时 —— 必须靠重试救回来
      ['flaky', 'ok'],
      ['ok', 'hang'],
      ['hang', 'ok'],
      ['ok', 'wrong'], // SPA 没切 tab
      ['ok', 'drip'], // 行一条条冒,别读半张表
      ['drip', 'drip'],
      ['hang', 'hang'],
    ];
    let n = 0;
    for (const [pb, lb] of fixed) await oneRound(browser, ++n, pb, lb);

    // 再随机捶
    for (let i = 0; i < rounds; i++) {
      const pb = ALL[Math.floor(Math.random() * ALL.length)];
      const lb = ALL[Math.floor(Math.random() * ALL.length)];
      await oneRound(browser, ++n, pb, lb);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\n══ 暴力测试:${passed} 通过 / ${failed} 失败,用时 ${secs}s ══`);
  if (failed) {
    console.log('\n出问题的:');
    for (const p of problems.slice(0, 20)) console.log('  · ' + p);
    process.exitCode = 1;
  } else {
    console.log('铁律全守住了:要么完整正确,要么明确失败,没有串台、没有少行、没有假数据。\n');
  }
}
