@echo off
chcp 65001 >nul
title ModelBridge - ALLOW A PROJECT
cd /d "%~dp0.."

echo ============================================================
echo   Let the sub-agent work in another project
echo ============================================================
echo.
echo   The sub-agent may only work inside the roots listed in .env
echo   (DEEPSEEK_ALLOWED_ROOTS). This adds another one.
echo.
echo   The tunnel is left running, so the public URL does not change
echo   and ChatGPT needs no edit.
echo.
echo   WARNING: anyone holding the public URL can read and write files
echo   in EVERY directory on this list, and run commands there.
echo   "Can run commands" means "has this computer".
echo.
echo   Quote the path, or use forward slashes - a bare backslash can
echo   be eaten by the shell:   "D:\my-project"   or   D:/my-project
echo.

set "PROJ="
set /p "PROJ=Project directory to allow  (Enter = just show the list): "

if "%PROJ%"=="" (
  call npm run ctl -- allow
) else (
  call npm run ctl -- allow "%PROJ%"
)

echo.
echo ------------------------------------------------------------
echo   Take one back out again with:
echo     npm run ctl -- allow --remove "D:\the\project"
echo ------------------------------------------------------------
echo.
pause
