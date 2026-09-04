@echo off
setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0"
set "NO_PAUSE=0"

if /i "%~1"=="-NoPause" set "NO_PAUSE=1"
if defined CI set "NO_PAUSE=1"
if defined UGK_LAUNCHER_NO_PAUSE set "NO_PAUSE=1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%scripts\launch-cockpit.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if %EXIT_CODE% neq 0 (
    echo.
    echo [ERROR] UGK Cockpit launcher failed with exit code %EXIT_CODE%.
    if "%NO_PAUSE%"=="0" (
        echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && (
            echo %cmdcmdline% | findstr /i /c:"/c" >nul && pause
        )
    )
) else (
    if "%NO_PAUSE%"=="0" (
        echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && (
            echo %cmdcmdline% | findstr /i /c:"/c" >nul && (
                echo.
                pause
            )
        )
    )
)

exit /b %EXIT_CODE%
