@echo off
chcp 65001 >nul
title DeepSeek Bridge - SELF TEST
cd /d "%~dp0.."

echo ============================================================
echo   TEST 1/2 : DeepSeek key + tool  (no tunnel needed)
echo ============================================================
echo.
call npm run selftest:memory
echo.

echo ============================================================
echo   TEST 2/2 : public endpoint  (run 1-START first)
echo ============================================================
echo.
call npm run smoke
echo.

echo ============================================================
echo   If both show "all passed", the bridge, the tunnel and
echo   your key are all fine. When ChatGPT still fails, the
echo   problem is inside ChatGPT's connector settings.
echo ============================================================
echo.
pause
