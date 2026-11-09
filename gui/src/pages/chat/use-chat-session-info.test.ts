import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Connection } from '../../connection';
import type { ConfigChangedInfo } from '../../settings/use-config-changed';
import type { ChatState } from '../../chat-reducer';
import { useChatSessionInfo } from './use-chat-session-info';

/** 模型 pill 热重载钉（2026-11-09 用户实测「欢迎页有模型、会话页默认模型+发送报密钥未配置」）：
 *  daemon 收到配置变更后已热重载模型层，会话页须随 settings/providers 变更帧重拉 sessionModel，
 *  否则药丸停在挂载时的旧态；他类资源帧不触发重拉 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeConn(): { conn: Connection; calls: () => number; emit: (f: ConfigChangedInfo) => void } {
  let n = 0;
  const subs: Array<(f: ConfigChangedInfo) => void> = [];
  const conn = {
    sessionModel: () => {
      n += 1;
      return Promise.resolve({ current: n > 1 ? 'a/m1' : undefined, choices: [] });
    },
    onConfigChanged: (cb: (f: ConfigChangedInfo) => void) => {
      subs.push(cb);
      return () => undefined;
    },
  } as unknown as Connection;
  return { conn, calls: () => n, emit: (f) => subs.forEach((cb) => cb(f)) };
}

const CHAT = { status: 'idle', entries: [] } as unknown as ChatState;

describe('useChatSessionInfo 模型 pill 随配置变更重拉', () => {
  it('settings 与 providers 帧各触发一次重拉；mcp 帧不触发', async () => {
    const { conn, calls, emit } = makeConn();
    renderHook(() => useChatSessionInfo({ conn, sessionId: 's1', chat: CHAT }));
    expect(calls()).toBe(1);
    await act(async () => {
      emit({ resource: 'mcp', scope: 'global', root: null });
      vi.advanceTimersByTime(200);
    });
    expect(calls()).toBe(1);
    await act(async () => {
      emit({ resource: 'settings', scope: 'global', root: null });
      vi.advanceTimersByTime(200);
    });
    expect(calls()).toBe(2);
    await act(async () => {
      emit({ resource: 'providers', scope: 'global', root: null });
      vi.advanceTimersByTime(200);
    });
    expect(calls()).toBe(3);
  });
});
