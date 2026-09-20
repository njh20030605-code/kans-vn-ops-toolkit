@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 看代码版本 ====
node src/index.js version
echo.
echo 按任意键关闭。
pause >nul
