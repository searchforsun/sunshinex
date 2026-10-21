import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '../../../src/types';
import { applyAgentEvent } from './agent-activity';

/**
 * G8d 子智能体活动聚合 reducer 纯测(task-3):payload.subagent 标签事件按 label 聚卡——
 * 建卡(首见即 running)/currentTool 锚/token 累计(turnTotal 水位)/status 流转(running→
 * done·error,error 粘滞;delegation-ended failed→error)/chat 内核投影(转录页条目单源)/
 * 原引用守卫(无标签·不变事件同引用返回——StrictMode 安全)。
 * 聚合口径对齐 TUI ChildPanel(子智能体面板;gui 侧零 import 独立实现)。
 */

let ts = 0;
/** 事件构造糖:ts 单调递增(reducer 不消费 ts,仅为类型完整) */
function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, text, payload, ts: ++ts };
}

/** 子智能体事件构造糖:payload 合入 subagent 标签 */
const sub = (type: SessionEvent['type'], label: string, text?: string, payload: Record<string, unknown> = {}): SessionEvent =>
  ev(type, text, { ...payload, subagent: label });

describe('建卡与原引用守卫', () => {
  it('子智能体事件首见 label 即建 running 卡(零先见 delegation 也行);delegation 无标签不建卡', () => {
    let s = applyAgentEvent({}, sub('tool-call', 'searcher', 'read', { input: { path: 'src/a.ts' }, callId: 'c1' }));
    expect(Object.keys(s)).toEqual(['searcher']);
    expect(s.searcher).toMatchObject({ label: 'searcher', status: 'running', tokens: 0, currentTool: 'read' });
    // delegation 事件无 subagent 标签:未建卡(建卡只靠子智能体事件首见)——原引用返回
    const before = s;
    s = applyAgentEvent(s, ev('delegation-started', undefined, { label: 'ghost', delegationId: 'ghost', kind: 'subagent' }));
    expect(s).toBe(before);
    expect(s.ghost).toBeUndefined();
  });

  it('无标签事件原引用返回(非 delegation 系一概不动)', () => {
    const s = applyAgentEvent({}, sub('token', 'a1', 'x'));
    for (const e of [
      ev('token', '主流字'),
      ev('tool-call', 'read', { callId: 'c9' }),
      ev('usage', undefined, { turnTotal: 500 }),
      ev('model-start'),
      { ...ev('done', 'fin'), payload: { subagent: 42 } }, // 标签非 string(坏载荷)
    ] as SessionEvent[]) {
      expect(applyAgentEvent(s, e)).toBe(s);
    }
  });

  it('不变事件原引用返回:usage 无 turnTotal/已 error 再 error/已 done 的 done', () => {
    let s = applyAgentEvent({}, sub('usage', 'w1', undefined, { turnTotal: 100 }));
    expect(applyAgentEvent(s, sub('usage', 'w1'))).toBe(s); // 无 turnTotal
    s = applyAgentEvent(s, sub('error', 'w1', 'boom'));
    expect(s.w1!.status).toBe('error');
    expect(applyAgentEvent(s, sub('error', 'w1', 'again'))).toBe(s); // error 幂等
    s = applyAgentEvent(s, sub('done', 'w1', 'fin'));
    expect(s.w1!.status).toBe('error'); // error 粘滞:done 不覆写
  });

  it('不改入参(纯函数;既有卡对象引用复用)', () => {
    const s0 = applyAgentEvent({}, sub('token', 'a1', 'x'));
    const s1 = applyAgentEvent(s0, sub('token', 'a2', 'y'));
    expect(s0.a2).toBeUndefined();
    expect(s1.a1).toBe(s0.a1); // 未动卡原对象引用复用
  });
});

