@echo off
title Combo Maker
cd /d "%~dp0"

echo.
echo   Combo Maker
echo   Starting up...
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

node "tools\serve.mjs"
if errorlevel 1 goto failed
goto end

:nonode
echo   Node.js was not found on this computer.
echo.
echo   Combo Maker needs it to run. Install the LTS version from:
echo     https://nodejs.org
echo.
echo   Then double-click this file again.
echo.
echo   (If you already installed Node, close this window,
echo    open a new one, and try again.)
echo.
pause
goto end

:failed
echo.
echo   Combo Maker could not start. The message above says why.
echo.
pause

:end
