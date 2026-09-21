@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 播报诊断:把后台返回的数据抓下来 ====
echo 成交/ROI 显示 0 的时候跑这个,跑完把 logs 里生成的
echo board-dump-*.json 发给 Claude。
echo.
node src/index.js board --dump
echo.
echo 按任意键关闭。
pause >nul
