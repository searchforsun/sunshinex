# P0 委派可见性(Delagation Visibility)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GraphEngine 与 SubagentRunner 的执行经统一 delegation 事件进入 SessionEvent 公共事件面,并由纯函数委派投影消费——TUI 面板/浏览列表与未来 GUI 同源,消灭「Graph 层零呈现」断层。

**Architecture:** 三步走:①`src/delegation/projection.ts` 纯 reducer(委派投影,零 TUI 依赖,GUI 同源消费点);②两个发射端(GraphEngine 按节点、SubagentRunner 按 spawn 生命周期)经既有 `deps.onEvent` 透传;③TUI 在 `onEvent` 单点分流进 `TuiState.delegations`,ChildPanel/Ctrl+B 经**并集选择器**消费投影(过渡接线:投影 ∪ 既有 children,保证合成事件测试路径全绿;P1 TaskBoard 落地后收敛为投影单源)。

**Tech Stack:** TypeScript (tsc strict)、node:test + assert/strict、ink(仅 TUI 组件)、无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§4.5 委派投影、§11 事件面扩展、§13 P0;本计划执行其 P0 段)。

## Global Constraints

- tsc strict 零报错;测试跑编译产物:`pnpm build && node --test dist/<路径>.test.js`;终局 `pnpm test` 全量绿。
- 事件 payload 结构化:禁止 ANSI/预渲染字符串进 payload(spec §11)。
- 既有 `session.subagent-*`、`App.spawn-browse`、`ChildPanel.live` 测试**零改动全绿**(并集选择器保证;组件新增 prop 一律可选)。
- 不改任何执行语义:GraphEngine 调度/Runner 生命周期零变化,只加事件发射。
- 注释密度与命名跟随仓库现状(中文决策注释,注明用户裁决/规格出处)。
- 事件载荷字段口径(全计划统一):`payload: { delegationId: string, kind: 'subagent' | 'background-task' | 'graph-node', label?: string, status?: 'done' | 'failed' | 'skipped' | 'paused', taskId?: string, nodeKind?: string, tokens?: number, reply?: string }`。

---

### Task 1: 事件面类型扩展 + 委派投影纯模型

**Files:**
- Modify: `src/types.ts:259-262`(SessionEventType 联合类型)
- Create: `src/delegation/projection.ts`
- Test: `src/delegation/projection.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`(types.ts:265-271,已存在)
- Produces: `DelegationKind` / `DelegationStatus` / `Delegation`(接口)、`applyDelegation(list: Delegation[], e: SessionEvent): Delegation[]`(纯函数;Task 3/4 依赖)、`DelegationEventPayload`(payload 口径单点;Task 2/3 的发射侧引用)

- [ ] **Step 1: 写失败测试**

创建 `src/delegation/projection.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '../types';
import { applyDelegation, Delegation } from './projection';

const ev = (type: string, payload: Record<string, unknown>, ts = 1000): SessionEvent =>
  ({ type, payload, ts }) as never;

test('applyDelegation:started 建条、ended 收态、未知事件引用不变', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent', label: 'rv' }, 100));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, 'running');
  assert.equal(list[0]!.startedAt, 100);
  const same = applyDelegation(list, ev('token', { x: 1 }, 200));
  assert.equal(same, list, '非委派事件返回原引用(零分配)');
  list = applyDelegation(list, ev('delegation-ended', { delegationId: 'rv', kind: 'subagent', status: 'done', tokens: 42 }, 300));
  assert.equal(list[0]!.status, 'done');
  assert.equal(list[0]!.endedAt, 300);
  assert.equal(list[0]!.tokens, 42);
});

test('applyDelegation:ended 无 started 时合成终态条目(skipped 语义)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-ended', { delegationId: 'b', kind: 'graph-node', status: 'skipped' }, 500));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, 'skipped');
  assert.equal(list[0]!.startedAt, 500, '合成条目起点取终态时刻');
});

test('applyDelegation:载荷缺 delegationId/kind 非法即忽略(防御口径)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { kind: 'subagent' }));
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'x', kind: 'bogus' }));
  list = applyDelegation(list, ev('delegation-ended', {}));
  assert.equal(list.length, 0);
});

test('applyDelegation:started 重发幂等(保留首次起点)', () => {
  let list: Delegation[] = [];
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent' }, 100));
  list = applyDelegation(list, ev('delegation-started', { delegationId: 'rv', kind: 'subagent' }, 900));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.startedAt, 100);
});

test('GUI 同源验证(spec §13 P0 验收):混合事件流 → 单一订阅者推导统一委派列表', () => {
  let list: Delegation[] = [];
  const stream: SessionEvent[] = [
    ev('delegation-started', { delegationId: 'planner', kind: 'graph-node', nodeKind: 'agent' }, 1),
    ev('delegation-started', { delegationId: 'rv', kind: 'subagent', label: 'rv' }, 2),
    ev('delegation-ended', { delegationId: 'planner', kind: 'graph-node', status: 'done', tokens: 900 }, 3),
    ev('delegation-started', { delegationId: 'bg1', kind: 'background-task', taskId: 'b1' }, 4),
    ev('delegation-ended', { delegationId: 'rv', kind: 'subagent', status: 'done' }, 5),
  ];
  for (const e of stream) list = applyDelegation(list, e);
  assert.deepEqual(list.map((d) => [d.id, d.kind, d.status]), [
    ['planner', 'graph-node', 'done'],
    ['rv', 'subagent', 'done'],
    ['bg1', 'background-task', 'running'],
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/delegation/projection.test.js`
Expected: FAIL——`Cannot find module './projection'`(或 tsc 报 dist 下无产物)。若 tsc 先因 types.ts 尚无新事件字面量在别处报错,属正常,进 Step 3 一并解决。

