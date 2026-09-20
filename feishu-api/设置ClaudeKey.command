#!/bin/bash
# 双击运行：配置 Claude API Key（支持官方 或 第三方中转），存到 ~/.feishu/ 权限 600
cd "$(dirname "$0")"
clear
echo "配置 Claude API Key —— 让机器人能真回答，而不是只回「收到」"
echo "════════════════════════════════════════════════════════"
echo
echo "选一种："
echo "  1) Anthropic 官方"
echo "  2) 第三方中转 / 代理（需要额外填一个 base URL）"
echo
read -r -p "输入 1 或 2，回车： " MODE
echo

if [ "$MODE" = "2" ]; then
  echo "中转服务商给你的接口地址，形如 https://xxx.com  或  https://xxx.com/v1"
  read -r -p "base URL： " BASEURL
  BASEURL="$(echo "$BASEURL" | tr -d '[:space:]')"
  echo
  echo "模型名（中转平台的叫法可能不一样；直接回车＝claude-opus-5）"
  read -r -p "model： " MODELNAME
  MODELNAME="$(echo "$MODELNAME" | tr -d '[:space:]')"
  echo
else
  BASEURL=""
  MODELNAME=""
  echo "去这个页面点 Create Key，生成一串 sk-ant-... 开头的字符串："
  echo
  echo "        console.anthropic.com/settings/keys"
  echo
  echo "⚠️  要复制的是生成出来的那串 key，不是上面这行网址。"
  echo "⚠️  这是按用量计费的 API 账号，和 Claude 订阅是两回事，需单独充值。"
  echo
fi

read -r -s -p "粘贴 API Key（输入时不显示），回车： " KEY
echo
KEY="$(echo "$KEY" | tr -d '[:space:]')"

# —— 输入校验，挡掉常见的粘错 ——
if [ -z "$KEY" ]; then
  echo "❌ 没输入内容，已取消。"; read -n 1 -s -r -p "按任意键关闭"; exit 1
fi
case "$KEY" in
  http*)
    echo "❌ 你粘的是一条网址，不是 key。先去那个页面点 Create Key 生成。"
    read -n 1 -s -r -p "按任意键关闭"; exit 1 ;;
esac
if [ ${#KEY} -lt 20 ]; then
  echo "❌ 只有 ${#KEY} 个字符，太短了，不像 API key。"
  read -n 1 -s -r -p "按任意键关闭"; exit 1
fi

mkdir -p ~/.feishu
umask 177
printf '%s' "$KEY" > ~/.feishu/anthropic_key;      chmod 600 ~/.feishu/anthropic_key
[ -n "$BASEURL" ]   && { printf '%s' "$BASEURL"   > ~/.feishu/anthropic_base_url; chmod 600 ~/.feishu/anthropic_base_url; }
[ -n "$MODELNAME" ] && { printf '%s' "$MODELNAME" > ~/.feishu/anthropic_model;    chmod 600 ~/.feishu/anthropic_model; }
[ -z "$BASEURL" ]   && rm -f ~/.feishu/anthropic_base_url
[ -z "$MODELNAME" ] && rm -f ~/.feishu/anthropic_model

echo "✅ 已保存（${#KEY} 字符）到 ~/.feishu/"
echo
echo "--- 实际发一个请求测一下 ---"
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const rd=n=>{const f=path.join(os.homedir(),".feishu",n);return fs.existsSync(f)?fs.readFileSync(f,"utf8").trim():null;};
const key=rd("anthropic_key"), base=rd("anthropic_base_url"), model=rd("anthropic_model")||"claude-opus-5";
const Anthropic=require("@anthropic-ai/sdk");
console.log("  model = "+model+(base?"\n  base  = "+base:"  (官方)"));
new Anthropic({apiKey:key, ...(base?{baseURL:base}:{})}).messages.create({
  model, max_tokens:100, messages:[{role:"user",content:"回复四个字：连接正常"}]
}).then(r=>console.log("\n✅ "+r.content.filter(b=>b.type==="text").map(b=>b.text).join("")))
 .catch(e=>{
   console.log("\n❌ "+e.message);
   if(/401|authentication/i.test(e.message)) console.log("   → key 不对，或没复制全");
   if(/404|not_found|model/i.test(e.message)) console.log("   → 模型名不对，换中转平台支持的名字");
 });
'
echo
echo "接下来：关掉机器人窗口，重新双击「启动机器人.command」。"
echo "启动那行应该显示「Claude 已接入（真回答模式）」。"
echo
read -n 1 -s -r -p "按任意键关闭"
