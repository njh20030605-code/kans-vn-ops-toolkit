# Changelog

## v1.1.0 · 2026-09-20

**从「越南专用」变成「东南亚通用框架」。**

- **多市场**：越南 / 泰国 / 印尼 / 马来西亚 / 菲律宾 / 新加坡。市场参数集中在一处，换国家改配置不改代码
  - ROI 预警：`config.json` 新增 `market` 块（国家码、货币、符号、时区、汇率），六国模板见 `markets.example.json`；旧的 `vndToCnyRate` / `timezoneOffsetHours` 仍兼容，`node src/index.js config` 可自动迁移
  - 表头识别扩到七种语言（中 / 英 / 越 / 泰 / 印尼 / 马来 / 菲律宾），数字解析自动判别点逗号，小面额币种（泰铢 / 林吉特 / 新币）无符号时按本币算
  - 主播排名：`config.json` 新增 `currency` 与 `local_lang`，第三张工作表的语言与货币可整体替换（示例给的是泰语）
- **汇率插件 v2.0**（目录 `vnd-cny-extension` → `fx-extension`）：重写成「市场表 + 纯函数内核 + DOM 层」三层
  - 六国货币、本地缩写（Tr / Tỷ / jt / rb / K / M / B）、符号前后缀、点逗号千分位全部覆盖
  - 按域名自动识别市场，可切换换算成人民币或美元
  - 加国家只改 `markets.js` 一段
  - 新增 `test/` 单元测试与 `demo/` 演示页（README 的前后对比图就是它）
- **CI**：GitHub Actions 跑插件单元测试、ROI 预警离线自检（113 项）、全仓库语法检查
- 脱敏脚本覆盖飞书租户域名、多维表格 token、云盘文件夹 ID

## v1.0.0 · 2026-09-20

首个公开版本。

- 五个子项目整合进一个仓库：feishu-api、roi-monitor（Mac / Windows）、host-ranking、vnd-cny-extension
- **可复用**：所有业务参数（表 ID、负责人、店铺与计划映射、实习生名单、阈值、汇率、品牌名、Google 表 ID、列索引）全部抽到 `*.json` 配置，代码零改动即可接入其他店铺；每处配置附 `*.example.json` 模板
- 中英双语 README，按角色导航，「10 分钟接入」步骤表
- `sync-from-desktop.sh` + `scrub.sh`：从开发机同步源码并自动脱敏
- GitHub Actions 打包 host-ranking 的 Windows EXE
- MIT 许可
