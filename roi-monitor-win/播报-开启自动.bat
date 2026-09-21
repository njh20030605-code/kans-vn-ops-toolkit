@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 开启每半小时自动播报 ====
echo 只在数字核对无误后再开!
echo.
node src/index.js board --on
echo.
echo 按任意键关闭。
pause >nul
