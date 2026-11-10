@echo off
rem Elyra VPR - router + control panel + landing on http://localhost:8545
cd /d "%~dp0"
start "Elyra VPR" /min node router/server.mjs
timeout /t 1 >nul
start "" http://localhost:8545/app/
