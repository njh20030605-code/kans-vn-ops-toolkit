@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 飞书配置体检:看凭据对不对、能不能取到 token ====
node src/index.js feishu-check
echo.
echo 按任意键关闭。
pause >nul
