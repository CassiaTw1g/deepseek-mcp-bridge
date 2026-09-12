@echo off
chcp 65001 >nul
title ModelBridge - STOP
cd /d "%~dp0.."

echo ============================================================
echo   STOP
echo ============================================================
echo.
echo This stops the service AND the tunnel.
echo ChatGPT will no longer be able to call DeepSeek.
echo.
echo Only want to cut ChatGPT off but keep the service running?
echo Cancel this and run:  npm run untunnel
echo.
set /p ok=Type Y and press Enter to confirm:
if /i not "%ok%"=="Y" (
  echo Cancelled.
  echo.
  pause
  exit /b 0
)

call npm run disable
echo.
echo Stopped. To restore: double-click 1-START.
echo.
pause
