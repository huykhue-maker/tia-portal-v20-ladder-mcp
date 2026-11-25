@echo off
setlocal
set "LAD_NODE_EXE="
for /f "delims=" %%P in ('where node.exe 2^>nul') do if not defined LAD_NODE_EXE set "LAD_NODE_EXE=%%P"
if defined LAD_NODE_EXE goto run
rem Codex on Windows can supply Node.js even when it is not on PATH.
for /d %%D in ("%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.*__3k8sg7r9htsxt") do if exist "%%D\dependencies\node\bin\node.exe" set "LAD_NODE_EXE=%%D\dependencies\node\bin\node.exe"
if defined LAD_NODE_EXE goto run
echo Node.js was not found. Install Node.js and reopen this demo.
set "LAD_DEMO_STATUS=2"
goto finish
:run
"%LAD_NODE_EXE%" "%~dp0server\test-project.js" "%~dp0examples\inspection\suite.json"
set "LAD_DEMO_STATUS=%ERRORLEVEL%"
:finish
if /i not "%~1"=="--no-pause" pause
exit /b %LAD_DEMO_STATUS%
