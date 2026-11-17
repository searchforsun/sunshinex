import { beforeEach, describe, expect, it } from 'vitest';
import { applyDeveloperMode } from './developer-mode';
import { readUiMode } from './ui-mode';
import { readConciseMode } from './concise-mode';
import { readUsageStats } from './usage-stats';

/** 2026-11-17 用户裁定「非开发者模式下,肯定是办公模式/简洁模式,用量统计是关的,终端是关的」:
 *  四类模式派生偏好在普通态取固定有效值,存储值仅在开发者模式开启时生效(切回即恢复用户原选择) */
describe('非开发者模式派生默认', () => {
  beforeEach(() => {
    localStorage.clear();
    applyDeveloperMode(false);
  });

  it('普通态:办公模式 + 简洁开 + 用量统计关', () => {
    expect(readUiMode()).toBe('office');
    expect(readConciseMode()).toBe(true);
    expect(readUsageStats()).toBe(false);
  });

  it('开发者模式:恢复存储值', () => {
    localStorage.setItem('sunshinex.ui-mode', 'code');
    localStorage.setItem('sunshinex.concise-mode', '0');
    localStorage.setItem('sunshinex.usage-stats', '1');
    applyDeveloperMode(true);
    expect(readUiMode()).toBe('code');
    expect(readConciseMode()).toBe(false);
    expect(readUsageStats()).toBe(true);
  });

  it('普通态落根属性与有效值一致', () => {
    expect(document.documentElement.dataset.uiMode).toBe('office');
    applyDeveloperMode(true);
    expect(document.documentElement.dataset.uiMode).toBe('code');
    // 2026-11-17 缺省反转后:开发者模式缺省=简洁开/用量关(开关与行为一致)
    expect(document.documentElement.dataset.conciseMode).toBe('1');
    expect(document.documentElement.dataset.usageStats).toBe('0');
    applyDeveloperMode(false);
    expect(document.documentElement.dataset.conciseMode).toBe('1');
    expect(document.documentElement.dataset.usageStats).toBe('0');
  });
});
