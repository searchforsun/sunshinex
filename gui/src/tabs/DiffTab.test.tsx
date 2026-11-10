import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiffTab } from './DiffTab';
import type { Connection } from '../connection';

/** 审查页改版钉(2026-11-10 用户裁定):顶栏=区域下拉(已暂存/未暂存,分支左侧)+区动作钮(刷新左侧),下方只列所选区;
 *  暂存全部一击即执行;撤回全部/撤销全部/行级撤销二次确认;只提交暂存区;分支切换被未提交改动阻断 → 「提交并切换」确认框 */
function mkConn(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const conn = {
    sessionChanges: vi.fn(async () => ({
      branch: 'dev1',
      files: [],
      staged: [{ path: 'src/a.ts', status: 'modified', added: 1, deleted: 0 }],
      unstaged: [
        { path: 'src/b.ts', status: 'modified', added: 2, deleted: 1 },
        { path: 'new.txt', status: 'untracked', added: null, deleted: null, newLines: 3 },
      ],
    })),
    sessionChangeContent: vi.fn(async () => ({ newContent: 'x\n', truncated: false, deleted: false })),
    stageChanges: vi.fn(async (_id: string, paths?: string[]) => void calls.push(`stage:${paths?.join(',') ?? '*'}`)),
    unstageChanges: vi.fn(async (_id: string, paths?: string[]) => void calls.push(`unstage:${paths?.join(',') ?? '*'}`)),
    discardUnstaged: vi.fn(async (_id: string, paths?: string[]) => void calls.push(`discard:${paths?.join(',') ?? '*'}`)),
    commitChanges: vi.fn(async (_id: string, msg: string, stagedOnly?: boolean) => void calls.push(`commit:${msg}:${String(stagedOnly)}`)),
    pushChanges: vi.fn(async () => void calls.push('push')),
    gitBranches: vi.fn(async () => ({ current: 'dev1', branches: ['dev1', 'main'] })),
    gitCheckout: vi.fn(async () => {
      throw Object.assign(new Error('would be overwritten'), { code: 'DIRTY_TREE' });
    }),
    gitCommitCheckout: vi.fn(async (_r: string, b: string) => void calls.push(`commit-checkout:${b}`)),
    ...over,
  } as unknown as Connection;
  return { conn, calls };
}

async function mount() {
  const m = mkConn();
  render(<DiffTab conn={m.conn} sessionId="s1" params={{}} root="/repo" />);
  await screen.findByText('b.ts'); // 缺省=未暂存区
  return m;
}

const areaBtn = (): HTMLElement => screen.getByRole('button', { name: 'changes area' });
const pick = async (label: 'Staged' | 'Unstaged'): Promise<void> => {
  fireEvent.click(areaBtn());
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
  });
};

describe('DiffTab 区域下拉', () => {
  it('缺省未暂存:只列未暂存文件;切已暂存只列暂存文件;下拉当前项带对号', async () => {
    const { conn } = await mount();
    expect(screen.queryByText('a.ts')).toBeNull();
    expect(screen.getByText('b.ts')).toBeDefined();
    expect(screen.getByText('new.txt')).toBeDefined();
    await pick('Staged');
    expect(screen.getByText('a.ts')).toBeDefined();
    expect(screen.queryByText('b.ts')).toBeNull();
    expect(conn.sessionChanges).toHaveBeenCalledTimes(1); // 切区不重拉
    fireEvent.click(areaBtn());
    expect(screen.getByRole('menuitemradio', { name: 'Staged' }).getAttribute('aria-checked')).toBe('true');
  });

  it('区动作钮随区切换:未暂存=暂存全部+撤回全部(二次确认);已暂存=提交+推送+撤销全部(二次确认)', async () => {
    const { calls } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));
    await waitFor(() => expect(calls).toContain('stage:*'));
    const discard = screen.getByRole('button', { name: 'Discard all changes' });
    fireEvent.click(discard);
    expect(calls.some((c) => c.startsWith('discard'))).toBe(false);
    fireEvent.click(discard);
    await waitFor(() => expect(calls).toContain('discard:*'));
    await pick('Staged');
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged' }));
    fireEvent.change(screen.getByLabelText('commit message'), { target: { value: 'TEST_ msg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(calls).toContain('commit:TEST_ msg:true'));
    const unstageAll = screen.getByRole('button', { name: 'Unstage all' });
    fireEvent.click(unstageAll);
    fireEvent.click(unstageAll);
    await waitFor(() => expect(calls).toContain('unstage:*'));
  });

  it('行级撤销随区:未暂存行=丢弃该文件、已暂存行=取消暂存该文件,均二次确认', async () => {
    const { calls } = await mount();
    const discardRow = screen.getAllByRole('button', { name: 'Discard changes to this file' })[0]!;
    fireEvent.click(discardRow);
    fireEvent.click(discardRow);
    await waitFor(() => expect(calls).toContain('discard:src/b.ts'));
    await pick('Staged');
    const unstageRow = screen.getByRole('button', { name: 'Unstage this file' });
    fireEvent.click(unstageRow);
    fireEvent.click(unstageRow);
    await waitFor(() => expect(calls).toContain('unstage:src/a.ts'));
  });

  it('分支下拉在区域下拉左侧:切换被未提交改动阻断 → 「提交并切换」确认框', async () => {
    const { calls } = await mount();
    // jsdom 无布局:以 DOM 先后断言分支钮在区域钮之前(顶栏左区先分支后区域)
    expect(screen.getByRole('button', { name: 'review branch' }).compareDocumentPosition(areaBtn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'review branch' }));
    await screen.findByRole('menuitem', { name: 'main' });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'main' }));
    });
    await screen.findByRole('dialog', { name: 'Uncommitted changes' });
    fireEvent.click(screen.getByRole('button', { name: 'Commit and switch' }));
    await waitFor(() => expect(calls).toContain('commit-checkout:main'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
