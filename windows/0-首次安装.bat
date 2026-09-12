@echo off
chcp 65001 >nul
title ModelBridge - FIRST-RUN SETUP
cd /d "%~dp0.."

echo ============================================================
echo   FIRST-RUN SETUP  (the guided one)
echo ============================================================
echo.
echo   Run this ONCE, the first time you install this project.
echo   It asks a few questions, writes .env, starts the service and
echo   the tunnel, and prints the URL to paste into your MCP host.
echo.
echo   Have the API key for your model provider ready - it is pasted
echo   in, never typed on the command line, and never printed.
echo.
echo   It asks, in order:
echo     1. which model, and the API key (the provider is checked
echo        with one tiny request, so a bad key is caught here)
echo     2. which harness runs it - Claude Code, installed separately
echo     3. which directories the sub-agent may touch  (Enter = none:
echo        question-and-answer only, it cannot touch your files)
echo     4. a temporary hostname, or your own fixed one
echo     5. should the sub-agent ask before running commands
echo.
echo   Ctrl+C quits at any point. What is already written stays, and
echo   you can rerun this file to carry on.
echo.
echo   Already set up? Do not run this - use 1 to start normally.
echo.
echo ------------------------------------------------------------
echo   Double-click 4 any time to check that everything works.
echo ------------------------------------------------------------
echo.
pause
echo.
call npm run setup
echo.
pause
