import { contextBridge, ipcRenderer } from 'electron';

/** 窗控桥(2026-10-23 用户裁定:−□× 自绘为应用按钮样式,撤原生 WCO 方块)——
 *  渲染层经 window.sunshinexWindow 调主进程窗控;maximized 态变化推送给渲染层换 □/restore 字形。
 *  openExternal(2026-10-25):Web 标签「在系统浏览器打开」走 shell.openExternal——由 OS 默认
 *  浏览器承接(用户配置的 Chrome);window.open 在 Electron 里只会开自家子窗,不是系统浏览器。 */
contextBridge.exposeInMainWorld('sunshinexWindow', {
  minimize: (): void => void ipcRenderer.send('win:minimize'),
  toggleMaximize: (): void => void ipcRenderer.send('win:toggle-maximize'),
  close: (): void => void ipcRenderer.send('win:close'),
  // 通知点击唤起主窗(渲染层 window.focus() 拉不回 hide/最小化窗,走主进程 show+focus)
  focusMain: (): void => void ipcRenderer.send('win:focus-main'),
  /** 抽屉程序化拖窗(2026-10-29):抽屉头 mousedown 发 drag-start(主进程跟随光标循环),
   *  渲染层全局 mouseup 发 drag-end 停表——绕开 app-region 位图(fixed 抽屉下吞按钮/拖区) */
  dragStart: (): void => void ipcRenderer.send('win:drag-start'),
  dragEnd: (): void => void ipcRenderer.send('win:drag-end'),
  openExternal: (url: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('shell:open-external', url),
  /** 内置浏览器调试(2026-10-31 用户裁定「⋯菜单→打开调试工具」):主窗 detach 独立 DevTools 窗,
   *  检查器帧选择器可定位 WebTab iframe;已开再点=关闭(toggle) */
  openDevtools: (): void => void ipcRenderer.send('web:open-devtools'),
  /** M2 融合:guest 弹窗 URL 由主进程转发(main setWindowOpenHandler → builtin:open-url),
   *  GUI 开新侧栏 web 页签(和浏览器一样;退订返回卸载用) */
  onOpenUrl: (cb: (url: string) => void): (() => void) => {
    const handler = (_: unknown, url: string): void => cb(url);
    ipcRenderer.on('builtin:open-url', handler);
    return () => void ipcRenderer.removeListener('builtin:open-url', handler);
  },
  /** 模型关页(facade closeTarget):主进程按 CDP target 解出 guest webContents id 下发,持有该 webview
   *  的侧栏页签自行关闭 */
  onCloseWebContents: (cb: (webContentsId: number) => void): (() => void) => {
    const handler = (_: unknown, id: number): void => cb(id);
    ipcRenderer.on('builtin:close-webcontents', handler);
    return () => void ipcRenderer.removeListener('builtin:close-webcontents', handler);
  },
  /** 模型文本输入前后(facade Input.insertText):聚焦对应 webview,应答后归还焦点 */
  onFocusWebContents: (cb: (webContentsId: number, phase: 'begin' | 'end') => void): (() => void) => {
    const handler = (_: unknown, id: number, phase: 'begin' | 'end'): void => cb(id, phase);
    ipcRenderer.on('builtin:focus-webcontents', handler);
    return () => void ipcRenderer.removeListener('builtin:focus-webcontents', handler);
  },
  onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
    const handler = (_: unknown, v: boolean): void => cb(v);
    ipcRenderer.on('win:maximized', handler);
    return () => void ipcRenderer.removeListener('win:maximized', handler);
  },
});

/** 桌面壳桥二（2026-10-27 创建新项目慢修复）：window.sunshinex.pickFolder——GUI 契约（env.d.ts）
 *  早已声明、两处创建入口（欢迎页/侧栏）本就优先消费，壳侧此前缺席 ⇒ 装机面恒走浏览器态兜底
 *  （showDirectoryPicker 句柄无路径 → 标记文件 + 全盘 BFS 定位，同步 readdir 阻塞 daemon 主线程，
 *  实测深目录 3.7s+，整段创建「卡住」即此）。原生对话框直接回绝对路径，零扫描。 */
contextBridge.exposeInMainWorld('sunshinex', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('shell:pick-folder'),
});
