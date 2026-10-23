import { contextBridge, ipcRenderer } from 'electron';

/** 窗控桥(2026-10-23 用户裁定:−□× 自绘为应用按钮样式,撤原生 WCO 方块)——
 *  渲染层经 window.sunshinexWindow 调主进程窗控;maximized 态变化推送给渲染层换 □/restore 字形。 */
contextBridge.exposeInMainWorld('sunshinexWindow', {
  minimize: (): void => void ipcRenderer.send('win:minimize'),
  toggleMaximize: (): void => void ipcRenderer.send('win:toggle-maximize'),
  close: (): void => void ipcRenderer.send('win:close'),
  onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
    const handler = (_: unknown, v: boolean): void => cb(v);
    ipcRenderer.on('win:maximized', handler);
    return () => void ipcRenderer.removeListener('win:maximized', handler);
  },
});
