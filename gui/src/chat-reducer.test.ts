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

  it('error：error 条入列但不封段不改状态(G14.51:done 必发,收口统一归 done——旁路错误不再裂条)', () => {
    const s = fold([ev('model-start'), ev('token', 'half'), ev('error', 'boom')]);
    expect(s.entries).toHaveLength(3); // G11：model-start 先插 run 条目，assistant/error 顺延
    expect(s.entries[0]!.kind).toBe('run');
    expect(s.entries[1]!.streaming).toBe(true); // 流式条保持在场,done 到达仍可合入终稿
    expect(s.entries[1]!.md).toBe('half');
    expect(s.entries[2]).toMatchObject({ kind: 'error', md: 'Error: boom' });
    expect(s.status).toBe('running');
    // 后续 done 照常收口:合并入同条,不裂两截
    const s2 = applyChatEvent(s, ev('done', 'half boom'));
    expect(s2.entries.filter((e) => e.kind === 'assistant')).toHaveLength(1);
    expect(s2.status).toBe('idle');
  });
});

describe('工具 callId 配对（乱序回填，字段单源单条）', () => {
  it('call 先到：条即时入列(pending),result 到达回填同条转终态(done 缺省)', () => {
    const called = fold([ev('tool-call', 'read', { callId: 'c1' })]);
    expect(called.entries).toHaveLength(1);
    expect(called.entries[0]).toMatchObject({ kind: 'tool', md: '', name: 'read', status: 'pending' }); // P11:字段单源,md 恒空
    const s = fold([
      ev('tool-call', 'read', { callId: 'c1' }),
      ev('tool-result', '42 chars', { callId: 'c1' }),
    ]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'tool', md: '', name: 'read', result: { text: '42 chars', ok: true } });
    expect(s.entries[0]!.status).toBeUndefined(); // done 以缺省承载(终态行字段省略)
  });

  it('result 先到（乱序）：占位条即刻终态入列，call 迟到回填 name 同条（位置不变，status 不回填）', () => {
    const s = fold([
      ev('notice', 'n'),
      ev('tool-result', 'out', { callId: 'c9' }),
      ev('tool-call', 'bash', { callId: 'c9' }),
    ]);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ kind: 'notice', md: 'n' });
    expect(s.entries[1]).toMatchObject({ kind: 'tool', md: '', name: 'bash', callId: 'c9', result: { text: 'out', ok: true } });
    expect(s.entries[1]!.status).toBeUndefined(); // result 先行条已终态——call 回填只补 name,不回 status
  });

  it('不同 callId 各自成条不串扰；多行 result 全文入 result.text（首行截断归渲染面）', () => {
    const s = fold([
      ev('tool-call', 'read', { callId: 'a' }),
      ev('tool-call', 'write', { callId: 'b' }),
      ev('tool-result', 'line1\nline2', { callId: 'b' }),
      ev('tool-result', 'ok', { callId: 'a' }),
    ]);
    expect(s.entries.map((e) => e.md)).toEqual(['', '']);
    expect(s.entries.map((e) => e.result?.text)).toEqual(['ok', 'line1\nline2']);
    expect(s.entries.every((e) => e.status === undefined)).toBe(true); // 配对完成即终态
  });

  it('无 callId：FIFO 配最老未配对 call 条（配对者转终态,落单者保持 pending）', () => {
    const s = fold([ev('tool-call', 'read'), ev('tool-call', 'grep'), ev('tool-result', 'first out')]);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ kind: 'tool', md: '', name: 'read', result: { text: 'first out', ok: true } });
    expect(s.entries[0]!.status).toBeUndefined();
    expect(s.entries[1]).toMatchObject({ kind: 'tool', md: '', name: 'grep', status: 'pending' }); // 未配对:pending 在场
    expect(s.entries[1]!.result).toBeUndefined();
  });

  it('无 callId 孤儿 result：以 payload.tool 为动词独立成条', () => {
    const s = fold([ev('tool-result', 'late', { tool: 'spawn' })]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'tool', md: '', name: 'spawn', result: { text: 'late', ok: true } });
    expect(s.entries[0]!.status).toBeUndefined(); // 孤儿条即刻终态
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
  it('notice/agent-message → notice 条;delegation 状态行零条目(G14.213 内核语义,可见性归委派徽标/Agents 页)', () => {
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
      'user|go',
      'notice|hello',
      'notice|[boss → dev] hi',
    ]);
  });

  it('delegation 两态(label 缺省回落 delegationId)同样零条目', () => {
    const s = fold([ev('delegation-started', undefined, { delegationId: 'd7' }), ev('delegation-ended', undefined, { delegationId: 'd7' })]);
    expect(s.entries).toHaveLength(0);
  });

  it('chat 面忽略事件：task-*/gate-*/route/model-end/approval-* 不产生条目(reasoning 已改为思考链聚合,见下组)', () => {
    const s0 = initialChatState();
    const s = fold(
      [
        ev('task-created', 't', { id: 't1' }),
        ev('gate-waiting'),
        ev('route', undefined, { tier: 'small' }),
        ev('model-end'),
        ev('approval-request', '?', { id: 'q' }),
      ],
      s0,
    );
    expect(s.entries).toEqual(s0.entries);
    expect(s).toBe(s0); // 全忽略时原状态引用透传（免无谓重渲染）
    // P9:ctx 已升级统计面事件——不产条目但水位入 k.stats(状态对象变更是预期行为)
    const withCtx = fold([ev('ctx', undefined, { used: 1 })], s0);
    expect(withCtx.entries).toEqual(s0.entries);
    expect(withCtx.k.stats.ctxUsed).toBe(1);
  });

  it('payload.subagent 事件不入主流(G8a:Agents 标签另聚;delegation 摘要行保留)', () => {
    let s = initialChatState();
    s = applyChatEvent(s, { type: 'tool-call', ts: 1, payload: { tool: 'read', subagent: 'ap-1' } } as never);
    s = applyChatEvent(s, { type: 'tool-result', ts: 2, payload: { tool: 'read', ok: true, subagent: 'ap-1' } } as never);
    s = applyChatEvent(s, { type: 'token', ts: 3, text: '子智能体流字', payload: { subagent: 'ap-1' } } as never);
    expect(s.entries).toHaveLength(0);
    s = applyChatEvent(s, { type: 'delegation-started', ts: 4, payload: { label: '搜库', delegationId: 'd1' } } as never);
    expect(s.entries).toHaveLength(0); // 委派状态行零条目(G14.213)
  });
});

