# 流式会话三态状态机（Streaming Task State）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 reactor 事件面补齐「思考中 / 执行前 / 执行完成」三态事件（model-start/model-end、tool-call/tool-result 增 callId+status），session 层用纯函数状态机推导 LiveTaskState，TUI 只读渲染活动状态行。

**Architecture:** 状态产生与推进全部在 harness 事件面完成（旁路遥测、尾追加、零前缀击穿）；`src/tui/task-state.ts` 为单点纯函数状态机（applyTaskState），SessionController 持有 LiveTaskState 瞬态，App 渲染层只消费状态。规格见 `docs/superpowers/specs/2026-09-22-streaming-task-state-design.md`（提交 6bd670f）。

**Tech Stack:** TypeScript strict + Node.js 内置 `node:test`；测试与被测模块同目录；`pnpm test` 经 `scripts/run-tests.js` 启动。

## Global Constraints

- 前缀缓存红线：新事件与新增载荷字段全部旁路遥测，不进提示词、不进会话链、journal 词汇表零扩展（CLAUDE.md §11；规格 §3.4）。
- 既有事件发射时机与文本载荷一字不动，只增可选字段与新增事件类型（规格 §2.4）。
- callId 形态 `step:N-idx:M`（步号+批内序号），reactor 单点生成，零随机源、零时间戳进提示词面（规格 §3.3）。
- 提示词面恒英文；TUI 用户可见新文案一律 `t(en, zh)` 双语（CLAUDE.md §15）。
- TypeScript strict；新增共享类型在 `src/types.ts` 登记；测试文件与被测模块同目录（CLAUDE.md §5）。
- 工作区存在大量并发线 WIP：每次提交只 `git add` 本任务列出的文件，禁止 `git add -A` / `git add .`。
- 门禁（Task 4 终验）：`pnpm build` tsc 零报错 + `pnpm test` fail 0 + `pnpm selfcheck` OK。

---

### Task 1: reactor 事件面三态化（model-start/model-end + callId/status）

**Files:**
- Modify: `src/types.ts:262-265`（`SessionEventType` 联合扩展）
- Modify: `src/harness/reactor.ts:402-496`（`chatRound` 内 4 个发射点）
- Test: `src/harness/reactor.taskstate.test.ts`（新建，构造辅助逐字照抄 `src/harness/reactor.events.test.ts:13-23` 的 `makeReactor`）

**Interfaces:**
- Consumes: 既有 `private emit(type, text?, payload?)`（reactor.ts:380）；`chatRound` 形参 `step: number`。
- Produces（后续任务依赖的精确契约）:
  - `SessionEventType` 新增成员 `'model-start' | 'model-end'`；
  - `model-start` 载荷 `{ step: number }`；`model-end` 载荷 `{ step: number, ms: number }`；
  - `tool-call` 载荷增 `callId: string`（形如 `step:1-idx:0`）与 `status: 'pending'`；
  - `tool-result` 载荷增 `callId: string` 与 `status: 'completed' | 'failed'`（`ok === true` → completed，否则 failed；护栏拒绝与坏参调用均为 failed）。

- [ ] **Step 1: 写失败测试**

新建 `src/harness/reactor.taskstate.test.ts`（头部 import 与 `makeReactor` 辅助从 `reactor.events.test.ts` 逐字复制，仅换 import 路径注释），追加三个用例：

