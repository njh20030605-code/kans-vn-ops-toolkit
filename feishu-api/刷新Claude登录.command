#!/bin/bash
# 双击运行：给飞书机器人换一个长期令牌（不会过两天就掉）
clear
echo "═══════════════════════════════════════════════"
echo " 给 My Claude 机器人换长期令牌"
echo "═══════════════════════════════════════════════"
echo
echo "接下来会跑 claude setup-token："
echo "  1. 浏览器自动打开授权页 → 点 Authorize"
echo "  2. 页面给你一串授权码，复制"
echo "  3. 粘回这个窗口，回车"
echo "  4. 它会输出一个 sk-ant-oat01-... 开头的长期令牌"
echo
echo "⚠️ 那串令牌等下会自动存到 ~/.feishu/claude_oauth_token（权限600）"
echo "   你不用手动复制，脚本会抓。"
echo
read -n 1 -s -r -p "准备好按任意键开始…"
echo; echo

TMPOUT=$(mktemp)
# 剥掉可能干扰的变量
env $(env | grep -oE '^(CLAUDE[A-Z_]*|ANTHROPIC_[A-Z_]*)' | sed 's/^/-u /' | tr '\n' ' ') \
  claude setup-token 2>&1 | tee "$TMPOUT"

TOKEN=$(grep -oE 'sk-ant-oat[0-9]*-[A-Za-z0-9_-]+' "$TMPOUT" | tail -1)
rm -f "$TMPOUT"

echo
if [ -n "$TOKEN" ]; then
  mkdir -p ~/.feishu
  umask 177
  printf '%s' "$TOKEN" > ~/.feishu/claude_oauth_token
  chmod 600 ~/.feishu/claude_oauth_token
  echo "✅ 长期令牌已保存（${#TOKEN} 字符）→ ~/.feishu/claude_oauth_token"
  echo
  echo "--- 用它跑一次验证 ---"
  echo "回复四个字：连接正常" | env -i \
    PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
    HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=zh_CN.UTF-8 \
    CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
    claude -p --output-format text --disallowed-tools Bash Read Write Edit 2>&1 | head -4
  echo
  echo "--- 重启机器人 ---"
  launchctl kickstart -k "gui/$(id -u)/com.jasper.feishu-myclaude" 2>/dev/null && echo "已重启" || echo "重启失败，手动跑：launchctl load ~/Library/LaunchAgents/com.jasper.feishu-myclaude.plist"
else
  echo "⚠️ 没从输出里抓到 sk-ant-oat 开头的令牌。"
  echo "   如果上面确实显示了令牌，手动跑这句（把 xxx 换成令牌）："
  echo "   printf '%s' 'xxx' > ~/.feishu/claude_oauth_token && chmod 600 ~/.feishu/claude_oauth_token"
  echo "   然后：launchctl kickstart -k gui/\$(id -u)/com.jasper.feishu-myclaude"
fi
echo
read -n 1 -s -r -p "按任意键关闭"
