@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0security-setup.ps1" %*
pause
