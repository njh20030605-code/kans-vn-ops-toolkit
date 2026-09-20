#!/bin/bash
# 双击运行：启动飞书机器人（被 @ 自动回复）。关掉这个窗口机器人就停了。
cd "$(dirname "$0")"
clear
echo "启动飞书机器人 My Claude …"
echo "（关闭本窗口 或 按 Ctrl+C 即停止）"
echo
# 想让它用 Claude 真回答，把下面这行的 # 去掉并填上 key：
# export ANTHROPIC_API_KEY=sk-ant-...
node bot.js
echo
read -n 1 -s -r -p "机器人已停止，按任意键关闭"