describe('currentTool 锚', () => {
  it('tool-call 置 currentTool;tool-result 保留最后工具名(完成态「正在做」锚由 status 承担)', () => {
    let s = applyAgentEvent({}, sub('tool-call', 'dev', 'write', { input: { path: 'src/a.ts', content: 'x' }, callId: 'c1' }));
    expect(s.dev!.currentTool).toBe('write');
    s = applyAgentEvent(s, sub('tool-call', 'dev', 'bash', { input: { command: 'x'.repeat(200) }, callId: 'c2' }));
    expect(s.dev!.currentTool).toBe('bash');
    s = applyAgentEvent(s, sub('tool-result', 'dev', 'ok', { tool: 'bash', ok: true, callId: 'c2' }));
    expect(s.dev!.currentTool).toBe('bash'); // 不清空
  });

  it('空工具名 tool-call 不动 currentTool', () => {
    let s = applyAgentEvent({}, sub('tool-call', 'dev', 'read', { callId: 'c1' }));
    s = applyAgentEvent(s, sub('tool-call', 'dev', '', { callId: 'c2' }));
    expect(s.dev!.currentTool).toBe('read');
  });
});

describe('token 累计与 status 流转', () => {
  it('usage:turnTotal 水位累计(卡内自持 base;回退/等值不增)', () => {
    let s = applyAgentEvent({}, sub('usage', 'dev', undefined, { turnTotal: 100 }));
    expect(s.dev!.tokens).toBe(100);
    s = applyAgentEvent(s, sub('usage', 'dev', undefined, { turnTotal: 250 }));
    expect(s.dev!.tokens).toBe(250);
    s = applyAgentEvent(s, sub('usage', 'dev', undefined, { turnTotal: 80 })); // 回退:水位保持
    expect(s.dev!.tokens).toBe(250);
  });

  it('status 流转:error → error;done(运行中)→ done;delegation-ended failed → error·done → done;delegation-started 复活 running', () => {
    let s = applyAgentEvent({}, sub('token', 'rev', 'x'));
    s = applyAgentEvent(s, sub('error', 'rev', 'model down'));
    expect(s.rev!.status).toBe('error');
    // delegation-ended(无标签):payload.label 命中既有卡 → failed → error(权威终语)
    s = applyAgentEvent(s, ev('delegation-ended', undefined, { label: 'rev', delegationId: 'rev', kind: 'subagent', status: 'failed' }));
    expect(s.rev!.status).toBe('error');
    // delegation-started 复活(同名再派):running
    s = applyAgentEvent(s, ev('delegation-started', undefined, { label: 'rev', delegationId: 'rev', kind: 'subagent' }));
    expect(s.rev!.status).toBe('running');
    // 运行中 done(子链收尾事件)→ done
    s = applyAgentEvent(s, sub('done', 'rev', 'fin'));
    expect(s.rev!.status).toBe('done');
    // delegation-ended status=done → done(幂等)
    s = applyAgentEvent(s, ev('delegation-ended', undefined, { label: 'rev', delegationId: 'rev', kind: 'subagent', status: 'done', tokens: 42 }));
    expect(s.rev!.status).toBe('done');
  });

  it('delegation 系标签未命中既有卡:原引用(不建卡);status 缺省 ended → done', () => {
    let s = applyAgentEvent({}, sub('token', 'a', 'x'));
    const before = s;
    s = applyAgentEvent(s, ev('delegation-started', undefined, { label: 'unknown', kind: 'subagent' }));
    expect(s).toBe(before);
    // 命中但 status 缺省:ended → done
    s = applyAgentEvent(s, ev('delegation-ended', undefined, { label: 'a', delegationId: 'a', kind: 'subagent' }));
    expect(s.a!.status).toBe('done');
  });
});

