#!/bin/bash
# 双击运行:常驻扫描。每小时扫当天;越南时间 10 点/14 点加扫近7天。
# 关掉这个窗口即停止。要 7×24 无人值守请看 README 的 launchd 方案。
cd "$(dirname "$0")"
echo "==== KANS 预警程序 · 常驻扫描(每小时) ===="
echo "保持本窗口开启即持续运行;关闭窗口即停止。"
echo "(运行期间已阻止 Mac 休眠;但笔记本合上盖子仍会睡)"
# caffeinate:程序运行期间阻止系统/硬盘/idle 休眠,避免睡眠漏扫
caffeinate -ims node src/index.js start
