import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMenuChannels } from './use-menu-channels';
import type { SessionRow, WorkspaceRow } from '../connection';
import type { ChannelConfigMsg } from '../connection-api';

/**
 * useMenuChannels 刷新驱动(2026-11-22 用户实测「发了消息侧栏没有通道组」根修):通道会话由
 * IM 侧外来创建,宿主 rows 引用(listShallowEqual 保引用)不动它——hook 必须自驱。用例:
 * ①初次装载拉一次(空列);②内置 30s tick 自驱重拉,IM 侧新会话现身(fake timers,
 * connection.test 同款 advanceTimersByTimeAsync,act 包裹冲刷异步状态);③reloadNonce
 * (recentVersion bump)变化即重拉(半分钟内即时性);④conn 缺 channelSessions 方法=旧桩守卫,
 * 行集保持 null(装载态=组不渲染同口径)零调用。
 */

const row = (id: string): SessionRow =>
  ({
    id,
    file: `${id}.jsonl`,
    updatedAt: 1_728_000_000_000,
    firstUser: `通道会话 ${id}`,
    kind: 'channel',
    root: 'C:/x/channels/im-tg1-c1',
    channel: 'tg1',
  }) as SessionRow;

function makeConn(sessions: SessionRow[]): { channelSessions: ReturnType<typeof vi.fn>; settingsChannels: ReturnType<typeof vi.fn> } {
  return {
    channelSessions: vi.fn(async () => sessions),
    settingsChannels: vi.fn(async (): Promise<{ channels: ChannelConfigMsg[]; warnings: string[] }> => ({ channels: [], warnings: [] })),
  };
}

const ROWS: WorkspaceRow[] | null = null;

describe('useMenuChannels(通道组行集刷新驱动)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('①初次装载拉一次;②30s tick 自驱重拉,IM 侧新会话现身', async () => {
    const conn = makeConn([]);
    const { result, rerender } = renderHook(({ conn }) => useMenuChannels(conn, ROWS), { initialProps: { conn } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.rows).toEqual([]); // 空容器合法空态(组整块不渲染由组内自守卫)
    expect(conn.channelSessions).toHaveBeenCalledTimes(1);

    // IM 侧来了一条通道会话(宿主零变化——rerender 同参不触发 effect,只靠 tick 自驱)
    conn.channelSessions.mockImplementation(async () => [row('j-new')]);
    rerender({ conn });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(conn.channelSessions).toHaveBeenCalledTimes(1); // 无驱动点不重拉(浅等守卫同拍:不风暴)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(conn.channelSessions).toHaveBeenCalledTimes(2); // tick 到点重拉
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows![0]!.id).toBe('j-new');
  });

  it('③reloadNonce(recentVersion bump)变化即重拉(同 conn,nonce 单变)', async () => {
    const conn = makeConn([]);
    const { rerender, result } = renderHook(({ nonce }) => useMenuChannels(conn, ROWS, nonce), {
      initialProps: { nonce: 0 },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.rows).toEqual([]);
    conn.channelSessions.mockImplementation(async () => [row('j-bumped')]);
    rerender({ nonce: 1 }); // bump → effect 重跑(conn/rows 引用未变,nonce 即刷新信号)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows![0]!.id).toBe('j-bumped');
  });

  it('④conn 缺 channelSessions 方法(旧桩守卫):行集保持 null 零调用', async () => {
    const conn = {} as Parameters<typeof useMenuChannels>[0];
    const { result } = renderHook(() => useMenuChannels(conn, ROWS));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.rows).toBeNull(); // 缺方法守卫:装载态原样(组不渲染同口径)
  });
});
