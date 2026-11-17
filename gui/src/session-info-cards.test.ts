import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySessionInfoCards, readSessionInfoCards } from './session-info-cards';
import { applyDeveloperMode } from './developer-mode';

/** 2026-11-17 用户裁定「会话信息卡,也在普通模式下不显示,开发者默认开,同样放到 diff 下」:
 *  普通态恒关(行亦不渲染);开发者模式按存储值、缺省开 */
describe('会话信息卡偏好', () => {
  beforeEach(() => {
    localStorage.clear();
    applyDeveloperMode(false);
  });
  afterEach(() => applyDeveloperMode(false));

  it('普通态恒关(即使存储为开)', () => {
    applySessionInfoCards(true);
    expect(readSessionInfoCards()).toBe(false);
  });

  it('开发者模式缺省开,可关可再开', () => {
    applyDeveloperMode(true);
    expect(readSessionInfoCards()).toBe(true);
    applySessionInfoCards(false);
    expect(readSessionInfoCards()).toBe(false);
    applySessionInfoCards(true);
    expect(readSessionInfoCards()).toBe(true);
  });

  it('切回普通态即恒关', () => {
    applyDeveloperMode(true);
    applySessionInfoCards(true);
    applyDeveloperMode(false);
    expect(readSessionInfoCards()).toBe(false);
  });
});
