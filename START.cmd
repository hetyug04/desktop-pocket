@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop-pocket.ps1" start
if errorlevel 1 pause
