@echo off
setlocal
cd /d "%~dp0.."
echo WeChat Codex Code - setup
echo.
echo This will open a QR code image. Scan it with WeChat to bind the account.
echo.
npm run setup
echo.
pause
