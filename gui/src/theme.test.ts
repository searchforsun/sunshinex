import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTheme, readThemePref, watchSystemTheme } from './theme';

describe('theme 主题偏好', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = '';
  });

  it('缺省 system;非法存储值回落 system', () => {
    expect(readThemePref()).toBe('system');
    localStorage.setItem('sunshinex.theme', 'bogus');
    expect(readThemePref()).toBe('system');
  });

  it('applyTheme 落 html[data-theme] 并持久', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('sunshinex.theme')).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('system 态按 matchMedia 落属性(matchMedia 缺失回落暗色)', () => {
    const spy = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    window.matchMedia = spy as unknown as typeof window.matchMedia;
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    delete (window as { matchMedia?: unknown }).matchMedia;
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('watchSystemTheme:非 system 返回解绑即空;system 挂监听', () => {
    expect(watchSystemTheme('dark')).toBeTypeOf('function');
    const mq = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    window.matchMedia = vi.fn().mockReturnValue(mq) as unknown as typeof window.matchMedia;
    const off = watchSystemTheme('system');
    expect(mq.addEventListener).toHaveBeenCalled();
    off();
    expect(mq.removeEventListener).toHaveBeenCalled();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });
});
