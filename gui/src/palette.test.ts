import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentPalette, mixHex, palettesFor, PALETTES, readPalettePref, setPalettePref, syncPalette } from './palette';
import { applyTheme } from './theme';

describe('palette 配色主题', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    document.documentElement.dataset.theme = 'light';
  });

  it('亮暗各四套,id 唯一', () => {
    expect(palettesFor('light')).toHaveLength(4);
    expect(palettesFor('dark')).toHaveLength(4);
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(PALETTES.length);
  });

  it('缺省/非法偏好回落 default', () => {
    expect(readPalettePref('light')).toBe('light-default');
    localStorage.setItem('sunshinex.palette-dark', 'light-mist');
    expect(readPalettePref('dark')).toBe('dark-default');
  });

  it('亮暗偏好分记,生效配色随 data-theme;default 清空内联', () => {
    setPalettePref('light', 'light-mist');
    setPalettePref('dark', 'dark-nord');
    const root = document.documentElement;
    expect(root.dataset.palette).toBe('light-mist');
    expect(root.style.getPropertyValue('--accent')).toBe('#2b6be0');
    applyTheme('dark');
    expect(currentPalette().id).toBe('dark-nord');
    expect(root.style.getPropertyValue('--surface')).toBe('#181d27');
    setPalettePref('dark', 'dark-default');
    expect(root.style.getPropertyValue('--surface')).toBe('');
    expect(root.dataset.palette).toBe('dark-default');
    applyTheme('light');
    expect(root.dataset.palette).toBe('light-mist');
  });

  it('syncPalette 幂等', () => {
    setPalettePref('light', 'light-sage');
    syncPalette();
    syncPalette();
    expect(document.documentElement.style.getPropertyValue('--fg')).toBe('#1d261f');
  });

  it('default 两套与 app.css 双主题块同值(单源防漂移)', () => {
    const css = readFileSync(join(__dirname, 'app.css'), 'utf8');
    const lightStart = css.indexOf("[data-theme='light'] {");
    const blocks = { dark: css.slice(0, lightStart), light: css.slice(lightStart, css.indexOf('}', lightStart)) };
    // surfaceCode 退役单源锚(2026-11-13 用户裁定「亮色暗码关代码井随菜单灰」):light=var(--surface-under)
    // 别名不再持字面色值,单独断言;dark 仍随 palette 字面
    const vars: Record<string, string> = { surface: '--surface', surfaceUnder: '--surface-under', surfaceElevated: '--surface-elevated', surfaceSoft: '--surface-soft', fg: '--fg' };
    for (const mode of ['light', 'dark'] as const) {
      const p = PALETTES.find((x) => x.id === `${mode}-default`)!;
      for (const [k, name] of Object.entries(vars)) {
        const m = new RegExp(`${name}:\\s*(#[0-9a-f]{3,6})`, 'i').exec(blocks[mode]);
        const want = m![1]!.toLowerCase();
        const norm = want.length === 4 ? `#${[...want.slice(1)].map((c) => c + c).join('')}` : want;
        expect(p.tokens[k as keyof typeof p.tokens], `${mode} ${name}`).toBe(norm);
      }
    }
    expect(/--surface-code:\s*var\(--surface-under\)/.test(blocks.light)).toBe(true);
    expect((/--surface-code:\s*(#[0-9a-f]{3,6})/i.exec(blocks.dark))![1]!.toLowerCase()).toBe(PALETTES.find((x) => x.id === 'dark-default')!.tokens.surfaceCode.toLowerCase());
  });

  it('mixHex 线性混色', () => {
    expect(mixHex('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mixHex('#dfdfdf', '#101010', 0)).toBe('#101010');
  });
});
