!include "LogicLib.nsh"

!macro customInit
  ; The outer installer already checked the initiating user before an all-users relaunch.
  ${If} ${UAC_IsInnerInstance}
  ${OrIf} ${Silent}
  ${OrIf} ${isUpdated}
    Goto agentrixCodexSetupDone
  ${EndIf}
  Push $0
  Push $1
  Push $OUTDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ClearErrors
  File "${BUILD_RESOURCES_DIR}\codex-sandbox-setup.ps1"
  ${If} ${Errors}
    Goto agentrixCodexSetupRestore
  ${EndIf}

  StrCpy $1 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$1"
    StrCpy $1 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::Exec '"$1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\codex-sandbox-setup.ps1"'
  Pop $0
  ${If} $0 == "10"
    MessageBox MB_OKCANCEL|MB_ICONQUESTION \
      "Agentrix 的 Codex 角色需要管理员批准，才能完成一次性的 Windows 沙箱设置。$\r$\n$\r$\nAgentrix Codex roles need administrator approval for one-time Windows sandbox setup." \
      IDCANCEL agentrixCodexSetupFailed
    nsExec::Exec '"$1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\codex-sandbox-setup.ps1" -Provision'
    Pop $0
    ${If} $0 != "0"
      Goto agentrixCodexSetupFailed
    ${EndIf}
  ${EndIf}

agentrixCodexSetupRestore:
  Pop $0
  SetOutPath "$0"
  Pop $1
  Pop $0
  Goto agentrixCodexSetupDone

agentrixCodexSetupFailed:
  MessageBox MB_OK|MB_ICONSTOP "未完成 Windows 沙箱设置，无法继续安装。 / Installation cannot continue without Windows sandbox setup."
  SetErrorLevel 1
  Abort
agentrixCodexSetupDone:
!macroend
