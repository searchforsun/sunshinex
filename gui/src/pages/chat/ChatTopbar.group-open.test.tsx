import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Connection } from '../../connection';
import { setLanguage } from '../../i18n';
import { ChatTopbar } from './ChatTopbar';

setLanguage('zh');

/** Sunx 会话顶栏群入口（2026-11-27 用户裁定「sunx 内部顶部最右侧，[|] 左侧放置群图标，
 *  点击进入群聊」）：群 id 由 /sunx/sessions 行反查；非 Sunx / 反查失败不产死钮。 */

function makeConn(): Connection {
  return {
    sunxSessions: vi.fn(async () => [
      { id: 'j1', file: 'j1.jsonl', updatedAt: 1, kind: 'sunx', root: 'D:/w', groupId: 'grp_x' },
      { id: 'j2', file: 'j2.jsonl', updatedAt: 1, kind: 'sunx', root: 'D:/w', liveSessionId: 's2', groupId: 'grp_y' },
    ]),
  } as unknown as Connection;
}

const base = {
  fixedTitle: undefined,
  titleEditing: false,
  titleDraft: '',
  setTitleDraft: () => undefined,
  commitTitle: () => undefined,
  setTitleEditing: () => undefined,
  displayTitle: '小明',
  sessionId: 's1',
  tokens: 0,
  steps: 0,
  running: false,
  blocks: [],
  archived: false,
  onArchive: () => undefined,
};

describe('ChatTopbar 群入口', () => {
  it('Sunx 会话：反查所属群并上抛 groupId', async () => {
    const onOpenGroupChat = vi.fn();
    render(<ChatTopbar {...base} conn={makeConn()} sessionKind="sunx" journalId="j1" onOpenGroupChat={onOpenGroupChat} />);
    const btn = await screen.findByRole('button', { name: 'open group chat' });
    expect(btn.getAttribute('data-tip')).toBe('进入群聊');
    fireEvent.click(btn);
    expect(onOpenGroupChat).toHaveBeenCalledWith('grp_x');
  });

  it('活动会话（liveSessionId 命中）：群 id 同样反查到', async () => {
    const onOpenGroupChat = vi.fn();
    render(<ChatTopbar {...base} conn={makeConn()} sessionId="s2" sessionKind="sunx" onOpenGroupChat={onOpenGroupChat} />);
    fireEvent.click(await screen.findByRole('button', { name: 'open group chat' }));
    expect(onOpenGroupChat).toHaveBeenCalledWith('grp_y');
  });

  it('非 Sunx 会话不渲染群入口', async () => {
    render(<ChatTopbar {...base} conn={makeConn()} onOpenGroupChat={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'open group chat' })).toBeNull());
  });
});
