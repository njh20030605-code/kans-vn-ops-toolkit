@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 自动发现新建的广告计划 ====
echo 会打开后台列表页抓 campaign_id,大概十几秒。
echo.
node src/index.js discover
echo.
echo 按任意键关闭。
pause >nul
