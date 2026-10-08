/** 主题偏好(G9 Codex 1:1 spec §1.1):三态持久 localStorage['sunshinex.theme'];
 *  applyTheme 落 html[data-theme](CSS 双主题块的切换面);system 态经 matchMedia 求值。 */

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'sunshinex.theme';

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** system 态求值:matchMedia 缺失(jsdom/旧 WebView)按暗色缺省(与 index.html 引导同语义) */
function systemDark(): boolean {
  if (typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
}

/** pref=system 时跟随系统切换;返回解绑函数 */
export function watchSystemTheme(pref: ThemePref, onChange?: (pref: ThemePref) => void): () => void {
  if (pref !== 'system' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const fn = (): void => {
    applyTheme('system');
    onChange?.('system');
  };
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}
