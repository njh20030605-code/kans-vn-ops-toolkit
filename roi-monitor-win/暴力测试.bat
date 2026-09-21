@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== KANS 预警程序 · 暴力测试(不用登录,不碰真实数据)====
echo 会造一个故意抽风的假后台,反复捶打播报取数(约 6 分钟)。
echo 正常应该看到「253 通过 / 0 失败」这类结果。
echo.
node src/index.js stress
echo.
echo 按任意键关闭。
pause >nul
