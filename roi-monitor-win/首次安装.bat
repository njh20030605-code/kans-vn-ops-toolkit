@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 首次安装:安装依赖 + 浏览器内核(只需跑一次)====
echo 请确保已装 Node.js (https://nodejs.org, 选 LTS 版)
echo.
call npm install
call npx playwright install chromium
echo.
echo 安装完成。接下来双击「启动-登录.bat」登录一次。按任意键关闭。
pause >nul
