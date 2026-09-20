#!/bin/bash
# 双击运行:立即手动扫描一次(当天口径)。想同时扫近7天,把下面命令改成 scan --with-7d
cd "$(dirname "$0")"
echo "==== KANS 预警程序 · 立即扫一次(当天) ===="
node src/index.js scan
echo ""
echo "完成。按任意键关闭窗口。"
read -n 1
