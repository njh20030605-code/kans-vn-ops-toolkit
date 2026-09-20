#!/bin/bash
# 双击运行：把飞书 App Secret 存到本机 ~/.feishu/credentials.json（权限 600，只有你能读）
cd "$(dirname "$0")"
APP_ID="cli_aa030355f5f89cde"
echo "飞书应用：My Claude  ($APP_ID)"
echo "去这里点「眼睛」图标复制 App Secret："
echo "  https://open.feishu.cn/app/$APP_ID/baseinfo"
echo
read -r -s -p "粘贴 App Secret（输入时不显示），然后回车：" SECRET
echo
if [ -z "$SECRET" ]; then echo "没输入，已取消。"; read -n 1 -s -r -p "按任意键关闭"; exit 1; fi
mkdir -p ~/.feishu
umask 177
printf '{"app_id":"%s","app_secret":"%s"}\n' "$APP_ID" "$SECRET" > ~/.feishu/credentials.json
chmod 600 ~/.feishu/credentials.json
echo "已保存到 ~/.feishu/credentials.json"
echo
echo "--- 自检 ---"
node feishu.js selftest
echo
read -n 1 -s -r -p "按任意键关闭"
