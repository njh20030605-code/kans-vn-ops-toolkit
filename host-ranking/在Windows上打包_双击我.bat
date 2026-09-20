@echo off
cd /d "%~dp0"
echo ==================================================
echo   KANS Host Ranking - Windows Packager  v2
echo ==================================================
echo.
echo [1] Checking Python via the 'py' launcher:
py --version
echo.
echo     If line [1] above shows a version number, good.
echo     If it says 'py' is not recognized, first double-click the
echo     python-3.12.10 installer in THIS folder, click Install Now,
echo     wait until done, then run this bat again.
echo.
echo [2] Installing build tools openpyxl + pyinstaller, needs internet...
py -m pip install --upgrade openpyxl pyinstaller
echo.
echo [3] Building EXE, please wait 1-3 minutes...
py -m PyInstaller --noconfirm --windowed --clean --onefile --name "KANS-Host-Ranking" --collect-submodules openpyxl main_app.py
echo.
echo ==================================================
echo   If the file below exists, packaging SUCCEEDED:
dir dist\KANS-Host-Ranking.exe
echo   Location: dist\KANS-Host-Ranking.exe
echo   Copy that .exe to the PC you use daily. No Python needed there.
echo ==================================================
explorer dist
echo.
pause
