import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { info, warn, resolvePath } from './util.js';

export function driveEnabled(config) {
  const g = config.output?.gdrive;
  return !!(g && g.enabled && g.remote && g.rootFolderId);
}

/** rclone 是否可用(命令存在)。 */
export function rcloneAvailable() {
  return new Promise((resolve) => {
    execFile('rclone', ['version'], { timeout: 10000 }, (err) => resolve(!err));
  });
}

/**
 * 用 rclone 把本地文件上传到配置的 Google Drive 文件夹(按 folder id 定位)。
 * 返回 { ok, error, authFail }。全程只上传自己的输出文件。
 */
export function uploadToDrive(config, filePath) {
  return new Promise((resolve) => {
    const g = config.output.gdrive;
    const args = [
      'copy',
      filePath,
      `${g.remote}:`,
      '--drive-root-folder-id',
      g.rootFolderId,
      '--no-traverse',
    ];
    execFile('rclone', args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (!err) {
        info('已上传 Google Drive:', filePath.split('/').pop());
        return resolve({ ok: true });
      }
      const lines = (stderr || err.message || '')
        .split('\n')
        .filter((l) => /ERROR|failed|token|oauth|invalid_grant|401|403|couldn.t/i.test(l))
        .slice(0, 3)
        .join(' | ');
      const msg = lines || err.message || 'unknown rclone error';
      const authFail = /token|oauth|invalid_grant|401|403|couldn.t fetch|expired/i.test(msg);
      warn('Google Drive 上传失败:', msg);
      resolve({ ok: false, error: msg, authFail });
    });
  });
}

/**
 * 当程序无法扫描(登录掉了/验证码/风控)时,在 Google 文件夹里新建一个情况说明文件,
 * 让无人值守时也能在云端第一时间看到"现在什么情况"。
 */
export async function uploadStatusNote(config, DT, state, message) {
  if (!driveEnabled(config)) return { ok: false, skipped: true };
  const dir = resolvePath(config.output.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fname = `⚠️需人工-${state}-${DT}.txt`;
  const fpath = path.join(dir, fname);
  const content =
    `KANS 高成本低ROI 预警程序 · 情况说明\n` +
    `时间(越南):${DT}\n` +
    `状态:${state}\n\n` +
    `${message}\n\n` +
    `处理:请到运行程序的 Mac 上,双击「启动-登录.command」重新登录一次 TikTok 卖家后台即可恢复。\n`;
  fs.writeFileSync(fpath, content);
  return await uploadToDrive(config, fpath);
}

/**
 * 心跳/健康文件:固定文件名,每轮覆盖更新。用户瞄一眼"最近运行时间"就知道程序还活着没。
 */
export async function uploadStatusFile(config, text) {
  if (!driveEnabled(config)) return { ok: false, skipped: true };
  const dir = resolvePath(config.output.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fpath = path.join(dir, '运行状态.txt');
  fs.writeFileSync(fpath, text);
  return await uploadToDrive(config, fpath);
}
