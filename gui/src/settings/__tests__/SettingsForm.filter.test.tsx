import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SettingsForm, SETTINGS_PANES } from '../SettingsForm';
import type { SettingsFormConn } from '../SettingsForm';
import type { SettingsKeyRow, SettingsView } from '../../connection';

/**
 * Task 25 SettingsForm 行过滤桩测(四 SETTINGS_PANES 顶部 SearchBar):conn 全桩(不出网),
 * 用例沿 task brief——①顶部 SearchBar 按行标签过滤(200ms 防抖沿 SearchBar 契约);②按键名
 * 过滤;③无匹配空态;④清空恢复。特例行(theme/zoom/font)过滤激活时一并滤除。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

/** 键行构造器(SettingsKeyRow 合法缺省,逐例覆写) */
const keyRow = (key: string, over: Partial<SettingsKeyRow> = {}): SettingsKeyRow => ({ key, value: null, source: 'global', envOverride: false, ...over });

/** GET /settings 应答构造器(general 面 keys;权限/providers 面空形——本面不消费) */
const viewOf = (keys: SettingsKeyRow[]): SettingsView => ({
  keys,
  permissions: {
    merged: { deny: [], allow: [], additionalDirs: [] },
    project: { deny: [], allow: [], additionalDirs: [] },
    global: { deny: [], allow: [], additionalDirs: [] },
  },
  providers: { choices: [], apiKeyPresent: {}, warnings: [] },
});

/** conn 桩:settings 单答;写面/记忆面零消费形 */
const connOf = (view: SettingsView): { conn: SettingsFormConn } => ({
  conn: {
    settings: () => Promise.resolve(view),
    putSettings: () => Promise.resolve(),
    memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
  },
});

describe('SettingsForm 行过滤(SETTINGS_PANES 顶部 SearchBar)', () => {
  it('按行标签过滤:输入 shell → 仅 Shell 行留;特例行(theme/zoom/font)与他不匹配行滤除;清空恢复', async () => {
    const { conn } = connOf(viewOf([keyRow('language'), keyRow('projectsDir'), keyRow('userSkillsDir'), keyRow('globalSunshine'), keyRow('shell')]));
    render(<SettingsForm conn={conn} root="/w/proj" pane={SETTINGS_PANES[0]} />);
    expect(await screen.findByText('Shell')).toBeDefined(); // 初始全行在
    expect(screen.getByText('Projects directory')).toBeDefined();
    expect(screen.getByText('Font preset')).toBeDefined(); // 特例行(本地偏好)初始在
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'shell' } });
      act(() => {
        vi.advanceTimersByTime(200); // SearchBar 200ms 防抖
      });
      expect(screen.getByText('Shell')).toBeDefined();
      expect(screen.queryByText('Projects directory')).toBeNull();
      expect(screen.queryByText('Language')).toBeNull();
      expect(screen.queryByText('Font preset')).toBeNull(); // 过滤激活:特例行一并滤除
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('Projects directory')).toBeDefined(); // 清空恢复
      expect(screen.getByText('Font preset')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('按键名过滤:输入 dir → projectsDir/userSkillsDir 两行留(标签含 dir);无匹配 → 空态+组卡全隐', async () => {
    const { conn } = connOf(viewOf([keyRow('projectsDir'), keyRow('userSkillsDir'), keyRow('shell')]));
    render(<SettingsForm conn={conn} root="/w/proj" pane={SETTINGS_PANES[0]} />);
    await screen.findByText('Projects directory');
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'dir' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('Projects directory')).toBeDefined();
      expect(screen.getByText('User skills directory')).toBeDefined();
      expect(screen.queryByText('Shell')).toBeNull();
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz-no-match' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('No matching settings.')).toBeDefined(); // 空态
      expect(screen.queryByText('Paths')).toBeNull(); // 组卡整卡隐
    } finally {
      vi.useRealTimers();
    }
  });
});
