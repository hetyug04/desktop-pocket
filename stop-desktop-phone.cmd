@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop-pocket.ps1" stop
if errorlevel 1 pause
