import { describe, it, expect } from 'vitest';
import { applyChatEvent, initialChatState } from './chat-reducer';
import type { SessionEvent } from '../../src/types';

describe('probe: exit_plan 行状态翻转', () => {
  it('tool-call pending/running + tool-result completed → entry done', () => {
    let s = initialChatState();
    const mk = (type: string, seq: number, payload: Record<string, unknown>, text?: string): SessionEvent =>
      ({ type, seq, ts: Date.now(), ...(text !== undefined ? { text } : {}), payload } as unknown as SessionEvent);
    s = applyChatEvent(s, mk('model-start', 1, { step: 1 }));
    s = applyChatEvent(s, mk('tool-call', 2, { callId: 'step:2-idx:0', name: 'exit_plan', input: { name: '测试计划' }, status: 'pending' }, 'exit_plan'));
    s = applyChatEvent(s, mk('tool-call', 3, { callId: 'step:2-idx:0', name: 'exit_plan', input: { name: '测试计划' }, status: 'running' }, 'exit_plan'));
    s = applyChatEvent(s, mk('tool-result', 4, { callId: 'step:2-idx:0', status: 'completed', ok: true }, 'plan approved — implement'));
    const tools = s.k.entries.filter((e) => e.kind === 'tool');
    for (const t of tools) {
      console.log('tool entry:', JSON.stringify({ name: t.name, status: t.status, hasResult: t.result !== undefined }));
    }
    expect(tools.every((t) => t.status === undefined)).toBe(true);
  });
});
