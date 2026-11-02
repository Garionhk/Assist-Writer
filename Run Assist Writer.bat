@echo off
title Assist Writer
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "APP=target\release\assist-writer.exe"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\@tauri-apps\cli" (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 goto :error
)

rem Rebuild only when the code changed since the last build.
node scripts\needs-build.mjs "%APP%" src src-tauri crates vite.ui.config.ts
if errorlevel 1 (
  where cargo >nul 2>nul
  if errorlevel 1 (
    echo Rust is not installed, so Assist Writer can't be built. Install it from https://rustup.rs
    pause
    exit /b 1
  )
  echo Building Assist Writer. The first build takes a few minutes, later ones are quicker...
  call npx tauri build --no-bundle
  if errorlevel 1 goto :error
)

start "" "%APP%"
exit /b 0

:error
echo.
echo Something went wrong. See the messages above.
pause
exit /b 1
