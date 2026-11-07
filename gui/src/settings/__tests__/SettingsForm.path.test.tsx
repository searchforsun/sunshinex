import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsForm, SETTINGS_PANES } from '../SettingsForm';
import type { SettingsFormConn } from '../SettingsForm';
import type { SettingsKeyRow, SettingsView } from '../../connection';

/** 路径行(2026-11-07 用户裁定):目录/文件地址行右侧选择钮——桌面壳原生对话框选完即存;浏览器态
 *  目录行回落应用内目录浏览,文件行无原生桥不出钮 */

const keyRow = (key: string, value: string | null = null): SettingsKeyRow => ({ key, value, source: 'global', envOverride: false });
const view: SettingsView = {
  keys: [keyRow('projectsDir', 'D:/old'), keyRow('globalSunshine'), keyRow('shell')],
  permissions: { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } },
  providers: { choices: [], apiKeyPresent: {}, warnings: [] },
};
const connOf = (extra: Partial<SettingsFormConn> = {}): { conn: SettingsFormConn; put: ReturnType<typeof vi.fn> } => {
  const put = vi.fn(() => Promise.resolve());
  return { put, conn: { settings: () => Promise.resolve(view), putSettings: put, memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }), ...extra } };
};

afterEach(() => {
  delete (window as { sunshinex?: unknown }).sunshinex;
});

describe('SettingsForm 路径行选择钮', () => {
  it('桌面壳:目录钮以现值为起点开原生对话框,选定即落库;文件行走 pickFile', async () => {
    const pickFolder = vi.fn(() => Promise.resolve('E:/new-projects'));
    const pickFile = vi.fn(() => Promise.resolve('C:/pwsh/pwsh.exe'));
    (window as { sunshinex?: unknown }).sunshinex = { pickFolder, pickFile };
    const { conn, put } = connOf();
    render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse projectsDir' }));
    expect(pickFolder).toHaveBeenCalledWith('D:/old');
    await waitFor(() => expect(put).toHaveBeenCalledWith('global', undefined, { projectsDir: 'E:/new-projects' }));
    expect((screen.getByLabelText('projectsDir') as HTMLInputElement).value).toBe('E:/new-projects');
    fireEvent.click(screen.getByRole('button', { name: 'Browse shell' }));
    expect(pickFile).toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(put).toHaveBeenCalledWith('global', undefined, { shell: 'C:/pwsh/pwsh.exe' }));
  });

  it('浏览器态:目录行有 dirpicker 即出钮(开应用内目录浏览),文件行无原生桥不出钮', async () => {
    const dirpicker = vi.fn(() => Promise.resolve({ path: 'C:/', parent: 'C:/', dirs: ['proj'] }));
    const { conn } = connOf({ dirpicker } as unknown as Partial<SettingsFormConn>);
    render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse globalSunshine' }));
    await waitFor(() => expect(dirpicker).toHaveBeenCalled());
    expect(await screen.findByText('proj')).toBeDefined(); // 目录浏览弹层已开
    expect(screen.queryByRole('button', { name: 'Browse shell' })).toBeNull();
  });
});
