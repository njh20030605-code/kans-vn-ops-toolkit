@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== KANS 预警程序 · 手动登录 TikTok ====
echo 浏览器弹出后请完成登录(含验证码/拼图),再回来按 Enter。
node src/index.js login
echo.
echo 完成。按任意键关闭。
pause >nul