- [ ] **Step 3: 扩展 SessionEventType + 写 projection.ts**

`src/types.ts` 中把(types.ts:259-262):

```ts
type SessionEventType =
  | 'token' | 'reasoning' | 'usage' | 'tool-call' | 'tool-result' | 'step'
  | 'route' | 'approval-request' | 'approval-resolved'
  | 'ctx' | 'done' | 'error' | 'notice' | 'model-start' | 'model-end';
```

替换为:

```ts
type SessionEventType =
  | 'token' | 'reasoning' | 'usage' | 'tool-call' | 'tool-result' | 'step'
  | 'route' | 'approval-request' | 'approval-resolved'
  | 'ctx' | 'done' | 'error' | 'notice' | 'model-start' | 'model-end'
  // 委派/任务事件(2026-10-04 多Agent编排 spec §11):P0 只发射 delegation-*;
  // task-* 为 P1 TaskBoard 词汇、gate-*/agent-message 为 P1/P2 词汇,先立协议面
  | 'task-created' | 'task-status-changed' | 'task-unlocked' | 'task-blocked'
  | 'delegation-started' | 'delegation-ended'
  | 'gate-waiting' | 'gate-resolved' | 'agent-message';
```

创建 `src/delegation/projection.ts`:

```ts
import type { SessionEvent } from '../types';

/** 委派投影(spec 2026-10-04 §4.5):spawn/graph 节点/后台任务的统一生命周期投影。
 *  纯函数从 SessionEvent 流推导,零 TUI 依赖——GUI 同源消费点(任何订阅者 + 本 reducer 即可
 *  推导委派列表);会话侧瞬态不落 journal(与 LiveTaskState 同口径,归档面走消息区 SPAWN 行) */
export type DelegationKind = 'subagent' | 'background-task' | 'graph-node';
export type DelegationStatus = 'running' | 'done' | 'failed' | 'skipped' | 'paused';

export interface Delegation {
  id: string;
  kind: DelegationKind;
  label: string;
  status: DelegationStatus;
  startedAt: number;
  endedAt?: number;
  tokens?: number;
  reply?: string;
}

/** 发射侧载荷口径单点(spec §11:结构化,禁 ANSI/预渲染) */
export interface DelegationEventPayload {
  delegationId: string;
  kind: DelegationKind;
  label?: string;
  status?: 'done' | 'failed' | 'skipped' | 'paused';
  taskId?: string;
  nodeKind?: string;
  tokens?: number;
  reply?: string;
}

function payloadOf(e: SessionEvent): DelegationEventPayload | undefined {
  const p = e.payload as Partial<DelegationEventPayload> | undefined;
  if (typeof p?.delegationId !== 'string' || p.delegationId.length === 0) return undefined;
  if (p.kind !== 'subagent' && p.kind !== 'background-task' && p.kind !== 'graph-node') return undefined;
  return p as DelegationEventPayload;
}

/** 状态推导(纯):started 建条/幂等重发保留首起点;ended 收态、无宿主时合成终态条目
 *  (graph skipped 节点无 started 的真实形态);非委派事件原引用返回(零分配) */
export function applyDelegation(list: Delegation[], e: SessionEvent): Delegation[] {
  if (e.type !== 'delegation-started' && e.type !== 'delegation-ended') return list;
  const p = payloadOf(e);
  if (p === undefined) return list;
  const idx = list.findIndex((d) => d.id === p.delegationId);
  if (e.type === 'delegation-started') {
    const entry: Delegation = { id: p.delegationId, kind: p.kind, label: p.label ?? p.delegationId, status: 'running', startedAt: e.ts };
    if (idx < 0) return [...list, entry];
    const next = [...list];
    next[idx] = { ...entry, startedAt: list[idx]!.startedAt };
    return next;
  }
  const base: Delegation =
    idx >= 0
      ? list[idx]!
      : { id: p.delegationId, kind: p.kind, label: p.label ?? p.delegationId, status: 'running', startedAt: e.ts };
  const ended: Delegation = {
    ...base,
    status: p.status ?? 'done',
    endedAt: e.ts,
    ...(typeof p.tokens === 'number' ? { tokens: p.tokens } : {}),
    ...(typeof p.reply === 'string' ? { reply: p.reply } : {}),
  };
  const next = [...list];
  if (idx >= 0) next[idx] = ended;
  else next.push(ended);
  return next;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/delegation/projection.test.js`
