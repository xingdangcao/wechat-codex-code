@echo off
setlocal
cd /d "%~dp0.."
npm run daemon -- start
echo.
pause
