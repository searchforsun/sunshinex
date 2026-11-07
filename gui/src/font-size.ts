/**
 * 界面字号 / 代码字号(2026-11-07 用户裁定,外观设置两项;对标 Codex「UI font size / Code font size」):
 * - 界面字号(缺省 14px):落根 --f-base-size(body 基础)与 --fz(=字号/14,全部固定 px 文字尺寸的
 *   缩放系数——app.css 文字尺寸统一写作 calc(Npx * var(--fz)))。只缩文字,图标/布局 px 不动。
 * - 代码字号(缺省 12px):落根 --f-code——代码块、文件预览(Monaco)、差异视图、终端同源读取。
 * 缺省值清内联,回落 app.css :root。字体预设只管字族/行高/段距,字号由本模块独占。
 * 持久与主题/缩放同通路:localStorage 即时层 + /app/gui-state 公共档双写(ui-pref-sync)。
 */
import { notifyUiPref } from './ui-pref-sync';

export const UI_FONT_DEFAULT = 14;
export const CODE_FONT_DEFAULT = 12;
export const UI_FONT_CHOICES: readonly number[] = [12, 13, 14, 15, 16, 17, 18, 20];
export const CODE_FONT_CHOICES: readonly number[] = [10, 11, 12, 13, 14, 15, 16, 18];

const UI_KEY = 'sunshinex.ui-font-size';
const CODE_KEY = 'sunshinex.code-font-size';

function read(key: string, choices: readonly number[], dflt: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return choices.includes(n) ? n : dflt;
  } catch {
    return dflt;
  }
}

function persist(key: string, n: number): void {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
}

/** 非 CSS 消费方(xterm/Monaco/Mermaid)热更信号:与字体预设同一事件,取值面自行重读 */
function notifyCanvas(): void {
  window.dispatchEvent(new CustomEvent('sunshinex:font-preset'));
}

export const readUiFontSize = (): number => read(UI_KEY, UI_FONT_CHOICES, UI_FONT_DEFAULT);
export const readCodeFontSize = (): number => read(CODE_KEY, CODE_FONT_CHOICES, CODE_FONT_DEFAULT);

export function applyUiFontSize(n: number): void {
  const root = document.documentElement.style;
  if (n === UI_FONT_DEFAULT) {
    root.removeProperty('--f-base-size');
    root.removeProperty('--fz');
  } else {
    root.setProperty('--f-base-size', `${n}px`);
    root.setProperty('--fz', String(n / UI_FONT_DEFAULT));
  }
  persist(UI_KEY, n);
  notifyUiPref('uiFontSize', String(n));
  notifyCanvas();
}

export function applyCodeFontSize(n: number): void {
  const root = document.documentElement.style;
  if (n === CODE_FONT_DEFAULT) root.removeProperty('--f-code');
  else root.setProperty('--f-code', `${n}px`);
  persist(CODE_KEY, n);
  notifyUiPref('codeFontSize', String(n));
  notifyCanvas();
}
