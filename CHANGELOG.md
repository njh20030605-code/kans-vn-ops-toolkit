# Changelog

## v1.0.0 · 2026-09-20

首个公开版本。

- 五个子项目整合进一个仓库：feishu-api、roi-monitor（Mac / Windows）、host-ranking、vnd-cny-extension
- **可复用**：所有业务参数（表 ID、负责人、店铺与计划映射、实习生名单、阈值、汇率、品牌名、Google 表 ID、列索引）全部抽到 `*.json` 配置，代码零改动即可接入其他店铺；每处配置附 `*.example.json` 模板
- 中英双语 README，按角色导航，「10 分钟接入」步骤表
- `sync-from-desktop.sh` + `scrub.sh`：从开发机同步源码并自动脱敏
- GitHub Actions 打包 host-ranking 的 Windows EXE
- MIT 许可