describe('G14.2xx b chat 投影对标主对话(reasoning/run/steps 入核)', () => {
  it('reasoning 走 withChat:转录 chat 出现 thinking 条目(此前滑窗单轨缺失的病根)', () => {
    let s = applyAgentEvent({}, sub('reasoning', 'th', '先看目录'));
    s = applyAgentEvent(s, sub('reasoning', 'th', ',再读入口文件'));
    const think = s.th!.chat.entries.filter((e) => e.kind === 'thinking');
    expect(think).toHaveLength(1);
    expect(think[0]!.md).toBe('先看目录,再读入口文件');
    expect(think[0]!.streaming).toBe(true); // 开启段流式(封段随边界事件)
  });

  it('model-start/step 入投影:run 条开启(openRun/status=running)、steps 计数;done 封 run 回 idle', () => {
    let s = applyAgentEvent({}, sub('model-start', 'rn'));
    expect(s.rn!.chat.k.openRun).toBeGreaterThanOrEqual(0); // run 条开启
    expect(s.rn!.chat.status).toBe('running');
    const runEntry = s.rn!.chat.entries.find((e) => e.kind === 'run');
    expect(runEntry).toBeDefined();
    expect(runEntry!.streaming).toBe(true);
    s = applyAgentEvent(s, sub('step', 'rn', 'model'));
    s = applyAgentEvent(s, sub('step', 'rn', 'model'));
    expect(s.rn!.chat.steps).toBe(2); // 此前 default 分支原引用返回,steps 恒 0
    s = applyAgentEvent(s, sub('usage', 'rn', undefined, { turnTotal: 77 }));
    expect(s.rn!.chat.tokens).toBe(77);
    s = applyAgentEvent(s, sub('done', 'rn', '结论'));
    expect(s.rn!.chat.status).toBe('idle'); // 封 run 回 idle(run-live 行随之熄灭)
    const sealedRun = s.rn!.chat.entries.find((e) => e.kind === 'run');
    expect(sealedRun!.streaming).toBeUndefined();
  });

  it('model-start 首见也建卡(此前 default 不建卡——run 条丢失的连生根)', () => {
    const s = applyAgentEvent({}, sub('model-start', 'first'));
    expect(s.first).toBeDefined();
    expect(s.first!.chat.entries.some((e) => e.kind === 'run')).toBe(true);
  });

  it('error 粘滞但 done 权威终语仍封 chat 投影(openRun 不悬空——运行态行不永转)', () => {
    let s = applyAgentEvent({}, sub('model-start', 'er'));
    s = applyAgentEvent(s, sub('error', 'er', 'boom'));
    expect(s.er!.status).toBe('error');
    expect(s.er!.chat.status).toBe('running'); // error 不封段(G14.51 同口径)
    s = applyAgentEvent(s, sub('done', 'er', '收尾'));
    expect(s.er!.status).toBe('error'); // 卡状态粘滞(done 不覆写)
    expect(s.er!.chat.status).toBe('idle'); // 投影已封 run——run-live 熄灭
  });

  it('零变化事件原引用返回:等值 usage 不动投影(StrictMode 纪律);route 封开启段但不产 run 条', () => {
    const before = applyAgentEvent({}, sub('usage', 'q', undefined, { turnTotal: 500 }));
    const after = applyAgentEvent(before, sub('usage', 'q', undefined, { turnTotal: 500 }));
    expect(after).toBe(before); // 等值 usage:投影零变化原引用
    // route 是段边界(封开启段,主对话 applyEvent default 同款)——封段但零 run 条
    const s = applyAgentEvent(before, sub('token', 'q', '正文'));
    expect(s.q!.chat.entries.find((e) => e.kind === 'assistant')!.streaming).toBe(true);
    const s2 = applyAgentEvent(s, sub('route', 'q', undefined, { to: 'm1' }));
    expect(s2.q!.chat.entries.find((e) => e.kind === 'assistant')!.streaming).toBeUndefined();
    expect(s2.q!.chat.entries.some((e) => e.kind === 'run')).toBe(false);
  });

  it('工具三态投影:call pending→running→result done 逐帧直映(数据面对标主对话)', () => {
    let s = applyAgentEvent({}, sub('tool-call', 'tri', 'read', { input: { path: 'a.ts' }, callId: 'c1', status: 'pending' }));
    expect(s.tri!.chat.entries.map((e) => e.status)).toContain('pending');
    s = applyAgentEvent(s, sub('tool-call', 'tri', 'read', { input: { path: 'a.ts' }, callId: 'c1', status: 'running' }));
    expect(s.tri!.chat.entries.map((e) => e.status)).toContain('running');
    s = applyAgentEvent(s, sub('tool-result', 'tri', 'ok', { callId: 'c1', ok: true, tool: 'read' }));
    for (const e of s.tri!.chat.entries) expect(e.status).toBeUndefined(); // 终态以缺省承载
  });
});
