import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsForm, SETTINGS_PANES } from '../SettingsForm';
import type { SettingsFormConn } from '../SettingsForm';
import { applyArtifactCards } from '../../artifact-cards';
import { setLanguage } from '../../i18n';

const conn: SettingsFormConn = {
  settings: () => Promise.resolve({ keys: [], permissions: { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } }, providers: { choices: [], apiKeyPresent: {}, warnings: [] } }),
  putSettings: () => Promise.resolve(),
  memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
};

/** 产物卡显隐开关(2026-11-16 用户裁定「设置页可以控制产物显隐开关」):行在/拨动落键/关时落
 *  html[data-artifact-cards]=0(ArtifactsStrip 据此整块不渲染) */

describe('通用页产物卡开关', () => {
  beforeEach(() => {
    localStorage.clear();
    setLanguage('en');
    applyArtifactCards(true); // 复位根属性
  });

  it('渲染「Artifact cards」行;拨动即写 localStorage 与根 data 属性', async () => {
    render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]!} />);
    expect(await screen.findByText('Artifact cards')).toBeDefined();
    const sw = screen.getByLabelText('artifact cards');
    expect(document.documentElement.dataset.artifactCards).toBeUndefined(); // 开=属性缺省
    fireEvent.click(sw);
    expect(localStorage.getItem('sunshinex.artifact-cards')).toBe('0');
    expect(document.documentElement.dataset.artifactCards).toBe('0'); // ArtifactsStrip 消费面
    fireEvent.click(sw);
    expect(localStorage.getItem('sunshinex.artifact-cards')).toBe('1');
    expect(document.documentElement.dataset.artifactCards).toBeUndefined();
  });
});
