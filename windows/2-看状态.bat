@echo off
chcp 65001 >nul
title ModelBridge - STATUS
cd /d "%~dp0.."

call npm run status

echo.
echo ------------------------------------------------------------
echo   enabled  = OK        disabled = double-click 1 to start
echo   running  = service alive
echo   tunnel   = ChatGPT can reach you only if this is running
echo ------------------------------------------------------------
echo.
pause