describe('status·tokens·steps 聚合', () => {
  it('model-start→running；done→idle(error 不改态,收口归 done)', () => {
    let s = initialChatState();
    s = applyChatEvent(s, ev('model-start'));
    expect(s.status).toBe('running');
    s = applyChatEvent(s, ev('done', 'ok'));
    expect(s.status).toBe('idle');
    s = applyChatEvent(s, ev('model-start'));
    expect(s.status).toBe('running');
    s = applyChatEvent(s, ev('error', 'bad'));
    expect(s.status).toBe('running'); // G14.51:旁路错误不收口
    s = applyChatEvent(s, ev('done', 'ok'));
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

  it('usage 缓存命中累计（G14.18）：cacheHitTotal 与 tokens 同基线法，跨 run 累加不回零', () => {
    const s = fold([
      ev('model-start'),
      ev('usage', undefined, { turnTotal: 100, cacheHitTotal: 80 }),
      ev('usage', undefined, { turnTotal: 250, cacheHitTotal: 180 }), // run 内水位覆盖语义:增量 100
      ev('done', 'a'),
      ev('model-start'),
      ev('usage', undefined, { turnTotal: 50, cacheHitTotal: 40 }), // 新 run 低水位重启:再增 40
    ]);
    expect(s.tokens).toBe(300);
    expect(s.cacheTokens).toBe(220);
  });

  it('usage 无缓存回告（端点不支持）：cacheTokens 恒 0,tokens 照常累计', () => {
    const s = fold([
      ev('model-start'),
      ev('usage', undefined, { turnTotal: 120 }),
      ev('usage', undefined, { turnTotal: 200 }),
    ]);
    expect(s.tokens).toBe(200);
    expect(s.cacheTokens).toBe(0);
  });

  it('run 条尾插居 user 回显之后（G14.22）：轮次=[用户输入]→[Worked 行]→[回复]', () => {
    let s = initialChatState();
    s = appendUserMessage(s, '列出文件'); // 提交回显先入列
    s = applyChatEvent(s, ev('model-start')); // run 边界:run 条尾插,自然居 user 后
    expect(s.entries.map((e) => e.kind)).toEqual(['user', 'run']);
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

  it('子智能体 usage（payload.subagent）不进主链会话累计；无数值载荷不更新', () => {
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
  it('五 kind 直映射 entries（md 原文、无 streaming），status 读游标(P10),tokens/steps 0 起步', () => {
    const s = seedChatFromSnapshot(
      [
        { seq: 1, ts: 1, kind: 'user', md: 'goal' },
        { seq: 2, ts: 2, kind: 'tool', md: '', name: 'read', result: { text: 'ok', ok: true } },
        { seq: 3, ts: 3, kind: 'assistant', md: 'answer' },
        { seq: 4, ts: 4, kind: 'notice', md: '✻ dev started' },
        { seq: 5, ts: 5, kind: 'error', md: 'boom' },
      ],
      { openRun: -1, openSeg: -1 },
    );
    expect(s.entries.map((e) => ({ key: e.key, kind: e.kind, md: e.md, streaming: e.streaming }))).toEqual([
      { key: 'k1', kind: 'user', md: 'goal', streaming: undefined },
      { key: 'k2', kind: 'tool', md: '', streaming: undefined },
      { key: 'k3', kind: 'assistant', md: 'answer', streaming: undefined },
      { key: 'k4', kind: 'notice', md: '✻ dev started', streaming: undefined },
      { key: 'k5', kind: 'error', md: 'Error: boom', streaming: undefined }, // P10 前缀归渲染面
    ]);
    expect(s.status).toBe('idle'); // P10:status 读游标(-1=idle)
    expect(s.tokens).toBe(0);
    expect(s.steps).toBe(0);
  });

  it('P4.1 种子 tool 条内核字段直映(callId/name/input/result)——重放条经字段合成 info,折叠行目标/展开体全文不落 md', () => {
    const s = seedChatFromSnapshot(
      [
        {
          seq: 1, ts: 1, kind: 'tool',
          md: '',
          callId: 'c1', name: 'read', input: { path: 'src/cli/cli.test.ts' },
          result: { text: '{\n  "a": 1\n}\n', ok: true },
        },
      ],
      { openRun: -1, openSeg: -1 },
    );
    const tool = s.entries[0]!;
    expect(tool).toMatchObject({
      key: 'k1',
      kind: 'tool',
      callId: 'c1',
      name: 'read',
      input: { path: 'src/cli/cli.test.ts' },
      result: { text: '{\n  "a": 1\n}\n', ok: true },
    });
  });

  it('G14.51 快照竞态:P4 起游标由快照直供(内核权威,不再从条目反推)——部分回复按流式态摄入,done 合入不裂条', () => {
    // 挂载播种与流式跑动竞态:快照捕获到在途轮的部分回复(journal 已落档的 token 前缀);
    // openRun/openSeg 由 daemon 内核游标随快照携带,客户端零推导
    const seeded = seedChatFromSnapshot(
      [
        { seq: 1, ts: 1, kind: 'user', md: 'goal' },
        { seq: 2, ts: 2, kind: 'run', md: '' },
        { seq: 3, ts: 3, kind: 'assistant', md: '终稿' },
        { seq: 4, ts: 4, kind: 'notice', md: '✻ learned' },
      ],
      { openRun: 2, openSeg: 3 },
    );
    expect(seeded.k.openRun).toBe(2); // 游标直落内核态
    expect(seeded.k.openSeg).toBe(3);
    const asst = seeded.entries.find((e) => e.kind === 'assistant');
    expect(asst?.streaming).toBe(true); // 种子即流式态(done 可寻址)
    const runE = seeded.entries.find((e) => e.kind === 'run');
    expect(runE?.streaming).toBe(true); // Working 计时续推
    // 后续帧照常续推 + done 合入同条(不追加新条)
    let s = applyChatEvent(seeded, ev('token', '答复'));
    s = applyChatEvent(s, ev('done', '终稿答复', { steps: 3 }));
    const assistants = s.entries.filter((e) => e.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.md).toBe('终稿答复');
    expect(s.status).toBe('idle');
  });

  it('G14.51 快照竞态边界:游标 -1(末 run 已封/轮间静默)不标流式——上一轮回答不得并入下轮', () => {
    const seeded = seedChatFromSnapshot(
      [
        { seq: 1, ts: 1, kind: 'run', md: '', meta: { seconds: 5, steps: 2, tokens: 100 } },
        { seq: 2, ts: 2, kind: 'assistant', md: '上一轮回答' },
        { seq: 3, ts: 3, kind: 'notice', md: '✻ between rounds' },
      ],
      { openRun: -1, openSeg: -1 },
    );
    const asst = seeded.entries.find((e) => e.kind === 'assistant');
    expect(asst?.streaming).toBeUndefined();
    const runE = seeded.entries.find((e) => e.kind === 'run');
    expect(runE?.streaming).toBeUndefined();
  });

  it('seed 后事件续推：usage 从 0 基线续（重连 token 显示接受归零裁定，事件面续推）', () => {
    const s = applyChatEvent(seedChatFromSnapshot([{ seq: 1, ts: 1, kind: 'assistant', md: 'old' }], { openRun: -1, openSeg: -1 }), ev('model-start'));
    const s2 = applyChatEvent(s, ev('usage', undefined, { turnTotal: 10 }));
    expect(s2.tokens).toBe(10);  });

  it('P11 user 裸文直映(无剥前缀)+ tool status 直映', () => {
    const s = seedChatFromSnapshot(
      [
        { seq: 1, ts: 1, kind: 'user', md: 'goal' },
        { seq: 2, ts: 2, kind: 'tool', md: '', callId: 'c1', name: 'read', input: { path: 'a.ts' }, status: 'running' },
      ],
      { openRun: -1, openSeg: -1 },
    );
    expect(s.entries[0]).toMatchObject({ kind: 'user', md: 'goal' });
    expect(s.entries[1]).toMatchObject({ kind: 'tool', md: '', status: 'running' });
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

describe('条目时间戳(G9 B3a:日期分隔投影源)', () => {
  it('事件条透传 e.ts;种子条透传快照 ts;本地回显就地取时', () => {
    const e = ev('done', 'hi');
    const s = fold([e]);
    expect(s.entries[0]!.ts).toBe(e.ts);
    const seeded = seedChatFromSnapshot([{ seq: 1, ts: 1728380001000, kind: 'user', md: 'yo' }], { openRun: -1, openSeg: -1 });
    expect(seeded.entries[0]!.ts).toBe(1728380001000);
    const echoed = appendUserMessage(initialChatState(), 'yo', 999);
    expect(echoed.entries[0]!.ts).toBe(999);
  });
});

describe('run 边界条目(G11 状态行:idle→running 插入,done/error 封段计时)', () => {
  it('idle 态 model-start 插入 run 条目(streaming 标+ts);running 续轮不重复插', () => {
    let s = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'run', md: '', streaming: true, ts: 1_000 });
    s = applyChatEvent(s, { type: 'model-start', ts: 5_000 } as SessionEvent);
    expect(s.entries).toHaveLength(1);
  });

  it('done 封段:去 streaming 标、seconds 计 ts 差、steps/tokens 透传 done 载荷、endedTs 回填', () => {
    let s = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'token', text: '答', ts: 2_000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'done', text: '答', ts: 34_500, payload: { steps: 12, tokensUsed: 8400 } } as SessionEvent);
    const run = s.entries.find((e) => e.kind === 'run')!;
    expect(run).toMatchObject({ kind: 'run', streaming: undefined, seconds: 34, steps: 12, tokens: 8400, endedTs: 34_500 });
  });

  it('error 不封段(G14.51):run 保持流式,done 收口计时;done 无 ts 不计秒', () => {
    let s = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'error', text: 'boom', ts: 4_000 } as SessionEvent);
    expect(s.entries[0]).toMatchObject({ kind: 'run', streaming: true }); // 旁路错误不打断 run
    s = applyChatEvent(s, { type: 'done', text: 'x', ts: 5_000 } as SessionEvent);
    expect(s.entries[0]).toMatchObject({ kind: 'run', streaming: undefined, seconds: 4 });
    let s2 = applyChatEvent(initialChatState(), { type: 'model-start' } as SessionEvent); // 无 ts → run 条无起算点
    s2 = applyChatEvent(s2, { type: 'done', text: 'x', ts: 2_000 } as SessionEvent);
    expect(s2.entries[0]).toMatchObject({ kind: 'run', streaming: undefined });
    expect(s2.entries[0]!.seconds).toBeUndefined();
  });

  it('done 无 run 条目(直答面)不补插;多轮 run 各自成段', () => {
    const s = fold([ev('done', 'direct')]);
    expect(s.entries.map((e) => e.kind)).toEqual(['assistant']);
    let s2 = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    s2 = applyChatEvent(s2, { type: 'done', text: 'a', ts: 2_000 } as SessionEvent);
    s2 = applyChatEvent(s2, { type: 'model-start', ts: 10_000 } as SessionEvent);
    s2 = applyChatEvent(s2, { type: 'done', text: 'b', ts: 13_000 } as SessionEvent);
    expect(s2.entries.filter((e) => e.kind === 'run').map((r) => r.seconds)).toEqual([1, 3]);
  });

  it('seed 快照不产 run 条目(历史归档无 run 标)', () => {
    const s = seedChatFromSnapshot([{ seq: 1, ts: 1, kind: 'assistant', md: 'old' }], { openRun: -1, openSeg: -1 });
    expect(s.entries.map((e) => e.kind)).toEqual(['assistant']);
  });
});

describe('思考链聚合(G10-C3:reasoning → thinking 条)', () => {
  it('reasoning 开段续写;assistant token 封段计耗时;新 reasoning 再开新段', () => {
    let s = applyChatEvent(initialChatState(), { type: 'reasoning', text: '先看', ts: 1000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'reasoning', text: '结构', ts: 2000 } as SessionEvent);
    expect(s.entries[0]).toMatchObject({ kind: 'thinking', md: '先看结构', streaming: true });
    s = applyChatEvent(s, { type: 'token', text: '答', ts: 8000 } as SessionEvent); // 7s 后正文到 → 封段
    expect(s.entries[0]).toMatchObject({ kind: 'thinking', streaming: undefined, seconds: 7 });
    expect(s.entries[1]).toMatchObject({ kind: 'assistant', md: '答' });
    s = applyChatEvent(s, { type: 'reasoning', text: '再想', ts: 9000 } as SessionEvent);
    expect(s.entries[2]).toMatchObject({ kind: 'thinking', md: '再想', streaming: true });
  });

  it('done/tool-call 亦封思考段;无 ts 不计秒', () => {
    let s = applyChatEvent(initialChatState(), { type: 'reasoning', text: '想' } as SessionEvent);
    s = applyChatEvent(s, { type: 'done', text: '终' } as SessionEvent);
    expect(s.entries[0]).toMatchObject({ kind: 'thinking', streaming: undefined });
    expect(s.entries[0]!.seconds).toBeUndefined();
    expect(s.entries[1]!.kind).toBe('assistant');
  });
});

describe('queue 面板事件(P5:不入转录投影)', () => {
  it('queue 帧直通守卫:返回原引用零变更;开启段不被误闭合', () => {
    let s = applyChatEvent(initialChatState(), { type: 'user', text: '问', ts: 1000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'token', text: '答', ts: 2000 } as SessionEvent);
    const openKey = s.entries[1]!.key;
    const before = s;
    const next = applyChatEvent(s, { type: 'queue', ts: 3000, payload: { items: [{ seq: 0, text: 'x', front: false }] } } as unknown as SessionEvent);
    expect(next).toBe(before);
    expect(next.entries).toHaveLength(2);
    expect(next.entries[1]!.key).toBe(openKey);
    expect(next.entries[1]!.streaming).toBe(true);
  });
});

describe('structureVersion(P1 成员变更计数,派生冻结 memo key——spec §3.3)', () => {
  it('纯内容帧不递增,成员帧递增,种子重置为 1', () => {
    let s = seedChatFromSnapshot([], { openRun: -1, openSeg: -1 });
    expect(s.structureVersion).toBe(1);
    s = applyChatEvent(s, ev('model-start')); // run 条入列(成员帧)
    const svRun = s.structureVersion;
    expect(svRun).toBe(2);
    s = applyChatEvent(s, ev('token', '开头')); // 首个 token 开流式条=成员帧(合法递增——防 Task 2 过度冻结)
    const svOpen = s.structureVersion;
    expect(svOpen).toBe(svRun + 1);
    for (let i = 0; i < 5; i++) s = applyChatEvent(s, ev('token', 'x'));
    expect(s.structureVersion).toBe(svOpen); // token burst 落在已开条上:纯内容帧,不递增
    s = applyChatEvent(s, ev('tool-result', '孤儿输出')); // 无 callId 配对 → 孤儿 tool 条入列(成员帧)
    expect(s.structureVersion).toBe(svOpen + 1);
  });

  it('零变更透传帧(model-start 重复/queue)不动计数;空→空不算变更', () => {
    const s0 = seedChatFromSnapshot([], { openRun: -1, openSeg: -1 });
    expect(applyChatEvent(s0, ev('route'))).toBe(s0); // 透传帧连引用都不换,计数自然恒定
    const s1 = applyChatEvent(s0, ev('model-start'));
    expect(s1.structureVersion).toBe(2);
    const s2 = applyChatEvent(s1, ev('model-start')); // 已 running:内核零变更透传(run 不重复入列)
    expect(s2.structureVersion).toBe(s1.structureVersion);
  });

  it('tool-result 配对帧递增(result 引用跃迁),token burst 仍恒定', () => {
    let s = seedChatFromSnapshot([], { openRun: -1, openSeg: -1 });
    s = applyChatEvent(s, ev('model-start')); // run 条入列(成员帧)
    const svRun = s.structureVersion;
    s = applyChatEvent(s, ev('tool-call', 'read', { callId: 'c-pair' })); // pending tool 条入列(成员帧)
    const svCall = s.structureVersion;
    expect(svCall).toBe(svRun + 1);
    expect(s.entries[s.entries.length - 1]!.result).toBeUndefined(); // 尾条=pending tool,结果未配对
    s = applyChatEvent(s, ev('tool-result', '42 chars', { callId: 'c-pair', ok: true }));
    expect(s.entries[s.entries.length - 1]!.result?.text).toBe('42 chars'); // 原位配对落定
    expect(s.structureVersion).toBe(svCall + 1); // 修复点:长度/首键均不变,result 引用跃迁须递增(否则 taskNameOf 冻结陈旧)
    s = applyChatEvent(s, ev('token', '后续')); // 配对后首 token 开新流式条=成员帧(合法递增)
    const svOpen = s.structureVersion;
    expect(svOpen).toBe(svCall + 2);
    for (let i = 0; i < 5; i++) s = applyChatEvent(s, ev('token', 'x'));
    expect(s.structureVersion).toBe(svOpen); // token burst 仍恒定——第三条件不破坏冻结面
  });
});

describe('seedGen(种子代次——reseed 恒换新值,防 structureVersion 等值碰撞漏检)', () => {
  it('seedGen: 每次种子代次递增,structureVersion 保持种子语义', () => {
    const a = seedChatFromSnapshot([], { openRun: -1, openSeg: -1 });
    const b = seedChatFromSnapshot([], { openRun: -1, openSeg: -1 });
    expect(b.seedGen).toBe(a.seedGen + 1);
    expect(b.structureVersion).toBe(1);
  });
});
