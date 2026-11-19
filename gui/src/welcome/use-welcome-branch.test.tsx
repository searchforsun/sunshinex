import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWelcomeBranch } from './use-welcome-branch';
import type { WelcomeComposerConn } from './welcome-conn';

/** 分支清单竞态守卫(2026-11-19 用户实测「默认工作区没有 git 却有分支残留」):切项目瞬间旧项目
 *  的 gitBranches 应答晚到,不得把已清空的分支状态写回 */

function connOf(deferred: Array<(v: { current: string; branches: string[] }) => void>): WelcomeComposerConn {
  return {
    gitBranches: () => new Promise((resolve) => deferred.push(resolve)),
  } as unknown as WelcomeComposerConn;
}

describe('useWelcomeBranch 竞态', () => {
  it('切到默认工作区(非 git)后,旧项目晚到的分支应答被丢弃', async () => {
    const deferred: Array<(v: { current: string; branches: string[] }) => void> = [];
    const conn = connOf(deferred);
    const setHint = vi.fn();
    const { result, rerender } = renderHook(
      ({ picked, def }: { picked: string; def: boolean }) => useWelcomeBranch(conn, picked, def, setHint),
      { initialProps: { picked: 'D:/repo', def: false } },
    );
    expect(deferred).toHaveLength(1);
    // 切到默认工作区:立即清空
    rerender({ picked: 'C:/Temp/sunshinex-default', def: true });
    expect(result.current.gitBr).toBeNull();
    // 旧项目的应答此刻才回来:必须被拒
    act(() => deferred[0]!({ current: 'feature/bigdata-assist', branches: ['feature/bigdata-assist', 'main'] }));
    await waitFor(() => expect(result.current.gitBr).toBeNull());
  });

  it('停留在同一项目时正常落地', async () => {
    const deferred: Array<(v: { current: string; branches: string[] }) => void> = [];
    const conn = connOf(deferred);
    const { result } = renderHook(() => useWelcomeBranch(conn, 'D:/repo', false, vi.fn()));
    act(() => deferred[0]!({ current: 'main', branches: ['main'] }));
    await waitFor(() => expect(result.current.gitBr).toEqual({ current: 'main', branches: ['main'] }));
  });
});
