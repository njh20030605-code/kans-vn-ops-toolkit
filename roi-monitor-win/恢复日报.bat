@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 恢复每日日报推送(越南时间 9 点)====
node src/index.js daily on 9
echo.
echo 按任意键关闭。
pause >nul
