import { beforeEach, describe, expect, it } from 'vitest';
import { applyDeveloperMode, readDeveloperMode } from './developer-mode';

describe('developer-mode 偏好', () => {
  beforeEach(() => {
    localStorage.clear();
    applyDeveloperMode(false);
  });

  it('缺省关闭(未设置即关)', () => {
    localStorage.clear();
    expect(readDeveloperMode()).toBe(false);
  });

  it('开启写 localStorage 与根 data 属性,关闭清除属性', () => {
    applyDeveloperMode(true);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('1');
    expect(document.documentElement.dataset.developerMode).toBe('1');
    applyDeveloperMode(false);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('0');
    expect(document.documentElement.dataset.developerMode).toBeUndefined();
  });
});
