@echo off
title Assist Writer (Web)
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "SERVER=target\release\assist-writer-server.exe"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 goto :error
)

rem Rebuild the UI and the server only when their code changed.
node scripts\needs-build.mjs out\renderer\index.html src\renderer src\shared vite.ui.config.ts
if errorlevel 1 (
  echo Building the editor...
  call npm run build:ui
  if errorlevel 1 goto :error
)
node scripts\needs-build.mjs "%SERVER%" crates
if errorlevel 1 (
  where cargo >nul 2>nul
  if errorlevel 1 (
    echo Rust is not installed, so the server can't be built. Install it from https://rustup.rs
    pause
    exit /b 1
  )
  echo Building the server. The first build takes a few minutes...
  cargo build --release -p assist-writer-server
  if errorlevel 1 goto :error
)

rem Open the browser once the server has had a moment to start.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5178"

"%SERVER%" --ui out\renderer
echo.
echo The Assist Writer server has stopped.
pause
exit /b 0

:error
echo.
echo Something went wrong. See the messages above.
pause
exit /b 1
