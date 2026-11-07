/**
 * 关窗即驻留:非退出流程中一律隐藏到托盘,只有退出流程放行真关闭。
 */
export function shouldHideOnClose(quitting: boolean): boolean {
  return !quitting;
}

/** 托盘动作(主进程 → 渲染层 tray:action 下发;show/quit 主进程自理不下发) */
export type TrayAction =
  | { kind: 'open-session'; root: string; journalId: string }
  | { kind: 'new-chat' }
  | { kind: 'settings' }
  | { kind: 'shortcuts' };

export type TrayMenuItem =
  | { type: 'separator' }
  | { type: 'action'; label: string; action: TrayAction }
  | { type: 'show'; label: string; accelerator: string }
  | { type: 'quit'; label: string };

/** 托盘最近会话行(daemon /sessions?root= 行收敛;label 已按侧栏同口径回落) */
export interface TrayRecent {
  readonly journalId: string;
  readonly root: string;
  readonly label: string;
  readonly updatedAt: number;
}

/** 托盘最近会话条数(2026-11-07 用户裁定「最近 5 个,不够则不加」) */
export const TRAY_RECENT_LIMIT = 5;
/** 会话名截断字数:原生菜单宽随最长项,不截会被长首句撑满半屏 */
const TRAY_LABEL_MAX = 28;

/** 会话名单行化+截断(首句常含换行/连续空白);'&' 转义防 Windows 菜单把它吃成助记符下划线 */
export function trayLabel(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const cut = [...one].length > TRAY_LABEL_MAX ? `${[...one].slice(0, TRAY_LABEL_MAX).join('')}…` : one;
  return cut.replace(/&/g, '&&');
}

/** 最近活跃会话:跨工作区按 updatedAt 降序取前 limit 条(同 journal 去重) */
export function pickTrayRecents(rows: readonly TrayRecent[], limit = TRAY_RECENT_LIMIT): TrayRecent[] {
  const seen = new Set<string>();
  return [...rows]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((r) => (seen.has(r.journalId) ? false : (seen.add(r.journalId), true)))
    .slice(0, limit);
}

/** 外观语言（D33 纪律⑤ 收口）：locale 前缀 zh* → 'zh'，余者 'en' 兜底（app.getLocale() 产物形态
 *  如 zh-CN/zh_TW/en-US/de）。壳无 i18n 单点——托盘是唯一用户可见文案面，就地双语言表。 */
export type UiLang = 'en' | 'zh';

export function resolveUiLang(locale: string): UiLang {
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 设置语言解析（2026-10-23 用户裁定:托盘菜单跟随应用语言设置而非 OS locale）——
 *  settings.json language 键经 loadSettingsChain 装入 SUNSHINEX_LANGUAGE 槽,GUI 设置页
 *  改语言经 reloadSettingsChain 运行时刷新该槽;'zh*' → zh,'en*' → en,未设/异形值
 *  → undefined（调用方回落 resolveUiLang(app.getLocale())）。 */
export function resolveUiLangFromSetting(value: string | undefined): UiLang | undefined {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  return v.startsWith('zh') ? 'zh' : v.startsWith('en') ? 'en' : undefined;
}

const TRAY_LABELS: Record<UiLang, { newChat: string; settings: string; shortcuts: string; show: string; quit: string }> = {
  en: { newChat: 'New chat', settings: 'Settings', shortcuts: 'Keyboard shortcuts', show: 'Open Sunshinex', quit: 'Quit' },
  zh: { newChat: '新对话', settings: '设置', shortcuts: '快捷键', show: '打开 Sunshinex', quit: '退出' },
};

/** 唤主窗的全局快捷键(main.ts 注册同值;菜单项右侧显示,兼撑宽菜单) */
export const SHOW_ACCELERATOR = 'Alt+Shift+S';

/** 托盘菜单三组(2026-11-07 用户裁定,组间细线):①最近活跃会话(≤5,无则整组连同分隔线省略)
 *  ②新对话/设置/快捷键 ③打开 Sunshinex/退出。重复触发防护由壳侧 runQuit 幂等守卫承担。 */
export function trayMenu(lang: UiLang, recents: readonly TrayRecent[] = []): TrayMenuItem[] {
  const l = TRAY_LABELS[lang];
  const sessions: TrayMenuItem[] = recents.map((r) => ({
    type: 'action',
    label: trayLabel(r.label),
    action: { kind: 'open-session', root: r.root, journalId: r.journalId },
  }));
  return [
    ...(sessions.length > 0 ? [...sessions, { type: 'separator' } as const] : []),
    { type: 'action', label: l.newChat, action: { kind: 'new-chat' } },
    { type: 'action', label: l.settings, action: { kind: 'settings' } },
    { type: 'action', label: l.shortcuts, action: { kind: 'shortcuts' } },
    { type: 'separator' },
    { type: 'show', label: l.show, accelerator: SHOW_ACCELERATOR },
    { type: 'quit', label: l.quit },
  ];
}

/** 未命名会话回落名(侧栏同口径:title → 首句 → 「新会话」) */
export function untitledSession(lang: UiLang): string {
  return lang === 'zh' ? '新会话' : 'New session';
}

/** 退出序面:先关 daemon,后 app 退出(文档性常量,顺序由测试锁定)。 */
export const QUIT_STEPS = ['daemon-close', 'app-quit'] as const;
