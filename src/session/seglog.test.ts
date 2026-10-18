import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceSteerRows, reduceSegRows, kernelEventRows } from './seglog';
import { SessionKernel } from './kernel';
import type { KernelEvent } from './kernel';
import type { KernelEntry } from './entry';
import type { SessionEvent } from '../types';

/** v3 段级行重放/往返测试(session-kernel spec §3.2 装载序;journal v3 零兼容,P11-T2):
 *  行面语义(seg 顺序零变换直读/seg-update 按 seq 字段回填/run-open/runmeta 对位/truncate 即时生效/
 *  悬空 run 标停止/悬空 tool 补 interrupted)
 *  与写读往返(live 事件流 → 内核事件 → 行 → reduceSegRows → seed → replay 与 live 等价)。 */

function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>, ts = 4242): SessionEvent {
  return { type, ts, ...(text !== undefined ? { text } : {}), ...(payload !== undefined ? { payload } : {}) };
}

/** 事件流 → v3 行(P2 写者映射的独立复刻——serve/session.persistKernelEvent 同规则;断言两侧不漂移) */
function kernelEventsToRows(events: KernelEvent[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const e of events) {
    if (e.t === 'seg-open') {
      const en = e.entry;
      if (en.kind === 'run') {
        rows.push({ t: 'run-open', ts: en.ts, seq: en.seq });
        continue;
      }
      if (e.open && (en.kind === 'assistant' || en.kind === 'thinking')) continue;
      rows.push({ t: 'seg', kind: en.kind, md: en.md, ts: en.ts, seq: en.seq, ...(en.callId !== undefined ? { callId: en.callId } : {}), ...(en.name !== undefined ? { name: en.name } : {}), ...(en.input !== undefined ? { input: en.input } : {}), ...(en.seconds !== undefined ? { seconds: en.seconds } : {}) });
      if (en.kind === 'tool' && en.result !== undefined) rows.push({ t: 'seg-update', seq: en.seq, ts: en.ts, result: en.result });
      continue;
    }
    if (e.t === 'seg-close') {
      const en = e.entry;
      rows.push({ t: 'seg', kind: en.kind, md: en.md, ts: en.ts, seq: en.seq, ...(en.seconds !== undefined ? { seconds: en.seconds } : {}) });
      continue;
    }
    if (e.t === 'seg-update') {
      const en = e.entry;
      rows.push({ t: 'seg-update', seq: en.seq, ts: en.ts, ...(en.name !== undefined ? { name: en.name } : {}), ...(en.input !== undefined ? { input: en.input } : {}), ...(en.result !== undefined ? { result: en.result } : {}) });
      continue;
    }
    if (e.t === 'steer') {
      rows.push({ t: 'steer', items: e.items.map((x) => ({ ...x })) });
      continue;
    }
    if (e.t === 'stats') continue; // 统计面零落档(P9)
    rows.push({ t: 'truncate', upToSeq: e.upToSeq });
  }
  return rows;
}

/** live 事件流泵入内核并落行 → 重放 → 双方条目等价(往返一致性,spec §7 装载-重放往返断言) */
function roundTrip(events: SessionEvent[]): { live: KernelEntry[]; replayed: KernelEntry[] } {
  const rows: Record<string, unknown>[] = [];
  const k = new SessionKernel({ onKernelEvent: (e) => rows.push(...kernelEventsToRows([e])) });
  for (const e of events) k.pump(e);
  const k2 = new SessionKernel();
  k2.seed(reduceSegRows(rows));
  return { live: k.replay(), replayed: k2.replay() };
}

function assertSameShape(a: KernelEntry, b: KernelEntry, path: string): void {
  // run 条 meta 由 runmeta 行对位——往返里 runmeta 行缺位时 live 有 meta 而重放悬空标 stopped,单列断言;
  // status 不落行(P11-T2):live 在途三态为瞬态面,装载面条目恒终态(done=缺省承载)——单列不比
  const strip = (e: KernelEntry): unknown => {
    const { meta: _meta, status: _status, ...rest } = e;
    return rest;
  };
  assert.deepEqual(strip(b), strip(a), `${path} 条目面等价`);
  if (a.kind !== 'run') assert.deepEqual(b.meta, a.meta, `${path} meta 等价`);
}

test('v3 重放:seg 顺序零变换直映 + tool 行按 seg-update 字段回填(result 后到;md 恒空)', () => {
  const entries = reduceSegRows([
    { t: 'seg', kind: 'user', md: '目标', ts: 100, seq: 1 },
    { t: 'seg', kind: 'tool', md: '', ts: 200, seq: 2, callId: 'c1', name: 'read', input: { path: 'a.ts' } },
    { t: 'seg-update', seq: 2, ts: 300, result: { text: 'file body\nmore', ok: true } },
    { t: 'seg', kind: 'assistant', md: '正文', ts: 400, seq: 3 },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.kind, e.seq]),
    [['user', 1], ['tool', 2], ['assistant', 3]],
  );
  const tool = entries[1]!;
  assert.equal(tool.md, '', 'md 恒空(字段单源——seg-update 纯字段回填,零 md 重算)');
  assert.deepEqual(tool.result, { text: 'file body\nmore', ok: true });
  assert.deepEqual(tool.input, { path: 'a.ts' });
  assert.equal(tool.name, 'read');
});

