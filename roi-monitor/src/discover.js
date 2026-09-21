import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SELLER_HOST, MARKET, info, warn } from './util.js';
import { getPage, gotoWithRetry, setLiveInterception, isPageResponsive } from './browser.js';

/**
 * 自动发现广告计划,把 campaign_id / product_id 抓出来写进 campaigns.json。
 *
 * 为什么不去扒 DOM:列表页那些「Analytics / Edit」按钮多半是 JS 驱动的,
 * href 里未必有 id,扒 DOM 很脆。这里改成**拦截页面自己的接口返回** ——
 * 列表数据必然来自某个 JSON 接口,里面一定有 id 和名字,比扒 DOM 稳得多。
 *
 * 抓不到也不猜:会把捕获到的接口列表打出来,发给 Claude 就能定位。
 */
export async function discoverCampaigns(config, deps) {
  const ctx = deps.context || (deps.getContext && deps.getContext());
  if (!ctx) return { ok: false, reason: '没有可用的浏览器' };

  const page = await getPage(ctx);
  await setLiveInterception(page, null, config); // 关掉拦截,别影响缓存

  const captured = [];
  const onResp = async (res) => {
    try {
      const url = res.url();
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      if (!/campaign|ads|gmv|promot/i.test(url)) return;
      const body = await res.json().catch(() => null);
      if (body) captured.push({ url: url.split('?')[0], body });
    } catch {
      /* 某些响应读不了,跳过 */
    }
  };
  page.on('response', onResp);

  const listUrl = `${SELLER_HOST}/ads-creation/dashboard?origin=SC_ads_tab_button_PC&shop_region=${MARKET.code}`;
  info('打开广告计划列表页…');
  const nav = await gotoWithRetry(page, listUrl, config);
  if (!nav.ok) {
    page.off('response', onResp);
    return { ok: false, reason: `列表页打不开(${nav.error})` };
  }

  // 列表是异步加载的,多等一会儿;顺便滚一下让懒加载的行也请求出来
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
  }
  page.off('response', onResp);

  if (!(await isPageResponsive(page))) warn('页面响应有点慢,抓到的可能不全。');

  const found = extractCampaigns(captured);
  info(`从 ${captured.length} 个接口响应里挖出 ${found.length} 条计划。`);

  return { ok: true, found, endpoints: [...new Set(captured.map((c) => c.url))] };
}

/** 在一堆 JSON 里递归找"像广告计划"的对象。 */
export function extractCampaigns(captured) {
  const byId = new Map();

  const idKeys = ['campaign_id', 'campaignId', 'adgroup_campaign_id'];
  const nameKeys = ['campaign_name', 'campaignName', 'name', 'title'];
  const prodKeys = ['product_id', 'productId', 'item_id', 'itemId'];

  const looksLikeId = (v) => typeof v === 'string' && /^\d{12,20}$/.test(v);
  const pick = (o, keys) => {
    for (const k of keys) {
      if (o[k] == null) continue;
      const v = String(o[k]);
      if (v && v !== 'null' && v !== 'undefined') return v;
    }
    return '';
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    const cid = pick(node, idKeys);
    const name = pick(node, nameKeys);
    if (looksLikeId(cid) && name && name.length <= 120) {
      const pid = pick(node, prodKeys);
      const prev = byId.get(cid);
      // 同一个 id 可能在多个接口里出现,取信息最全的那份
      if (!prev || (!prev.product_id && pid) || (prev.name.length < name.length && name.length < 80)) {
        byId.set(cid, {
          name: name.trim(),
          campaign_id: cid,
          product_id: looksLikeId(pid) ? pid : '',
        });
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };

  for (const c of captured) walk(c.body);
  return [...byId.values()];
}

/**
 * 把发现的计划并进现有 campaigns.json。
 * 原则:已有的一条都不动(名字/type 可能是人工调过的),只追加新的。
 */
export function mergeCampaigns(existing, found) {
  const have = new Set(existing.map((c) => String(c.campaign_id)));
  const added = [];
  for (const f of found) {
    if (have.has(f.campaign_id)) continue;
    const entry = { name: f.name, campaign_id: f.campaign_id };
    // 有商品ID = 商品广告;没有 = 多半是直播计划(现有两条直播计划就没有 product_id)
    if (f.product_id) entry.product_id = f.product_id;
    else entry.type = 'live';
    added.push(entry);
  }
  return { merged: [...existing, ...added], added };
}

export function campaignsPath() {
  return path.join(ROOT, process.env.KANS_CAMPAIGNS_FILE || 'campaigns.json');
}

export function backupCampaigns() {
  const p = campaignsPath();
  if (!fs.existsSync(p)) return null;
  const bak = p.replace(/\.json$/, `.备份-${new Date().toISOString().slice(0, 10)}.json`);
  fs.copyFileSync(p, bak);
  return bak;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
