#!/bin/bash
clear
echo "═══════════════════════════════════════════════════════"
echo "  给飞书机器人登录 Claude"
echo "═══════════════════════════════════════════════════════"
echo
echo "【第 0 步】先体检网络 —— 这是上次失败的真正原因"
echo

IP=$(curl -s --max-time 10 https://ipinfo.io/json 2>/dev/null)
CC=$(echo "$IP" | grep -o '"country": *"[^"]*"' | cut -d'"' -f4)
ORG=$(echo "$IP" | grep -o '"org": *"[^"]*"' | cut -d'"' -f4)
ADDR=$(echo "$IP" | grep -o '"ip": *"[^"]*"' | cut -d'"' -f4)
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 https://claude.ai/ 2>/dev/null)

echo "  出口 IP : $ADDR"
echo "  地区    : $CC"
echo "  运营商  : $ORG"
echo "  claude.ai 响应: $CODE"
echo

if [ "$CODE" = "403" ]; then
  echo "❌ 这个节点被 Cloudflare 拦了（403 = 人机挑战页）。"
  echo
  echo "   浏览器能过是因为它会跑 JS 挑战，命令行不会，所以登录到"
  echo "   最后一步一定会 403 失败。现在登录 100% 会白跑。"
  echo
  echo "   请换一个 VPN 节点，优先【家宽 / 住宅 IP】，"
  echo "   避开标着「机房」「IDC」的节点，然后重新双击本脚本。"
  echo
  read -n 1 -s -r -p "按任意键关闭"
  exit 1
fi

echo "✅ 网络这关过了（$CODE），可以登录。"
echo
echo "接下来："
echo "  1. 下面会打印一个授权链接，窗口会【停住等你】"
echo "  2. 复制链接去浏览器打开（别点已经开着的旧标签页）"
echo "  3. 点 Authorize → 复制页面给的授权码"
echo "  4. 切回【本窗口】粘贴 → 回车（粘贴时不显示字符是正常的）"
echo
read -n 1 -s -r -p "按任意键开始…"
clear

UNSET=$(env | grep -oE '^(CLAUDE[A-Z_]*|ANTHROPIC_[A-Z_]*)' | sed 's/^/-u /' | tr '\n' ' ')
env $UNSET claude auth login --claudeai

echo
echo "═══════════════════ 验证 ═══════════════════"
echo "回复四个字：连接正常" | env $UNSET claude -p --output-format text --disallowed-tools Bash Read Write Edit 2>&1 | head -4
echo
launchctl kickstart -k "gui/$(id -u)/com.jasper.feishu-myclaude" 2>/dev/null \
  && echo "✅ 机器人已重启" || echo "⚠️ 机器人重启失败"
echo
echo "看到【连接正常】就成了，去飞书 @ 它。"
echo
read -n 1 -s -r -p "按任意键关闭"
