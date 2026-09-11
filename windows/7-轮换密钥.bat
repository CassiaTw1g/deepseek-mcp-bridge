@echo off
chcp 65001 >nul
title DeepSeek Bridge - ROTATE SECRET
cd /d "%~dp0.."

echo ============================================================
echo   Rotating the MCP capability secret
echo ============================================================
echo.
echo   The tunnel is left running, so the public hostname stays
echo   the same. Only the secret at the end of the URL changes.
echo.
echo   Rotate this if the URL was ever seen by anyone else - it is
echo   the only thing standing between this machine and whoever
echo   holds it.
echo.

call npm run ctl -- rotate
echo.
echo ------------------------------------------------------------
echo   The new URL is on your clipboard. Paste it into ChatGPT:
echo     Settings - Plugins - MCP - your connector - Edit
echo ------------------------------------------------------------
echo.
pause
