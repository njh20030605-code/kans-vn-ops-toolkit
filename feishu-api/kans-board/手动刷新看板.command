#!/bin/bash
cd "$(dirname "$0")"
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
node build.js --force
echo ""
echo "完成。按任意键关闭。"
read -n 1
