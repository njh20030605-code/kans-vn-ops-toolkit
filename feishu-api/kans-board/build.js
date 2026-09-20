#!/usr/bin/env node
/**
 * KANS 低效素材看板 —— 从「命中明细」滚动汇总成计划维度看板
 *
 *   底表（只读，绝不修改）：
 *     命中明细   tblT9nDZFnVa90qO   —— 预警程序每小时追加，同一素材每小时一行（成本累计）
 *     计划日汇总 tblhTnhAwHQVB8ad   —— 计划当日总成本/GMV/ROI
 *   产出（本脚本全权重写）：
 *     看板·当天   tblfk2fh6kGSrkGL
 *     看板·近7天  tblX8gL4MsUu7XP6
 *
 *   核心处理：同一 (日期,口径,素材ID) 只保留最新一次扫描（成本是累计值），
 *            再按「广告计划」聚合，输出可直接粘进 TikTok 后台的素材ID清单。
 *
 *   用法： node build.js [--force] [--days=3]
 */
const fs = require('fs');
const path = require('path');
const { api, listAll, batchCreate, batchDelete, txt, num } = require('./fslib.js');

// 表 ID 在 config.json（本机）/ config.example.json（模板）
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, fs.existsSync(path.join(__dirname, 'config.json')) ? 'config.json' : 'config.example.json'), 'utf8'));
const APP = CFG.app_token;
const T_HIT = CFG.hit_table;
const T_DAY = CFG.daily_table;
const BOARDS = {
  '当天':  { table: CFG.board_today, withPlanTotal: true },
  '近7天': { table: CFG.board_7d, withPlanTotal: false },
};
const STATE = path.join(__dirname, '.state.json');
const MAX_IDS = 400;          // TikTok「作品ID 包含任一项」单次上限
const pastable = id => /^\d{6,}$/.test(id);   // 只有纯数字作品ID能粘进后台（「商品卡片(无作品ID)」要剔掉）
const ALL = '【全部计划】';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
// 看板只留最新一天（就是"当天"）；要回看历史加 --days=N
const KEEP_DAYS = Number((argv.find(a => a.startsWith('--days=')) || '--days=1').split('=')[1]) || 1;

const isTest = f => txt(f['标记']) === '测试数据' || /^TEST/i.test(txt(f['素材ID']));
const r2 = n => Math.round(n * 100) / 100;

function log(...a) { console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a); }

(async () => {
  const hits = (await listAll(APP, T_HIT)).filter(h => !isTest(h.f));
  const days = await listAll(APP, T_DAY);

  // 计划日汇总索引： 日期|计划 -> {cost, roi}
  const dayIdx = {};
  for (const d of days) {
    dayIdx[`${txt(d.f['日期'])}|${txt(d.f['广告计划'])}`] = { cost: num(d.f['成本¥']), roi: num(d.f['ROI']) };
  }

  // 变更签名：底表没动就不重写
  const sig = JSON.stringify({
    n: hits.length,
    d: days.length,
    t: Math.max(0, ...hits.map(h => Number(h.f['扫描时间']) || 0)),
    k: KEEP_DAYS,
  });
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')).sig; } catch {}
  if (!FORCE && prev === sig) { log('底表无变化，跳过重写'); return; }

  for (const [scope, cfg] of Object.entries(BOARDS)) {
    const rows = hits.filter(h => txt(h.f['口径']) === scope);
    const dates = [...new Set(rows.map(h => txt(h.f['日期'])))].filter(Boolean).sort().reverse().slice(0, KEEP_DAYS);

    // 同一 (日期,素材ID) 取最新一次扫描
    const latest = new Map();
    for (const h of rows) {
      const date = txt(h.f['日期']);
      if (!dates.includes(date)) continue;
      const key = `${date}|${txt(h.f['素材ID'])}`;
      const t = Number(h.f['扫描时间']) || 0;
      const cur = latest.get(key);
      if (!cur || t >= cur.t) latest.set(key, { t, date, f: h.f });
    }

    // 按 日期|计划 分组
    const groups = new Map();
    for (const { date, f } of latest.values()) {
      const plan = txt(f['广告计划']) || '(未命名计划)';
      for (const g of [`${date}|${plan}`, `${date}|${ALL}`]) {
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(f);
      }
    }

    const now = Date.now();
    const built = [];
    for (const [gkey, items] of groups) {
      const [date, plan] = gkey.split('|');
      items.sort((a, b) => num(b['成本¥']) - num(a['成本¥']));
      const cost = items.reduce((s, f) => s + num(f['成本¥']), 0);
      const gmv = items.reduce((s, f) => s + num(f['成本¥']) * num(f['ROI']), 0);
      const ids = [...new Set(items.map(f => txt(f['素材ID'])))];
      const rec = {
        '广告计划': plan,
        '日期': date,
        '低效素材数': ids.length,
        '红色预警数': items.filter(f => f['红色预警'] === true).length,
        '低效成本¥': r2(cost),
        '低效GMV¥': r2(gmv),
        '加权ROI': cost ? r2(gmv / cost) : 0,
        '最差ROI': r2(Math.min(...items.map(f => num(f['ROI'])))),
        // 一行一个ID：从飞书复制粘进 TikTok 搜索框会自动变成空格分隔，正好命中「作品ID 包含任一项」；逗号分隔它不认
        '素材ID清单（粘TikTok）': ids.filter(pastable).slice(0, MAX_IDS).join('\n'),
        '明细 ID｜达人｜成本¥｜ROI': items.map(f =>
          `${txt(f['素材ID'])} | ${txt(f['达人账号']) || '-'} | ¥${num(f['成本¥'])} | ROI ${num(f['ROI'])}` +
          `${f['红色预警'] === true ? ' | 🔴红色' : ''}${txt(f['标记']) ? ' | ' + txt(f['标记']) : ''}`
        ).join('\n'),
        '达人清单': [...new Set(items.map(f => txt(f['达人账号'])).filter(Boolean))].join('、'),
        '更新时间': now,
        '键': `${date}|${scope}|${plan}`,
      };
      if (cfg.withPlanTotal) {
        const tot = plan === ALL
          ? Object.entries(dayIdx).filter(([k]) => k.startsWith(date + '|'))
              .reduce((s, [, v]) => s + v.cost, 0)
          : (dayIdx[`${date}|${plan}`] || {}).cost || 0;
        if (tot) {                                   // 当日汇总还没跑出来时留空，不写 0 免得误读
          rec['计划总成本¥'] = r2(tot);
          rec['占计划成本'] = r2(cost / tot * 100) / 100;
        }
      }
      built.push(rec);
    }

    // 排序：日期新→旧，同日【全部计划】置顶，其余按低效成本降序
    built.sort((a, b) =>
      b['日期'].localeCompare(a['日期']) ||
      (a['广告计划'] === ALL ? -1 : b['广告计划'] === ALL ? 1 : 0) ||
      b['低效成本¥'] - a['低效成本¥']
    );

    const old = await listAll(APP, cfg.table);
    if (old.length) await batchDelete(APP, cfg.table, old.map(r => r.record_id));
    if (built.length) await batchCreate(APP, cfg.table, built);
    log(`看板·${scope}：${dates.join(' / ') || '无数据'} → 写入 ${built.length} 行（清掉旧 ${old.length} 行）`);
  }

  fs.writeFileSync(STATE, JSON.stringify({ sig, at: new Date().toISOString() }));
})().catch(e => { log('出错：' + e.message); process.exit(1); });
