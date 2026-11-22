import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useIsChannelJournal } from './use-channel-bound';
import type { ChannelBindingMsg } from '../../connection-api';

/**
 * 通道会话判定钩子(2026-11-22 用户裁定「/new 空态显示成普通系统提示」):journalId 命中
 * 绑定档=通道域会话。用例:①命中 → true;②未命中 → false;③拉取失败 → false(静默降级);
 * ④conn 缺方法/空 journalId → false(旧桩守卫,零调用)。
 */

const binding = (journalId: string): { bindings: ChannelBindingMsg[] } => ({
  bindings: [{ key: 'feishu-1:c1', sessionId: 's1', journalId, updatedAt: 1 }],
});

describe('useIsChannelJournal(通道会话判定)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('①journalId 命中绑定档 → true;②未命中 → false', async () => {
    const conn = { channelBindings: vi.fn(async () => binding('j-hit')) };
    const { result, rerender } = renderHook(({ jid }) => useIsChannelJournal(conn, jid), { initialProps: { jid: 'j-hit' } });
    await act(async () => {});
    expect(result.current).toBe(true);
    rerender({ jid: 'j-other' }); // 未命中
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it('③拉取失败 → false(静默降级,信息条整块 null 同语义)', async () => {
    const conn = { channelBindings: vi.fn(async () => { throw new Error('boom'); }) };
    const { result } = renderHook(() => useIsChannelJournal(conn, 'j1'));
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it('④conn 缺方法/空 journalId → false 且零调用(旧桩守卫)', async () => {
    const conn = {} as Parameters<typeof useIsChannelJournal>[0];
    const { result } = renderHook(() => useIsChannelJournal(conn, 'j1'));
    await act(async () => {});
    expect(result.current).toBe(false);
    const connOk = { channelBindings: vi.fn(async () => binding('j1')) };
    const r2 = renderHook(() => useIsChannelJournal(connOk, ''));
    await act(async () => {});
    expect(r2.result.current).toBe(false);
    expect(connOk.channelBindings).not.toHaveBeenCalled();
  });
});
