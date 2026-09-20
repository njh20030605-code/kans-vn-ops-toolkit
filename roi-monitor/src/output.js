import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { resolvePath, info } from './util.js';

/** 解析输出目录。支持 "DESKTOP" / "DESKTOP/子目录" → 系统桌面(跨 Mac/Windows)。 */
function resolveOutDir(od) {
  const v = od || './output';
  if (v === 'DESKTOP' || /^DESKTOP[/\\]/.test(v)) {
    const rest = v.replace(/^DESKTOP[/\\]?/, '');
    return path.join(os.homedir(), 'Desktop', rest);
  }
  return resolvePath(v);
}

export const CSV_HEADER = ['统计口径', '广告计划', '达人账号', '素材ID', '成本(¥)', 'ROI', '标记'];

/**
 * 给命中行打标记 + 排序(§6.1)。
 * @param hits 每项 { caliber, campaign, acct, workId, costCNY, roi }
 * @param prevIds 今天此前「当天」命中过的素材ID集合
 * @param todayHasHistory 今天是否已有历史(false 时首轮不打 🆕)
 * @param roiThreshold 用于文本(此处仅 ROI<1 触发 ⚠️,与阈值无关)
 */
export function markAndSort(hits, prevIds, todayHasHistory) {
  const marked = hits.map((h) => {
    const marks = [];
    if (h.roi < 1) marks.push('⚠️ROI<1');
    // 仅「当天」口径判定 🆕;近7天不判定;首轮(今天无历史)不打
    if (h.caliber === '当天' && h.workId && todayHasHistory && !prevIds.has(h.workId)) {
      marks.push('🆕新素材');
    }
    return { ...h, mark: marks.join(' ') };
  });

  // 口径块顺序:当天在前,近7天在后
  const caliberOrder = { 当天: 0, 近7天: 1 };

  // 每个口径内按计划分组,组间按组内最高成本降序,组内按成本降序
  const byCaliber = new Map();
  for (const r of marked) {
    if (!byCaliber.has(r.caliber)) byCaliber.set(r.caliber, []);
    byCaliber.get(r.caliber).push(r);
  }

  const result = [];
  const calibers = [...byCaliber.keys()].sort(
    (a, b) => (caliberOrder[a] ?? 9) - (caliberOrder[b] ?? 9)
  );
  for (const cal of calibers) {
    const rows = byCaliber.get(cal);
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.campaign)) groups.set(r.campaign, []);
      groups.get(r.campaign).push(r);
    }
    const groupArr = [...groups.entries()].map(([campaign, list]) => {
      list.sort((a, b) => b.costCNY - a.costCNY); // 组内成本降序
      return { campaign, list, maxCost: Math.max(...list.map((x) => x.costCNY)) };
    });
    groupArr.sort((a, b) => b.maxCost - a.maxCost); // 组间按最高成本降序
    for (const g of groupArr) result.push(...g.list);
  }
  return result;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowToArray(r) {
  const isCard = !r.workId;
  return [
    r.caliber,
    r.campaign,
    isCard ? '商品卡片(无作品ID)' : r.acct,
    isCard ? '' : r.workId,
    r.costCNY,
    r.roi,
    r.mark || '',
  ];
}

export async function writeOutput(config, DT, rows) {
  const dir = resolveOutDir(config.output.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const format = (config.output.format || 'xlsx').toLowerCase();

  if (format === 'csv') {
    const file = path.join(dir, `${DT}.csv`);
    const lines = [CSV_HEADER.map(csvCell).join(',')];
    for (const r of rows) lines.push(rowToArray(r).map(csvCell).join(','));
    fs.writeFileSync(file, '﻿' + lines.join('\n')); // BOM 便于 Excel 中文
    info('已写出 CSV:', file);
    return file;
  }

  // xlsx
  const file = path.join(dir, `${DT}.xlsx`);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(DT.replace(/[.:\\/?*[\]]/g, '_').slice(0, 31));
  ws.addRow(CSV_HEADER);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(rowToArray(r));
  ws.columns = [
    { width: 8 }, { width: 22 }, { width: 22 }, { width: 22 },
    { width: 10 }, { width: 8 }, { width: 16 },
  ];
  await wb.xlsx.writeFile(file);
  info('已写出 xlsx:', file);
  return file;
}
