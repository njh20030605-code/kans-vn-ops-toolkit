@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 运营播报 . 先预览,核对数字 ====
echo 会打开后台列表页取当天数据,十几秒。只预览,不推群。
echo.
node src/index.js board
echo.
echo 按任意键关闭。
pause >nul