test('v3 重放:乱序(result 行先行)→ seg-update 带 name 字段回填;thinking 行 seconds 随档', () => {
  const entries = reduceSegRows([
    { t: 'seg', kind: 'tool', md: '', ts: 100, seq: 1, callId: 'x' },
    { t: 'seg-update', seq: 1, ts: 200, name: 'read', input: { path: 'b.ts' } },
    { t: 'seg', kind: 'thinking', md: '想想', ts: 300, seq: 2, seconds: 7 },
  ]);
  const tool = entries[0]!;
  assert.equal(tool.md, '', 'md 恒空(乱序字段回填同样零重组)');
  assert.equal(tool.name, 'read');
  assert.deepEqual(tool.input, { path: 'b.ts' });
  assert.equal(entries[1]!.kind, 'thinking');
  assert.equal(entries[1]!.seconds, 7);
});

test('v3 重放:run-open + runmeta 对位;悬空 run(无 runmeta)标 stopped;truncate 行即时截断', () => {
  const entries = reduceSegRows([
    { t: 'run-open', ts: 100, seq: 1 },
    { t: 'runmeta', seconds: 14, steps: 5, runSteps: 2, tokens: 12000, endedTs: 2500 },
    { t: 'seg', kind: 'user', md: '二', ts: 300, seq: 2 },
    { t: 'run-open', ts: 400, seq: 3 },
    { t: 'seg', kind: 'notice', md: '重启前中断', ts: 500, seq: 4 },
  ]);
  const run1 = entries[0]!;
  assert.deepEqual(run1.meta, { seconds: 14, steps: 5, runSteps: 2, tokens: 12000, endedTs: 2500 }, 'runmeta 行对位末个 run 条');
  assert.equal('stopped' in (run1.meta ?? {}), false, '有 runmeta 对位不标停止');
  const dangling = entries[2]!;
  assert.equal(dangling.kind, 'run');
  assert.equal(dangling.meta?.stopped, true, '悬空 run-open 重放标停止(run 随 daemon 重启已死)');
  // truncate:保留 seq<=1
  const cut = reduceSegRows([
    { t: 'seg', kind: 'user', md: '一', ts: 1, seq: 1 },
    { t: 'seg', kind: 'assistant', md: '答', ts: 2, seq: 2 },
    { t: 'truncate', upToSeq: 1 },
    { t: 'seg', kind: 'user', md: '二', ts: 3, seq: 3 },
  ]);
  assert.deepEqual(
    cut.map((e) => e.md),
    ['一', '二'],
    'truncate 行在流中位置即时生效',
  );
});

test('v3 重放:未知/v1 行型忽略;坏字段缺省回落不炸', () => {
  const entries = reduceSegRows([
    { t: 'header', v: 2, id: 'x', createdAt: 'now' },
    { t: 'chain', steps: [] },
    { t: 'seg' }, // 全缺省:kind 缺 → 忽略
    { t: 'seg', kind: 'notice', ts: 'bad', seq: 'bad' }, // 坏字段 → 回落 0/续发
    { t: 'seg-update', seq: 99 }, // 无对位 → 忽略
  ]);
  assert.equal(entries.length, 1, 'header/chain/坏 kind seg/无对位 update 全忽略');
  assert.equal(entries[0]!.kind, 'notice');
});

test('往返:token 流式段+思考秒+工具配对+run 统计,重放与 live 等价', () => {
  const { live, replayed } = roundTrip([
    ev('user', '跑一轮', undefined, 100),
    ev('model-start', undefined, undefined, 200),
    ev('reasoning', '想', undefined, 300),
    ev('reasoning', '思路', undefined, 900),
    ev('tool-call', 'read', { callId: 'c1', input: { path: 'a.ts' } }, 1000),
    ev('tool-result', 'body\nmore', { callId: 'c1', ok: true }, 1100),
    ev('token', '回', undefined, 1200),
    ev('token', '答', undefined, 1300),
    ev('done', '回答', { steps: 3, runSteps: 1, tokensUsed: 500, stopReason: 'done' }, 5000),
  ]);
  assert.equal(replayed.length, live.length, `条数一致(${live.length})`);
  for (let i = 0; i < live.length; i++) assertSameShape(live[i]!, replayed[i]!, `#${i}`);
  const think = replayed.find((e) => e.kind === 'thinking');
  assert.equal(think?.seconds, 1, '思考秒随档(300→900)');
  const tool = replayed.find((e) => e.kind === 'tool');
  assert.equal(tool?.md, '', 'tool md 恒空往返(字段单源:md 零重组,result 走字段回填)');
  assert.deepEqual(tool?.result, { text: 'body\nmore', ok: true });
  assert.equal(tool?.input && (tool.input as { path?: string }).path, 'a.ts', 'input 随档');
});

