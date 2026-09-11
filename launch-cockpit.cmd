@echo off
rem No delayed expansion: with it enabled, a repo path containing "!" is
rem corrupted when %~dp0 is expanded into the REPO_ROOT set statement.
setlocal

set "REPO_ROOT=%~dp0"
set "NO_PAUSE=0"

if /i "%~1"=="-NoPause" set "NO_PAUSE=1"
if defined CI set "NO_PAUSE=1"
if defined UGK_LAUNCHER_NO_PAUSE set "NO_PAUSE=1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%scripts\launch-cockpit.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

rem %cmdcmdline% is expanded inside quotes on purpose: bare, a launch path
rem containing "&" or "^" would split this line into unrelated commands. The
rem quoted echo keeps it a single literal argument for findstr.
set "PARENT_CMDLINE=%cmdcmdline%"

if %EXIT_CODE% neq 0 (
    echo.
    echo [ERROR] UGK Cockpit launcher failed with exit code %EXIT_CODE%.
    if "%NO_PAUSE%"=="0" (
        echo "%PARENT_CMDLINE%" | findstr /i /c:"%~nx0" >nul && (
            echo "%PARENT_CMDLINE%" | findstr /i /c:"/c" >nul && pause
        )
    )
) else (
    if "%NO_PAUSE%"=="0" (
        echo "%PARENT_CMDLINE%" | findstr /i /c:"%~nx0" >nul && (
            echo "%PARENT_CMDLINE%" | findstr /i /c:"/c" >nul && (
                echo.
                pause
            )
        )
    )
)

exit /b %EXIT_CODE%
