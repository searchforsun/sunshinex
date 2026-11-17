import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyChangeCards, readChangeCards } from './change-cards';
import { applyDeveloperMode } from './developer-mode';

/** 2026-11-17 用户裁定「产物卡下面显示一个改动卡,普通模式下不显示,开发者模式默认是打开的,显示 diff 卡条」:
 *  普通态恒关(行亦不渲染);开发者模式按存储值、缺省开 */
describe('改动卡偏好', () => {
  beforeEach(() => {
    localStorage.clear();
    applyDeveloperMode(false);
  });
  afterEach(() => applyDeveloperMode(false));

  it('普通态恒关(即使存储为开)', () => {
    applyChangeCards(true);
    expect(readChangeCards()).toBe(false);
  });

  it('开发者模式缺省开,可关', () => {
    applyDeveloperMode(true);
    expect(readChangeCards()).toBe(true);
    applyChangeCards(false);
    expect(readChangeCards()).toBe(false);
    applyChangeCards(true);
    expect(readChangeCards()).toBe(true);
  });

  it('开发者模式切回普通态即恒关', () => {
    applyDeveloperMode(true);
    applyChangeCards(true);
    applyDeveloperMode(false);
    expect(readChangeCards()).toBe(false);
  });
});
