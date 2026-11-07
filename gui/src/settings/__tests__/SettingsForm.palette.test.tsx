import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsForm, SETTINGS_PANES } from '../SettingsForm';
import type { SettingsFormConn } from '../SettingsForm';
import type { SettingsView } from '../../connection';
import { applyTheme } from '../../theme';

/**
 * 配色主题行桩测:位于界面放缩之后、字体预设之前;只列当前生效模式的四套;点击即生效
 * (根内联令牌+data-palette);外观切换即换组且亮暗偏好分记。测试基准语言钉 en。
 */

const view: SettingsView = {
  keys: [{ key: 'language', value: null, source: 'global', envOverride: false }],
  permissions: {
    merged: { deny: [], allow: [], additionalDirs: [] },
    project: { deny: [], allow: [], additionalDirs: [] },
    global: { deny: [], allow: [], additionalDirs: [] },
  },
  providers: { choices: [], apiKeyPresent: {}, warnings: [] },
};

const conn: SettingsFormConn = {
  settings: () => Promise.resolve(view),
  putSettings: () => Promise.resolve(),
  memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
};

const cardNames = (): string[] => screen.getAllByRole('radio').map((b) => (b.textContent ?? '').replace('✓', ''));

describe('SettingsForm 配色主题行', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    applyTheme('light');
  });

  it('行序:界面放缩 → 配色主题 → 字体预设;亮色下列亮色四套,默认选中', async () => {
    render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]} />);
    const label = await screen.findByText('Color theme');
    const labels = [...document.querySelectorAll('.sx-setting-label')].map((n) => n.textContent);
    expect(labels.indexOf('Color theme')).toBe(labels.indexOf('UI zoom') + 1);
    expect(labels.indexOf('Font preset')).toBe(labels.indexOf('Color theme') + 1);
    expect(label).toBeDefined();
    expect(cardNames()).toEqual(['Default', 'Mist', 'Sage', 'Solarized']);
    expect(screen.getAllByRole('radio')[0]!.getAttribute('aria-checked')).toBe('true');
    // 选中勾与下拉选项勾同款(.sx-dd-opt-check accent),仅选中卡有
    const checks = document.querySelectorAll('.sx-palette-card .sx-dd-opt-check');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.closest('.sx-palette-card')!.getAttribute('aria-checked')).toBe('true');
    // 字体预设卡同形:出厂名「Default」,选中卡名行带同款勾
    const fontActive = document.querySelector('.sx-font-preset-card.active')!;
    expect(fontActive.querySelector('.sx-font-preset-name')!.textContent).toBe('Default✓');
    expect(document.querySelectorAll('.sx-font-preset-card .sx-dd-opt-check')).toHaveLength(1);
  });

  it('点击即生效;切到暗色换组且亮色偏好保留', async () => {
    render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]} />);
    await screen.findByText('Color theme');
    fireEvent.click(screen.getByRole('radio', { name: /Sage/ }));
    expect(document.documentElement.dataset.palette).toBe('light-sage');
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('#f2f5f0');
    expect(screen.getByRole('radio', { name: /Sage/ }).getAttribute('aria-checked')).toBe('true');

    act(() => applyTheme('dark'));
    await waitFor(() => expect(cardNames()).toEqual(['Default', 'Nord', 'Mocha', 'Gruvbox']));
    expect(document.documentElement.dataset.palette).toBe('dark-default');
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('');

    act(() => applyTheme('light'));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Sage/ }).getAttribute('aria-checked')).toBe('true'));
  });
});
