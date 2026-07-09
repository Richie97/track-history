@echo off
rem Dev-server wrapper: ensures Node is on PATH regardless of how this is spawned.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
call npx wrangler dev --port 8787
