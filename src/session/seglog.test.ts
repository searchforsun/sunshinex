import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceSteerRows, reduceSegRows, kernelEventRows, crashWindowEntries, entriesToChainSteps, reduceWakeScheduleRows, reducePendingRows } from './seglog';
import { SessionKernel } from './kernel';
import type { KernelEvent } from './kernel';
import type { KernelEntry } from './entry';
import type { SegRowLike } from './seglog';
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
    if (e.t === 'shadow') continue; // 面事件透传行(G14.2xx)归 shadow 映射,本帮助面不消费
    if (e.t === 'runmeta') {
      const m = e.entry.meta;
      if (m !== undefined) rows.push({ t: 'runmeta', ...(m.steps !== undefined ? { steps: m.steps } : {}), ...(m.runSteps !== undefined ? { runSteps: m.runSteps } : {}), ...(m.tokens !== undefined ? { tokens: m.tokens } : {}), ...(m.cacheTokens !== undefined ? { cacheTokens: m.cacheTokens } : {}) });
      continue; // open run meta 增量行(与 kernelEventRows 同映射——往返断言覆盖在飞回合统计)
    }
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

test('v3 重放:seg-update result.full 全文保留(G14.2xx——text 恒 200 截断回执,丢 full 则回放后工具展开体只剩回执行)', () => {
  const full = `[Skill] demo (id=demo v=0.1.0)\nDirectory: C:/sk/demo\n\n# Demo\n${'正文行\n'.repeat(50)}`;
  const entries = reduceSegRows([
    { t: 'seg', kind: 'tool', md: '', ts: 100, seq: 1, callId: 'c1', name: 'skill', input: { id: 'demo' } },
    { t: 'seg-update', seq: 1, ts: 200, result: { text: full.slice(0, 200), ok: true, full } },
  ]);
  const tool = entries[0]!;
  assert.equal(tool.result?.full, full, 'full 全文原样回放');
  assert.equal(tool.result?.text, full.slice(0, 200));
  assert.equal(tool.result?.ok, true);
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

test('G14.2xx shadow 行映射:task-/gate- → board 行、delegation- → delegation 行、子智能体流 → subagent 行(原件直存)', () => {
  const rows = kernelEventRows({ t: 'shadow', e: { type: 'task-created', ts: 1, payload: { taskId: 't1' } } });
  assert.deepEqual(rows, [{ t: 'board', e: { type: 'task-created', ts: 1, payload: { taskId: 't1' } } }]);
  const rows2 = kernelEventRows({ t: 'shadow', e: { type: 'delegation-started', ts: 2, payload: { delegationId: 'd1' } } });
  assert.deepEqual(rows2, [{ t: 'delegation', e: { type: 'delegation-started', ts: 2, payload: { delegationId: 'd1' } } }]);
  const rows3 = kernelEventRows({ t: 'shadow', e: { type: 'tool-call', ts: 3, payload: { subagent: 'w1' } } });
  assert.deepEqual(rows3, [{ t: 'subagent', e: { type: 'tool-call', ts: 3, payload: { subagent: 'w1' } } }]);
});

test('crashWindowEntries: chain 行落点为入链水位——其后 seg 行为崩溃窗口,之前零窗口', () => {
  const rows: SegRowLike[] = [
    { t: 'seg', kind: 'user', md: 'task one', ts: 1, seq: 1 },
    { t: 'chain', steps: [{ step: 1, action: 'task', observation: 'task one' }] },
    { t: 'seg', kind: 'user', md: 'task two', ts: 2, seq: 2 },
    { t: 'seg', kind: 'assistant', md: 'working…', ts: 3, seq: 3 },
  ];
  const win = crashWindowEntries(rows);
  assert.deepEqual(win.map((e) => e.md), ['task two', 'working…'], '末个 chain 行之后的 seg 行=在飞窗口');
});

test('crashWindowEntries: 正常档(chain 行收尾)零窗口;无 chain 行全窗口', () => {
  const normal: SegRowLike[] = [
    { t: 'seg', kind: 'user', md: 'a', ts: 1, seq: 1 },
    { t: 'chain', steps: [{ step: 1, action: 'task', observation: 'a' }] },
    { t: 'seg', kind: 'assistant', md: 'done', ts: 2, seq: 2 },
    { t: 'chain', steps: [{ step: 2, action: 'reply', observation: 'done' }] },
  ];
  assert.deepEqual(crashWindowEntries(normal), [], '末行 chain 收尾:全部 seg 已入链,零窗口');
  const orphan: SegRowLike[] = [{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1 }];
  assert.equal(crashWindowEntries(orphan).length, 1, '无 chain 行(首 run 即崩):全窗口');
});

test('entriesToChainSteps:四类映射逐类断言 + thinking 前挂后继 assistant + 残缺容错', () => {
  const steps = entriesToChainSteps([
    { seq: 1, ts: 1, kind: 'user', md: 'do it' },
    { seq: 2, ts: 2, kind: 'thinking', md: 'hmm', seconds: 3 },
    { seq: 3, ts: 3, kind: 'assistant', md: 'ans' },
    { seq: 4, ts: 4, kind: 'tool', md: '', callId: 'c1', name: 'read', input: { path: 'a' }, result: { text: 'short', ok: true, full: 'full observation' } },
    { seq: 5, ts: 5, kind: 'error', md: 'boom' },
    { seq: 6, ts: 6, kind: 'notice', md: 'note text' },
    { seq: 7, ts: 7, kind: 'run', md: '' },
    { seq: 8, ts: 8, kind: 'tool', md: '', callId: 'c2' }, // 悬空(无 result):跳过
  ]);
  assert.deepEqual(steps[0], { action: 'task', observation: 'do it' });
  assert.deepEqual(steps[1], { action: 'reply', observation: 'ans', reasoning: 'hmm', thinkSeconds: 3 }, 'thinking 附挂后继 assistant 行');
  assert.equal(steps[2].action, 'tool-result');
  assert.equal(steps[2].observation, 'full observation', '观察行取 result.full(全量观测优先)');
  assert.deepEqual(steps[3], { action: 'note', observation: 'Error: boom' });
  assert.deepEqual(steps[4], { action: 'note', observation: 'note text' });
  assert.equal(steps.length, 5, 'run 条与无结果悬空 tool 行跳过');
});

test('entriesToChainSteps:孤立 thinking(无后继 assistant)自落 note 行', () => {
  const steps = entriesToChainSteps([{ seq: 1, ts: 1, kind: 'thinking', md: 'alone' }]);
  assert.deepEqual(steps, [{ action: 'note', observation: '[thinking] alone' }]);
});

test('imagesOf 路径引用回读(2026-10-31 images-cache 裁定):seg 行本地图片地址不被净化丢弃', () => {
  const entries = reduceSegRows([
    { t: 'seg', kind: 'user', md: '带图', ts: 1, seq: 1, images: ['D:/data/images-cache/20261031T140114Z-5e8877a5cbeb.png'] },
    { t: 'seg', kind: 'user', md: '旧档 dataURL', ts: 2, seq: 2, images: ['data:image/png;base64,AAAA'] },
    { t: 'seg', kind: 'user', md: '垃圾串丢弃', ts: 3, seq: 3, images: ['not-an-image'] },
  ]);
  assert.deepEqual(entries[0]!.images, ['D:/data/images-cache/20261031T140114Z-5e8877a5cbeb.png'], '路径引用保留(重启回显不蒸发)');
  assert.deepEqual(entries[1]!.images, ['data:image/png;base64,AAAA'], '旧档 dataURL 兼容');
  assert.equal(entries[2]!.images, undefined, '非图片串仍弃(行面不予信任)');
});

// ---- bg-wake 批A:wake notice 落档/恢复往返(spec §5.1/§5.3;旧档无 wake 字段=普通 notice,恢复面零变化) ----

test('wake notice 落档往返：kernelEventRows seg 行携带 wake，reduceSegRows 恢复逐字段恒等', () => {
  const entry: KernelEntry = { seq: 7, ts: 5, kind: 'notice', md: '<task-notification>x</task-notification>', wake: [{ id: 'a', name: 'n' }, { id: 'b', board: true, boardRef: 't3' }] };
  const rows = kernelEventRows({ t: 'seg-open', entry, open: false });
  const segRow = rows.find((r) => r.t === 'seg') as { t: 'seg'; wake?: unknown };
  assert.deepEqual(segRow.wake, entry.wake);
  const back = reduceSegRows(rows); // 既有入参形态=平铺行列(brief 分组示意按本文件实形装配)
  const got = back.find((e) => e.seq === 7);
  assert.deepEqual(got?.wake, entry.wake);
  // 旧档无 wake 字段 → 普通 notice
  const legacy = reduceSegRows([{ t: 'seg', kind: 'notice', md: 'plain', ts: 1, seq: 8 }]);
  assert.equal(legacy.find((e) => e.seq === 8)?.wake, undefined);
});

// ---- sunx 定时调度（2026-11-15 P2 Task 3）：wake-schedule 机制行落档/回放往返 + schedule 标记字段 ----

test('schedule notice 标记往返：kernelEventRows seg 行携带 schedule，reduceSegRows 恢复逐字段恒等', () => {
  const entry: KernelEntry = { seq: 9, ts: 6, kind: 'notice', md: '<schedule-wake>\nScheduled wake', schedule: true };
  const rows = kernelEventRows({ t: 'seg-open', entry, open: false });
  const segRow = rows.find((r) => r.t === 'seg') as { t: 'seg'; schedule?: unknown };
  assert.equal(segRow.schedule, true, '写侧单点携带 schedule 标记');
  const back = reduceSegRows(rows);
  assert.equal(back.find((e) => e.seq === 9)?.schedule, true);
  // 旧档无 schedule 字段 → 普通 notice（行为不变）
  const legacy = reduceSegRows([{ t: 'seg', kind: 'notice', md: 'plain', ts: 1, seq: 10 }]);
  assert.equal(legacy.find((e) => e.seq === 10)?.schedule, undefined);
});

test('wake-schedule 行往返：逐字段恒等 + 同 id 末行为准（firedAt 终态覆盖）+ 坏行跳过', () => {
  // 写面形态（serve/session.logScheduleRow 直落——runmeta 既有直写先例，非内核转录事件）
  const rows: SegRowLike[] = [
    { t: 'wake-schedule', id: 'sched-1', fireAt: 1700000000000, note: 'check the oven' },
    { t: 'wake-schedule', id: 'sched-2', fireAt: 1700000005000, note: 'refresh cache', taskSpec: 'TASK-SPEC', firedAt: 1700000006000 },
    { t: 'wake-schedule', id: 'sched-1', fireAt: 1700000000000, note: 'check the oven', firedAt: 1700000002000 }, // 触发终态行
  ];
  const got = reduceWakeScheduleRows(rows);
  assert.deepEqual(got, [
    { id: 'sched-1', fireAt: 1700000000000, note: 'check the oven', firedAt: 1700000002000 },
    { id: 'sched-2', fireAt: 1700000005000, note: 'refresh cache', taskSpec: 'TASK-SPEC', firedAt: 1700000006000 },
  ]);
  // 坏行逐条跳过（行面字段不予信任）：缺 id/fireAt/note 任一即弃，不炸读面
  const bad = reduceWakeScheduleRows([
    { t: 'wake-schedule', fireAt: 1, note: 'no id' },
    { t: 'wake-schedule', id: 'a', note: 'no fireAt' },
    { t: 'wake-schedule', id: 'b', fireAt: 1 },
    { t: 'wake-schedule', id: 'c', fireAt: 'x', note: 'bad fireAt type' },
  ] as SegRowLike[]);
  assert.deepEqual(bad, []);
});

test('旧档无 wake-schedule 行=行为不变：reduceWakeScheduleRows 空列 + reduceSegRows 忽略机制行', () => {
  assert.deepEqual(reduceWakeScheduleRows([]), []);
  // 机制行不入转录投影（reduceSegRows 忽略未知行型——防重复入转录）
  const entries = reduceSegRows([
    { t: 'seg', kind: 'user', md: 'hello', ts: 1, seq: 1 },
    { t: 'wake-schedule', id: 'sched-1', fireAt: 1, note: 'n' },
  ] as SegRowLike[]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, 'user');
});

// ---- sunx 挂起持久化（2026-11-15 P2 Task 4）：pending-open/pending-resolve 机制行往返 + 恢复轮素材读面 ----

test('pending 行往返：open/resolved 按 pid 配对逐字段恒等（ask 素材含 options/askedBy）+ 未决留 open', () => {
  // 写面形态（serve/session.logPendingRow 直落——wake-schedule 同先例，非内核转录事件）：
  // suspend 入口落 open（req 原件随行）、resolve/deny 出口落 resolve（pid+结果摘要）
  const rows: SegRowLike[] = [
    {
      t: 'pending-open',
      pid: 'p1',
      kind: 'ask',
      req: {
        question: '用哪个数据库？',
        options: [{ label: 'postgres' }, { label: 'sqlite' }],
        askedBy: { label: 'alpha', taskId: 't3' },
      },
    },
    { t: 'pending-open', pid: 'p2', kind: 'approval', req: { id: 'ap-1', kind: 'write', subject: 'out/x.txt', reason: 'r' } },
    { t: 'pending-open', pid: 'p3', kind: 'plan-approval', req: { name: '重构计划', doc: '# 重构计划\n1. 步骤', items: ['步骤'] } },
    { t: 'pending-resolve', pid: 'p1', outcome: 'selected: postgres' },
    { t: 'pending-resolve', pid: 'p2', outcome: 'allow' },
  ];
  const got = reducePendingRows(rows);
  // 已决两枚：material 同构 + outcome 摘要，行序=审计序（resolved 列）
  assert.deepEqual(got.resolved, [
    { pid: 'p1', kind: 'ask', title: '用哪个数据库？', options: ['postgres', 'sqlite'], askedBy: { label: 'alpha', taskId: 't3' }, outcome: 'selected: postgres' },
    { pid: 'p2', kind: 'approval', title: 'out/x.txt', outcome: 'allow' },
  ]);
  // 未决（open 无 resolve 对位=daemon 重启蒸发的挂起）留 open——恢复轮素材（Task 5 消费）
  assert.deepEqual(got.open, [{ pid: 'p3', kind: 'plan-approval', title: '重构计划' }]);
});

test('pending 行人读面提取：ask 缺 name 的 plan 卡回落计划书首行;ask 无 options/askedBy 缺键', () => {
  const got = reducePendingRows([
    { t: 'pending-open', pid: 'p4', kind: 'plan-approval', req: { doc: '  # 兜底名  \n1. 步骤', items: [] } },
    { t: 'pending-open', pid: 'p5', kind: 'ask', req: { question: '裸问题', options: [] } },
  ]);
  assert.deepEqual(got.open, [
    { pid: 'p4', kind: 'plan-approval', title: '# 兜底名' },
    { pid: 'p5', kind: 'ask', title: '裸问题' },
  ]);
});

test('pending 坏行丢弃：缺 pid/kind 非法/req 非对象/素材本质缺席逐条弃;孤儿 resolve（无 open 对位）弃', () => {
  const got = reducePendingRows([
    { t: 'pending-open', kind: 'ask', req: { question: 'no pid' } },
    { t: 'pending-open', pid: 'a', kind: 'bogus', req: { question: 'bad kind' } },
    { t: 'pending-open', pid: 'b', kind: 'ask', req: 'not-an-object' },
    { t: 'pending-open', pid: 'c', kind: 'ask', req: { options: [{ label: 'x' }] } }, // 缺 question=素材本质缺席
    { t: 'pending-open', pid: 'd', kind: 'approval', req: { id: 'ap' } }, // 缺 subject
    { t: 'pending-resolve', pid: 'ghost', outcome: 'allow' }, // 孤儿 resolve：kind/title 不可知,不伪造
    { t: 'pending-resolve', pid: 'p1' }, // 缺 outcome
  ] as SegRowLike[]);
  assert.deepEqual(got, { open: [], resolved: [] });
});

test('旧档无 pending 行=行为不变：空视图 + reduceSegRows 忽略 pending 机制行（不入转录）', () => {
  assert.deepEqual(reducePendingRows([]), { open: [], resolved: [] });
  const entries = reduceSegRows([
    { t: 'seg', kind: 'user', md: 'hello', ts: 1, seq: 1 },
    { t: 'pending-open', pid: 'p1', kind: 'ask', req: { question: 'q' } },
    { t: 'pending-resolve', pid: 'p1', outcome: 'dismissed' },
  ] as SegRowLike[]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, 'user');
});
