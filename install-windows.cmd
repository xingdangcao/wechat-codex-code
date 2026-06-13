@echo off
setlocal
cd /d "%~dp0"

echo.
echo === WeChat Codex Code Installer ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 18+ first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please reinstall Node.js with npm enabled.
  pause
  exit /b 1
)

where codex >nul 2>nul
if errorlevel 1 (
  echo Codex CLI was not found. Please install and log in to Codex CLI first.
  pause
  exit /b 1
)

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo.
echo Starting WeChat QR setup. Scan the QR code with WeChat when it appears.
call npm run setup
if errorlevel 1 (
  echo WeChat setup failed.
  pause
  exit /b 1
)

echo.
echo Installing Windows autostart and keepalive...
call npm run autostart -- install

echo.
echo Starting daemon...
call npm run daemon -- start

echo.
echo Current status:
call npm run daemon -- status

echo.
echo Installation finished. You can now send messages from WeChat.
pause
