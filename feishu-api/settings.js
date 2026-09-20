/**
 * 统一业务配置（表 ID、负责人、输出文件夹、租户域名）。
 * 读取顺序：环境变量 FEISHU_SETTINGS 指定的文件 → 本目录 settings.json → settings.example.json。
 * settings.json 只在本机，不进仓库；接入自己的租户时 cp settings.example.json settings.json 再填。
 */
const fs = require('fs');
const path = require('path');
function load() {
  const cands = [process.env.FEISHU_SETTINGS, path.join(__dirname, 'settings.json'), path.join(__dirname, 'settings.example.json')].filter(Boolean);
  for (const f of cands) if (fs.existsSync(f)) return { ...JSON.parse(fs.readFileSync(f, 'utf8')), _file: f };
  throw new Error('缺少 settings.json：cp settings.example.json settings.json 并填写');
}
const S = load();
S.url = (kind, token) => `https://${S.domain}/${kind}/${token}`;   // kind: docx | sheets | base | wiki
module.exports = S;
