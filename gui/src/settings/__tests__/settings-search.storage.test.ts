import { describe, expect, it } from 'vitest';
import { SETTINGS_SEARCH_ITEMS } from '../settings-search';

/**
 * 设置搜索索引·存储页条目(2026-11-21):面板级 + 自绘行两条(保留天数/缓存)——
 * 搜「存储/清理缓存/归档保留」直达对应行锚(data-setting-key)。
 */

describe('SETTINGS_SEARCH_ITEMS 存储页条目', () => {
  it('面板级 pane:storage 在场(SETTINGS_GROUPS 同源)', () => {
    const pane = SETTINGS_SEARCH_ITEMS.find((i) => i.id === 'pane:storage');
    expect(pane).toBeDefined();
    expect(pane!.pane).toBe('storage');
    expect(pane!.label).toEqual({ en: 'Storage', zh: '存储' });
  });

  it('自绘行两条:保留天数(KEY_DESCRIPTIONS 同文)+缓存清理(行锚正确)', () => {
    const rd = SETTINGS_SEARCH_ITEMS.find((i) => i.id === 'row:storage:archiveRetentionDays');
    expect(rd).toBeDefined();
    expect(rd!.pane).toBe('storage');
    expect(rd!.row).toBe('archiveRetentionDays');
    expect(rd!.label).toEqual({ en: 'Archive retention', zh: '归档保留天数' });
    const cache = SETTINGS_SEARCH_ITEMS.find((i) => i.id === 'row:storage:cache');
    expect(cache).toBeDefined();
    expect(cache!.row).toBe('cache');
    expect(cache!.label).toEqual({ en: 'Clear cache', zh: '清理缓存' });
  });
});
