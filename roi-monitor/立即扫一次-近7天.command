#!/bin/bash
# 双击运行:立即扫一次,含"近7天"口径(会同时出 当天 + 近7天 两块)。
cd "$(dirname "$0")"
echo "==== KANS 预警程序 · 立即扫一次(当天 + 近7天) ===="
node src/index.js scan --with-7d
echo ""
echo "完成。按任意键关闭窗口。"
read -n 1
