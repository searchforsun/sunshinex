import { contextBridge, ipcRenderer } from 'electron';

/** 窗控桥(2026-10-23 用户裁定:−□× 自绘为应用按钮样式,撤原生 WCO 方块)——
 *  渲染层经 window.sunshinexWindow 调主进程窗控;maximized 态变化推送给渲染层换 □/restore 字形。
 *  openExternal(2026-10-25):Web 标签「在系统浏览器打开」走 shell.openExternal——由 OS 默认
 *  浏览器承接(用户配置的 Chrome);window.open 在 Electron 里只会开自家子窗,不是系统浏览器。 */
contextBridge.exposeInMainWorld('sunshinexWindow', {
  minimize: (): void => void ipcRenderer.send('win:minimize'),
  toggleMaximize: (): void => void ipcRenderer.send('win:toggle-maximize'),
  close: (): void => void ipcRenderer.send('win:close'),
  openExternal: (url: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('shell:open-external', url),
  onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
    const handler = (_: unknown, v: boolean): void => cb(v);
    ipcRenderer.on('win:maximized', handler);
    return () => void ipcRenderer.removeListener('win:maximized', handler);
  },
});