Expected: PASS(5 用例)

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/delegation/projection.ts src/delegation/projection.test.ts
git commit -m "feat(delegation): 事件面扩展 + 委派投影纯模型——SessionEventType 立 task-*/delegation-*/gate-*/agent-message 协议词汇(P0 只发 delegation-*);applyDelegation 纯 reducer 为 TUI/GUI 同源消费点(GUI 同源验证用例钉死)"
```

---

### Task 2: GraphEngine 按节点发射 delegation 事件

**Files:**
- Modify: `src/graph/engine.ts:152-181`(walk 的节点执行块)与 `engine.ts:119-130`(skip 路径)
- Test: `src/graph/engine.delegation.test.ts`(新建)

**Interfaces:**
- Consumes: `DelegationEventPayload` 口径(Task 1);`GraphDeps.onEvent?: (e: SessionEvent) => void`(loop/engine.ts:45,已存在)
- Produces: GraphEngine 执行每个节点时经 `deps.onEvent` 发射 `delegation-started`(执行前)与 `delegation-ended`(终态后;status 映射 pass→done、failed→failed、paused→paused、跳过→skipped);`completed` 幂等跳过的节点(resume)不重发

- [ ] **Step 1: 写失败测试**

创建 `src/graph/engine.delegation.test.ts`(装配样板取自 `engine.test.ts:1-30`:空依赖 + 手工节点工厂):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDeps, GraphEngine, GraphNode, GraphTermination } from './engine';
import { GraphContext, GraphNodeOutput, SessionEvent } from '../types';

const term = (over: Partial<GraphTermination> = {}): GraphTermination => ({ maxNodes: 12, maxTokens: 100_000, timeoutMs: 60_000, ...over });

function mkNode(id: string, deps: string[], run: () => GraphNodeOutput | Promise<GraphNodeOutput>): GraphNode {
  return { id, kind: 'agent', deps, run: (_ctx, _d, _inputs) => run() };
}

test('GraphEngine 节点进度事件:started/ended 成对、失败/跳过映射正确(串行链保序)', async () => {
  const events: SessionEvent[] = [];
  const deps = { onEvent: (e: SessionEvent) => events.push(e) } as GraphDeps;
  // 链 a(失败) → b(依赖 a,应 skipped);c 独立通过
  const eng = new GraphEngine(
    [
      mkNode('a', [], () => ({ nodeId: 'a', status: 'failed', tokens: 0 })),
      mkNode('b', ['a'], () => ({ nodeId: 'b', status: 'pass', tokens: 0 })),
      mkNode('c', [], () => ({ nodeId: 'c', status: 'pass', tokens: 7 })),
    ],
    deps,
    term(),
  );
  await eng.run('goal');
  const seq = events.map((e) => `${e.type}:${(e.payload as Record<string, unknown>)?.delegationId ?? ''}:${(e.payload as Record<string, unknown>)?.status ?? ''}`);
  // 层 1 [a,c] 并发:两 started 都先于任一 ended(map 序同步发射);层 2 b 无 started 只有 skipped ended
  const aStart = seq.findIndex((s) => s === 'delegation-started:a:');
  const cStart = seq.findIndex((s) => s === 'delegation-started:c:');
  const aEnd = seq.findIndex((s) => s === 'delegation-ended:a:failed');
  const bEnd = seq.findIndex((s) => s === 'delegation-ended:b:skipped');
  const cEnd = seq.findIndex((s) => s === 'delegation-ended:c:done');
  assert.ok(aStart >= 0 && cStart >= 0 && aEnd >= 0 && bEnd >= 0 && cEnd >= 0, `事件齐备,实际:${JSON.stringify(seq)}`);
  assert.ok(aStart < aEnd && cStart < cEnd, 'started 先于自身 ended');
  assert.ok(aEnd < bEnd, 'b 的 skipped 在 a 失败之后(层序)');
  assert.ok(!seq.some((s) => s.startsWith('delegation-started:b:')), 'skipped 节点无 started');
  assert.equal((events[0]!.payload as Record<string, unknown>)?.kind, 'graph-node');
  assert.equal((events[0]!.payload as Record<string, unknown>)?.nodeKind, 'agent');
});

test('GraphEngine 节点异常:catch 路径发 ended failed', async () => {
  const events: SessionEvent[] = [];
  const deps = { onEvent: (e: SessionEvent) => events.push(e) } as GraphDeps;
  const eng = new GraphEngine(
    [mkNode('boom', [], () => { throw new Error('kaboom'); })],
    deps,
    term(),
  );
  await eng.run('goal');
  const seq = events.map((e) => e.type);
  assert.deepEqual(seq, ['delegation-started', 'delegation-ended']);
  assert.equal((events[1]!.payload as Record<string, unknown>)?.status, 'failed');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/graph/engine.delegation.test.js`
