@echo off
chcp 65001 >nul
title ModelBridge - AUTO APPROVE (ON)
cd /d "%~dp0.."

echo ============================================================
echo   FULL AUTO-APPROVE   (turn approvals OFF)
echo ============================================================
echo.

rem Printed by node, not by this file: cmd.exe desyncs on non-ASCII
rem batch files, so every Chinese line in this project comes from ctl.mjs.
call npm run auto
echo.

echo ------------------------------------------------------------
echo   Turning this ON removes EVERY human approval gate:
echo     - the command allowlist
echo     - the chaining guard:  ^&^&   ^|   ;
echo     - the file workspace boundary
echo   It is not "fewer prompts". Nothing stops to ask you.
echo.
echo   A service restart turns it back off automatically,
echo   so forgetting about it is not permanent.
echo ------------------------------------------------------------
echo.
set /p ok=Type Y and press Enter to confirm:
if /i not "%ok%"=="Y" (
  echo Cancelled. Nothing changed.
  echo.
  pause
  exit /b 0
)
echo.
call npm run auto:on
echo.
echo When you are done, double-click 10 to restore approvals.
echo.
pause
