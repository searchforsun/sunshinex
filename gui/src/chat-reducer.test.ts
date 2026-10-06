import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '../../src/types';
import { applyChatEvent, appendUserMessage, initialChatState, seedChatFromSnapshot } from './chat-reducer';

/**
 * G3 chat reducer 纯测：流式 token 拼接 / done 收段（重叠覆盖+不重叠补入）/ 工具 callId 配对
 * （乱序回填/FIFO/孤儿）/ 五 kind 入列 / status·tokens·steps 聚合 / seed 快照映射。
 * 工具配对语义与 daemon TranscriptCollector 同构（gui 侧独立实现，两轨并行防形态漂移——
 * 断言以行为为准，不 import daemon 侧代码）。
 */

let ts = 0;
/** 事件构造糖：ts 单调递增（reducer 不消费 ts，仅为类型完整） */
function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, text, payload, ts: ++ts };
}
/** 状态折叠：events 依序 apply */
function fold(events: SessionEvent[], start = initialChatState()) {
  return events.reduce(applyChatEvent, start);
}

describe('流式 token 拼接与 done 收段', () => {
  it('token 增量并入当前 streaming 条（无则开条，streaming 标在场）', () => {
    const s = fold([ev('token', 'Hello '), ev('token', 'wor'), ev('token', 'ld')]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'assistant', md: 'Hello world' });
    expect(s.entries[0]!.streaming).toBe(true);
  });

  it('done 收段：streaming 标去除 + text 为终稿（与已累积重叠→覆盖）+ status idle', () => {
    const s = fold([
      ev('model-start'),
      ev('token', 'Hello wor'),
      ev('token', 'ld'),
      ev('done', 'Hello world!'), // 终稿以累积为前缀（多出感叹号）→ 以终稿为准
    ]);
    const last = s.entries.at(-1)!;
    expect(last).toMatchObject({ kind: 'assistant', md: 'Hello world!' });
    expect(last.streaming).toBeUndefined(); // 收段：流式标去除
    expect(s.status).toBe('idle');
  });

  it('done 补入：text 与已累积不重叠→追加（md += done text）', () => {
    const s = fold([ev('token', '部分'), ev('done', '完整终稿')]);
    expect(s.entries.at(-1)!.md).toBe('部分完整终稿');
    expect(s.entries.at(-1)!.streaming).toBeUndefined();
  });

  it('done 无 streaming 条时独立成条（事件面：done 恒有终稿条）', () => {
    const s = fold([ev('done', 'direct answer')]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'assistant', md: 'direct answer' });
  });

  it('新一轮 token 在 done 后开新条（旧条不再接收增量）', () => {
    const s = fold([ev('token', 'a'), ev('done', 'a'), ev('token', 'b')]);
    expect(s.entries.map((e) => e.md)).toEqual(['a', 'b']);
  });

  it('error：error 条入列 + status idle + 悬挂 streaming 条收段（不留永久流式标）', () => {
    const s = fold([ev('model-start'), ev('token', 'half'), ev('error', 'boom')]);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]!.streaming).toBeUndefined();
    expect(s.entries[0]!.md).toBe('half');
    expect(s.entries[1]).toMatchObject({ kind: 'error', md: 'boom' });
    expect(s.status).toBe('idle');
  });
});