Expected: FAIL——`events` 为空数组,`事件齐备` 断言失败(GraphEngine 尚不发射)。

- [ ] **Step 3: 实现 engine.ts 发射**

在 `GraphEngine` 类内(`layers()` 方法之前,engine.ts:49 前)加私有发射单点:

```ts
  /** 委派事件发射单点(spec §11/§13 P0):节点生命周期 → SessionEvent 公共面。
   *  label 恒取 node.id(graph 侧无业务 label);payload 结构化禁渲染字符串 */
  private emitDelegation(type: 'delegation-started' | 'delegation-ended', node: GraphNode, status?: 'done' | 'failed' | 'skipped' | 'paused'): void {
    this.deps.onEvent?.({
      type,
      ts: Date.now(),
      payload: { delegationId: node.id, kind: 'graph-node', nodeKind: node.kind, label: node.id, ...(status !== undefined ? { status } : {}) },
    });
  }
```

`walk()` 内三处接线(engine.ts 行号按现状,实现时以语义锚点为准):

① skip 路径(engine.ts:125-128),在 `ctx.results[id] = { nodeId: id, status: 'skipped', tokens: 0 };` 之后、`continue` 之前加:

```ts
          this.emitDelegation('delegation-ended', node, 'skipped');
```

② 成功路径(engine.ts:159-167),在 `try {` 后、`const o = await node.run(...)` 之前加:

```ts
            this.emitDelegation('delegation-started', node);
```

在 `this.hooks?.onNodeEnd?.(node, output);`(engine.ts:167)之前加:

```ts
            this.emitDelegation('delegation-ended', node, output.status === 'pass' ? 'done' : output.status);
```

③ 异常路径(engine.ts:168-179),在 `this.hooks?.onNodeEnd?.(node, output);`(engine.ts:178)之前加:

```ts
            this.emitDelegation('delegation-ended', node, 'failed');
```

注意:`this.completed.has(id)` 的 resume 幂等跳过(engine.ts:122-123)不加发射——该节点在首跑已发过 ended。

- [ ] **Step 4: 跑测试确认通过 + 引擎既有测试回归**

Run: `pnpm build && node --test dist/graph/engine.delegation.test.js dist/graph/engine.test.js dist/graph/engine.guardrail.test.js`
Expected: PASS(新 2 用例 + 既有引擎测试全绿)。

- [ ] **Step 5: 提交**

```bash
git add src/graph/engine.ts src/graph/engine.delegation.test.ts
git commit -m "feat(graph): GraphEngine 按节点发射 delegation 事件——消除「Graph 层不发 SessionEvent」断层(spec §13 P0):执行前 started、终态 ended(pass→done/failed/paused/skipped 映射),resume 幂等跳过不重发;CLI pipeline 消费方零改动自动获益"
```

---

### Task 3: SubagentRunner 发射 delegation 事件(前台 + 后台)

**Files:**
- Modify: `src/harness/subagent.ts:341-464`(runSubagent 主体)
- Test: `src/harness/subagent.delegation.test.ts`(新建)

