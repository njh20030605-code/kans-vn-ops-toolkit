#!/bin/bash
# 双击运行:一次性手动登录 TikTok 卖家后台(登录态会保存,以后扫描不用再登)
cd "$(dirname "$0")"
echo "==== KANS 预警程序 · 手动登录 ===="
node src/index.js login
echo ""
echo "完成。按任意键关闭窗口。"
read -n 1
