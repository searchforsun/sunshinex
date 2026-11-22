import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChannelJournalInfo } from './use-channel-bound';
import type { ChannelBindingMsg } from '../../connection-api';

/**
 * 通道会话判定钩子(2026-11-22 用户裁定系列):journalId 命中绑定档=通道域会话,返回
 * {isChannel, chatId, platform}。用例:①命中 → isChannel+chatId+平台反查归位;②未命中 →
 * 非通道;③拉取失败 → 非通道(静默降级);④conn 缺方法/空 journalId → 非通道且零调用(旧桩守卫)。
 */

const binding = (journalId: string): { bindings: ChannelBindingMsg[] } => ({
  bindings: [{ key: 'feishu-1:c1', sessionId: 's1', journalId, updatedAt: 1 }],
});

describe('useChannelJournalInfo(通道会话判定)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('①journalId 命中绑定档 → isChannel+chatId+平台反查归位;②未命中 → 非通道', async () => {
    const conn = {
      channelBindings: vi.fn(async () => binding('j-hit')),
      settingsChannels: vi.fn(async () => ({ channels: [{ id: 'feishu-1', platform: 'feishu' }], warnings: [] })),
    };
    const { result, rerender } = renderHook(({ jid }) => useChannelJournalInfo(conn, jid), { initialProps: { jid: 'j-hit' } });
    await act(async () => {});
    expect(result.current.isChannel).toBe(true);
    expect(result.current.chatId).toBe('c1');
    await act(async () => {});
    expect(result.current.platform).toBe('feishu'); // 平台反查晚到归位
    rerender({ jid: 'j-other' }); // 未命中
    await act(async () => {});
    expect(result.current.isChannel).toBe(false);
    expect(result.current.chatId).toBe('');
  });

  it('③拉取失败 → 非通道(静默降级)', async () => {
    const conn = { channelBindings: vi.fn(async () => { throw new Error('boom'); }) };
    const { result } = renderHook(() => useChannelJournalInfo(conn, 'j1'));
    await act(async () => {});
    expect(result.current.isChannel).toBe(false);
  });

  it('④conn 缺方法/空 journalId → 非通道且零调用(旧桩守卫)', async () => {
    const conn = {} as Parameters<typeof useChannelJournalInfo>[0];
    const { result } = renderHook(() => useChannelJournalInfo(conn, 'j1'));
    await act(async () => {});
    expect(result.current.isChannel).toBe(false);
    const connOk = { channelBindings: vi.fn(async () => binding('j1')) };
    const r2 = renderHook(() => useChannelJournalInfo(connOk, ''));
    await act(async () => {});
    expect(r2.result.current.isChannel).toBe(false);
    expect(connOk.channelBindings).not.toHaveBeenCalled();
  });
});
