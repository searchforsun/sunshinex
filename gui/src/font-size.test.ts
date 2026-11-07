import { describe, it, expect, beforeEach } from 'vitest';
import { applyCodeFontSize, applyUiFontSize, readCodeFontSize, readUiFontSize } from './font-size';
import { applyFontPreset } from './font-preset';

describe('界面字号/代码字号(2026-11-07 外观两项)', () => {
  const root = document.documentElement.style;
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
  });

  it('缺省 14/12;非法存储值回落缺省', () => {
    expect(readUiFontSize()).toBe(14);
    expect(readCodeFontSize()).toBe(12);
    localStorage.setItem('sunshinex.ui-font-size', '99');
    expect(readUiFontSize()).toBe(14);
  });

  it('界面字号落 --f-base-size + --fz(文字缩放系数);回缺省清内联', () => {
    applyUiFontSize(16);
    expect(root.getPropertyValue('--f-base-size')).toBe('16px');
    expect(Number(root.getPropertyValue('--fz'))).toBeCloseTo(16 / 14);
    expect(readUiFontSize()).toBe(16);
    applyUiFontSize(14);
    expect(root.getPropertyValue('--f-base-size')).toBe('');
    expect(root.getPropertyValue('--fz')).toBe('');
  });

  it('代码字号落 --f-code;字体预设切换不覆盖字号(预设只管字族/行高)', () => {
    applyCodeFontSize(14);
    applyUiFontSize(15);
    applyFontPreset('serif');
    applyFontPreset('default');
    expect(root.getPropertyValue('--f-code')).toBe('14px');
    expect(root.getPropertyValue('--f-base-size')).toBe('15px');
  });
});
