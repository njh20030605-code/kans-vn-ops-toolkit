# feishu-api · 飞书命令行 + My Claude 机器人 + 常驻同步任务

一个 Node.js 目录，装着所有跟飞书打交道的东西。凭证只存在本机 `~/.feishu/credentials.json`（权限 600），仓库里没有。

## 1. `feishu.js` — 飞书开放平台命令行

直连飞书 API，几百毫秒返回。所有其它脚本都复用它的 token 逻辑。

```bash
node feishu.js selftest                                      # 自检：凭证 + 权限
node feishu.js sheet:read  <token> 'Sheet1!A1:D20'           # 读电子表格区域
node feishu.js sheet:write <token> 'Sheet1!A1:C3' '[["a","b","c"]]'
node feishu.js base:tables  <appToken>                       # 多维表格：列数据表
node feishu.js base:fields  <appToken> <tableId>             # 列字段
node feishu.js base:records <appToken> <tableId> 50          # 读记录
node feishu.js base:add     <appToken> <tableId> '{"字段":"值"}'
node feishu.js doc:read   <docToken>                         # 读新版文档全文
node feishu.js doc:create <标题> [folderToken]               # 新建文档
node feishu.js doc:append <docToken> <文本>                  # 追加正文
node feishu.js chat:history <chatId> 50                      # 读群聊记录
node feishu.js api <METHOD> <路径> [JSON]                    # 万能透传，任何 open-apis 接口
```

链接 → token：`/docx/XXXX` 就是 docToken；`/base/XXXX?table=tblYYYY` 是 appToken + tableId；`/wiki/XXXX` 要先 `api GET /open-apis/wiki/v2/spaces/get_node?token=XXXX&obj_type=wiki` 解析出真实对象。

配套小工具：`docread.js`（把消息里的飞书链接读成正文喂给模型）、`docwrite.js`（模型输出的写表 / 写文档动作执行器）、`mdwrite.js`（Markdown → 飞书文档块，标题 / 列表 / 表格 / 高亮块）。

## 2. `bot.js` — 飞书机器人「My Claude」

- **护栏写死**：只有 OWNER 说话才回；群聊必须 @；同一条消息只回一次。
- 每轮喂给模型：`kb/` 本地知识库（权威事实源，没有的不许编）+ 本群聊天记录（范围可用自然语言指定）+ 聊天里的图片。
- 群内指令：`/kb list` 列出注入的知识库文件，`/kb reload` 立即重扫。
- 事件订阅已注册多维表格记录变更（3 秒防抖），用来触发下面的同步任务。

运行：`node bot.js` 或双击 `启动机器人.command`。常驻用 launchd `com.jasper.feishu-myclaude`，改完代码：

```bash
launchctl kickstart -k gui/$(id -u)/com.jasper.feishu-myclaude
```

`kb/` 的组织与注入规则（100 KB 单文件、60 KB 总量、关键词打分截断）见 [`kb/README.md`](kb/README.md)。

## 3. 常驻同步任务

| 目录 | 干什么 | 频率 | launchd |
|---|---|---|---|
| [`creative-exclusion/`](creative-exclusion/) | 素材排除表机器人：按计划补 Shop、同店同素材历史结论回写 ⚠ Robot、Jasper 有新批注就推卡片给实习生 | 180 s | `com.jasper.creative-exclusion` |
| `followup-sync.js` | 投放跟进工作台双向同步：源表「有投流码且无投放跟进人」进工作台，退回备注以【投放退回】块追加写回，去重靠 record_id | 30 s | `com.jasper.followup-sync` |
| [`intern-workflow/`](intern-workflow/) | 广告实习生每日工作流多维表格：建表、每天 00:10 清零并归档打卡历史、重灌任务 | 每日 | `com.jasper.intern-workflow` |
| [`kans-board/`](kans-board/) | 低效素材看板：把预警程序的命中流水按「每素材当天最后一次扫描」去重，汇总成计划维度当天 / 近 7 天两张表 | 15 min | `com.jasper.kans-board` |
| [`intern-manual/`](intern-manual/) | 广告实习生培训手册（v3.1）生成与就地补丁脚本，产物是飞书文档 | 手动 | — |

各任务详细口径见目录内 README / 说明文件：[`投放跟进同步-说明.md`](投放跟进同步-说明.md)、[`creative-exclusion/README.md`](creative-exclusion/README.md)、[`kans-board/README.md`](kans-board/README.md)。

## 4. 首次准备

```bash
npm install
# 双击 设置凭证.command，粘贴飞书应用 App Secret → 写入 ~/.feishu/credentials.json
node feishu.js selftest
```

读不到某份文档时不是权限问题（应用侧权限全开），是那份文档没把应用加成协作者：在文档右上角「分享」里搜 `My Claude` 加为可编辑。

## 5. 目录

```
feishu.js            命令行入口 / token / 各 API 封装
bot.js               飞书机器人
docread.js  docwrite.js  mdwrite.js   机器人的读写云文档助手
followup-sync.js     投放跟进同步
creative-exclusion/  素材排除表机器人（sync.js 常驻，rebuild.js 重建表，manual.js 生成培训手册）
intern-workflow/     实习生日清表
intern-manual/       实习生培训手册生成脚本
kans-board/          低效素材看板
kb/                  机器人知识库（业务口径、KPI、禁区）
*.command            双击脚本：启动机器人 / 设置凭证 / 登录 Claude / 抓报错
```
