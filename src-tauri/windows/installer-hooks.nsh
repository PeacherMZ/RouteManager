${StrStr}
${UnStrStr}
${UnStrCase}
; Never close a running database writer. The user must exit the app first.
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq RouteManager.exe" /NH'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法检查程序是否运行，安装已中止。"
    Abort
  ${EndIf}
  ${StrCase} $1 $1 "L"
  ${StrStr} $2 $1 "routemanager.exe"
  ${If} $2 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先退出路由管理器，然后重新运行安装包。"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq RouteManager.exe" /NH'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法检查程序是否运行，卸载已中止。"
    Abort
  ${EndIf}
  ${UnStrCase} $1 $1 "L"
  ${UnStrStr} $2 $1 "routemanager.exe"
  ${If} $2 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先退出路由管理器，然后重新卸载。用户数据将被保留。"
    Abort
  ${EndIf}
!macroend
