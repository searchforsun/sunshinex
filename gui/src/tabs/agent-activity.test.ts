import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '../../../src/types';
import { applyAgentEvent } from './agent-activity';

/**
 * G8d Agents 标签聚合 reducer 纯测(task-3):payload.subagent 标签事件按 label 聚卡——
 * 建卡(首见即 running)/工具行(名+入参摘要 path 优先截 80)/滑窗 20/token 累计(turnTotal
 * 水位)/status 流转(running→done·error,error 粘滞;delegation-ended failed→error)/
 * 原引用守卫(无标签·不变事件同引用返回——StrictMode 安全)。
 * 聚合口径对齐 TUI ChildPanel(子代理面板;gui 侧零 import 独立实现)。
 */

let ts = 0;
/** 事件构造糖:ts 单调递增(reducer 不消费 ts,仅为类型完整) */
function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, text, payload, ts: ++ts };
}

/** 子代理事件构造糖:payload 合入 subagent 标签 */
const sub = (type: SessionEvent['type'], label: string, text?: string, payload: Record<string, unknown> = {}): SessionEvent =>
  ev(type, text, { ...payload, subagent: label });

describe('建卡与原引用守卫', () => {
  it('子代理事件首见 label 即建 running 卡(零先见 delegation 也行);delegation 无标签不建卡', () => {
    let s = applyAgentEvent({}, sub('tool-call', 'searcher', 'read', { input: { path: 'src/a.ts' }, callId: 'c1' }));
    expect(Object.keys(s)).toEqual(['searcher']);
    expect(s.searcher).toMatchObject({ label: 'searcher', status: 'running', tokens: 0, currentTool: 'read' });
    // delegation 事件无 subagent 标签:未建卡(建卡只靠子代理事件首见)——原引用返回
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

describe('工具行与滑窗', () => {
  it('tool-call:currentTool=工具名 + lines push {kind:tool,名+入参摘要(path 优先,截 80)}', () => {
    let s = applyAgentEvent({}, sub('tool-call', 'dev', 'write', { input: { path: 'src/a.ts', content: 'x' }, callId: 'c1' }));
    expect(s.dev!.currentTool).toBe('write');
    expect(s.dev!.lines).toEqual([{ kind: 'tool', text: 'write src/a.ts' }]);
    // 无 path 入参:JSON 摘要;长摘要截 80
    s = applyAgentEvent(s, sub('tool-call', 'dev', 'bash', { input: { command: 'x'.repeat(200) }, callId: 'c2' }));
    const line2 = s.dev!.lines[1]!;
    expect(line2.kind).toBe('tool');
    expect(line2.text.startsWith('bash {"command":"xxxx')).toBe(true);
    expect(line2.text.length).toBe(80);
    expect(s.dev!.currentTool).toBe('bash');
  });

  it('tool-result:lines push ✓/✗ + 工具名(ok=false → ✗)', () => {
    let s = applyAgentEvent({}, sub('tool-result', 'dev', 'written', { tool: 'write', ok: true, callId: 'c1' }));
    expect(s.dev!.lines).toEqual([{ kind: 'tool', text: '✓ write' }]);
    s = applyAgentEvent(s, sub('tool-result', 'dev', 'boom', { tool: 'read', ok: false, callId: 'c2' }));
    expect(s.dev!.lines[1]).toEqual({ kind: 'tool', text: '✗ read' });
  });

  it('lines 滑窗:每卡尾部 20 行(第 21 行起最旧行滚出)', () => {
    let s = applyAgentEvent({}, sub('token', 'dev', 'l0'));
    for (let i = 1; i <= 25; i += 1) s = applyAgentEvent(s, sub('token', 'dev', `l${i}`));
    expect(s.dev!.lines).toHaveLength(20);
    expect(s.dev!.lines[0]).toEqual({ kind: 'token', text: 'l6' }); // l0..l5 滚出
    expect(s.dev!.lines.at(-1)).toEqual({ kind: 'token', text: 'l25' });
    // 滑窗按卡独立:第二卡从零起算
    s = applyAgentEvent(s, sub('token', 'other', 'x'));
    expect(s.other!.lines).toHaveLength(1);
  });

  it('token 行截 120(超长增量只留前 120 字)', () => {
    const s = applyAgentEvent({}, sub('token', 'dev', 'y'.repeat(300)));
    expect(s.dev!.lines).toEqual([{ kind: 'token', text: 'y'.repeat(120) }]);
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