```ts
test('三态事件面：model-start 先于工具事件、tool-call/tool-result 携带 callId 与 status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ts1-'));
  try {
    const events: SessionEvent[] = [];
    const r = await makeReactor(tmp, new ScriptedAdapter([
      '{"tool":"read","input":{"path":"a.txt"}}',
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '读文件' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'model-start').length, 2, '两个模型轮各发一次 model-start');
    assert.ok(types.indexOf('model-start') < types.indexOf('tool-call'), 'model-start 先于 tool-call');
    const call = events.find((e) => e.type === 'tool-call');
    assert.equal(call?.payload?.status, 'pending');
    assert.equal(call?.payload?.callId, 'step:1-idx:0');
    const result = events.find((e) => e.type === 'tool-result');
    assert.equal(result?.payload?.callId, 'step:1-idx:0', 'tool-result 与 tool-call 同 callId 配对');
    assert.ok(result?.payload?.status === 'completed' || result?.payload?.status === 'failed');
    const ends = events.filter((e) => e.type === 'model-end');
    assert.equal(ends.length, 2, '两个模型轮各发一次 model-end');
    assert.equal(ends[0]?.payload?.step, 1);
    assert.ok(typeof ends[0]?.payload?.ms === 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('三态事件面：并行批 callId 逐项独立', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ts2-'));
  try {
    const events: SessionEvent[] = [];
    await makeReactor(tmp, new ScriptedAdapter([
      '{"tools":[{"tool":"read","input":{"path":"a.txt"}},{"tool":"glob","input":{"pattern":"*.ts"}}]}',
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '并行读' }, { maxSteps: 3 });
    const callIds = events.filter((e) => e.type === 'tool-call').map((e) => e.payload?.callId);
    assert.deepEqual(callIds, ['step:1-idx:0', 'step:1-idx:1']);
    const resultIds = events.filter((e) => e.type === 'tool-result').map((e) => e.payload?.callId);
    assert.deepEqual(resultIds, ['step:1-idx:0', 'step:1-idx:1'], '结果按调用序与 callId 成对');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('三态事件面：并行护栏拒绝的调用 status=failed、callId 仍在', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ts3-'));
  try {
    const events: SessionEvent[] = [];
    await makeReactor(tmp, new ScriptedAdapter([
      '{"tools":[{"tool":"read","input":{"path":"a.txt"}},{"tool":"exec","input":{"command":"ls"}}]}',
      '{"done":true,"reply":"ok"}',
    ]), (e) => events.push(e)).run({ goal: '混入 exec' }, { maxSteps: 3 });
    const pairs = events.filter((e) => e.type === 'tool-result');
    assert.equal(pairs.length, 2);
    for (const p of pairs) {
      assert.equal(p.payload?.status, 'failed', '护栏拒绝一律 failed');
      assert.ok(typeof p.payload?.callId === 'string' && String(p.payload?.callId).startsWith('step:1-idx:'));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/reactor.taskstate.test.js`
Expected: FAIL——断言 `model-start` 数量为 0 ≠ 2、`callId` 为 undefined。

- [ ] **Step 3: 最小实现**

`src/types.ts` SessionEventType 联合尾部扩展：

```ts
export type SessionEventType =
  | 'token' | 'reasoning' | 'usage' | 'tool-call' | 'tool-result' | 'step'
  | 'route' | 'approval-request' | 'approval-resolved'
  | 'ctx' | 'done' | 'error' | 'notice'
  | 'model-start' | 'model-end';
```

`src/harness/reactor.ts` `chatRound`（当前 L402 起）四处改动：

```ts
// ① 方法体首行（buildMessages 之前）：
const startedAt = Date.now();
this.emit('model-start', undefined, { step });

// ② chat/chatStream 返回 result 之后、finish 判断之前：
this.emit('model-end', undefined, { step, ms: Date.now() - startedAt });

// ③ calls 解析出后（finish!=='stop' 且 calls.length>0 分支内、emit('step', calls[0].name, ...) 之前）：
const callIds = calls.map((_, i) => `step:${step}-idx:${i}`);

// ④ 两处 tool-call / tool-result 发射补字段（护栏拒绝分支与正常执行分支同构）：
this.emit('tool-call', calls[i].name, { input: argsOf[i] ?? {}, callId: callIds[i], status: 'pending' });
this.emit('tool-result', rejection.slice(0, 200), { ok: false, full: rejection, tool: calls[i].name, callId: callIds[i], status: 'failed' });
// —— 正常执行分支：
this.emit('tool-call', c.name, { input: args ?? {}, callId: callIds[i], status: 'pending' });
this.emit('tool-result', obs.slice(0, 200), { ok: r !== null && r.ok, full: obs, tool: c.name, callId: callIds[i], status: r !== null && r.ok ? 'completed' : 'failed' });
```

