# KANS 越南 GMV Max 高成本低ROI 素材预警(独立程序 · 只读)

每小时自动扫描 KANS 越南若干个 GMV Max「商品广告」计划下的创意素材,
找出**归一化成本 > ¥70 且 ROI < 2** 的低效高耗素材,写入一张表(默认本地 xlsx);
越南时间 **10 点 / 14 点**额外加扫「近7天」口径。

> **全程只读**:程序只读取数据、只写自己的输出表/本地文件,**绝不点击暂停、改预算、改任何广告设置**。

---

## 一、首次准备(只做一次)

前提:已装 Node ≥ 18(本机 `node -v` 应显示 v18 以上)。

```bash
cd ~/Desktop/kans-roi-monitor
npm install                       # 装依赖(已装过可跳过)
cp campaigns.example.json campaigns.json   # 填入要监控的推广系列 ID / 商品 ID
# config.json：brand（通知标题里的品牌名）、costThresholdCNY / roiThreshold（命中阈值）、vndToCnyRate（汇率）、notify（通知通道）
cp .env.example .env              # 按需填通知通道的 key
npx playwright install chromium   # 装浏览器内核(已装过可跳过)
```

### 手动登录一次 TikTok(关键)
程序不保存账号密码,靠浏览器持久 profile 记住登录态。
- **双击 `启动-登录.command`**(或命令行 `npm run login`)
- 在弹出的浏览器里手动完成登录(含验证码/二次验证)
- 看到卖家后台首页后,回到终端按 Enter
- 出现 `✅ 检测到已登录` 即成功。以后扫描不用再登(直到 session 过期)。

---

## 二、日常使用

| 我想… | 双击这个 | 或命令行 |
|---|---|---|
| 立即扫一次(当天) | `立即扫一次.command` | `npm run scan` |
| 立即扫一次(当天+近7天) | — | `npm run scan:7d` |
| 常驻自动扫(每小时) | `启动-常驻扫描.command` | `npm run start` |
| 看今天命中概况 | — | `npm run status` |
| 离线自检(不用登录) | — | `npm run selftest` |
| 运营播报·先预览不推群 | — | `node src/index.js board` |
| 运营播报·开/关每半小时自动 | — | `node src/index.js board --on` / `--off` |
| 自动发现新建的广告计划 | — | `node src/index.js discover` |
| 暴力测试(假后台,不用登录) | — | `node src/index.js stress` |

- **输出**:`output/<时间串>.xlsx`,例 `output/7月23日-14.00.xlsx`;**同时自动上传到 Google Drive**(见第五节)
- **无命中**:不写表,只在日志/通知里记一行 `✅ …无高成本低ROI素材`
- **告警**(登录失效/验证码/风控):写入 `output/ALERTS.log`,按通知通道推送,**并在 Google 文件夹里新建一个「⚠️需人工-…」情况说明文件**

---

## 五、Google Drive 自动上传(已接好 rclone)

