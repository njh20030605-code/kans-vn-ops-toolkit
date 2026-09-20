#!/bin/bash
clear
LOG="$HOME/Desktop/feishu-api/logs/login-debug.log"
mkdir -p "$(dirname "$LOG")"
echo "═══════════════════════════════════════════════════"
echo " 抓 Claude 登录的真实报错"
echo "═══════════════════════════════════════════════════"
echo
echo "这次不为了登录成功，只为了把服务端到底为什么拒绝【记下来】。"
echo "流程和之前一样：链接 → 浏览器 Authorize → 复制码 → 粘回来。"
echo "就算最后还是 403 也没关系，日志会写到："
echo "  $LOG"
echo
read -n 1 -s -r -p "按任意键开始…"
clear
UNSET=$(env | grep -oE '^(CLAUDE[A-Z_]*|ANTHROPIC_[A-Z_]*)' | sed 's/^/-u /' | tr '\n' ' ')
env $UNSET claude --debug --debug-file "$LOG" auth login --claudeai 2>&1 | tee -a "$LOG"
echo
echo "═══════════════════════════════════════════════════"
echo "日志已写入： $LOG"
echo "把这个文件发给 Claude（或者直接说「看 login-debug.log」）"
echo "═══════════════════════════════════════════════════"
echo
read -n 1 -s -r -p "按任意键关闭"
