@echo off
chcp 65001 >nul
title DeepSeek Bridge - START
cd /d "%~dp0.."

echo ============================================================
echo   Starting DeepSeek Bridge
echo ============================================================
echo.

echo [1/3] enable ...
call npm run enable
echo.

echo [2/3] start local server ...
call npm start
echo.

echo [3/3] start public tunnel, wait about 15 seconds ...
call npm run tunnel
echo.

echo ------------------------------------------------------------
call npm run status
echo ------------------------------------------------------------
echo.
echo   Copy the public endpoint URL above into ChatGPT:
echo     Settings - Plugins - MCP - Add server
echo     Type: Streamable HTTP    Auth: No authentication
echo.
pause
