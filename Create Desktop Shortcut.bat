@echo off
title Combo Maker - desktop shortcut
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Combo Maker.lnk')); $s.TargetPath = (Join-Path $PWD 'Combo Maker.bat'); $s.WorkingDirectory = $PWD; $s.IconLocation = 'imageres.dll,68'; $s.Description = 'Build product combo images locally'; $s.Save(); Write-Host ''; Write-Host '  Done - Combo Maker is now on your desktop.'"

echo.
pause
