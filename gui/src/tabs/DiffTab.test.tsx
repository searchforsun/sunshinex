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
    gitBranches: vi.fn(async () => ({ current: 'dev1', branches: ['dev1', 'main', 'held-by-wt'], occupied: { 'held-by-wt': 'D:/wt/other' } })),
    branchDiffStat: vi.fn(async (_r: string, b: string) =>
      b === 'main' ? { files: 12, added: 100, deleted: 3, dirty: 0, dirtyAdded: 0, dirtyDeleted: 0, missing: false } : { files: 0, added: 0, deleted: 0, dirty: 2, dirtyAdded: 5, dirtyDeleted: 1, missing: false }),
    gitCheckout: vi.fn(async (_r: string, b: string) => void calls.push(`checkout:${b}`)),
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

  it('分支下拉在区域下拉左侧:切换先弹代价确认(干净树=切换,示 numstat 汇总)', async () => {
    const { calls } = await mount();
    // jsdom 无布局:以 DOM 先后断言分支钮在区域钮之前(顶栏左区先分支后区域)
    expect(screen.getByRole('button', { name: 'review branch' }).compareDocumentPosition(areaBtn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'review branch' }));
    await screen.findByRole('menuitem', { name: 'main' });
    // 被其他 worktree 签出的分支:菜单禁用+「已签出」标记(2026-11-10 用户裁定)
    const held = await screen.findByRole('menuitem', { name: /held-by-wt/ });
    expect(held.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(held); // 禁用项点击不派发
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'main' }));
    });
    await screen.findByRole('dialog', { name: 'Switch branch' });
    await screen.findByText(/12 files|12 个文件/); // 代价面:numstat 汇总
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(calls).toContain('checkout:main'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('未提交改动在场:确认框只给「提交并切换」(git 将阻断,直接切不可选)', async () => {
    const c = mkConn({
      branchDiffStat: vi.fn(async () => ({ files: 12, added: 100, deleted: 3, dirty: 2, dirtyAdded: 5, dirtyDeleted: 1, missing: false })),
    });
    render(<DiffTab conn={c.conn} sessionId="s1" params={{}} root="/repo" />);
    await screen.findByText('b.ts');
    fireEvent.click(screen.getByRole('button', { name: 'review branch' }));
    await screen.findByRole('menuitem', { name: 'main' });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'main' }));
    });
    await screen.findByRole('dialog', { name: 'Switch branch' });
    await screen.findByText(/\+5 −1/); // 脏面 ±数量
    fireEvent.change(screen.getByLabelText(/Commit message|提交信息/), { target: { value: 'WIP_ msg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit and switch' }));
    await waitFor(() => expect(c.conn.gitCommitCheckout).toHaveBeenCalledWith('/repo', 'main', false, 'WIP_ msg'));
  });

  it('代价面拉取失败仍确认(不示数文案,不静默切换)', async () => {
    const c = mkConn();
    (c.conn as unknown as { branchDiffStat: unknown }).branchDiffStat = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<DiffTab conn={c.conn} sessionId="s1" params={{}} root="/repo" />);
    await screen.findByText('b.ts');
    fireEvent.click(screen.getByRole('button', { name: 'review branch' }));
    await screen.findByRole('menuitem', { name: 'main' });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'main' }));
    });
    await screen.findByRole('dialog', { name: 'Switch branch' });
    expect(screen.queryByText(/12 files|12 个文件/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(c.calls).toContain('checkout:main'));
  });
});
