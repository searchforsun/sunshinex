import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsForm, SETTINGS_PANES } from '../SettingsForm';
import type { SettingsFormConn } from '../SettingsForm';
import type { SettingsKeyRow, SettingsView } from '../../connection';
import { applyDeveloperMode } from '../../developer-mode';

const keyRow = (key: string, over: Partial<SettingsKeyRow> = {}): SettingsKeyRow => ({ key, value: null, source: 'global', envOverride: false, ...over });
const viewOf = (keys: SettingsKeyRow[]): SettingsView => ({
  keys,
  permissions: { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } },
  providers: { choices: [], apiKeyPresent: {}, warnings: [] },
});
const connOf = (view: SettingsView): SettingsFormConn => ({
  settings: () => Promise.resolve(view),
  putSettings: () => Promise.resolve(),
  memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
});

const PANE = SETTINGS_PANES[0]!;
const view = viewOf([keyRow('language'), keyRow('terminalDock', { value: 'on' })]);

/** 2026-11-17 用户裁定「通用里面,非开发者模式下办公模式/简洁模式/用量统计/终端是关的……整体看一下」:
 *  普通态四行隐藏(取值由模式派生);开发者模式恢复,且终端行紧随简洁模式 */
describe('通用页外观行的模式分层', () => {
  afterEach(() => applyDeveloperMode(false));

  it('普通态隐藏 界面模式/简洁模式/用量统计/终端 四行', async () => {
    applyDeveloperMode(false);
    render(<SettingsForm conn={connOf(view)} root="" pane={PANE} />);
    expect(await screen.findByText('Developer mode')).toBeDefined();
    for (const label of ['Interface mode', 'Concise mode', 'Usage stats', 'Terminal']) expect(screen.queryByText(label)).toBeNull();
    expect(screen.getByText('Dark bubbles')).toBeDefined(); // 纯外观行仍在
  });

  it('开发者模式四行恢复,终端行紧随简洁模式', async () => {
    applyDeveloperMode(true);
    render(<SettingsForm conn={connOf(view)} root="" pane={PANE} />);
    expect(await screen.findByText('Concise mode')).toBeDefined();
    const labels = [...document.querySelectorAll('.sx-setting-label')].map((el) => el.textContent);
    expect(labels).toContain('Terminal');
    expect(labels.indexOf('Terminal')).toBe(labels.indexOf('Concise mode') + 1);
  });
});
