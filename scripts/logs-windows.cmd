@echo off
setlocal
cd /d "%~dp0.."
npm run daemon -- logs
echo.
pause