**Interfaces:**
- Consumes: `DelegationEventPayload` 口径(Task 1);`this.deps.onEvent`(Runner deps,装配面已注入)
- Produces: 前台 spawn:`delegation-started`(finalLabel 消歧后)→ `delegation-ended`(ok 路径 status done + tokens;did-not-finish/isolation 失败/异常路径 status failed),payload.kind='subagent';后台 spawn 同一函数路径覆盖,payload.kind='background-task' 且带 taskId(opts.taskId 在场判定);CONCURRENCY_LIMIT/INVALID_ARG 等_started 之前的早退不发射

- [ ] **Step 1: 写失败测试**

创建 `src/harness/subagent.delegation.test.ts`(装配样板取自 `graph/agents.events.test.ts:14-30`:真实 deps + ScriptedAdapter):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRegistry, SubagentRunner } from './subagent';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';
import { SessionEvent } from '../types';

function assemble(model: ScriptedAdapter, events: SessionEvent[], root: string): SubagentRunner {
  const store = new FileStore(path.join(root, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  const context = new ContextManager(root, store);
  const agents = new AgentRegistry();
  agents.registerBuiltins();
  return new SubagentRunner(
    { registry, safety, context, model, root, onEvent: (e) => events.push(e) },
    agents,
  );
}

test('前台 spawn:started/ended(done+tokens)成对,kind=subagent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-del-fg-'));
  try {
    const events: SessionEvent[] = [];
    const model = new ScriptedAdapter([JSON.stringify({ done: true, reply: '子结论' })]);
    const runner = assemble(model, events, tmp);
    const r = await runner.runSubagent(
      { prompt: '干活', label: 'w' },
      { budget: { maxSteps: 3 } },
    );
    assert.equal(r.ok, true);
    const seq = events.filter((e) => e.type.startsWith('delegation-')).map((e) => e.type);
    assert.deepEqual(seq, ['delegation-started', 'delegation-ended']);
    const started = events.find((e) => e.type === 'delegation-started')!.payload as Record<string, unknown>;
    const ended = events.find((e) => e.type === 'delegation-ended')!.payload as Record<string, unknown>;
    assert.equal(started.delegationId, 'w');
    assert.equal(started.kind, 'subagent');
    assert.equal(ended.status, 'done');
    assert.equal(typeof ended.tokens, 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('并发上限早退:不发射任何 delegation 事件(未 started 即退)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-del-lim-'));
  try {
    const events: SessionEvent[] = [];
    const model = new ScriptedAdapter([]);
    const runner = assemble(model, events, tmp);
    // 直接用非法入参走早退路径(INVALID_ARG 在 label 消歧前返回)
    const r = await runner.runSubagent({ prompt: '' , agent_id: 'no-such-agent' } as never, { budget: { maxSteps: 1 } });
    assert.equal(r.ok, false);
    assert.equal(events.filter((e) => e.type.startsWith('delegation-')).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/subagent.delegation.test.js`
Expected: FAIL——第一用例 `seq` 为空数组(deepEqual 期望两事件)。

- [ ] **Step 3: 实现 subagent.ts 发射**

在 `runSubagent` 内、`this.inFlight++;`(subagent.ts:366 附近,同名消歧与计数之后、`try {` 之前)加发射器:

```ts
    // 委派事件发射单点(spec §11/§13 P0):finalLabel 消歧后恒定;后台路径(opts.taskId 在场)
    // 判 kind=background-task 并携带 taskId;started 之前的早退(参数/并发)不发射
    const delKind = opts?.taskId !== undefined ? 'background-task' : 'subagent';
    const emitDelegation = (type: 'delegation-started' | 'delegation-ended', status?: 'done' | 'failed', extra?: { tokens?: number }): void => {
      this.deps.onEvent?.({
        type,
        ts: Date.now(),
        payload: {
          delegationId: finalLabel,
          kind: delKind,
          label: finalLabel,
          ...(opts?.taskId !== undefined ? { taskId: opts.taskId } : {}),
          ...(status !== undefined ? { status } : {}),
          ...extra,
        },
      });
    };
```

四处接线(行号按现状,以语义锚点为准):

① `try {` 后第一行(subagent.ts:367,隔离判定之前):

```ts
      emitDelegation('delegation-started');
```

② ok 返回路径(subagent.ts:440,`return ok({ reply: result.reply, tokens: result.tokensUsed ?? 0 });` 之前):

```ts
          emitDelegation('delegation-ended', 'done', { tokens: result.tokensUsed ?? 0 });
```

③ did-not-finish 失败路径(subagent.ts:449,`return fail('INCOMPLETE', ...did not finish...)` 之前)与④ catch 路径(subagent.ts:445,`return fail('INCOMPLETE', msg);` 之前)各加:

```ts
        emitDelegation('delegation-ended', 'failed');
```

隔离失败早退路径(subagent.ts:383,`return fail('INCOMPLETE', '[...] isolation failed ...')` 之前)同样加 `emitDelegation('delegation-ended', 'failed');`(该路径 started 已发射)。

后台 `spawnBackground` 不加发射——它内部调 `runSubagent(input, { taskId: task.id, ... })`(subagent.ts:319-323),上述单点自动以 kind='background-task' 覆盖。

- [ ] **Step 4: 跑测试确认通过 + Runner 既有测试回归**

Run: `pnpm build && node --test dist/harness/subagent.delegation.test.js dist/harness/subagent.test.js dist/harness/subagent.spawn.test.js dist/harness/subagent.spawn-nulllit.test.js dist/harness/subagent.background.test.js`
Expected: PASS(新 2 用例 + Runner 既有测试全绿——发射不影响返回值/链行/账本行为)。

- [ ] **Step 5: 提交**

```bash
git add src/harness/subagent.ts src/harness/subagent.delegation.test.ts
git commit -m "feat(harness): SubagentRunner 发射 delegation 生命周期事件——前台 kind=subagent、后台(opts.taskId 在场)kind=background-task 带 taskId;done 带 tokens、三失败路径 failed;早退不发射;spawn 通道自此进统一委派投影(spec §4.5)"
```

---

### Task 4: TUI 接线——onEvent 分流 + TuiState.delegations + 面板/浏览消费

**Files:**
- Modify: `src/tui/chat-model.ts:174-202`(TuiState)——新增 `delegations` 字段 + `runningDelegations` 并集选择器
- Modify: `src/tui/session.ts:93`(初始 state)、`session.ts:817`(/new 重置)、`session.ts:1052-1057`(onEvent 分流)
- Modify: `src/tui/commands-session.ts:103`(恢复重置)
- Modify: `src/tui/components/use-browse-keys.ts:9-16`(browseRows 运行段换数据源)
- Modify: `src/tui/components/ChildPanel.tsx`(可选 `rows` prop,成员资格来自投影、明细 join children)
- Modify: `src/tui/components/App.tsx:287、510`(runningChildren 高度口径 + ChildPanel 传 rows)
- Test: `src/tui/session.delegation.test.tsx`(新建)

**Interfaces:**
- Consumes: `applyDelegation`/`Delegation`(Task 1);`ChildLiveState`(chat-model.ts:127)
- Produces: `TuiState.delegations: Delegation[]`(瞬态,不进 journal,与 `task: LiveTaskState` 同口径);`runningDelegations(st: Pick<TuiState, 'delegations' | 'children'>): { label: string; startedAt: number }[]`(并集选择器:children 运行中 ∪ 投影 running,投影终态对同名 children 行有否决权;ChildPanel/browseRows/App 消费)

- [ ] **Step 1: 写失败测试**

创建 `src/tui/session.delegation.test.tsx`(驱动样板取自 `session.subagent-meta.test.tsx:14-18`:SessionController + onEventForTest):

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { runningDelegations } from './chat-model';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('delegation 事件进投影:state.delegations 维护、终态对 children 行否决', () => {
  const tmp = tmpdir('sunshinex-sess-del-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    // 合成子代理流(既有测试路径,无 Runner):children 建条
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '审查', label: 'rv' } } } as never);
    ctrl.onEventForTest({ type: 'token', text: '审查中\n', payload: { subagent: 'rv' } } as never);
    // 投影流:另一委派 graph-node 启动
    ctrl.onEventForTest({ type: 'delegation-started', ts: 100, payload: { delegationId: 'planner', kind: 'graph-node', label: 'planner' } } as never);
    let st = ctrl.getState();
    assert.equal(st.delegations.length, 1);
    assert.equal(st.delegations[0]!.id, 'planner');
    let rows = runningDelegations(st);
    assert.deepEqual(rows.map((r) => r.label).sort(), ['planner', 'rv'], '并集:children(rv) ∪ 投影(planner)');
    // 投影终态否决同名 children 行(rv 的 Runner ended 先行,done 事件迟到)
    ctrl.onEventForTest({ type: 'delegation-ended', ts: 200, payload: { delegationId: 'rv', kind: 'subagent', status: 'done' } } as never);
    st = ctrl.getState();
    rows = runningDelegations(st);
    assert.deepEqual(rows.map((r) => r.label), ['planner'], '投影 done → rv 不再运行中');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 重置:delegations 清空', () => {
  const tmp = tmpdir('sunshinex-sess-delnew-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'delegation-started', ts: 100, payload: { delegationId: 'x', kind: 'subagent' } } as never);
    assert.ok(ctrl.getState().delegations.length > 0);
    (ctrl as unknown as { newSession: () => void }).newSession();
    assert.equal(ctrl.getState().delegations.length, 0, '/new 清空投影');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

注:`newSession` 的实际公开名以现场为准——若 `/new` 入口是 commands 族函数,直接调用该函数;断言目标不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tui/session.delegation.test.js`
Expected: FAIL——`st.delegations` 为 undefined(字段不存在)。

- [ ] **Step 3: 实现 chat-model + session + 组件接线**

① `src/tui/chat-model.ts`:import 区加 `import type { Delegation } from '../delegation/projection';`(**只进类型**;`applyDelegation` 由 session.ts 直接引,chat-model 保持"零 this 依赖纯件"的既有纪律);`TuiState`(chat-model.ts:174-202)的 `children` 字段后加:

```ts
  /** 委派投影(spec §4.5,P0):delegation-* 事件经 applyDelegation 纯函数推导;瞬态不进 journal
   *  (与 task 同口径)——归档回看面仍是消息区 SPAWN 行,投影只承担运行期生命周期 */
  delegations: Delegation[];
```

文件尾部(`slashHelp` 之前)加并集选择器:

```ts
/** 运行中委派行(P0 过渡接线,spec §13):children 运行中 ∪ 投影 running——投影终态对同名
 *  children 行有否决权(Runner ended 先于归档的窗口期);合成事件测试路径(无 Runner,只建
 *  children)与真实路径双兜底,保证既有测试全绿;P1 TaskBoard 落地后收敛为投影单源 */
export function runningDelegations(st: Pick<TuiState, 'delegations' | 'children'>): { label: string; startedAt: number }[] {
  const out = new Map<string, number>();
  for (const c of st.children) if (!c.done) out.set(c.label, c.startedAt);
  for (const d of st.delegations) {
    if (d.status !== 'running') out.delete(d.id);
    else if (!out.has(d.id)) out.set(d.id, d.startedAt);
  }
  return [...out].map(([label, startedAt]) => ({ label, startedAt })).sort((a, b) => a.startedAt - b.startedAt);
}
```

② `src/tui/session.ts`:import 区加 `import { applyDelegation } from '../delegation/projection';`;初始 state(session.ts:93 `children: [],` 后)加 `delegations: [],`;/new 重置点(session.ts:817 `children: [],` 后)加 `delegations: [],`;`onEvent`(session.ts:1052-1057)的子代理分流之后、`applyTaskState` 之前插:

```ts
    // 委派投影分流(spec §4.5 P0):delegation-* 只进投影,不触达主链消息分支
    if (e.type === 'delegation-started' || e.type === 'delegation-ended') {
      this.state = { ...this.state, delegations: applyDelegation(this.state.delegations, e) };
      this.notifyThrottled();
      return;
    }
```

③ `src/tui/commands-session.ts:103`(`children: [],` 后)加 `delegations: [],`(恢复重置)。

④ `src/tui/components/use-browse-keys.ts:9-16`:`browseRows` 运行段从 children 过滤改为选择器(import 自 '../chat-model'):

```ts
export function browseRows(st: TuiState): BrowseRow[] {
  return [
    ...runningDelegations(st).map((r) => ({ id: `live:${r.label}`, label: r.label, running: true as const })),
    ...st.messages
      .filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.subagentMeta)
      .map((m) => ({ id: `archived:${m.seq}`, label: m.text.replace(/^SPAWN /, ''), seq: m.seq, meta: m.subagentMeta }))
      .sort((a, b) => (a.meta?.delegatedAt ?? a.seq!) - (b.meta?.delegatedAt ?? b.seq!)),
  ];
}
```

(archived 段原样保留;journal 回放面不依赖投影。)

⑤ `src/tui/components/ChildPanel.tsx`:props 加可选 `rows`;成员资格改由 rows(缺省回退现状 children 过滤,既有测试零改动),明细按 label join:

```tsx
export interface ChildRow {
  label: string;
  startedAt: number;
}

export function ChildPanel({ childrenState, columns, rows }: { childrenState: ChildLiveState[]; columns: number; rows?: ChildRow[] }): JSX.Element {
  // 成员资格(P0 过渡接线,spec §13):rows 在场=委派投影并集口径,明细 join children;
  // 缺省=现状 children 过滤(既有测试路径)。投影终态否决权在 runningDelegations 内实现
  const membership: ChildRow[] = rows ?? childrenState.filter((c) => !c.done).map((c) => ({ label: c.label, startedAt: c.startedAt }));
  if (membership.length === 0) return <Box />;
  const width = Math.max(8, columns - 4);
  const glyph = '✻';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      {membership.map((r) => {
        const c = childrenState.find((x) => x.label === r.label);
        const calls = c?.calls ?? [];
        const tokens = c?.tokens ?? 0;
        const steps = c?.steps ?? 0;
        const startedAt = c?.startedAt ?? r.startedAt;
        const label = r.label;
        const headCost = glyph.length + 1 + displayWidth(label) + 2;
        const tail = ` · ↑${formatTokens(tokens)} tokens`;
        const durWidths = calls.map((call) => formatDuration(Math.max(0, Math.round((Date.now() - call.startedAt) / 1000))).length);
        const perCall = Math.max(8, Math.floor(
          (width - headCost - displayWidth(tail) - calls.length * 6 - durWidths.reduce((s, d) => s + d, 0)) / Math.max(1, calls.length),
        ));
        return (
        <Box key={label}>
          {calls.length > 0 ? (
            <Text color={theme.accent} dimColor>
              {glyph} [{label}]{' '}
              <Text dimColor>
                {calls.map((call, i) => (
                  <Text key={call.callId}>
                    {i > 0 ? ' · ' : ''}[{elideByWidth(call.target, perCall)}]{' '}
                    {formatDuration(Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)))}
                  </Text>
                ))}
                {' · '}↑{formatTokens(tokens)} tokens
              </Text>
            </Text>
          ) : (
            <Spinner startedAt={startedAt} tokens={tokens} label={label} steps={steps} columns={columns} />
          )}
        </Box>
        );
      })}
    </Box>
  );
}
```

(渲染分支结构不变:工具活动行 / Spinner 思考行两态;`ChildPanel.live.test.tsx` 不传 rows → 走缺省路径,零改动绿。)

⑥ `src/tui/components/App.tsx`:import `runningDelegations`(自 './chat-model' 经 session 转发或直接路径,以现场导入风格为准);`runningChildren` 高度口径(App.tsx:287 上方的计算点)改为 `const runningChildren = runningDelegations(state).length;`;ChildPanel 调用(App.tsx:510)追加 `rows` 属性——现有属性名以现场为准,仅追加一行:

```tsx
        <ChildPanel
          childrenState={state.children}
          columns={columns}
          rows={runningDelegations(state)}
        />
```

- [ ] **Step 4: 跑测试确认通过 + TUI 回归**

Run: `pnpm build && node --test dist/tui/session.delegation.test.js dist/tui/session.subagent-meta.test.js dist/tui/session.subagent-bg.test.js dist/tui/session.subagent-done.test.js dist/tui/session.subagent-page.test.js`
Expected: PASS(新 2 用例 + 既有 subagent 系列全绿)。

- [ ] **Step 5: 提交**

```bash
git add src/tui/chat-model.ts src/tui/session.ts src/tui/commands-session.ts src/tui/components/use-browse-keys.ts src/tui/components/ChildPanel.tsx src/tui/components/App.tsx src/tui/session.delegation.test.tsx
git commit -m "feat(tui): 委派投影接线——delegation-* 分流进 TuiState.delegations(瞬态);runningDelegations 并集选择器承载 ChildPanel 成员与 Ctrl+B 运行段(投影终态否决 children 行;缺省路径保既有测试零改动);/new 与恢复两点重置"
```

---

### Task 5: 全量回归 + GUI 同源验收 + spec 回写

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§13 P0 段执行回写)

**Interfaces:**
- Consumes: Task 1-4 全部产物
- Produces: 全量绿基线 + spec P0 落地记录

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全量 pass / fail 0(既有 win32 符号链接 2 例平台跳过维持);任何红即停,回对应任务修,不带病过闸。

- [ ] **Step 2: selfcheck**

Run: `pnpm selfcheck`
Expected: OK。

- [ ] **Step 3: spec 执行回写**

spec §13 P0 段末尾追加一行(沿用仓库执行回写惯例):

```markdown
> **落地记录**:P0 已交付(commit 见 git log `feat(delegation)`/`feat(graph)`/`feat(harness)`/`feat(tui)` 四笔)——事件面词汇就位、GraphEngine/Runner 双端发射、TuiState.delegations 投影 + 并集选择器过渡接线;「ChildPanel/Ctrl+B 改为消费投影」以并集口径落地(合成事件测试路径保绿),投影单源收敛随 P1 TaskBoard。
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md
git commit -m "docs(spec): P0 执行回写——委派可见性四笔落地记录与并集过渡口径说明"
```
