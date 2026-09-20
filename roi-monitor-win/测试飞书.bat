@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 测试飞书:发测试卡片到群 + 写一条测试记录 ====
node src/index.js feishu-test
echo.
echo 按任意键关闭。
pause >nul