test('往返:乱序 result 先行 + reset truncate 全清', () => {
  const rows: Record<string, unknown>[] = [];
  const k = new SessionKernel({ onKernelEvent: (e) => rows.push(...kernelEventsToRows([e])) });
  k.pump(ev('tool-result', 'early', { callId: 'x', ok: true }, 100));
  k.pump(ev('tool-call', 'read', { callId: 'x' }, 200));
  const { replayed } = { replayed: (() => { const k2 = new SessionKernel(); k2.seed(reduceSegRows(rows)); return k2.replay(); })() };
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]!.md, '', '乱序往返归位(md 恒空,result 字段随档)');
  // truncate(0) 全清:重放列空
  const rows2: Record<string, unknown>[] = [];
  const k3 = new SessionKernel({ onKernelEvent: (e) => rows2.push(...kernelEventsToRows([e])) });
  k3.pump(ev('user', '一', undefined, 1));
  k3.truncate(0);
  const k4 = new SessionKernel();
  k4.seed(reduceSegRows(rows2));
  assert.equal(k4.replay().length, 0, 'truncate 行重放=清空视界');
});

test('渲染中立 v3(P11):tool md 恒空;悬空 tool 行补 interrupted result(零旧形态归一——raw 直读)', () => {
  const entries = reduceSegRows([
    { t: 'seg', kind: 'user', md: '裸目标', ts: 1, seq: 1 },
    { t: 'seg', kind: 'tool', md: '', ts: 2, seq: 2, callId: 'c1', name: 'read', input: { path: 'a.ts' } },
    { t: 'seg-update', seq: 2, ts: 3, result: { text: 'body', ok: true } },
    { t: 'seg', kind: 'tool', md: '', ts: 4, seq: 3, callId: 'c2', name: 'bash', input: { command: 'ls' } },
  ]);
  assert.equal(entries[0]!.md, '裸目标', 'user 裸文直读(零变换)');
  assert.equal(entries[1]!.md, '');
  assert.deepEqual(entries[1]!.result, { text: 'body', ok: true });
  assert.deepEqual(entries[2]!.result, { text: '(interrupted)', ok: false }, '悬空 tool 行(渲染 ✗ 不永转)');
});

test('P11 渲染中立钉:装载条不携 status 键(status 不落行,终态缺省);TUI restore v3 守卫源码钉', () => {
  const entries = reduceSegRows([
    { t: 'seg', kind: 'user', md: '裸', ts: 1, seq: 1 },
    { t: 'seg', kind: 'tool', md: '', ts: 2, seq: 2, callId: 'c', name: 'read', input: { path: 'x' } },
  ]);
  for (const e of entries) assert.equal('status' in e, false, 'journal 装载条零 status 键(悬空 tool 走 interrupted result,非 status)');
  // TUI restore 守卫源码钉(guards 先例):仅认 v:3(dist 回仓根取源)
  let root = __dirname;
  while (!require('fs').existsSync(require('path').join(root, 'package.json'))) root = require('path').dirname(root);
  const src = require('fs').readFileSync(require('path').join(root, 'src', 'tui', 'commands-session.ts'), 'utf8');
  assert.ok(src.includes('version !== 3'), 'TUI restore 仅认 v:3(守卫分支在场)');
});

test('steer 行读面(P5,spec §12):reduceSteerRows 取末行为准+字段净化;kernelEventRows 映射整列', () => {
  // 末条 steer 行覆盖前行(整列重写语义)
  assert.deepEqual(
    reduceSteerRows([
      { t: 'steer', items: [{ seq: 0, text: '旧', front: false }] },
      { t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1 }, // 段行不扰
      { t: 'steer', items: [{ seq: 0, text: '甲', front: false }, { seq: 1, text: '乙', front: true }] },
    ]),
    [
      { seq: 0, text: '甲', front: false },
      { seq: 1, text: '乙', front: true },
    ],
  );
  // 净化:非串 text 弃、front 严判 true、坏 seq 夹取、空 text 行丢弃
  assert.deepEqual(
    reduceSteerRows([{ t: 'steer', items: [{ seq: 5, text: '好', front: 'yes' }, { seq: -1, text: 42, front: true }, { text: '', front: false }, 'junk' as unknown as Record<string, unknown>] }]),
    [{ seq: 5, text: '好', front: false }],
  );
  assert.deepEqual(reduceSteerRows([{ t: 'seg', kind: 'user', md: '', ts: 1, seq: 1 }]), [], '无 steer 行=空列');
  // 写读往返:内核队列变更 → steer 事件(kernelEventRows 映射走同一行形) → reduceSteerRows 回种与 live 等价
  const events: KernelEvent[] = [];
  const k = new SessionKernel({ onKernelEvent: (e) => events.push(e) });
  k.steerEnqueue('一');
  k.steerEnqueue('二');
  k.steerMoveToFront(1);
  const rows = events.flatMap((e) => kernelEventRows(e));
  const k2 = new SessionKernel();
  k2.steerRestore(reduceSteerRows(rows));
  assert.deepEqual(k2.steerPendingItems(), k.steerPendingItems(), '装载往返等价');
});
