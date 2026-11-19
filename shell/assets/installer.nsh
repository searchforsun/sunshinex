; 安装器完成页「运行 Sunshinex」启动方式覆写(2026-11-19 用户复测「点击完成时未响应」回归)。
;
; 根因:electron-builder 模板的 StartApp 走 StdUtils::ExecShellAsUser —— 该调用在安装器 UI
; 线程上等目标进程进入输入空闲(WaitForInputIdle),Electron 首启被 Defender 首次扫描 +
; daemon 装配拖慢的几秒里,安装器整窗无响应(用户看到「未响应」)。壳侧已经把 daemon 启动
; 分步让点(c8ded1cc),但冷机扫描时间不受应用控制,等待式启动仍是硬伤。
;
; 改法:交给已运行的 Explorer 代为启动——explorer.exe 属于登录会话的 shell 进程,Exec 立即
; 返回(不等待),应用仍以当前登录用户态拉起;安装器提权时也不会把管理员权限传给应用。
; 该宏会被 electron-builder 的 assistedInstaller.nsh 识别并替换默认完成页(含「运行」勾选)。
!macro customFinishPage
  Function StartApp
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
