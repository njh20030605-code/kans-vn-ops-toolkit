# KANS 越南运营工具箱 · kans-vn-ops-toolkit

围绕 **KANS（韩束）越南 TikTok Shop** 日常运营写的一组自动化工具。主 KPI 是本土店「直播间 GMV + 商品卡 GMV」，
这里的每个工具都为了把围绕这条 KPI 的重复劳动（导数、盯盘、登记、汇总、发群）交给程序。

> 仓库为私有。所有凭证（飞书 App Secret、TikTok 登录态、.env）都**不在**仓库里，见各子项目「首次准备」。

## 给谁用 · 按角色找工具

| 你是 | 直接去 | 解决什么 |
|---|---|---|
| **广告 / 投放实习生** | [`roi-monitor/`](roi-monitor/) · [`feishu-api/kans-board`](feishu-api/kans-board/) · [`feishu-api/creative-exclusion`](feishu-api/creative-exclusion/) · [`feishu-api/intern-workflow`](feishu-api/intern-workflow/) | 每小时自动盯低效素材、看板里一键复制素材 ID 回后台排除、登记待排除素材、每天任务清单自动清零 |
| **在 Windows 常开机上值守的同事** | [`roi-monitor-win/`](roi-monitor-win/) | 双击 `.bat` 就能跑的预警程序，结果落桌面 |
| **达人 BD / 投流码对接** | [`feishu-api/followup-sync.js`](feishu-api/followup-sync.js) · [`feishu-api/投放跟进同步-说明.md`](feishu-api/投放跟进同步-说明.md) | 填了投流码但没人跟的记录自动进工作台，退回原因自动写回你的表 |
| **直播运营 / 主播管理** | [`host-ranking/`](host-ranking/) | 每天一键出中英越三语主播 GMV 日排名 + 月排名 Excel，直接发群 |
| **所有要看越南后台的人** | [`vnd-cny-extension/`](vnd-cny-extension/) | TikTok / Shopee 后台的越南盾自动换算成人民币显示 |
| **负责人 / 要问数据口径的人** | [`feishu-api/bot.js`](feishu-api/bot.js) · [`feishu-api/kb/`](feishu-api/kb/) | 飞书里 @My Claude 直接问，答案只来自 kb 里的权威口径 |
| **要接手维护的技术同学** | 各子目录 README 的「首次准备」+ 根目录 `sync-from-desktop.sh` | 凭证怎么配、launchd 怎么装、源码怎么同步 |

关键词：TikTok Shop 越南 · GMV Max · 素材预警 · ROI · 飞书开放平台 · 多维表格 · Playwright · 主播排名 · VND CNY 汇率插件

## 目录

| 目录 | 一句话 | 技术栈 | 运行方式 |
|---|---|---|---|
| [`feishu-api/`](feishu-api/) | 飞书开放平台命令行 + 「My Claude」飞书机器人 + 4 个常驻同步任务（素材排除表、投放跟进台、实习生日清、低效素材看板） | Node.js · 飞书 SDK · Claude | launchd 常驻 |
| [`roi-monitor/`](roi-monitor/) | GMV Max 高成本低 ROI 素材预警：每小时只读扫描 TikTok 广告后台，命中写 xlsx / 飞书多维表格并推送 | Node.js · Playwright | Mac launchd 常驻 |
| [`roi-monitor-win/`](roi-monitor-win/) | 同一套扫描内核的 Windows 精简版，放在 24h 常开的电脑上跑，一堆 `.bat` 双击即用 | Node.js · Playwright | Windows 常驻 |
| [`host-ranking/`](host-ranking/) | 主播排名生成器：读线上 Google 表，合并多个直播间，出中 / 英 / 越三语 Excel 日排名与月排名 | Python · openpyxl · PyInstaller | 桌面 App / exe |
| [`vnd-cny-extension/`](vnd-cny-extension/) | Chrome / Edge 插件：把 TikTok、Shopee 越南后台里的 VND 金额实时换算成人民币显示 | 浏览器扩展（MV3） | 加载已解压扩展 |

## 它们之间怎么配合

```
TikTok 广告后台 ──(roi-monitor 每小时只读扫描)──▶ 飞书多维表格「命中明细」
                                                        │
                              feishu-api/kans-board 每 15 分钟 ─▶ 「看板·当天 / 近7天」(素材ID 一键粘回 TikTok 批量筛)
                                                        │
实习生登记素材 ─▶ 「素材排除表」 ◀── feishu-api/creative-exclusion 每 3 分钟补店铺 / 查重 / 推卡片
BD 填投流码   ─▶ 「投放跟进工作台」◀── feishu-api/followup-sync 每 30 秒双向同步
群里 @My Claude ─▶ feishu-api/bot.js 读本地 kb/ 知识库 + 群聊记录 + 图片 ─▶ 用 Claude 回答 / 读写云文档
```

## 口径（全仓库统一）

- 汇率：₫3,860 ≈ ¥1；USD × 6.8 = RMB
- 低效素材：当天归一化成本 ≥ ¥70 且 ROI < 2；红色预警：成本 ≥ ¥200 且 ROI < 1
- 归因：TikTok 后台 7 天归因 vs TTMS O5A 30 天，两套口径不混用
- 更多业务口径见 [`feishu-api/kb/`](feishu-api/kb/)（机器人回答时的权威事实来源）

## 环境

- Node.js ≥ 18（feishu-api、roi-monitor）
- Python 3.12 + openpyxl（host-ranking）
- macOS launchd 用于常驻任务；plist 模板在各子目录

## 同步

源码平时在桌面各目录里改，改完运行仓库根目录的 `sync-from-desktop.sh` 会把最新源码拷进来（自动排除 node_modules / 日志 / 数据 / 凭证），再 `git add -A && git commit && git push` 即可。
