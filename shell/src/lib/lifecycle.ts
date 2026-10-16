/**
 * 关窗即驻留:非退出流程中一律隐藏到托盘,只有退出流程放行真关闭。
 */
export function shouldHideOnClose(quitting: boolean): boolean {
  return !quitting;
}

interface TrayMenuItem {
  id: 'show' | 'quit';
  label: string;
  enabled: boolean;
}

/**
 * 托盘菜单两件套:显示主窗 / 退出。
 * 收口中(quitting)label 原样、enabled 全 false,防退出流程中被重复触发。
 */
/** 外观语言（D33 纪律⑤ 收口）：locale 前缀 zh* → 'zh'，余者 'en' 兜底（app.getLocale() 产物形态
 *  如 zh-CN/zh_TW/en-US/de）。壳无 i18n 单点——托盘是唯一用户可见文案面，就地双语言表。 */
export type UiLang = 'en' | 'zh';

export function resolveUiLang(locale: string): UiLang {
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const TRAY_LABELS: Record<UiLang, { show: string; quit: string }> = {
  en: { show: 'Show sunshinex', quit: 'Quit' },
  zh: { show: '显示 sunshinex', quit: '退出' },
};

export function trayMenu(quitting: boolean, lang: UiLang): TrayMenuItem[] {
  const labels = TRAY_LABELS[lang];
  return [
    { id: 'show', label: labels.show, enabled: !quitting },
    { id: 'quit', label: labels.quit, enabled: !quitting },
  ];
}

/** 退出序面:先关 daemon,后 app 退出(文档性常量,顺序由测试锁定)。 */
export const QUIT_STEPS = ['daemon-close', 'app-quit'] as const;
