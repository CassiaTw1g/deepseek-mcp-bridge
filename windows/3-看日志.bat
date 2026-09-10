@echo off
chcp 65001 >nul
title DeepSeek Bridge - LOGS
cd /d "%~dp0.."

echo Latest log lines. Double-click this file again to refresh.
echo.
call npm run logs
echo.
echo ------------------------------------------------------------
echo   tools/call deepseek_flash    = ChatGPT really called it
echo   only initialize / tools/list = connected, but Sol skipped it
echo   nothing new                  = ChatGPT never connected
echo ------------------------------------------------------------
echo.
pause
