@echo off
rem Windows: checks Node, then runs the benchmark with your options.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is needed: https://nodejs.org & exit /b 1)
node bench.mjs %*
