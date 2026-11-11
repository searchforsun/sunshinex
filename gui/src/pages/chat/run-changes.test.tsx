import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RunChangesBar } from './RunFooter';

/** 轮尾改动条(2026-11-11 用户裁定「每轮修改产生快照写死,快照互不影响,只是当时的快照」冻结面):
 *  行=落档记录、行数=冻结统计——live git 不参与(提交不吞数字/跨轮不互染),旧动态渲染退役 */

const f = (path: string, added: number | null, deleted: number | null, newLines?: number) => ({
  path,
  status: added === null ? (newLines !== undefined ? 'untracked' : 'deleted') : 'modified',
  added,
  deleted,
  ...(newLines !== undefined ? { newLines } : {}),
});

const renderBar = (recorded: ReturnType<typeof f>[]) =>
  render(<RunChangesBar changes={recorded} />);

describe('RunChangesBar 冻结面', () => {
  it('行数=落档冻结值(+N -0/-0 -N 同口径,零也显示)', () => {
    const recorded = [f('new.ts', null, null, 3), f('gone.ts', 0, 30)];
    const { container } = renderBar(recorded);
    expect(container.textContent).toContain('2 files changed');
    const head = container.querySelector('.run-changes-head .run-changes-stat')!;
    expect(head.textContent).toBe('+3-30');
  });

  it('冻结行不随 git 状态退场(轮记录恒在);汇总=冻结值合计', () => {
    const recorded = [f('a.ts', 1, 0), f('b.ts', 2, 0)];
    const { container, unmount } = renderBar(recorded);
    expect(container.textContent).toContain('2 files changed');
    expect(container.querySelector('.run-changes-head .run-changes-stat')!.textContent).toBe('+3-0');
    unmount();
  });
});
