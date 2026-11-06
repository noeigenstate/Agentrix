@echo off
rem Command Prompt terminals: UTF-8 text, the refreshed PATH, codex and claude through the same wrappers as
rem PowerShell (agent.ps1), and a prompt that tells Agentrix where it is. The prompt prints an invisible
rem OSC marker, ESC ] 6973;Agentrix;prompt;<directory> ESC \ , before the usual "C:\path>".
chcp 65001 >nul
for /f "usebackq delims=" %%P in (`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0print-path.ps1"`) do set "PATH=%%P"
doskey codex=powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent.ps1" codex $*
doskey claude=powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent.ps1" claude $*
echo   AGENTRIX
echo   Type codex or claude to start, or codex resume --last to continue.
echo.
prompt $E]6973;Agentrix;prompt;$P$E\$P$G
