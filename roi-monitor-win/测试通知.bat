@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 发一条测试通知,验证手机/推送通道是否打通 ====
node src/index.js test-notify
echo.
echo 按任意键关闭。
pause >nul
