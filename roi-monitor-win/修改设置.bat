@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== KANS 预警 · 修改阈值设置 ====
node src/index.js set
echo.
echo 完成。按任意键关闭。
pause >nul
