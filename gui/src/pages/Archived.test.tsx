import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchivedPage } from './Archived';
import { setLanguage } from '../i18n';
import type { Connection } from '../connection';

/** T6 归档页:用例文案钉 zh(brief 断言逐字 zh;全局 setup 钉 en,本文件显式切回 zh,
 *  vitest 文件级模块隔离——不泄漏他文件) */
setLanguage('zh');

const rows = [
  { id: 'j1', slug: 'ws-a', root: 'D:/ws-a', title: '会话一', updatedAt: 2, archivedAt: 20 },
  { id: 'j2', slug: 'ws-b', root: 'D:/ws-b', updatedAt: 1, archivedAt: 10 },
];

function mkConn() {
  // 三方法 stub → Connection(brief 原样 `as never` 令断言面 conn.archiveSession 取 never 报
  // TS2339——改 unknown 双跳,测试断言保留属性访问)
  return {
    archivedSessions: vi.fn(async () => rows),
    archiveSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } as unknown as Connection;
}

describe('ArchivedPage 归档页', () => {
  it('行渲染:标题(无题回落 id)+来源 slug;撤销调 archiveSession(j,false);红删除走确认后 deleteSession', async () => {
    const conn = mkConn();
    const onOpen = vi.fn();
    render(<ArchivedPage conn={conn} onOpen={onOpen} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('会话一')).toBeDefined());
    expect(screen.getByText('ws-a')).toBeDefined();                    // 来源项目标注
    expect(screen.getByText('j2')).toBeDefined();                      // 无题回落 id
    fireEvent.click(screen.getByRole('button', { name: '撤销归档 j1' }));
    await waitFor(() => expect(conn.archiveSession).toHaveBeenCalledWith('j1', false));
    fireEvent.click(screen.getByRole('button', { name: '删除 j2' }));   // → 行内变「确认」
    fireEvent.click(screen.getByRole('button', { name: '确认删除 j2' }));
    await waitFor(() => expect(conn.deleteSession).toHaveBeenCalledWith('j2'));
  });
  it('点击行 → onOpen(root, journalId)', async () => {
    const onOpen = vi.fn();
    render(<ArchivedPage conn={mkConn()} onOpen={onOpen} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('会话一')).toBeDefined());
    fireEvent.click(screen.getByText('会话一'));
    expect(onOpen).toHaveBeenCalledWith('D:/ws-a', 'j1');
  });
});
