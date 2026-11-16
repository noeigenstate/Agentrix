@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if not defined AGENTRIX_SHIM_NODE set "AGENTRIX_SHIM_NODE=node"
"%AGENTRIX_SHIM_NODE%" "%~dp0intercept.cjs" claude -- %*
exit /b %errorlevel%