注意：模型抛错路径不发 `model-end`（由既有 `error` 事件承载终态，规格 §3.2）——①②的位置天然满足（②在 await 之后，抛错即跳过）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/reactor.taskstate.test.js dist/harness/reactor.events.test.js dist/harness/reactor.prefix.test.js`
Expected: 三个文件全 PASS（前缀稳定回归零误伤——新事件零进提示词）。

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/harness/reactor.ts src/harness/reactor.taskstate.test.ts
git commit -m "feat(harness): 流式三态事件面——model-start/model-end 与 tool-call/result callId+status"
```

---

### Task 2: task-state 纯函数状态机 + SessionController 接线

**Files:**
- Create: `src/tui/task-state.ts`
- Modify: `src/tui/session.ts`（TuiState 增 `task` 字段 + `onEvent` 接线 + 审批两处挂起/恢复 + `/new` 清态 + 只读访问器）
- Test: `src/tui/task-state.test.ts`（纯函数，不依赖 ink/React）
- Test: `src/tui/session.taskstate.test.ts`（session 集成，经 `onEventForTest` 注入）

**Interfaces:**
- Consumes: Task 1 的全部事件契约；`SessionEvent`（`src/types.ts`）。
- Produces（Task 3 渲染层依赖的精确契约）:

```ts
// src/tui/task-state.ts
export type LiveTaskPhase = 'idle' | 'thinking' | 'responding' | 'tool-pending' | 'tool-awaiting';
export interface ActiveCall { callId: string; verb: string; startedAt: number; }
export interface LiveTaskState { phase: LiveTaskPhase; activeCalls: ActiveCall[]; }
export function initialTaskState(): LiveTaskState;                       // { phase: 'idle', activeCalls: [] }
export function applyTaskState(s: LiveTaskState, e: SessionEvent): LiveTaskState;
```

转换表（其余事件原样返回 `s`，零新对象时可不重建）：

```text
model-start                    → { phase: 'thinking', activeCalls: [] }
token                          → phase: 'responding'（activeCalls 不动）
tool-call（status==='pending'）→ phase: 'tool-pending'；activeCalls 追加 { callId: payload.callId, verb: e.text ?? '', startedAt: Date.now() }（callId 已存在则跳过追加，只确保 phase）
tool-result                    → activeCalls 移除 payload.callId 项；activeCalls 空且 phase 为 tool-* → 'thinking'（下一模型轮 model-start 亦会兜底归位）
done / error                   → initialTaskState()
```

审批挂起不经事件（asker 回调通道）：session 挂起处置 `phase: 'tool-awaiting'`、恢复处置回 `'tool-pending'`，见接线点。

- [ ] **Step 1: 写失败测试（纯函数）**

新建 `src/tui/task-state.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEvent } from '../types';
import { ActiveCall, LiveTaskState, applyTaskState, initialTaskState } from './task-state';

function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, ...(text !== undefined ? { text } : {}), ...(payload ? { payload } : {}), ts: 0 };
}

test('task-state：model-start→token→tool-call→tool-result→model-start→done 主链', () => {
  let s = initialTaskState();
  assert.equal(s.phase, 'idle');
  s = applyTaskState(s, ev('model-start', undefined, { step: 1 }));
  assert.equal(s.phase, 'thinking');
  s = applyTaskState(s, ev('token', 'he'));
  assert.equal(s.phase, 'responding');
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  assert.equal(s.phase, 'tool-pending');
  assert.equal(s.activeCalls.length, 1);
  assert.equal(s.activeCalls[0].callId, 'step:1-idx:0');
  assert.equal(s.activeCalls[0].verb, 'read');
  s = applyTaskState(s, ev('tool-result', 'ok', { callId: 'step:1-idx:0', status: 'completed' }));
  assert.equal(s.activeCalls.length, 0);
  assert.equal(s.phase, 'thinking');
  s = applyTaskState(s, ev('done', 'ok', { steps: 2 }));
  assert.equal(s.phase, 'idle');
});

test('task-state：并行批两 callId 独立推进、批内一先一后', () => {
  let s = applyTaskState(initialTaskState(), ev('model-start', undefined, { step: 1 }));
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  s = applyTaskState(s, ev('tool-call', 'glob', { callId: 'step:1-idx:1', status: 'pending' }));
  assert.equal(s.activeCalls.length, 2);
  s = applyTaskState(s, ev('tool-result', 'ok', { callId: 'step:1-idx:1', status: 'completed' }));
  assert.equal(s.activeCalls.length, 1);
  assert.equal(s.phase, 'tool-pending', '批内仍有未决调用保持 tool-pending');
  s = applyTaskState(s, ev('tool-result', 'ok', { callId: 'step:1-idx:0', status: 'failed' }));
  assert.equal(s.activeCalls.length, 0);
  assert.equal(s.phase, 'thinking');
});

test('task-state：tool-call 重复 callId 不重复追加；error 清态；无关事件原样', () => {
  let s = applyTaskState(initialTaskState(), ev('model-start', undefined, { step: 1 }));
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  const before = s.activeCalls.length;
  s = applyTaskState(s, ev('tool-call', 'read', { callId: 'step:1-idx:0', status: 'pending' }));
  assert.equal(s.activeCalls.length, before, '重复 callId 幂等');
  s = applyTaskState(s, ev('route', undefined, { tier: 'medium' }));
  assert.equal(s.phase, 'tool-pending', 'route 等无关事件零扰动');
  s = applyTaskState(s, ev('error', 'boom'));
  assert.deepEqual(s, initialTaskState(), 'error 清态');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tui/task-state.test.js`
