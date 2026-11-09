import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiffTab } from './DiffTab';
import type { Connection } from '../connection';

/** 审查页两区改版钉(2026-11-09 用户裁定):两区计数、暂存全部、撤回全部/撤销全部/行级撤销的二次确认、
 *  只提交暂存区、分支下拉切换与未提交改动阻断时的「提交并切换」确认框 */
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

async function mount(over?: Partial<Record<string, unknown>>) {
  const m = mkConn(over);
  render(<DiffTab conn={m.conn} sessionId="s1" params={{}} root="/repo" />);
  await screen.findByText('a.ts');
  return m;
}

describe('DiffTab 两区', () => {
  it('两区分列计数;暂存全部一击即执行;撤回全部需二次确认', async () => {
    const { calls } = await mount();
    expect(screen.getByText('b.ts')).toBeDefined();
    expect(screen.getByText('new.txt')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));
    await waitFor(() => expect(calls).toContain('stage:*'));
    const discard = screen.getByRole('button', { name: 'Discard all changes' });
    fireEvent.click(discard);
    expect(calls.some((c) => c.startsWith('discard'))).toBe(false); // 首击只武装
    expect(discard.className).toContain('arm');
    fireEvent.click(discard);
    await waitFor(() => expect(calls).toContain('discard:*'));
  });

  it('行级撤销:未暂存行=丢弃该文件、已暂存行=取消暂存该文件,均二次确认', async () => {
    const { calls } = await mount();
    const unstageRow = screen.getByRole('button', { name: 'Unstage this file' });
    fireEvent.click(unstageRow);
    fireEvent.click(unstageRow);
    await waitFor(() => expect(calls).toContain('unstage:src/a.ts'));
    const discardRows = screen.getAllByRole('button', { name: 'Discard changes to this file' });
    fireEvent.click(discardRows[0]!);
    expect(calls.some((c) => c.startsWith('discard'))).toBe(false);
    fireEvent.click(discardRows[0]!);
    await waitFor(() => expect(calls).toContain('discard:src/b.ts'));
  });

  it('已暂存区提交只提交暂存区;撤销全部=取消暂存需二次确认', async () => {
    const { calls } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged' }));
    fireEvent.change(screen.getByLabelText('commit message'), { target: { value: 'TEST_ msg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(calls).toContain('commit:TEST_ msg:true'));
    const unstageAll = screen.getByRole('button', { name: 'Unstage all' });
    fireEvent.click(unstageAll);
    fireEvent.click(unstageAll);
    await waitFor(() => expect(calls).toContain('unstage:*'));
  });

  it('分支下拉:切换被未提交改动阻断 → 弹确认框,「提交并切换」走 gitCommitCheckout', async () => {
    const { calls } = await mount();
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
