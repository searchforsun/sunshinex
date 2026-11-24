import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatTopbar } from './ChatTopbar';
import type { Connection } from '../../connection';

/** 通道 Sunx 菜单归普通通道（2026-11-25 用户裁定「品行和工作区是在通道配置的,页面上不再支持
 *  配置,只可重命名会话」+「下拉选项和普通会话一样,显示归档/重命名会话/复制会话ID等」）：
 *  通道 Sunx（kind='sunx'+chatId）菜单=重命名会话/归档/复制会话 ID,「编辑 Sunx」「复制 Sunx ID」
 *  退役;手建 Sunx 保持 编辑 Sunx（品性入口）+复制 Sunx ID、无归档（SUNX 组头专域） */

const conn = {} as Connection;
const base = {
  fixedTitle: undefined,
  titleEditing: false,
  titleDraft: '',
  setTitleDraft: () => undefined,
  commitTitle: () => undefined,
  setTitleEditing: () => undefined,
  displayTitle: 'demo',
  sessionId: 's1',
  tokens: 0,
  steps: 0,
  running: false,
  conn,
  archived: false,
  onArchive: () => undefined,
};

async function openMenu(props: Record<string, unknown>): Promise<void> {
  render(<ChatTopbar {...(base as object)} {...(props as object)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
  await screen.findByText('Rename session');
}

describe('通道 Sunx 顶栏菜单=普通通道（2026-11-25）', () => {
  it('通道 Sunx:重命名会话(非 编辑 Sunx)+归档+复制会话 ID;编辑 Sunx/复制 Sunx ID 退役', async () => {
    await openMenu({ sessionKind: 'sunx', channelChatId: 'oc-x' });
    expect(screen.getByText('Rename session')).toBeTruthy();
    expect(screen.queryByText('Edit Sunx')).toBeNull();
    expect(screen.getByText('Archive session')).toBeTruthy();
    expect(screen.getByText('Copy session ID')).toBeTruthy();
    expect(screen.queryByText('Copy Sunx ID')).toBeNull();
  });

  it('手建 Sunx:保持 编辑 Sunx+复制 Sunx ID,无归档（SUNX 组头专域）', async () => {
    render(<ChatTopbar {...(base as object)} sessionKind="sunx" />);
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    expect(await screen.findByText('Edit Sunx')).toBeTruthy();
    expect(screen.queryByText('Archive session')).toBeNull();
    expect(screen.getByText('Copy Sunx ID')).toBeTruthy();
  });
});