Expected: FAIL——模块不存在（TS2307）。

- [ ] **Step 3: 实现 `src/tui/task-state.ts`**

```ts
import { SessionEvent } from '../types';

/** 活任务阶段（瞬态不落 journal，规格 §4）：idle=无任务、thinking=等待首 token/动作、responding=正文流式中、tool-pending=有未决调用、tool-awaiting=审批挂起 */
export type LiveTaskPhase = 'idle' | 'thinking' | 'responding' | 'tool-pending' | 'tool-awaiting';

export interface ActiveCall {
  callId: string;
  verb: string;
  startedAt: number;
}

export interface LiveTaskState {
  phase: LiveTaskPhase;
  activeCalls: ActiveCall[];
}

export function initialTaskState(): LiveTaskState {
  return { phase: 'idle', activeCalls: [] };
}

/** 事件流→活任务状态（单点纯函数，规格 §4.2）：只消费三态相关事件，其余零扰动返回原引用 */
export function applyTaskState(s: LiveTaskState, e: SessionEvent): LiveTaskState {
  switch (e.type) {
    case 'model-start':
      return { phase: 'thinking', activeCalls: [] };
    case 'token':
      return s.phase === 'responding' ? s : { ...s, phase: 'responding' };
    case 'tool-call': {
      const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
      if (callId.length === 0) return s;
      if (s.activeCalls.some((c) => c.callId === callId)) return { ...s, phase: 'tool-pending' };
      const call: ActiveCall = { callId, verb: e.text ?? '', startedAt: Date.now() };
      return { phase: 'tool-pending', activeCalls: [...s.activeCalls, call] };
    }
    case 'tool-result': {
      const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
      if (callId.length === 0) return s;
      const activeCalls = s.activeCalls.filter((c) => c.callId !== callId);
      if (activeCalls.length === s.activeCalls.length) return s;
      if (activeCalls.length > 0) return { ...s, activeCalls };
      return { phase: 'thinking', activeCalls };
    }
    case 'done':
    case 'error':
      return initialTaskState();
    default:
      return s;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tui/task-state.test.js`
Expected: PASS 3/3。

- [ ] **Step 5: session 接线（先写失败测试）**

新建 `src/tui/session.taskstate.test.ts`。session 构造与 `/new` 触发形态逐字对齐 `src/tui/session.test.ts` 现行用例（构造：`new SessionController({ root: tmp, model: new ScriptedAdapter([...]) })`，`tmp` 为 `fs.mkdtempSync` 临时目录；斜杠命令经 `await ctrl.submit('/new')`）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-taskstate-'));
}

