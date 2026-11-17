import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsForm, SETTINGS_PANES } from '../SettingsForm';
import type { SettingsFormConn } from '../SettingsForm';

const conn: SettingsFormConn = {
  settings: () => Promise.resolve({ keys: [], permissions: { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } }, providers: { choices: [], apiKeyPresent: {}, warnings: [] } }),
  putSettings: () => Promise.resolve(),
  memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
};

describe('通用页开发者模式开关', () => {
  it('首组渲染「开发者模式」行,拨动即写 localStorage', async () => {
    localStorage.clear();
    render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]!} />);
    // 卡头标题改「Developer」后,「Developer mode」只剩行标签唯一命中
    expect(await screen.findByText('Developer mode')).toBeDefined();
    expect(screen.getByLabelText('developer mode')).toBeDefined();
    expect(localStorage.getItem('sunshinex.developer-mode')).toBeNull(); // 清空后未拨动:未落键
    const sw = screen.getByLabelText('developer mode');
    fireEvent.click(sw);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('1');
    fireEvent.click(sw);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('0');
  });
});
