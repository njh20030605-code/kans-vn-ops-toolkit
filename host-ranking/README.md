# host-ranking · KANS 主播排名生成器

读线上 Google 表（发布为 CSV 的公开链接），把当月多个直播间 tab（SKINCARE、OFFICIAL + KHTH）合并，
同一主播跨直播间 GMV 加总，生成**当日排名 + 当月累计排名**，一份 Excel 三个工作表：

| 工作表 | 货币 |
|---|---|
| 简体中文 | 人民币（元），固定汇率 1 元 = 3,860 越南盾 |
| English | 越南盾（VND） |
| Tiếng Việt | 越南盾（VND） |

口径为「退前 GMV」；当天数据不统计，默认出「前一天」；可指定日期补跑。

## 文件

- `report_core.py` — 数据内核：读表 → 合并 tab → 算排名 → 写 Excel。可单独 `python3 report_core.py` 跑。**要改的配置都在文件最顶部**（表 ID、直播间关键词、汇率、列索引、输出目录）。
- `main_app.py` — 图形界面（中 / 英 / 越三语切换、日期选择、一键生成、打开输出目录）。
- `requirements.txt` — 只有 `openpyxl`。
- `使用说明.txt` — 给运营同学的使用说明（Mac 版）。
- `在Windows上打包_双击我.bat`、`★如何生成Windows版exe.txt` — Windows 打包步骤。

## 运行

```bash
pip install -r requirements.txt
export KANS_WORKBOOK_ID=<线上 Google 表的 ID>   # 或直接改 report_core.py 顶部的 WORKBOOK_ID
python3 main_app.py
```

## 打包成桌面 App

Mac：
```bash
python3 -m PyInstaller --noconfirm --windowed --clean --name "KANS主播排名" --collect-submodules openpyxl main_app.py
```

Windows：本仓库根目录 `.github/workflows/build-host-ranking-windows.yml` 会在推送或手动触发时用 GitHub Actions 打出 `KANS-Host-Ranking.exe`，到 Actions 页面下载 artifact 即可，不需要本机装 Windows。

第一次打开 App 提示「无法验证开发者」：右键 → 打开 → 再点打开，只需一次。
