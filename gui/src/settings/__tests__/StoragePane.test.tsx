import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoragePane } from '../StoragePane';
import type { StoragePaneConn } from '../StoragePane';
import type { CacheStatusResp, SettingsKeyRow, SettingsView } from '../../connection-types';

/**
 * 存储面板桩测(2026-11-21):conn 全桩(不出网)——①保留天数行渲染/写回(global 桶);
 * ②缓存分类行渲染(safe 图标钮/引用型文字钮);③safe 行单独清;④引用型行内二次确认
 * (首点确认态,再点执行);⑤主按钮一键清(safe 档+壳桥 clearHttpCache)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

const keyRow = (key: string, over: Partial<SettingsKeyRow> = {}): SettingsKeyRow => ({ key, value: null, source: 'global', envOverride: false, ...over });

const viewOf = (keys: SettingsKeyRow[]): SettingsView => ({
  keys,
  permissions: {
    merged: { deny: [], allow: [], additionalDirs: [] },
    project: { deny: [], allow: [], additionalDirs: [] },
    global: { deny: [], allow: [], additionalDirs: [] },
  },
  providers: { choices: [], apiKeyPresent: {}, warnings: [] },
});

const cacheOf = (): CacheStatusResp => ({
  total: 14,
  categories: [
    { id: 'pty-replay', safe: true, size: 5, files: 1 },
    { id: 'images-cache', safe: false, size: 9, files: 1 },
  ],
  retention: { days: 30, lastRunAt: Date.now() - 120_000, lastPurged: 3, lastFailed: 0 },
});

interface ConnSpy {
  conn: StoragePaneConn;
  putSettings: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
}

const connOf = (view: SettingsView, cache: CacheStatusResp): ConnSpy => {
  const putSettings = vi.fn(() => Promise.resolve());
  const clearCache = vi.fn(() => Promise.resolve({ cleared: [], failed: [] }));
  return {
    conn: {
      settings: () => Promise.resolve(view),
      putSettings,
      cacheStatus: () => Promise.resolve(cache),
      clearCache,
    },
    putSettings,
    clearCache,
  };
};

const renderPane = (spy: ConnSpy): void => {
  render(<StoragePane conn={spy.conn} root="/w/proj" />);
};

describe('StoragePane(存储页)', () => {
  it('保留天数行/上次自动清理/缓存分类行渲染', async () => {
    const spy = connOf(viewOf([keyRow('archiveRetentionDays', { value: '30' })]), cacheOf());
    renderPane(spy);
    expect(await screen.findByLabelText('archiveRetentionDays')).toHaveProperty('value', '30');
    expect(screen.getByText('Last auto-clean')).toBeDefined();
    expect(screen.getByText('Total cache size')).toBeDefined();
    expect(screen.getByText('Terminal replay buffers')).toBeDefined();
    expect(screen.getByText('Image attachment originals')).toBeDefined();
    expect(screen.getAllByText('5 B').length).toBeGreaterThan(0);
    expect(screen.getAllByText('9 B').length).toBeGreaterThan(0);
    expect(screen.getByText('14 B')).toBeDefined();
  });

  it('保留天数失焦写回 global 桶(数字化);清空=删键(null)', async () => {
    const spy = connOf(viewOf([keyRow('archiveRetentionDays', { value: '30' })]), cacheOf());
    renderPane(spy);
    const input = await screen.findByLabelText('archiveRetentionDays');
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.blur(input);
    await waitFor(() => expect(spy.putSettings).toHaveBeenCalledWith('global', undefined, { archiveRetentionDays: 45 }));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(spy.putSettings).toHaveBeenCalledWith('global', undefined, { archiveRetentionDays: null }));
  });

  it('safe 行单独清:图标钮点击 → clearCache([id])', async () => {
    const spy = connOf(viewOf([keyRow('archiveRetentionDays', { value: '30' })]), cacheOf());
    renderPane(spy);
    await screen.findByText('Terminal replay buffers');
    fireEvent.click(screen.getByLabelText('clear pty-replay'));
    await waitFor(() => expect(spy.clearCache).toHaveBeenCalledWith(['pty-replay']));
  });

  it('引用型行内二次确认:首点确认态(不执行),再点执行', async () => {
    const spy = connOf(viewOf([keyRow('archiveRetentionDays', { value: '30' })]), cacheOf());
    renderPane(spy);
    await screen.findByText('Image attachment originals');
    const btn = screen.getByRole('button', { name: 'Clear' });
    fireEvent.click(btn);
    expect(screen.getByText('Confirm clear?')).toBeDefined();
    expect(spy.clearCache).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm clear?'));
    await waitFor(() => expect(spy.clearCache).toHaveBeenCalledWith(['images-cache']));
  });

  it('主按钮一键清:safe 档(无参)+壳桥 clearHttpCache 并行', async () => {
    const httpCache = vi.fn(() => Promise.resolve({ ok: true, partitions: 2 }));
    (window as unknown as { sunshinexWindow?: unknown }).sunshinexWindow = { clearHttpCache: httpCache };
    try {
      const spy = connOf(viewOf([keyRow('archiveRetentionDays', { value: '30' })]), cacheOf());
      renderPane(spy);
      const btns = screen.getAllByRole('button', { name: 'Clear cache' });
      fireEvent.click(btns[0]!);
      await waitFor(() => expect(spy.clearCache).toHaveBeenCalledWith(undefined));
      expect(httpCache).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { sunshinexWindow?: unknown }).sunshinexWindow;
    }
  });

  it('壳桥缺席:浏览器 HTTP 缓存行不渲染,主按钮照常出网', async () => {
    const spy = connOf(viewOf([keyRow('archiveRetentionDays', { value: '30' })]), cacheOf());
    renderPane(spy);
    await screen.findByText('Terminal replay buffers');
    expect(screen.queryByText('Browser HTTP cache')).toBeNull();
  });
});

beforeEach(() => {
  delete (window as unknown as { sunshinexWindow?: unknown }).sunshinexWindow;
});
afterEach(() => {
  delete (window as unknown as { sunshinexWindow?: unknown }).sunshinexWindow;
});