describe('工具 callId 配对（乱序回填，单条两行）', () => {
  it('call 先到：verb 行即时、result 行占位 …，result 到达回填同条', () => {
    const s = fold([
      ev('tool-call', 'read', { callId: 'c1' }),
      ev('tool-result', '42 chars', { callId: 'c1' }),
    ]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'tool', md: '● read\n⎿ 42 chars' });
  });

  it('result 先到（乱序）：verb 行占位入列，call 迟到回填同条（位置不变）', () => {
    const s = fold([
      ev('notice', 'n'),
      ev('tool-result', 'out', { callId: 'c9' }),
      ev('tool-call', 'bash', { callId: 'c9' }),
    ]);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ kind: 'notice', md: 'n' });
    expect(s.entries[1]).toMatchObject({ kind: 'tool', md: '● bash\n⎿ out' });
  });

  it('不同 callId 各自成条不串扰；多行 result 只取首行', () => {
    const s = fold([
      ev('tool-call', 'read', { callId: 'a' }),
      ev('tool-call', 'write', { callId: 'b' }),
      ev('tool-result', 'line1\nline2', { callId: 'b' }),
      ev('tool-result', 'ok', { callId: 'a' }),
    ]);
    expect(s.entries.map((e) => e.md)).toEqual(['● read\n⎿ ok', '● write\n⎿ line1']);
  });

  it('无 callId：FIFO 配最老未配对 call 条', () => {
    const s = fold([ev('tool-call', 'read'), ev('tool-call', 'grep'), ev('tool-result', 'first out')]);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]!.md).toBe('● read\n⎿ first out');
    expect(s.entries[1]!.md).toBe('● grep\n⎿ …');
  });

  it('无 callId 孤儿 result：以 payload.tool 为动词独立成条', () => {
    const s = fold([ev('tool-result', 'late', { tool: 'spawn' })]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.md).toBe('● spawn\n⎿ late');
  });

  it('streaming 条在 tool-call 时收段（流与工具不混条）', () => {
    const s = fold([ev('token', '正文'), ev('tool-call', 'read', { callId: 'x' }), ev('token', '后续')]);
    expect(s.entries.map((e) => [e.kind, e.streaming ?? null])).toEqual([
      ['assistant', null],
      ['tool', null],
      ['assistant', true],
    ]);
  });
});

describe('五 kind 与 notice 系映射', () => {
  it('notice/delegation/agent-message → notice 条（delegation 单行 ✻ label status）', () => {
    const s = fold(
      [
        ev('notice', 'hello'),
        ev('delegation-started', undefined, { label: 'dev', delegationId: 'd1' }),
        ev('delegation-ended', undefined, { label: 'dev', status: 'done' }),
        ev('agent-message', undefined, { from: 'boss', to: 'dev', text: 'hi' }),
      ],
      appendUserMessage(initialChatState(), 'go'),
    );
    expect(s.entries.map((e) => `${e.kind}|${e.md}`)).toEqual([
      'user|> go',
      'notice|hello',
      'notice|✻ dev started',
      'notice|✻ dev done',
      'notice|[boss → dev] hi',
    ]);
  });

  it('delegation label 缺省回落 delegationId，status 缺省 ended', () => {
    const s = fold([ev('delegation-started', undefined, { delegationId: 'd7' }), ev('delegation-ended', undefined, { delegationId: 'd7' })]);
    expect(s.entries.map((e) => e.md)).toEqual(['✻ d7 started', '✻ d7 ended']);
  });

  it('chat 面忽略事件：task-*/gate-*/route/ctx/model-end/reasoning/approval-* 不产生条目', () => {
    const s0 = initialChatState();
    const s = fold(
      [
        ev('task-created', 't', { id: 't1' }),
        ev('gate-waiting'),
        ev('route', undefined, { tier: 'small' }),
        ev('ctx', undefined, { used: 1 }),
        ev('model-end'),
        ev('reasoning', 'think'),
        ev('approval-request', '?', { id: 'q' }),
      ],
      s0,
    );
    expect(s.entries).toEqual(s0.entries);
    expect(s).toBe(s0); // 全忽略时原状态引用透传（免无谓重渲染）
  });
});

