import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLiveGitChanges } from './use-live-changes';

/**
 * 2026-11-18 多会话卡顿轮实测:/changes 单次约 0.7s(大仓 git status+numstat,单线程 daemon)。
 * 两条约束在此钉住:
 * ①驻留座(active=false → enabled=false)不轮询——打开多个会话后 /changes 请求不随座数增长;
 * ②同会话同一拍的两条消费线(live 改动条 + 顶栏总改动)共享一次在途请求(250ms 窗)。
 */

const files = [{ path: 'a.ts', status: 'M', added: 1, deleted: 2 }];

describe('useLiveGitChanges 请求收口(多会话卡顿轮)', () => {
  it('enabled=false 不拉;翻 true 才拉(驻留座零轮询)', async () => {
    const calls = vi.fn(() => Promise.resolve({ files }));
    const { rerender } = renderHook(({ enabled }: { enabled: boolean }) => useLiveGitChanges(calls, 's-no-poll', false, enabled), {
      initialProps: { enabled: false },
    });
    await act(async () => {});
    expect(calls).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => {});
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('同会话同拍两条消费线只发一次请求(共享在途 Promise)', async () => {
    const calls = vi.fn(() => Promise.resolve({ files }));
    const a = renderHook(() => useLiveGitChanges(calls, 's-share', false, true));
    const b = renderHook(() => useLiveGitChanges(calls, 's-share', false, true));
    await act(async () => {});
    expect(calls).toHaveBeenCalledTimes(1);
    expect(a.result.current).toEqual(files);
    expect(b.result.current).toEqual(files);
  });
});
