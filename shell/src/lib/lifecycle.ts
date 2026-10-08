/**
 * 关窗即驻留:非退出流程中一律隐藏到托盘,只有退出流程放行真关闭。
 */
export function shouldHideOnClose(quitting: boolean): boolean {
  return !quitting;
}

export interface TrayMenuItem {
  id: 'show' | 'quit';
  label: string;
  enabled: boolean;
}

/**
 * 托盘菜单两件套:显示主窗 / 退出。
 * 收口中(quitting)label 原样、enabled 全 false,防退出流程中被重复触发。
 */
export function trayMenu(quitting: boolean): TrayMenuItem[] {
  return [
    { id: 'show', label: '显示 sunshinex', enabled: !quitting },
    { id: 'quit', label: '退出', enabled: !quitting },
  ];
}

/** 退出序面:先关 daemon,后 app 退出(文档性常量,顺序由测试锁定)。 */
export const QUIT_STEPS = ['daemon-close', 'app-quit'] as const;
