@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 手动推一次今天的日报 ====
node src/index.js daily-report
echo.
echo 按任意键关闭。
pause >nul
