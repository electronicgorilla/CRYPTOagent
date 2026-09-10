@echo off
title CRYPTOagent
cd /d "%~dp0"

echo.
echo   CRYPTOagent - starting
echo   ---------------------

REM The loop holds a lockfile; a stale one from a hard shutdown would block it.
if exist "data\loop.lock" (
  tasklist /fi "imagename eq node.exe" | find /i "node.exe" >nul || del /q "data\loop.lock"
)

REM Server first so the browser has something to attach to.
start "CRYPTOagent server" /min cmd /c "node run.mjs serve"
timeout /t 3 /nobreak >nul

REM Scan loop. Refuses to start if another already holds the lock, which is the
REM behaviour we want - concurrent loops corrupt the ledger.
start "CRYPTOagent loop" /min cmd /c "node run.mjs loop"
timeout /t 2 /nobreak >nul

start "" "http://127.0.0.1:8787"

echo   Terminal:  http://127.0.0.1:8787
echo   Server and loop are running minimised.
echo.
echo   Close this window to leave them running.
echo   Use STOP-CRYPTOagent.bat to shut everything down.
echo.
timeout /t 6 /nobreak >nul