test('session 三态：事件流驱动 task 状态与 activeCalls', async () => {
  const tmp = tmpdir();
  try {
    const c = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    c.onEventForTest({ type: 'model-start', payload: { step: 1 }, ts: 0 });
    assert.equal(c.taskState().phase, 'thinking');
    c.onEventForTest({ type: 'tool-call', text: 'read', payload: { callId: 'step:1-idx:0', status: 'pending' }, ts: 1 });
    assert.equal(c.taskState().phase, 'tool-pending');
    assert.equal(c.taskState().activeCalls[0]?.verb, 'read');
    c.onEventForTest({ type: 'tool-result', text: 'ok', payload: { callId: 'step:1-idx:0', status: 'completed' }, ts: 2 });
    assert.equal(c.taskState().activeCalls.length, 0);
    c.onEventForTest({ type: 'done', text: 'ok', payload: { steps: 1 }, ts: 3 });
    assert.equal(c.taskState().phase, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('session 三态：/new 归位 idle', async () => {
  const tmp = tmpdir();
  try {
    const c = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    c.onEventForTest({ type: 'tool-call', text: 'read', payload: { callId: 'step:1-idx:0', status: 'pending' }, ts: 0 });
    assert.equal(c.taskState().phase, 'tool-pending');
    await c.submit('/new');
    assert.equal(c.taskState().phase, 'idle');
    assert.equal(c.taskState().activeCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm build && node --test dist/tui/session.taskstate.test.js`
Expected: FAIL——`taskState` 不存在。

- [ ] **Step 7: session.ts 最小接线**

`src/tui/session.ts` 五处改动：

```ts
// ① import（文件头）：
import { LiveTaskState, applyTaskState, initialTaskState } from './task-state';

// ② TuiState 接口（children 字段之后）——瞬态不落 journal（沿 children 先例）：
  /** 活任务三态（规格 §4）：事件流经 applyTaskState 纯函数推导，瞬态不进 journal */
  task: LiveTaskState;

// ③ 初始 state 构造（newSession 处 metrics 字面量同级）补 task: initialTaskState()；
//    /new 分支（约 L668 approval: undefined 同一处对象字面量）补 task: initialTaskState()

// ④ onEvent 分流入口（子代理分流判断之后、switch 之前）——所有事件统一过状态机：
    this.state = { ...this.state, task: applyTaskState(this.state.task, e) };
    // 注意：子代理分流 return 之前不消费（fork 事件零主链污染，规格不变量）——本行放在 sub 分流 return 之后

// ⑤ 审批挂起/恢复两处（asker 通道不经事件）：
//    L254 置 awaiting-approval 处补 phase 切换：
    this.state = { ...this.state, status: 'awaiting-approval', approval: req,
      task: this.state.task.phase === 'tool-pending' ? { ...this.state.task, phase: 'tool-awaiting' } : this.state.task };
//    L261 恢复 running 处对称切回 tool-pending。

// ⑥ 只读访问器（onEventForTest 旁）：
  /** 活任务三态只读视图（渲染层与测试消费；交互面只读不重推导） */
  taskState(): LiveTaskState { return this.state.task; }
```

- [ ] **Step 8: 跑定向测试确认通过**

Run: `pnpm build && node --test dist/tui/session.taskstate.test.js dist/tui/task-state.test.js`
Expected: 全 PASS。

- [ ] **Step 9: 提交**

```bash
git add src/tui/task-state.ts src/tui/task-state.test.ts src/tui/session.taskstate.test.ts src/tui/session.ts
git commit -m "feat(tui): LiveTaskState 三态状态机——applyTaskState 纯函数单点与 SessionController 接线"
```

---

### Task 3: TUI 渲染层消费三态（Spinner 升级 + App 接线）

**Files:**
- Modify: `src/tui/components/Spinner.tsx`（props 增 `phase` 与 `calls`，渲染状态行）
- Modify: `src/tui/components/App.tsx:511`（Spinner 挂载点传 `state.task`）
- Test: `src/tui/components/Spinner.taskstate.test.tsx`（新建，`render` from `../test-ink` + `lastFrame` 断言，写法逐字对齐 `src/tui/components/ChildPanel.test.tsx`）

**Interfaces:**
- Consumes: Task 2 的 `LiveTaskState` / `ActiveCall` / `LiveTaskPhase`（`src/tui/task-state.ts` 精确导出）；`TuiState.task`（`src/tui/session.ts`）。
- Produces: 无下游消费者（渲染层是终端面）。

渲染语义（规格 §5）：

```text
phase === 'idle'                        → 不渲染（App 层已按 status==='running' 门控，双保险）
phase === 'thinking'                    → 既有帧动画 + 思考动词（现状形态零变化）
phase === 'responding'                  → 静默：App 层不渲染 Spinner（正文流式即状态）
phase === 'tool-pending' / 'tool-awaiting' → 每个活跃调用一行：● [VERB] awaiting approval / ● [VERB]（带帧动画与耗时）
```

帧高不变量：Spinner 槽位从恒 1 行变为「活跃调用数」行（并行批 ≤8 上限由 reactor 护栏保证），行数只在调用加入/完成的事件点变化、帧动画期间恒定——与 ChildPanel 同一波动语义，非逐帧波动源。

- [ ] **Step 1: 写失败测试**

新建 `src/tui/components/Spinner.taskstate.test.tsx`：

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { Spinner } from './Spinner';

test('Spinner 三态：thinking 保留思考动词帧；tool-pending 按调用数渲染状态行', () => {
  const thinking = render(
    <Spinner startedAt={Date.now() - 5000} tokens={1200} phase="thinking" calls={[]} />,
  );
  const ft = thinking.lastFrame() ?? '';
  assert.match(ft, /Pondering|Brewing|Weaving|Distilling/, 'thinking 保留既有动词轮换');
  thinking.unmount();

  const pending = render(
    <Spinner
      startedAt={Date.now() - 3000}
      tokens={0}
      phase="tool-pending"
      calls={[
        { callId: 'step:1-idx:0', verb: 'read', startedAt: Date.now() - 2000 },
        { callId: 'step:1-idx:1', verb: 'grep', startedAt: Date.now() - 1000 },
      ]}
    />,
  );
  const fp = pending.lastFrame() ?? '';
  assert.match(fp, /\[read\]/, '活跃调用行含动词标识');
  assert.match(fp, /\[grep\]/, '并行批逐调用一行');
  const lines = fp.replace(/\n$/, '').split('\n').filter((l) => l.trim().length > 0).length;
  assert.equal(lines, 2, '两活跃调用恒 2 行（帧高 = 活跃调用数）');
  pending.unmount();
});

test('Spinner 三态：tool-awaiting 标注等待审批', () => {
  const awaiting = render(
    <Spinner
      startedAt={Date.now() - 3000}
      tokens={0}
      phase="tool-awaiting"
      calls={[{ callId: 'step:2-idx:0', verb: 'write', startedAt: Date.now() - 1500 }]}
    />,
  );
  const f = awaiting.lastFrame() ?? '';
  assert.match(f, /\[write\]/);
  assert.match(f, /awaiting approval/, '审批挂起态显式标注');
  awaiting.unmount();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tui/components/Spinner.taskstate.test.js`
Expected: FAIL——props `phase`/`calls` 不存在，行断言失败。

- [ ] **Step 3: 最小实现**

`src/tui/components/Spinner.tsx`——props 扩展与分支渲染：

```tsx
import { ActiveCall, LiveTaskPhase } from '../task-state';

export function Spinner({ startedAt, tokens, label, phase = 'thinking', calls = [] }: {
  startedAt: number;
  tokens: number;
  label?: string;
  /** 活任务阶段（缺省 thinking = 既有调用方零破坏） */
  phase?: LiveTaskPhase;
  /** tool-pending/tool-awaiting 的活跃调用清单；thinking/responding 忽略 */
  calls?: ActiveCall[];
}): JSX.Element {
  // ……既有 frame/useEffect 原样保留……
  if (phase === 'tool-pending' || phase === 'tool-awaiting') {
    return (
      <Box flexDirection="column">
        {calls.map((c) => (
          <Text key={c.callId} color="green" dimColor>
            {glyph} [{c.verb}]{' '}
            <Text dimColor>
              {phase === 'tool-awaiting' ? t('awaiting approval', '等待审批') + ' · ' : ''}
              {formatDuration(Math.max(0, Math.round((Date.now() - c.startedAt) / 1000)))}
            </Text>
          </Text>
        ))}
      </Box>
    );
  }
  // ……既有 thinking 渲染原样保留（label 分支不动）……
}
```

（`Box` from `ink`、`t` from `src/i18n`，import 面按文件既有形态补齐；动画帧 `glyph` 复用既有状态。）

`src/tui/components/App.tsx:511` 挂载点改为消费 `state.task`：

```tsx
{state.status === 'running' && state.task.phase !== 'responding' ? (
  <Spinner
    startedAt={state.metrics.turnStartedAt}
    tokens={state.metrics.turnTokens}
    phase={state.task.phase}
    calls={state.task.activeCalls}
  />
) : null}
```

- [ ] **Step 4: 跑定向测试确认通过**

Run: `pnpm build && node --test dist/tui/components/Spinner.taskstate.test.js dist/tui/components/ChildPanel.test.js`
Expected: 全 PASS（ChildPanel 回归零误伤——Spinner 既有调用方经缺省 props 零破坏）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/Spinner.tsx src/tui/components/App.tsx src/tui/components/Spinner.taskstate.test.tsx
git commit -m "feat(tui): Spinner 消费 LiveTaskState 三态——pending/awaiting 状态行与 responding 静默"
```

---

### Task 4: MANUAL.md 口径同步 + 终验门禁

**Files:**
- Modify: `MANUAL.md`（运行中显示形态段补三态口径；不新增章节，挂靠既有「运行中」相关行）
- Test: 无新测试（纯文档 + 门禁）

**Interfaces:**
- Consumes: Task 1–3 全部交付面（事件名、phase 枚举、状态行形态）。
- Produces: 用户手册与实现一致。

- [ ] **Step 1: MANUAL.md 同步**

在快捷键/运行控制表格附近（如 L287 运行控制表上方段落，落点以现行排版为准）补一段运行状态口径（中文为主、随文档既有语言形态）：

```markdown
- 运行状态实时显示：任务运行中，输入框上方状态行分三态——思考中（帧动画 + 耗时）、工具执行前/审批挂起（`● [工具名]` 逐调用一行，审批挂起标注 awaiting approval）、正文输出中（静默，流式正文即状态）；调用完成即转为消息流中的结果行。
```

同步核对：手册中如有「运行中仅显示转圈动画」类旧口径表述，一并按三态实况改写（删除即无痕，不留新旧并存）。

- [ ] **Step 2: 终验门禁（三连）**

Run: `pnpm build`
Expected: tsc strict 零报错。

Run: `pnpm test`
Expected: 全量 fail 0（新增用例数 = Task 1 三个 + Task 2 纯函数三个 + session 集成两个 + Spinner 两个，既有用例零回归；前缀稳定回归套件全绿为红线）。

Run: `pnpm selfcheck`
Expected: OK（工具清单零新增——本特性线未加任何工具，前缀无断点）。

- [ ] **Step 3: 残渣自查**

Run: `grep -rn "tool-running" src/ docs/superpowers/specs/2026-09-22-streaming-task-state-design.md`
Expected: 零命中（幽灵态已按规格 §4 收敛，代码与文档零残留）。

Run: `grep -n "TBD\|TODO" docs/superpowers/plans/2026-09-22-streaming-task-state.md`
Expected: 零命中。

- [ ] **Step 4: 提交**

```bash
git add MANUAL.md
git commit -m "docs(manual): 运行状态三态显示口径同步"
```

## 验收矩阵（规格 §7 映射）

| 规格条款 | 落点 |
|---|---|
| model-start/end 事件与时序 | Task 1（时序断言）+ Task 2（状态推导） |
| callId/status 配对与并行独立 | Task 1 三个用例 + Task 2 并行用例 |
| applyTaskState 纯函数全覆盖 | Task 2（主链/并行/幂等/error 清态） |
| 审批挂起 tool-awaiting | Task 2 Step 7（L254/L261 两处）+ Spinner awaiting 标注 |
| /new 归位 idle、瞬态不落 journal | Task 2（/new 用例；task 字段不进 journal 词汇表） |
| Spinner 三态渲染与帧高不变量 | Task 3 两个用例（行数 = 活跃调用数） |
| 前缀稳定零击穿 | Task 1 Step 4（reactor.prefix.test 回归）+ Task 4 全量门禁 |
| MANUAL 口径同步 | Task 4 Step 1 |

