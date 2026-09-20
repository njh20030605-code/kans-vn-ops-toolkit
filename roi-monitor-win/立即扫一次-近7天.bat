@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== KANS 预警程序 · 立即扫一次(当天 + 近7天)====
node src/index.js scan --with-7d
echo.
echo 完成。结果在:桌面\KANS高成本低ROI预警\。按任意键关闭。
pause >nul
