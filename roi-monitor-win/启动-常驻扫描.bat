@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KANS 预警 · 常驻扫描

:loop
echo.
echo ==== KANS 预警程序 . 常驻扫描(每小时)====
echo 保持本窗口开启即持续运行;关闭窗口即停止。
echo 结果输出到:桌面\KANS高成本低ROI预警\
echo.
node src/index.js start

echo.
echo ------------------------------------------------------------
echo  程序退出了,5 秒后自动重开。
echo  (覆盖了新代码会走这里,自动加载新版本;程序异常也会走这里)
echo  想彻底停掉:直接关掉本窗口。
echo ------------------------------------------------------------
timeout /t 5 /nobreak >nul
goto loop
