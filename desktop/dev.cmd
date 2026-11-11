@echo off
rem Double-click or run from a terminal: starts the local server and the desktop app.
rem Options: -Web  -Prod  -Release  -Check   (see dev.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
