# KANS 低效素材看板

把预警程序写进「命中明细」的流水，滚动汇总成**计划维度**的两块看板，
素材ID 一行一个，点一下单元格整段复制就能粘进 TikTok 后台批量筛。

## 在哪看

多维表格 `填多维表格appToken`（原表新加的两张表，底表没动）：

- **看板·当天** `tblfk2fh6kGSrkGL`
  https://你的域名.feishu.cn/base/填多维表格appToken?table=tblfk2fh6kGSrkGL&view=vewkNdJZqw
- **看板·近7天** `tblX8gL4MsUu7XP6`
  https://你的域名.feishu.cn/base/填多维表格appToken?table=tblX8gL4MsUu7XP6&view=vewv4pU4ba

排序固定：日期新→旧，同一天【全部计划】置顶，其余按低效成本从高到低。

## 口径

命中标准沿用预警程序 `config.json`：当天 成本≥¥70 且 ROI<2；红色预警 成本≥¥200 且 ROI<1。

关键一步是**去重**：命中明细里同一个素材每小时追加一行、成本是累计值，
看板只取**每个素材当天最后一次扫描**那行，所以不会把同一素材算成 5 条。

| 列 | 含义 |
|---|---|
| 低效素材数 | 该计划当天命中的**去重**素材数 |
| 红色预警数 | 其中命中红色（成本≥¥200 且 ROI<1）的条数 |
| 低效成本¥ | 这些素材的累计消耗合计 |
| 加权ROI | Σ(成本×ROI) ÷ Σ成本，不是简单平均 |
| 最差ROI | 组内最低 ROI |
| 计划总成本¥ / 占计划成本 | 取自「计划日汇总」。当天汇总还没跑出来时**留空**（不写 0） |
| 素材ID清单（粘TikTok） | **一行一个ID**（粘进 TikTok 搜索框会变成空格分隔，正好命中「作品ID 包含任一项」；逗号分隔它不认），按消耗从高到低，上限 400 个（TikTok「作品ID 包含任一项」的单次上限）。`商品卡片(无作品ID)` 这种非数字ID会被剔掉，只留能粘的 |
| 明细 | 一行一个素材：ID ｜ 达人 ｜ 成本 ｜ ROI ｜ 红色/标记，用来肉眼过 |

近7天那张没有「计划总成本/占比」两列 —— 日汇总是按天的，跟 7 天口径对不上，与其放个误导数不如不放。

## 更新节奏

launchd `com.jasper.kans-board`，**每 15 分钟**跑一次，只在底表有新扫描时才重写（靠 `.state.json` 比签名）。
默认**只保留最新一天**（就是当天），旧日期每轮自动清掉。要回看历史临时加 `--days=N`。

```bash
# 手动强刷
node build.js --force
# 临时回看最近 3 天（下一轮定时任务会恢复成只留当天）
node build.js --force --days=3
# 看日志
tail -f ~/Desktop/feishu-api/logs/kans-board.log
# 停 / 起
launchctl bootout   gui/$(id -u)/com.jasper.kans-board
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jasper.kans-board.plist
```

也可以双击 `手动刷新看板.command`。

## 注意

- 看板是**派生表**，每次重写会重建记录 —— 别在看板行上写批注或加自定义列，会被下一轮清掉。要标记请在「命中明细」上标。
- 底表「命中明细」「计划日汇总」本脚本**只读**，从不写入。
- 看板只反映预警程序扫到的数据；程序没跑（比如 TikTok 掉登录），看板就停在上一次的结果，看「更新时间」列能判断。