describe('status·tokens·steps 聚合', () => {
  it('model-start→running；done/error→idle', () => {
    let s = initialChatState();
    s = applyChatEvent(s, ev('model-start'));
    expect(s.status).toBe('running');
    s = applyChatEvent(s, ev('done', 'ok'));
    expect(s.status).toBe('idle');
    s = applyChatEvent(s, ev('model-start'));
    expect(s.status).toBe('running');
    s = applyChatEvent(s, ev('error', 'bad'));
    expect(s.status).toBe('idle');
  });

  it('usage 会话累计：单 run 内 turnTotal 增量累计（非直接赋值）', () => {
    const s = fold([
      ev('model-start'),
      ev('usage', undefined, { turnTotal: 100 }),
      ev('usage', undefined, { turnTotal: 250 }),
    ]);
    expect(s.tokens).toBe(250);
  });

  it('usage 跨 run 累计：水位仅在 run 边界重置（idle 态 model-start），会话 tokens 不回零', () => {
    const s = fold([
      ev('model-start'), // run 1 起（idle → 边界重置）
      ev('usage', undefined, { turnTotal: 300 }),
      ev('done', 'a'), // run 1 收束 → idle
      ev('model-start'), // run 2 起（idle → 边界重置；新 run turnTotal 从低值重启）
      ev('usage', undefined, { turnTotal: 50 }),
      ev('usage', undefined, { turnTotal: 70 }),
    ]);
    expect(s.tokens).toBe(370);
  });

  it('多轮 run（工具续轮）不虚增：run 内续 model-start（running 态）不重置水位', () => {
    // 事件源事实（reactor.ts）：model-start 每 chatRound 一次（:450），turnTotal 为 run 级单调累计
    // （:293）——轮间重置旧缺陷会把 run 累计值从 0 重复起算（100 + 180 = 280 虚增）
    const s = fold([
      ev('model-start'), // run 起（idle → 重置水位）
      ev('usage', undefined, { turnTotal: 100 }),
      ev('tool-call', 'read', { callId: 'c1' }),
      ev('tool-result', 'ok', { callId: 'c1' }),
      ev('model-start'), // 同 run 第二轮（running）——不重置
      ev('usage', undefined, { turnTotal: 180 }),
      ev('done', 'fin'),
    ]);
    expect(s.tokens).toBe(180);
  });

  it('子代理 usage（payload.subagent）不进主链会话累计；无数值载荷不更新', () => {
    const s = fold([
      ev('model-start'),
      ev('usage', undefined, { turnTotal: 100 }),
      ev('usage', undefined, { subagent: 'r1', turnTotal: 5000 }),
      ev('usage', undefined, {}),
    ]);
    expect(s.tokens).toBe(100);
  });

  it('step 事件计数', () => {
    const s = fold([ev('step', 'a'), ev('step', 'b'), ev('step', 'c')]);
    expect(s.steps).toBe(3);
  });
});

describe('seedChatFromSnapshot（onResync 基线）', () => {
  it('五 kind 直映射 entries（md 原文、无 streaming），status 采参数，tokens/steps 0 起步', () => {
    const s = seedChatFromSnapshot(
      [
        { seq: 1, ts: 1, kind: 'user', md: '> goal' },
        { seq: 2, ts: 2, kind: 'tool', md: '● read\n⎿ ok' },
        { seq: 3, ts: 3, kind: 'assistant', md: 'answer' },
        { seq: 4, ts: 4, kind: 'notice', md: '✻ dev started' },
        { seq: 5, ts: 5, kind: 'error', md: 'boom' },
      ],
      'running',
    );
    expect(s.entries.map((e) => ({ key: e.key, kind: e.kind, md: e.md, streaming: e.streaming }))).toEqual([
      { key: 's1', kind: 'user', md: '> goal', streaming: undefined },
      { key: 's2', kind: 'tool', md: '● read\n⎿ ok', streaming: undefined },
      { key: 's3', kind: 'assistant', md: 'answer', streaming: undefined },
      { key: 's4', kind: 'notice', md: '✻ dev started', streaming: undefined },
      { key: 's5', kind: 'error', md: 'boom', streaming: undefined },
    ]);
    expect(s.status).toBe('running');
    expect(s.tokens).toBe(0);
    expect(s.steps).toBe(0);
  });

  it('seed 后事件续推：usage 从 0 基线续（重连 token 显示接受归零裁定，事件面续推）', () => {
    const s = applyChatEvent(seedChatFromSnapshot([{ seq: 1, ts: 1, kind: 'assistant', md: 'old' }], 'idle'), ev('model-start'));
    const s2 = applyChatEvent(s, ev('usage', undefined, { turnTotal: 10 }));
    expect(s2.tokens).toBe(10);
  });
});

describe('纯函数性（immutable）', () => {
  it('applyChatEvent 不改入参（返回新引用；未动条目引用复用）', () => {
    const s0 = initialChatState();
    const s1 = applyChatEvent(s0, ev('token', 'x'));
    expect(s0.entries).toHaveLength(0);
    expect(s1).not.toBe(s0);
    const s2 = applyChatEvent(s1, ev('token', 'y'));
    expect(s1.entries[0]!.md).toBe('x');
    expect(s2.entries[0]!.md).toBe('xy');
    expect(s2.entries[0]).not.toBe(s1.entries[0]);
  });
});
