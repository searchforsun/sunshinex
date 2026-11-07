/**
 * 配色主题(2026-11-07 用户裁定「亮色四套 + 暗色四套,配色设置统一」):外观亮/暗之下的二级
 * 选择——亮色、暗色各记一份偏好(localStorage['sunshinex.palette-light'|'sunshinex.palette-dark']),
 * 生效配色 = 当前 data-theme 所对应那一份。
 *
 * 单源:本表是全部界面配色的唯一取值面——根节点 CSS 令牌(内联覆写 app.css 双主题块的基础色,
 * 派生令牌 --fg-secondary/--border 等经 color-mix(var(--fg)) 随之自动)、设置页剪影、Monaco/
 * xterm/Mermaid(画布面读不了 CSS 变量)共读此处。default 两套与 app.css :root/[data-theme=light]
 * 同值,切回 default 清空内联=样式表接管零漂移。
 *
 * 切换信号:applyPalette 落 html[data-palette](生效配色 id),watchThemeChange 同时观察
 * data-theme/data-palette,画布面无需另订阅。
 */

import { notifyUiPref } from './ui-pref-sync';

export type ThemeMode = 'light' | 'dark';

export interface PaletteTokens {
  /** 主面(对话区) */
  readonly surface: string;
  /** 底层(侧栏/页面底) */
  readonly surfaceUnder: string;
  /** 浮起面(卡片/输入框/弹层) */
  readonly surfaceElevated: string;
  readonly surfaceSoft: string;
  /** 代码井/终端底 */
  readonly surfaceCode: string;
  /** Monaco/Mermaid 画布底 */
  readonly editor: string;
  readonly fg: string;
  /** 实心按钮(底=fg)上的字色 */
  readonly fgOnSolid: string;
  /** 链接/焦点/信息色 */
  readonly accent: string;
}

export interface Palette {
  readonly id: string;
  readonly mode: ThemeMode;
  readonly name: { readonly en: string; readonly zh: string };
  readonly tokens: PaletteTokens;
}

export const PALETTES: readonly Palette[] = [
  {
    id: 'light-default',
    mode: 'light',
    name: { en: 'Default', zh: '默认' },
    tokens: { surface: '#f6f6f6', surfaceUnder: '#efefef', surfaceElevated: '#ffffff', surfaceSoft: '#ececec', surfaceCode: '#eeeeee', editor: '#fcfcfc', fg: '#1a1c1f', fgOnSolid: '#ffffff', accent: '#339cff' },
  },
  {
    id: 'light-mist',
    mode: 'light',
    name: { en: 'Mist', zh: '雾蓝' },
    tokens: { surface: '#f3f5f9', surfaceUnder: '#e9edf3', surfaceElevated: '#ffffff', surfaceSoft: '#e3e8f0', surfaceCode: '#e8ecf2', editor: '#f9fafc', fg: '#172033', fgOnSolid: '#ffffff', accent: '#2b6be0' },
  },
  {
    id: 'light-sage',
    mode: 'light',
    name: { en: 'Sage', zh: '鼠尾草' },
    tokens: { surface: '#f2f5f0', surfaceUnder: '#e7ece4', surfaceElevated: '#fbfcfa', surfaceSoft: '#e1e7dd', surfaceCode: '#e6ebe2', editor: '#f8faf6', fg: '#1d261f', fgOnSolid: '#ffffff', accent: '#3d8058' },
  },
  {
    id: 'light-solarized',
    mode: 'light',
    name: { en: 'Solarized', zh: '日晒' },
    tokens: { surface: '#f8f1dd', surfaceUnder: '#eee8d5', surfaceElevated: '#fdf6e3', surfaceSoft: '#e9e2cc', surfaceCode: '#eee8d5', editor: '#fdf6e3', fg: '#073642', fgOnSolid: '#fdf6e3', accent: '#268bd2' },
  },
  {
    id: 'dark-default',
    mode: 'dark',
    name: { en: 'Default', zh: '默认' },
    tokens: { surface: '#181818', surfaceUnder: '#131313', surfaceElevated: '#212121', surfaceSoft: '#303030', surfaceCode: '#101010', editor: '#101010', fg: '#dfdfdf', fgOnSolid: '#0d0d0d', accent: '#339cff' },
  },
  {
    id: 'dark-nord',
    mode: 'dark',
    name: { en: 'Nord', zh: '北境' },
    tokens: { surface: '#181d27', surfaceUnder: '#12161e', surfaceElevated: '#212836', surfaceSoft: '#2d3644', surfaceCode: '#10141b', editor: '#10141b', fg: '#dfe6f1', fgOnSolid: '#181d27', accent: '#88c0d0' },
  },
  {
    id: 'dark-mocha',
    mode: 'dark',
    name: { en: 'Mocha', zh: '摩卡' },
    tokens: { surface: '#181826', surfaceUnder: '#12121e', surfaceElevated: '#232336', surfaceSoft: '#2e2e44', surfaceCode: '#11111b', editor: '#11111b', fg: '#cdd6f4', fgOnSolid: '#181826', accent: '#cba6f7' },
  },
  {
    id: 'dark-gruvbox',
    mode: 'dark',
    name: { en: 'Gruvbox', zh: '暖棕' },
    tokens: { surface: '#201e1b', surfaceUnder: '#191714', surfaceElevated: '#2a2724', surfaceSoft: '#36322e', surfaceCode: '#14120f', editor: '#14120f', fg: '#e4dcc0', fgOnSolid: '#201e1b', accent: '#fabd2f' },
  },
];

