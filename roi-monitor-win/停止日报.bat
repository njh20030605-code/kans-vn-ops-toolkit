@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 停止每日日报推送(红色预警不受影响)====
node src/index.js daily off
echo.
echo 按任意键关闭。
pause >nul
