@echo off
chcp 65001 >nul
title ModelBridge - FIXED HOSTNAME
cd /d "%~dp0.."

echo ============================================================
echo   FIXED HOSTNAME   (a public URL that stops changing)
echo ============================================================
echo.
echo   A quick tunnel is handed a new random address on every
echo   start, so each restart costs a trip to ChatGPT to rebuild
echo   the connector. A fixed hostname on your own domain never
echo   changes, and the connector is created once.
echo.
echo   You need a domain whose nameservers already point at
echo   Cloudflare, and you must be signed in to the Cloudflare
echo   account that holds it.
echo.
echo   Do this in the Cloudflare dashboard FIRST:
echo.
echo     1. Create the tunnel
echo          Networking - Tunnels - Create a tunnel
echo        (the older Zero Trust / Networks / Connectors menu
echo         redirects to the same page)
echo.
echo     2. Add the route
echo          your tunnel - Routes - Add route
echo          - Published application
echo          Subdomain : mcp        Domain : your domain
echo          Service type : HTTP
echo          Service URL  : http://localhost:8787
echo        Cloudflare creates the DNS record and the certificate
echo        for you. Do not add a record by hand.
echo.
echo     3. Copy the long token the dashboard shows you.
echo.
echo ------------------------------------------------------------
echo.

set /p HOST=Your hostname, for example mcp.example.com :
if "%HOST%"=="" (
  echo.
  echo Nothing entered. Nothing changed.
  echo.
  pause
  exit /b 1
)

echo.
echo Running:  npm run ctl -- tunnel named %HOST%
echo It will ask you to paste the token. Keep it off any chat window.
echo.

call npm run ctl -- tunnel named %HOST%
if errorlevel 1 (
  echo.
  echo That did not finish, so nothing was switched over.
  echo.
  pause
  exit /b 1
)

echo.
echo ------------------------------------------------------------
echo   The address is saved, but this is NOT live yet: the route
echo   in step 2 above is what makes it reachable. It lives in
echo   Cloudflare, so nothing on this machine can check it.
echo ------------------------------------------------------------
echo.
set /p ok=Is that route already saved in the dashboard? Type Y :
if /i not "%ok%"=="Y" (
  echo.
  echo Saved, not switched yet. Add the route, then run this file
  echo again and answer Y. It will ask for the hostname and the
  echo token once more.
  echo.
  pause
  exit /b 0
)

echo.
echo Switching the tunnel over. The old random address stops working now.
echo.
call npm run untunnel
call npm run ctl -- tunnel
echo.
echo If the tunnel connected, the address above is your connector URL and
echo it will not change again. Double-click 1 to start it next time.
echo.
pause
