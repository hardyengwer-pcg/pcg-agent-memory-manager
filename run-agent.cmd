@echo off
cd /d "%~dp0"
echo [%date% %time%] start: %* >> agent-cron.log
npm run agent -- %* >> agent-cron.log 2>&1
echo [%date% %time%] ende: %* >> agent-cron.log