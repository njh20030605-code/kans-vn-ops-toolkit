@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 配置飞书推送(只需做一次)====
node src/index.js feishu-setup
echo.
echo 按任意键关闭。
pause >nul
