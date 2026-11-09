import { describe, it, expect, beforeEach } from 'vitest';

import { renderHook, act } from '@testing-library/react';
import { readFoldMemo, useChatFold } from './use-chat-fold';
import type { ChatState } from '../../chat-reducer';
import type { Connection } from '../../connection';

/** 轮次折叠手动态按会话持久:折叠/展开记录跨重挂(切换会话=Chat 以 key={sessionId} 重挂)读回 */
const run = (key: string, streaming: boolean) => ({ key, kind: 'run', md: '', ...(streaming ? { streaming: true } : {}) });
const chatOf = (entries: unknown[]): ChatState => ({ entries, structureVersion: 1, seedGen: 1 }) as unknown as ChatState;
const mount = (sessionId: string, entries: unknown[]) =>
  renderHook(() =>
    useChatFold({ chat: chatOf(entries), setChat: () => undefined, conn: {} as Connection, sessionId, chatScrollRef: { current: null }, chatStickRef: { current: false } }),
  );

beforeEach(() => localStorage.clear());

describe('轮次折叠手动态按会话持久', () => {
  it('运行中轮手动折叠 → 重挂(切回会话)仍折叠', () => {
    const a = mount('s1', [run('k1', true)]);
    expect(a.result.current.collapsedRuns.has('k1')).toBe(false);
    act(() => a.result.current.toggleRun('k1'));
    a.unmount();
    expect(readFoldMemo('s1').c).toEqual(['k1']);
    const b = mount('s1', [run('k1', true)]);
    expect(b.result.current.collapsedRuns.has('k1')).toBe(true);
  });
  it('已封段轮手动展开 → 重挂不被自动折叠回去;他会话不受影响', () => {
    const a = mount('s1', [run('k1', false)]);
    expect(a.result.current.collapsedRuns.has('k1')).toBe(true);
    act(() => a.result.current.toggleRun('k1'));
    a.unmount();
    const b = mount('s1', [run('k1', false)]);
    expect(b.result.current.collapsedRuns.has('k1')).toBe(false);
    const c = mount('s2', [run('k1', false)]);
    expect(c.result.current.collapsedRuns.has('k1')).toBe(true);
  });
});
