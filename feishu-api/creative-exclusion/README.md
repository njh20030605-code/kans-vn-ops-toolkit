# 素材排除表 · Creative Exclusion（极简版，2026-09-15 重建）

Base: https://你的域名.feishu.cn/base/填多维表格appToken
app_token 填多维表格appToken · table tblGYc5IntNPGC8D（唯一一张表）

## 8 列（英文表头，注释中英双语）
Creative ID | Shop | Campaign · KANS Official / · KANS Globe / · One Leaf（三列单选，各店视图只露自己那列，下拉只含本店计划）| Campaign（公式合成，给 Jasper 看）| Why(3选1) | Jasper: Exclude?(Yes/No) | Jasper Notice | Intern: Done(勾) | ⚠ Robot(机器人写) + Submitted(自动)

## 4 个视图
- 🏬 KANS Official vewQorgbL3 / 🏬 KANS Globe vewalv456g / 🏬 One Leaf vew9heRfPX
  —— 每个实习生只用自己店的视图：登记 + 看 Jasper 结论 + 打钩执行，全在这一个视图
- ★ Jasper 待审（三店汇总）vewYbP4OZx —— Exclude? 为空 且 ⚠ Robot 为空，按店分组

## 机器人 sync.js（launchd com.jasper.creative-exclusion，每 180 秒）
1. Shop 空 → 按 Campaign 补（映射在 config.json.campaign_shop）
2. 同 Shop+Creative ID 之前被打过 No/Yes → 写 ⚠ Robot（含 Jasper 原话），该行自动从 Jasper 待审消失
3. Jasper Notice 有新内容 → 飞书卡片推实习生（notified.json 防重发；推失败下轮重试）
   卡点：ryan 需加进 My Claude 应用「可用范围」，否则 code=230013

日志 ~/Desktop/feishu-api/logs/creative-exclusion.log
新店/新实习生：加 Shop 选项 + 复制一个 🏬 视图改筛选即可。

## 培训手册（中英）
https://你的域名.feishu.cn/docx/AYsqdxYXxofWMoxDsHLcZ4Evnpg  （manual.js 重生成）
视图 hidden_fields 可用 API 设（PATCH view property.hidden_fields）。
