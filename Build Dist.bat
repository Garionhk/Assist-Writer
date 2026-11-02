@echo off
title Build Assist Writer (dist)
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem Builds the files to share into the dist folder:
rem   AssistWriter-Setup-<version>.exe     installer
rem   AssistWriter-Portable-<version>.exe  runs without installing
rem   AssistWriter-Web-<version> + .zip    the web version

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install it from https://nodejs.org
  goto :fail
)
where cargo >nul 2>nul
if errorlevel 1 (
  echo Rust is not installed. Install it from https://rustup.rs
  goto :fail
)

rem The portable app can't be replaced while it is running from dist.
tasklist /FI "IMAGENAME eq AssistWriter-Portable*" 2>nul | find /I "AssistWriter-Portable" >nul
if not errorlevel 1 (
  echo The portable Assist Writer is open. Save your work and close it, then press a key to continue.
  pause >nul
  tasklist /FI "IMAGENAME eq AssistWriter-Portable*" 2>nul | find /I "AssistWriter-Portable" >nul
  if not errorlevel 1 (
    echo It is still open, so dist can't be updated.
    goto :fail
  )
)

if not exist "node_modules\@tauri-apps\cli" (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 goto :error
)

echo.
echo [1/3] Checking the code...
call npm run typecheck
if errorlevel 1 goto :error

echo.
echo [2/3] Running the tests...
call npm test
if errorlevel 1 goto :error

echo.
echo [3/3] Building the installer, portable app and web version. This takes a few minutes...
call npm run dist
if errorlevel 1 goto :error

echo.
echo Done. The files are in the dist folder.
start "" explorer "%~dp0dist"
pause
exit /b 0

:error
echo.
echo Something went wrong. See the messages above.
:fail
pause
exit /b 1
