@echo off
chcp 65001 >nul
title DeepSeek Bridge - UNINSTALL
cd /d "%~dp0.."

echo ============================================================
echo   UNINSTALL
echo ============================================================
echo.
echo Stops service + tunnel and clears the .state folder.
echo Project files and .env are NOT deleted.
echo.
set /p ok=Type Y and press Enter to confirm:
if /i not "%ok%"=="Y" (
  echo Cancelled.
  echo.
  pause
  exit /b 0
)

call npm run uninstall

echo.
echo ============================================================
echo   Two more things you must do by hand
echo ============================================================
echo.
echo 1) Delete the connector inside ChatGPT:
echo    chatgpt.com - Settings - Plugins - MCP - remove deepseek-bridge
echo.
echo 2) Revoke the API key in the DeepSeek console.
echo    Deleting .env does NOT revoke the key.
echo.
echo 3) If you no longer need the tunnel:
echo    winget uninstall Cloudflare.cloudflared
echo.
pause
