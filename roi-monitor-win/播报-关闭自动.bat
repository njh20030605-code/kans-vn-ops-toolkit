@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 关闭自动播报 ====
node src/index.js board --off
echo.
echo 按任意键关闭。
pause >nul
