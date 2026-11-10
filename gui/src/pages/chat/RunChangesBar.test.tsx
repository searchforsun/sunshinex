import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunChangesBar } from './RunFooter';
import { LiveChangesContext } from './use-live-changes';

/** 轮次 checkpoint 汇总条(2026-11-10 用户裁定「每轮精确看到自己的改动、能撤销」):
 *  文件名点击开本轮 diff 页签(run+path);撤销二次确认走 turn-restore,stale 行置灰;
 *  旧档(无 runSeq)回退审查页/git restore 语义 */

const changes = [
  { path: 'src/a.ts', status: 'modified', added: 3, deleted: 1 },
  { path: 'src/new.ts', status: 'untracked', added: null, deleted: null, newLines: 9 },
];

function renderBar(over: {
  runSeq?: number;
  turn?: Array<{ path: string; before?: string; beforeDeleted?: boolean; after: string }>;
  onOpenDiff?: (p: string) => void;
  onRestore?: (p: string) => void;
  onOpenTurn?: (run: number, path: string) => void;
  onTurnRestore?: (run: number, paths: string[]) => Promise<Array<{ path: string; ok: boolean; stale?: boolean; noCheckpoint?: boolean }>>;
}): void {
  render(
    <LiveChangesContext.Provider value={changes}>
      <RunChangesBar
        changes={changes}
        run={over.runSeq !== undefined ? { runSeq: over.runSeq, ...(over.turn !== undefined ? { turn: over.turn } : {}) } : undefined}
        onOpenDiff={over.onOpenDiff}
        onRestore={over.onRestore}
        onOpenTurn={over.onOpenTurn}
        onTurnRestore={over.onTurnRestore}
      />
    </LiveChangesContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /files changed|个文件已更改/ })); // 展开行区
}

describe('RunChangesBar checkpoint 语义', () => {
  test('文件名点击 → onOpenTurn(run, path)(有 runSeq)', () => {
    const onOpenTurn = vi.fn();
    renderBar({ runSeq: 42, turn: [{ path: 'src/a.ts', before: 'h1', after: 'h2' }], onOpenTurn });
    fireEvent.click(screen.getByText('a.ts'));
    expect(onOpenTurn).toHaveBeenCalledWith(42, 'src/a.ts');
  });

  test('旧档(无 runSeq):文件名回退 onOpenDiff,行撤销回退 onRestore(单击)', () => {
    const onOpenDiff = vi.fn();
    const onRestore = vi.fn();
    renderBar({ onOpenDiff, onRestore });
    fireEvent.click(screen.getByText('a.ts'));
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts');
    fireEvent.click(screen.getAllByRole('button', { name: /Undo|撤销/ })[1]!); // 行内撤销(首个=整轮)
    fireEvent.click(screen.getAllByRole('button', { name: /Undo|撤销/ })[1]!); // 二次确认
    expect(onRestore).toHaveBeenCalledWith('src/a.ts');
  });

  test('checkpoint 撤销二次确认:首击武装,再击 turn-restore;成功后行消失', async () => {
    const onTurnRestore = vi.fn().mockResolvedValue([{ path: 'src/a.ts', ok: true }]);
    renderBar({ runSeq: 7, turn: [{ path: 'src/a.ts', before: 'h1', after: 'h2' }], onTurnRestore });
    const rows = screen.getAllByText('a.ts');
    const row = rows[rows.length - 1]!.closest('.run-changes-row')!;
    const undoBtn = row.querySelector('.run-changes-undo-row') as HTMLButtonElement;
    fireEvent.click(undoBtn); // 首击武装
    expect(onTurnRestore).not.toHaveBeenCalled();
    expect(undoBtn.className).toContain('arm');
    fireEvent.click(undoBtn); // 再击执行
    await waitFor(() => expect(onTurnRestore).toHaveBeenCalledWith(7, ['src/a.ts']));
    await waitFor(() => expect(screen.queryByText('a.ts')).toBeNull()); // 成功后行退场
  });

  test('stale 行置灰停用(后续轮次又改过)', async () => {
    const onTurnRestore = vi.fn().mockResolvedValue([{ path: 'src/a.ts', ok: false, stale: true }]);
    renderBar({ runSeq: 7, turn: [{ path: 'src/a.ts', before: 'h1', after: 'h2' }], onTurnRestore });
    const row = screen.getAllByText('a.ts').slice(-1)[0]!.closest('.run-changes-row')!;
    const undoBtn = row.querySelector('.run-changes-undo-row') as HTMLButtonElement;
    fireEvent.click(undoBtn);
    fireEvent.click(undoBtn);
    await waitFor(() => expect(undoBtn.disabled).toBe(true));
  });

  test('无前像行(bash 改动)行撤销回退 onRestore', () => {
    const onRestore = vi.fn();
    const onTurnRestore = vi.fn().mockResolvedValue([]);
    renderBar({ runSeq: 7, turn: [{ path: 'src/a.ts', after: 'h2' }], onRestore, onTurnRestore });
    const row = screen.getAllByText('a.ts').slice(-1)[0]!.closest('.run-changes-row')!;
    const btn = row.querySelector('.run-changes-undo-row') as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn); // 二次确认
    expect(onRestore).toHaveBeenCalledWith('src/a.ts');
    expect(onTurnRestore).not.toHaveBeenCalled();
  });
});
