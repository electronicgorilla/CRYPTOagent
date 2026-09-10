@echo off
title CRYPTOagent - stop
cd /d "%~dp0"
echo   Stopping CRYPTOagent...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*run.mjs*' } | ForEach-Object { Write-Host ('  stopped pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
if exist "data\loop.lock" del /q "data\loop.lock"
echo   Done.
timeout /t 3 /nobreak >nul
