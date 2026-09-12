@echo off
chcp 65001 >nul
title ModelBridge - AUTO APPROVE (OFF)
cd /d "%~dp0.."

echo ============================================================
echo   RESTORE APPROVALS   (turn approvals back ON)
echo ============================================================
echo.

call npm run auto:off
echo.
pause
