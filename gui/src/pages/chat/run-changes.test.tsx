import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RunChangesBar } from './RunFooter';
import { LiveChangesContext, visibleRunChanges } from './use-live-changes';
import type { LiveChangeFile, LiveChanges } from './use-live-changes';

/** 轮尾改动条(2026-11-07):行数恒显 +X -Y(新建/删除无特殊样式);动态渲染=本轮记录 ∩ 当前 git 变动 */

const f = (path: string, added: number | null, deleted: number | null, newLines?: number): LiveChangeFile => ({
  path,
  status: added === null ? 'untracked' : 'modified',
  added,
  deleted,
  ...(newLines !== undefined ? { newLines } : {}),
});

const renderBar = (recorded: LiveChangeFile[], live: LiveChanges) =>
  render(
    <LiveChangesContext.Provider value={live}>
      <RunChangesBar changes={recorded} />
    </LiveChangesContext.Provider>,
  );

describe('visibleRunChanges', () => {
  it('交集+当前值;首拉未落定=空;拉取失败=回落轮记录', () => {
    const recorded = [f('a.ts', 1, 0), f('b.ts', 2, 2)];
    expect(visibleRunChanges(recorded, [f('a.ts', 5, 3), f('other.ts', 9, 9)])).toEqual([f('a.ts', 5, 3)]);
    expect(visibleRunChanges(recorded, undefined)).toEqual([]);
    expect(visibleRunChanges(recorded, null)).toBe(recorded);
  });
});

describe('RunChangesBar', () => {
  it('新建 +N -0、删除 +0 -N,汇总同口径(零也显示)', () => {
    const recorded = [f('new.ts', null, null, 3), f('gone.ts', 0, 0)];
    const { container } = renderBar(recorded, [f('new.ts', null, null, 12), f('gone.ts', 0, 30)]);
    expect(container.textContent).toContain('2 files changed');
    const head = container.querySelector('.run-changes-head .run-changes-stat')!;
    expect(head.textContent).toBe('+12-30');
    expect(container.textContent).not.toMatch(/new|新建/);
  });

  it('已提交(当前 git 无变动)的文件退场;全部退场 → 整条不渲染', () => {
    const recorded = [f('a.ts', 1, 0), f('b.ts', 2, 0)];
    const one = renderBar(recorded, [f('b.ts', 4, 1)]);
    expect(one.container.textContent).toContain('1 files changed');
    expect(one.container.querySelector('.run-changes-stat')!.textContent).toBe('+4-1');
    one.unmount();
    const none = renderBar(recorded, []);
    expect(none.container.querySelector('.run-changes')).toBeNull();
  });
});
