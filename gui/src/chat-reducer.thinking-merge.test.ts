import { describe, it, expect } from 'vitest';
import { mergeSplitThinking, seedChatFromSnapshot } from './chat-reducer';
import type { ChatEntry, SnapshotTranscriptEntry } from './chat-reducer';

/** 被旁白截断的思考流复原(2026-11-07 用户报障):思考段之间只隔旁白 → 合并一行,旁白顺移其后 */

const th = (key: string, md: string, seconds?: number, streaming?: boolean): ChatEntry => ({
  key, kind: 'thinking', md, ...(seconds !== undefined ? { seconds } : {}), ...(streaming ? { streaming } : {}),
});
const note = (key: string): ChatEntry => ({ key, kind: 'notice', md: '[memory] saved: x' });

describe('mergeSplitThinking', () => {
  it('思考+旁白+思考 → 合并一行(正文拼接/秒数相加/键取首段),旁白顺移其后', () => {
    const out = mergeSplitThinking([th('k1', 'I put image near', 7), note('k2'), th('k3', ' top — answer honestly.', 1)]);
    expect(out.map((e) => e.key)).toEqual(['k1', 'k2']);
    expect(out[0]).toMatchObject({ kind: 'thinking', md: 'I put image near top — answer honestly.', seconds: 8 });
  });

  it('多次截断链式合并;续段流式中则合并行流式', () => {
    const out = mergeSplitThinking([th('a', 'A'), note('n1'), th('b', 'B'), note('n2'), note('n3'), th('c', 'C', undefined, true)]);
    expect(out.map((e) => e.key)).toEqual(['a', 'n1', 'n2', 'n3']);
    expect(out[0]).toMatchObject({ md: 'ABC', streaming: true });
  });

  it('隔着工具/正文不合并;无旁白相邻思考不合并;无合并原数组返回', () => {
    const tool: ChatEntry = { key: 't', kind: 'tool', md: '' };
    const list = [th('a', 'A'), tool, th('b', 'B'), th('c', 'C'), note('n')];
    expect(mergeSplitThinking(list)).toBe(list);
  });

  it('合并视图跨帧复用(段引用不变即同一对象)', () => {
    const parts = [th('k1', 'x'), note('k2'), th('k3', 'y')];
    expect(mergeSplitThinking(parts)[0]).toBe(mergeSplitThinking([...parts])[0]);
  });

  it('快照播种(用户截图轮形态)→ 视图仅一条思考', () => {
    const msgs = [
      { seq: 8, kind: 'user', md: 'q' },
      { seq: 10, kind: 'thinking', md: 'in my previous reply I put image near', seconds: 7 },
      { seq: 11, kind: 'notice', md: '[memory] saved: User-s-preferred-communication-language' },
      { seq: 12, kind: 'thinking', md: ' top — just answer honestly.', seconds: 1 },
      { seq: 13, kind: 'assistant', md: 'answer' },
    ] as SnapshotTranscriptEntry[];
    const s = seedChatFromSnapshot(msgs, { openRun: -1, openSeg: -1 });
    const kinds = s.entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'thinking')).toHaveLength(1);
    expect(s.entries.find((e) => e.kind === 'thinking')!.md).toBe('in my previous reply I put image near top — just answer honestly.');
    expect(kinds.indexOf('notice')).toBe(kinds.indexOf('thinking') + 1);
  });
});