每轮扫描出表后,程序用 **rclone** 自动把 xlsx 传到 Google 文件夹:
**[KANS高成本低ROI素材预警](https://drive.google.com/drive/folders/填GoogleDrive文件夹ID)**,文件名就是时间串(如 `7月23日-20.00.xlsx`)。

- 配置在 `config.json` 的 `output.gdrive`(`enabled` / `remote` / `rootFolderId`)。不想传到云端就把 `enabled` 改 `false`。
- 授权信息存在 rclone 自己的配置 `~/.config/rclone/rclone.conf`,不在本项目里、不进日志。
- **换文件夹**:把新文件夹的 ID(Drive 网址里 `folders/` 后面那串)填到 `rootFolderId`。

### 授权失效了怎么办(重新授权)
如果某轮上传报「授权失效」告警,在项目目录跑一次重新授权即可:
```bash
rclone authorize "drive"     # 浏览器弹出→用 <你的 Google 账号邮箱> 登录→允许
```
把终端里 `--->` 和 `<---` 之间那段 token 交给维护者更新,或直接:
```bash
rclone config reconnect gdrive:
```

> ⚠️ **已知维护点**:当前用的是 rclone 自带的共享 client_id,Google 计划在 2026 年内停用它。
> 如果哪天上传开始持续失败,需要按 <https://rclone.org/drive/#making-your-own-client-id>
> 申请一个自己的 client_id(免费),再 `rclone config` 更新 `gdrive` 远程。届时找我改。

---

## 三、7×24 无人值守(可选,推荐给常开的 Mac)

用 macOS 自带的 launchd 让程序开机自启、崩溃自动拉起:

```bash
# 1) 拷贝配置(已按本机路径填好;换机器需改里面的绝对路径和 node 路径)
cp ~/Desktop/kans-roi-monitor/scripts/com.kans.roimonitor.plist ~/Library/LaunchAgents/

# 2) 加载并启动
launchctl load ~/Library/LaunchAgents/com.kans.roimonitor.plist

# 停止 / 卸载
launchctl unload ~/Library/LaunchAgents/com.kans.roimonitor.plist
```

> 说明:因 TikTok 有风控,浏览器默认**带界面运行**(headless=false),
> 所以这台 Mac 需保持**已登录用户桌面**(可锁屏但别注销/关机)。日志见 `logs/`。

---

## 三之二、运营播报(每半小时)

素材预警回答「哪条素材在烧钱」,播报回答「今天整体怎么样」。

- 数字来自**广告计划列表页接口返回的计划级官方数字**,不是把素材逐行加总 —— 素材层合计和后台的计划级数字对不上,日报数字不准就是栽在这
- 每张卡片两栏:当天累计 + 近 1 小时(两次快照相减;快照按市场当地日期分组,跨天不相减)
- 商品计划和直播计划是**两张分开的列表**,列顺序也不同,各读一次再合并
- **取全才推**:商品和直播都齐了才推群 / 写表 / 存快照;不齐隔 90 秒整轮重来,还不齐这个半点就不推
- 先 `board` 预览核对数字,确认无误再 `board --on`

相关配置在 `config.json` 的 `feishu.board`:`enabled`(开关) / `everyMinutes`(默认 30) / `timeoutMinutes`(看门狗)。

### 自动发现计划

推广系列 ID 会随日期后缀轮换。`discover` 拦截列表页自己的 JSON 接口把 `campaign_id` / `product_id` 抓出来,问一句再并进 `campaigns.json`(不扒 DOM —— 列表页的按钮多是 JS 驱动的,`href` 里未必有 id)。

### 暴力测试

`stress` 会起一个**故意抽风**的假后台:永不响应 / 前两次不响应 / 晚几秒渲染 / 行一条条往外冒 / 返回另一张表 / 有表没行 / 服务器报错 / 页面被关掉。商品与直播各随机抽一种,反复捶打取数链路。

验收只认一条铁律:**要么完整正确,要么明确失败** —— 绝不串台、绝不少行、绝不拿 0 冒充。不用登录,不碰真实数据,约 6 分钟。

---

## 四、配置项(`config.json`)

- `costThresholdCNY` / `roiThreshold`:命中阈值(¥70 / ROI<2)
- `vndToCnyRate`:VND→¥ 汇率(默认 3891,漂移时校准)
- `sevenDayHours`:哪几个越南整点加扫近7天(默认 `[10,14]`)
- `browser.headless`:是否无界面(TikTok 建议 `false` 更稳)
- `output.format`:`xlsx` 或 `csv`
- `output.mode`:`local`(默认,本地文件);Google Sheets 需另接凭据
- `llm.enabled`:是否启用 LLM 兜底(默认 `false`,纯规则跑通);启用需在 `.env` 填 `LLM_API_KEY`
- `notify.channels`:`log` / `file` / `feishu` / `telegram`(飞书、TG 需在 `.env` 填 webhook/token)
- `feishu.board`:运营播报开关与节奏(`enabled` / `everyMinutes` / `timeoutMinutes`)
- `feishu.bitable.boardTableId`:播报明细回写的数据表;运行日志另有一张「运行日志」表

**计划清单**在 `campaigns.json`——计划 ID 会随日期后缀轮换,上新计划时在这里增删。

密钥都放 `.env`(参考 `.env.example`),**不进日志、不硬编码**。

---

## 五、命中判定与输出规则(与需求文档一致)

- 命中条件:`归一化¥ > 70 且 ROI < 2`;列表按成本降序,读到成本 ≤¥70 即停。
- 列按**表头名**定位(作品ID / 成本 / 投资回报率),达人账号取第 3 列;不写死列序。
- 表格异步加载:先等 10s,再确认行数,未就绪重试(避免漏判)。
- 标记:`ROI<1 → ⚠️ROI<1`;当天口径首次出现的素材 → `🆕新素材`(今天首轮不打 🆕)。
- 排序:当天块在前、近7天块在后;每块内按计划分组、组间按最高成本降序、组内成本降序。
- 🆕 判定的历史来源是本地 `data/history.json`(不依赖读线上表)。

---

## 六、遇到问题怎么办

- **登录掉了 / 出验证码 / 风控页**:程序会告警(`output/ALERTS.log` + 通知)。
  重新双击 `启动-登录.command` 手动登录一次即可继续。
- **计划上新**:编辑 `campaigns.json` 增删计划。
- **命中数明显不对**:检查 `config.json` 的汇率/阈值;看 `logs/` 里当轮日志。

---

## 七、Windows 适配

核心代码是跨平台 Node,无 Mac 专属逻辑。Windows 版将补充:
`.bat` 双击脚本 + 「计划任务 / nssm 常驻」说明(Mac 版稳定跑通后再交付)。
