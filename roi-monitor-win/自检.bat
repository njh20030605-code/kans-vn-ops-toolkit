@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== KANS 预警程序 · 自检(不用登录,不碰真实数据)====
echo 大约 1 分钟。正常应看到「79 通过 / 0 失败」。
echo.
node src/index.js selftest
echo.
echo 按任意键关闭。
pause >nul
