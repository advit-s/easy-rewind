@echo off
title easy-rewind Backend Server

echo.
echo ╔══════════════════════════════════════════╗
echo ║     easy-rewind Learning Assistant       ║
echo ║        Starting Backend Server...         ║
echo ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0backend"

:: Check if node_modules exists
if not exist "node_modules" (
    echo [Setup] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Make sure Node.js is installed.
        pause
        exit /b 1
    )
)

echo [Server] Starting the Easy Rewind standalone backend...
echo [Server] Protected secret-store and restrictive file-permission adapters are required.
echo [Server] Press Ctrl+C to stop.
echo.

set "EASY_REWIND_STORAGE_ROOT=%LOCALAPPDATA%\EasyRewind\backend"
node server.js

if errorlevel 1 (
    echo.
    echo [ERROR] Server exited with code %errorlevel%
    echo Check the sanitized backend startup output above.
    pause
)
