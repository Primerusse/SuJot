@echo off
rem ============================================================
rem  SuJot  -  Windows launcher.  Just double-click this file.
rem
rem  IMPORTANT: this file is deliberately ASCII-only.  cmd.exe
rem  parses .cmd files in the OEM codepage (936 on Chinese
rem  Windows), so any non-ASCII text in here gets mis-decoded and
rem  echo lines end up being executed as commands.  Every Chinese
rem  message is printed by server.py, which handles UTF-8 properly.
rem
rem  Line endings must stay CRLF - see .gitattributes.
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title SuJot

echo.
echo   ------------------------------------------------------------
echo    SuJot  ^|  a private notebook that runs on your own machine
echo   ------------------------------------------------------------
echo.

rem ---------- 1. find a Python that can actually run ----------
rem  Do NOT use "where python" here: the Microsoft Store ships a
rem  stub python.exe that "where" finds but cannot execute.
set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY ( python -c "import sys" >nul 2>nul && set "PY=python" )
if not defined PY ( python3 -c "import sys" >nul 2>nul && set "PY=python3" )

if not defined PY (
  echo   ------------------------------------------------------------
  echo    Python 3.8 or newer was not found on this computer.
  echo.
  echo      download   https://www.python.org/downloads/windows/
  echo      important  tick "Add python.exe to PATH" while installing
  echo      then       close this window and double-click start_run_locally.cmd
  echo   ------------------------------------------------------------
  start "" "https://www.python.org/downloads/windows/"
  if exist "%~dp0docs\no-python.txt" type "%~dp0docs\no-python.txt"
  goto :hold
)

rem ---------- 2. version must be 3.8+ ----------
%PY% -c "import sys; raise SystemExit(0 if sys.version_info>=(3,8) else 1)" >nul 2>nul
if errorlevel 1 (
  echo   ------------------------------------------------------------
  echo    Python 3.8 or newer is required.  This is what I found:
  echo.
  %PY% -V
  echo   ------------------------------------------------------------
  goto :hold
)

rem ---------- 3. start the server ----------
set "SUJIAN_BASE=%~dp0data"
if not defined SUJIAN_PORT set "SUJIAN_PORT=8013"

%PY% -X utf8 server.py
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   ------------------------------------------------------------
  echo    SuJot exited with code %RC%.
  echo.
  echo    To see the full error, open a cmd window and run:
  echo        cd /d "%~dp0"
  echo        %PY% server.py
  echo   ------------------------------------------------------------
) else (
  echo   SuJot stopped.
)

:hold
echo.
echo   Press any key to close this window . . .
pause >nul
endlocal
exit /b
