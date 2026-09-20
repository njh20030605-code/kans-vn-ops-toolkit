#!/bin/bash
# 把桌面上最新源码同步进本仓库（只拷源码与文档，排除依赖 / 日志 / 数据 / 凭证）。
# 用法：bash sync-from-desktop.sh && git add -A && git commit -m "..." && git push
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/Desktop"; P="$D/插件:软件-Google"
X=(--exclude .DS_Store --exclude '._*' --exclude node_modules --exclude logs --exclude '*.log' --exclude '*.bak*' --exclude backups --exclude '.env' --exclude '.state.json' --exclude notified.json --exclude __pycache__ --exclude '*.pyc' --exclude .git --exclude README.md)
RS() { rsync -a --delete "${X[@]}" "$@"; }

RS --exclude 'intern-manual/*.docx' "$D/feishu-api/" "$R/feishu-api/"
RS --exclude data --exclude output "$P/kans-roi-monitor/" "$R/roi-monitor/"
RS "$P/kans-roi-monitor-win/" "$R/roi-monitor-win/"
RS --exclude '*.exe' --exclude .github --exclude dist --exclude build --exclude '*.spec' "$P/KANS主播排名报表/主播排名项目/KANS主播排名程序/" "$R/host-ranking/"
RS "$P/TikTok-Shopee-汇率插件-v2.0-多国/" "$R/fx-extension/"
cd "$R" && git status --short
bash "$R/scrub.sh"