const DEFAULT_ID: Record<ThemeMode, string> = { light: 'light-default', dark: 'dark-default' };
const KEYS: Record<ThemeMode, string> = { light: 'sunshinex.palette-light', dark: 'sunshinex.palette-dark' };
const SYNC_KEYS = { light: 'paletteLight', dark: 'paletteDark' } as const;

/** 令牌 → CSS 变量名(app.css 双主题块的基础色;派生令牌不列,经 color-mix 自动跟随) */
const CSS_VARS: ReadonlyArray<[keyof PaletteTokens, string]> = [
  ['surface', '--surface'],
  ['surfaceUnder', '--surface-under'],
  ['surfaceElevated', '--surface-elevated'],
  ['surfaceSoft', '--surface-soft'],
  ['surfaceCode', '--surface-code'],
  ['fg', '--fg'],
  ['fgOnSolid', '--fg-on-solid'],
  ['accent', '--accent'],
];

export function palettesFor(mode: ThemeMode): readonly Palette[] {
  return PALETTES.filter((p) => p.mode === mode);
}

function byId(mode: ThemeMode, id: string | null): Palette {
  return PALETTES.find((p) => p.mode === mode && p.id === id) ?? PALETTES.find((p) => p.id === DEFAULT_ID[mode])!;
}

/** 该模式下的偏好配色 id(非法/缺失回落 default) */
export function readPalettePref(mode: ThemeMode): string {
  try {
    return byId(mode, localStorage.getItem(KEYS[mode])).id;
  } catch {
    return DEFAULT_ID[mode];
  }
}

function modeNow(): ThemeMode {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** 当前生效配色(data-theme 对应模式的偏好) */
export function currentPalette(): Palette {
  const mode = modeNow();
  return byId(mode, readPalettePref(mode));
}

/** 按当前 data-theme 落生效配色(applyTheme 每次切换模式后调用;default 清空内联回落样式表) */
export function syncPalette(): void {
  const p = currentPalette();
  const root = document.documentElement;
  const isDefault = p.id === DEFAULT_ID[p.mode];
  for (const [k, name] of CSS_VARS) {
    if (isDefault) root.style.removeProperty(name);
    else root.style.setProperty(name, p.tokens[k]);
  }
  root.dataset.palette = p.id;
}

/** 设置某模式的配色偏好;该模式正生效时即刻落根 */
export function setPalettePref(mode: ThemeMode, id: string): void {
  const p = byId(mode, id);
  notifyUiPref(SYNC_KEYS[mode], p.id);
  try {
    localStorage.setItem(KEYS[mode], p.id);
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  syncPalette();
}

/** 色值混合(画布面派生色:mix(a, b, t) = a×t + b×(1−t),#rrggbb) */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number => Math.round(((pa >> shift) & 255) * t + ((pb >> shift) & 255) * (1 - t));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}
