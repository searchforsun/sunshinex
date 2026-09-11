# 长任务护栏下沉与 TUI 主链接线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「时间 / 预算 / 步数」护栏收进 Reactor 执行核，让 TUI 主链经 LoopEngine 拿到与 CLI 一致的终止口径，并使未完成终止对用户可见。

**Architecture:** 新增单一判定纯函数 `guardrailStop`（`src/harness/guardrail.ts`）；Reactor 每步边界调用它，Loop/Graph 引擎的节点边界检查改为复用同一函数，消除三份重复实现。两引擎把「剩余时间 / 剩余 token」换算后透传进 Reactor，修掉「超时守在节点边界、耗时发生在节点内部」的粒度错位（spec §1.2 R2）。TUI 的 `runTask` 从直连 Reactor 改为经 LoopEngine 的长任务模板，终止原因经 `stopReason` 上屏（修 R1 / R3）。

**Tech Stack:** TypeScript（strict）+ Node.js（CommonJS）；测试用 `node:test` + `node:assert/strict`；TUI 渲染层为 ink（React）。

**Spec:** `docs/superpowers/specs/2026-09-11-long-task-guardrail-design.md`（唯一事实来源）

## Global Constraints

- TypeScript strict，**禁止无理由 `any`**；新增共享类型须登记到 `src/types.ts`。
- 每次提交前：`npm run build` 零报错；`npm run selfcheck` 通过。
- 提交信息格式：`<type>(<scope>): <说明>`。
- **同一文件的改动串行进行**（本项目实测：同文件并行写会丢更新）。
- 不入库：`.npm-cache/`、`.data/`、`node_modules/`、`dist/`。
- 本环境 `HOME` 不可写，装依赖用 `npm install --cache .npm-cache`。
- 决策约束（spec §2，逐字沿用）：
  - D1 完成以模型自报 `done` 为准，**不引入校验环节**。
  - D2 **步边界收敛**，不抢占进行中的模型/工具调用。
  - D3 4h 记在 run 上（`deadlineAt = startedAt + timeoutMs`）。
  - D4 护栏**内建进 Reactor**，编排层注入剩余限额；不新增编排层。
  - D5 一条主链：入口 → LoopEngine（内嵌 Reactor）；不暴露引擎开关。
  - D6 graph 仅经专有模式 `/pipeline` 进入，**不自动转化**（本计划不实现）。
  - D7 判定顺序统一 **超时 → 预算 → 迭代/步数**。
- 明确不做（spec §10）：不引入校验环节；不引入 AbortSignal 抢占式中断；不新增编排层；不暴露 `/goal` `/graph`；不改 Loop/Graph 的验收节点与拓扑。
- **本计划范围 = spec §11 的 A（1–3）+ B（4–7）。** spec §11 的第 8 项（B+ 专有模式 `/pipeline`）与第 9 项（C 运行态展示 `FlowStrip`）**另行出计划**，不在本文件内。
- 两处 spec 未列全、本计划补上的量纲细节（实现以本文件为准）：
  - Reactor 的 `tokenCap`（**累计**硬上限）与 `budget.total`（**上下文窗口**阈值）是两个量纲，不得合并——spec §6 已定，但 §7 表格只列了 `budget`，故 Task 4 显式补上 `tokenCap` 一列。
  - Graph 既有超时判定用 `>`、Loop 用 `>=`；统一为 `>=`（spec §6 要求「同一判定函数」）。行为差异仅 1ms，Task 3 的测试予以固定。

---

## 文件结构

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `src/harness/guardrail.ts` | 终止判定的**唯一**实现（纯函数，无 IO） | 新建 |
| `src/types.ts` | 共享类型登记（`StopReason` / `LimitReason` / 两结果类型的 `stopReason`） | 改 |
| `src/harness/reactor.ts` | 每步边界调用护栏；接口显式化；`RunResult.stopReason` | 改 |
| `src/loop/engine.ts` | 节点边界改调同一判定函数 | 改 |
| `src/loop/nodes.ts` | `agentNode` 透传剩余时间 / 剩余 token | 改 |
| `src/graph/engine.ts` | 层边界改调同一判定函数 | 改 |
| `src/graph/agents.ts` | 角色 agent 节点透传剩余时间 / 剩余 token | 改 |
| `src/loop/templates.ts` | 新增长任务模板（单 agent 节点、4h） | 改 |
| `src/tui/runtime.ts` | `runTask` 改走长任务模板；返回投影 `RunOutcome` | 改 |
| `src/tui/stop-reason.ts` | 终止原因的**用户可见文案**（纯函数） | 新建 |
| `src/tui/session.ts` | 规划段与执行段同链；未完成终止上屏 | 改 |

---

### Task 1: 护栏判定纯函数 `guardrailStop`

**Files:**
- Create: `src/harness/guardrail.ts`
- Modify: `src/types.ts`（登记 `StopReason` / `LimitReason`）
- Test: `src/harness/guardrail.test.ts`

**Interfaces:**
- Consumes: 无（叶子模块）
- Produces:
  - `StopReason = 'done' | 'max-steps' | 'deadline' | 'budget' | 'model-error'`（`src/types.ts`）
  - `LimitReason = Extract<StopReason, 'max-steps' | 'deadline' | 'budget'>`（`src/types.ts`）
  - `GuardrailInput { now: number; deadlineAt?: number; tokensUsed: number; tokenCap?: number; iteration: number; maxIterations?: number }`
  - `guardrailStop(input: GuardrailInput): LimitReason | null`

- [ ] **Step 1: 在 `src/types.ts` 登记共享类型**

在文件末尾（`ToolCategory` 之后）追加：

```ts
/** 终止原因：done=正常完成；model-error=模型调用失败；其余为护栏触发（D7 顺序：超时 → 预算 → 迭代/步数） */
export type StopReason = 'done' | 'max-steps' | 'deadline' | 'budget' | 'model-error';

/** 护栏可返回的越限原因（不含「正常完成」与「模型失败」——那两类由调用方判定） */
export type LimitReason = Extract<StopReason, 'max-steps' | 'deadline' | 'budget'>;
```

- [ ] **Step 2: 写失败测试**

```ts
// src/harness/guardrail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardrailStop } from './guardrail';

/** 最小输入：三个上限都不给＝不设限 */
const base = { now: 1_000, tokensUsed: 0, iteration: 0 };

test('guardrailStop：不设限时不干预', () => {
  assert.equal(guardrailStop({ ...base }), null);
});

test('guardrailStop：时间优先——三者同时越限报 deadline', () => {
  assert.equal(
    guardrailStop({
      now: 5_000,
      deadlineAt: 5_000,
      tokensUsed: 100,
      tokenCap: 100,
      iteration: 9,
      maxIterations: 3,
    }),
    'deadline',
  );
});

test('guardrailStop：预算次之——预算与步数同时越限报 budget', () => {
  assert.equal(
    guardrailStop({ now: 1_000, tokensUsed: 10, tokenCap: 10, iteration: 4, maxIterations: 4 }),
    'budget',
  );
});

test('guardrailStop：各维度一律按 >= 判定（与两引擎既有比较语义一致）', () => {
  assert.equal(guardrailStop({ now: 999, deadlineAt: 1_000, tokensUsed: 0, iteration: 0 }), null);
  assert.equal(guardrailStop({ now: 1_000, deadlineAt: 1_000, tokensUsed: 0, iteration: 0 }), 'deadline');
  assert.equal(guardrailStop({ now: 0, tokensUsed: 0, tokenCap: 0, iteration: 0 }), 'budget');
  assert.equal(guardrailStop({ now: 0, tokensUsed: 0, iteration: 200, maxIterations: 200 }), 'max-steps');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run build && node --test dist/harness/guardrail.test.js`
Expected: 编译或运行失败，提示找不到 `./guardrail`

- [ ] **Step 4: 实现**

```ts
// src/harness/guardrail.ts
import { LimitReason } from '../types';

export interface GuardrailInput {
  /** 当前绝对时刻（ms epoch） */
  now: number;
  /** 绝对截止时刻；缺省＝不设时间限 */
  deadlineAt?: number;
  /** 本 run 的累计真实用量 */
  tokensUsed: number;
  /** 累计 token 硬上限；缺省＝不设预算限。与上下文窗口 budget 无关（两量纲） */
  tokenCap?: number;
  /** 已完成单位数（Reactor 步 / Loop 节点 / Graph 节点，语义一致：只数已完成的） */
  iteration: number;
  /** 单位数上限；缺省＝不设步数限 */
  maxIterations?: number;
}

/**
 * 护栏判定（纯函数）：顺序固定 超时 → 预算 → 迭代/步数（D7 时间优先）。
 * 各维度一律按 >= 判定，与 loop/graph 两引擎既有比较语义一致（graph 原用 `>`，本计划统一为 `>=`）。
 * 只回答「该不该停、为什么停」，不产生任何状态——状态映射由调用方负责。
 */
export function guardrailStop(input: GuardrailInput): LimitReason | null {
  const { now, deadlineAt, tokensUsed, tokenCap, iteration, maxIterations } = input;
  if (deadlineAt !== undefined && now >= deadlineAt) return 'deadline';
  if (tokenCap !== undefined && tokensUsed >= tokenCap) return 'budget';
  if (maxIterations !== undefined && iteration >= maxIterations) return 'max-steps';
  return null;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run build && node --test dist/harness/guardrail.test.js`
Expected: `# pass 4`、`# fail 0`

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/harness/guardrail.ts src/harness/guardrail.test.ts
git commit -m "feat(guardrail): 新增终止判定纯函数 guardrailStop（顺序对齐 D7）"
```

---

### Task 2: Reactor 内建护栏（每步边界）

**Files:**
- Modify: `src/harness/reactor.ts`（`RunResult` 增 `stopReason`；`run` 的 opts 显式化；循环边界改判）
- Test: `src/harness/reactor.guardrail.test.ts`

**Interfaces:**
- Consumes: `guardrailStop`（Task 1）、`StopReason`（Task 1）
- Produces:
  - `ReactorLimits { maxSteps?: number; budget?: { total: number; reserve: number }; tokenCap?: number; deadlineAt?: number }`
  - `ReactorOpts extends ReactorLimits { routeHint?: RouteHint }`
  - `RunResult { …; stopReason?: StopReason }`
  - `run(task: Task, opts?: ReactorOpts): Promise<RunResult>`

- [ ] **Step 1: 写失败测试**

```ts
// src/harness/reactor.guardrail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor, ReactorDeps } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';

/** 测试装配：真实安全链 / 注册表 / 上下文 + 注入适配器（对齐 reactor.test.ts 样板） */
function makeDeps(tmp: string, model: ReactorDeps['model']): ReactorDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

const CALL = '{"tool":"glob","input":{"pattern":"*"},"done":false}';
const DONE = '{"done":true,"reply":"好了"}';

function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-guard-'));
  return fn(tmp).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

test('Reactor：步数上限耗尽 → done=false 且 stopReason=max-steps', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([CALL, CALL, CALL]))).run(
      { goal: '一直调工具' },
      { maxSteps: 2 },
    );
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'max-steps');
    assert.equal(r.steps.length, 2, '步数上限 2 应恰好跑 2 步');
  });
});

test('Reactor：deadline 已过 → 一步都不跑即收敛', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([DONE]))).run(
      { goal: '来不及了' },
      { deadlineAt: Date.now() - 1 },
    );
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'deadline');
    assert.equal(r.steps.length, 0);
  });
});

test('Reactor：tokenCap=0 → 立即按预算收敛（累计量纲，与窗口 budget 无关）', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([DONE]))).run(
      { goal: '预算为零' },
      { tokenCap: 0 },
    );
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'budget');
    assert.equal(r.steps.length, 0);
  });
});

test('Reactor：未给 tokenCap 时窗口 budget 不构成硬停（跑完即 done）', async () => {
  await withTmp(async (tmp) => {
    const r = await new Reactor(makeDeps(tmp, new ScriptedAdapter([CALL, CALL, CALL]))).run(
      { goal: '调两次工具后被步数拦住' },
      { maxSteps: 2, budget: { total: 200_000, reserve: 40_000 } },
    );
    assert.equal(r.stopReason, 'max-steps', '窗口预算不得冒名顶替为累计硬停');
  });
});

test('Reactor：模型抛错 → stopReason=model-error 且不抛给调用方', async () => {
  await withTmp(async (tmp) => {
    const boom = {
      provider: 'boom',
      async complete(): Promise<string> {
        throw new Error('模型挂了');
      },
    };
    const r = await new Reactor(makeDeps(tmp, boom)).run({ goal: '触发模型失败' }, { maxSteps: 3 });
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'model-error');
    assert.equal(r.reply, '模型挂了');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/harness/reactor.guardrail.test.js`
Expected: FAIL —— `r.stopReason` 为 `undefined`（类型上尚不存在该字段，编译即报错）

- [ ] **Step 3: 改接口与循环边界**

`src/harness/reactor.ts`：

1) 顶部导入并扩展 `RunResult`：

```ts
import { guardrailStop } from './guardrail';
import { StopReason } from '../types';
```
```ts
export interface RunResult {
  steps: StepRecord[];
  done: boolean;
  reply?: string;
  tokensUsed?: number;
  /** 路由观测：本 run 实际生效的最后一次决策（模型偏好覆盖时以偏好为准） */
  route?: RouteDecision;
  /** 终止原因（新增）：done=正常完成；model-error=模型失败；其余为护栏越限 */
  stopReason?: StopReason;
}

/** 显式限额：maxSteps/tokenCap/deadlineAt 为硬边界，budget 仅用于上下文窗口压缩判定（两量纲） */
export interface ReactorLimits {
  maxSteps?: number;
  budget?: { total: number; reserve: number };
  /** 累计 token 硬上限（与编排层 maxTokens 同量纲） */
  tokenCap?: number;
  /** 绝对截止时刻（ms epoch） */
  deadlineAt?: number;
}

export interface ReactorOpts extends ReactorLimits {
  routeHint?: RouteHint;
}
```

2) 把 `run` 的签名与循环头改为：

```ts
  async run(task: Task, opts?: ReactorOpts): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? 200;
    const budget = opts?.budget ?? { total: 200_000, reserve: 40_000 };
    const tokenCap = opts?.tokenCap;
    const deadlineAt = opts?.deadlineAt;
```
```ts
    let stopReason: StopReason = 'max-steps'; // 循环出口原因：护栏越限（缺省即步数），done / model-error 在各自分支覆盖
    for (let step = 1; ; step++) {
      const hit = guardrailStop({
        now: Date.now(),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        tokensUsed,
        ...(tokenCap !== undefined ? { tokenCap } : {}),
        iteration: step - 1, // 已完成步数：与 maxSteps 的既有语义一致（step 从 1 起）
        maxIterations: maxSteps,
      });
      if (hit) {
        stopReason = hit;
        break;
      }
```

3) `done` 分支：`reply = action.reply ?? '完成';` 之后、`break;` 之前插入 `stopReason = 'done';`

4) 模型失败分支：`this.emit('error', reply);` 之后、`break;` 之前插入 `stopReason = 'model-error';`

5) 收尾两处：

```ts
    this.emit('done', reply, { steps: steps.length, tokensUsed, stopReason });
    return { steps, done, reply, tokensUsed, route: lastRoute, stopReason };
```

> 注意：循环是 `for (let step = 1; ; step++)`，出口只由护栏与分支 break 决定；`maxSteps` 缺省 200 保证不会真死循环。`step` 变量在循环体内仍被复杂度推导使用（`step <= 2`），语义不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test dist/harness/reactor.guardrail.test.js`
Expected: `# pass 5`、`# fail 0`

- [ ] **Step 5: 跑全量回归**

Run: `npm test`
Expected: 全绿（既有 `reactor.test.ts` 与 `reactor.settle.test.ts` 不依赖 `maxSteps` 的循环写法）

- [ ] **Step 6: 提交**

```bash
git add src/harness/reactor.ts src/harness/reactor.guardrail.test.ts
git commit -m "feat(reactor): 每步边界内建护栏并报告 stopReason"
```

---

### Task 3: 两引擎边界复用同一判定

**Files:**
- Modify: `src/types.ts`（`LoopRunResult` / `GraphRunResult` 增 `stopReason`）
- Modify: `src/loop/engine.ts`（边界检查改调 `guardrailStop`；`finish` 透传原因）
- Modify: `src/graph/engine.ts`（同上；`finish` 参数改对象形式）
- Test: `src/loop/engine.guardrail.test.ts`、`src/graph/engine.guardrail.test.ts`

**Interfaces:**
- Consumes: `guardrailStop` / `LimitReason` / `StopReason`（Task 1）
- Produces: `LoopRunResult.stopReason?: StopReason`、`GraphRunResult.stopReason?: StopReason`

- [ ] **Step 1: 写失败测试**

```ts
// src/loop/engine.guardrail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine, LoopDeps, LoopEngineNode } from './engine';
import { LoopTermination } from '../types';

const deps = {} as LoopDeps;
const term = (over: Partial<LoopTermination>): LoopTermination => ({
  maxIterations: 4,
  maxTokens: 1_000,
  timeoutMs: 60_000,
  ...over,
});
const okNode = (id: string): LoopEngineNode => ({ id, kind: 'agent', run: () => ({ status: 'pass', tokens: 0 }) });

test('LoopEngine：timeoutMs=0 → failed 且 stopReason=deadline（未执行任何节点）', async () => {
  const r = await new LoopEngine([okNode('a')], deps, term({ timeoutMs: 0 })).run('x');
  assert.equal(r.status, 'failed');
  assert.equal(r.stopReason, 'deadline');
  assert.equal(r.iterations, 0);
});

test('LoopEngine：D7 顺序——预算与迭代同时越限报 budget（旧序会先报 iteration）', async () => {
  const r = await new LoopEngine([okNode('a')], deps, term({ maxIterations: 0, maxTokens: 0 })).run('x');
  assert.equal(r.stopReason, 'budget');
  assert.equal(r.status, 'paused');
});
```

```ts
// src/graph/engine.guardrail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDeps, GraphEngine, GraphNode, GraphTermination } from './engine';
import { GraphNodeOutput } from '../types';

const deps = {} as GraphDeps;
const term = (over: Partial<GraphTermination> = {}): GraphTermination => ({
  maxNodes: 12,
  maxTokens: 100_000,
  timeoutMs: 60_000,
  ...over,
});
const okNode = (id: string): GraphNode => ({
  id,
  kind: 'agent',
  deps: [],
  run: () => ({ nodeId: id, status: 'pass', tokens: 0 }) as GraphNodeOutput,
});

test('GraphEngine：D7 顺序——超时与预算同时越限报 deadline（旧序先报预算）', async () => {
  const r = await new GraphEngine([okNode('a')], deps, term({ maxTokens: 0, timeoutMs: 0 })).run('x');
  assert.equal(r.stopReason, 'deadline');
  assert.equal(r.status, 'failed');
});

test('GraphEngine：预算越限 → paused 且 stopReason=budget', async () => {
  const r = await new GraphEngine([okNode('a')], deps, term({ maxTokens: 0, timeoutMs: 60_000 })).run('x');
  assert.equal(r.stopReason, 'budget');
  assert.equal(r.status, 'paused');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/loop/engine.guardrail.test.js dist/graph/engine.guardrail.test.js`
Expected: FAIL —— `stopReason` 不存在（编译报错）

- [ ] **Step 3: 在 `src/types.ts` 登记四处字段（两个结果类型 + 两个节点输出）**

```ts
// LoopRunResult 内追加
  /** 终止原因（新增）：done=验收通过；其余为护栏越限或模型失败 */
  stopReason?: StopReason;
```
```ts
// GraphRunResult 内追加
  /** 终止原因（新增）：done=全部完成；其余为护栏越限或 gate 挂起 */
  stopReason?: StopReason;
```
```ts
// NodeOutput 内追加（节点把内层 Reactor 的终止原因带出来——否则引擎只能报「节点 fail」，原因在边界处丢失）
  /** 内层执行的终止原因（agent 节点透传 Reactor 的 stopReason） */
  stopReason?: StopReason;
```

> `GraphNodeOutput` **不加**该字段：本计划范围内 graph 的原因由引擎边界三查提供（见 Step 5 的用例）。graph 节点级原因透传属 B+（`/pipeline` 要显示「哪个节点为何停」）的内容，届时随该计划补，避免现在留下没人读的字段。

- [ ] **Step 4: 改 `src/loop/engine.ts`**

导入：

```ts
import { guardrailStop } from '../harness/guardrail';
import { LimitReason, StopReason } from '../types';
```

把原有三段边界检查（注释「边界检查（本轮执行前）」处）整体替换为：

```ts
      // 边界检查（本轮执行前）：统一判定函数，顺序 超时 → 预算 → 迭代（D7 时间优先）
      const hit = guardrailStop({
        now: Date.now(),
        deadlineAt: ctx.startedAt + this.termination.timeoutMs,
        tokensUsed: ctx.tokensUsed,
        tokenCap: this.termination.maxTokens,
        iteration: ctx.iteration,
        maxIterations: this.termination.maxIterations,
      });
      if (hit) {
        const mapped: Record<LimitReason, { status: LoopRunResult['status']; error: string }> = {
          deadline: { status: 'failed', error: `执行超时（超过 ${this.termination.timeoutMs}ms）` },
          budget: {
            status: 'paused',
            error: `token 预算超支（used ${ctx.tokensUsed} ≥ max ${this.termination.maxTokens}）`,
          },
          'max-steps': { status: 'failed', error: `iteration 上限（${this.termination.maxIterations}）已耗尽` },
        };
        const m = mapped[hit];
        return this.finish(ctx, m.status, { error: m.error, stopReason: hit });
      }
```

`finish` 的 extra 增字段并在结果中透传：

```ts
  private finish(
    ctx: LoopContext,
    status: LoopRunResult['status'],
    extra: { reply?: string; criteria?: CriterionResult[]; error?: string; stopReason?: StopReason },
  ): LoopRunResult {
```
```ts
    if (extra.error !== undefined) r.error = extra.error;
    if (extra.stopReason !== undefined) r.stopReason = extra.stopReason;
```

验收通过路径补原因：

```ts
        return this.finish(ctx, 'done', { reply: out.reply, criteria: out.criteria, stopReason: 'done' });
```

节点硬失败路径（agent 等非 check 节点 fail）把内层原因带出来——否则引擎只能报「节点 fail」，TUI 侧那条「未完成必须可见」的链就断在这里：

```ts
      if (out.status === 'fail' && node.kind !== 'check') {
        return this.finish(ctx, 'failed', {
          error: `节点 ${node.id} fail：${out.reply ?? '（无说明）'}`,
          ...(out.stopReason !== undefined ? { stopReason: out.stopReason } : {}),
        });
      }
```

其余 `this.finish(...)` 调用点（未知 route 目标、check 未过续流等）保持原样，不传 `stopReason`——它们不是护栏越限。

- [ ] **Step 5: 改 `src/graph/engine.ts`**

导入 `guardrailStop` 与 `StopReason`；`finish` 改为对象参数：

```ts
  private finish(
    status: GraphRunResult['status'],
    reply: string,
    opts: { pendingGates?: string[]; failedNodes?: string[]; stopReason?: StopReason } = {},
  ): GraphRunResult {
    const ctx = this.ctx!;
    const pendingGates = opts.pendingGates ?? [];
    const failed =
      opts.failedNodes ?? Object.values(ctx.results).filter((r) => r.status === 'failed').map((r) => r.nodeId);
    return {
      status,
      iterations: this.steps,
      tokensUsed: ctx.tokensUsed,
      failedNodes: failed,
      pendingGates,
      reply,
      results: ctx.results,
      ...(opts.stopReason !== undefined ? { stopReason: opts.stopReason } : {}),
    };
  }
```

`collect()` 三处调用改为对象形式，且完成态带原因：

```ts
    if (pausedGates.length > 0)
      return this.finish('paused', `等待人工审批：${pausedGates.join(', ')}`, { pendingGates: pausedGates });
    const failedNodes = all.filter((r) => r.status === 'failed').map((r) => r.nodeId);
    if (failedNodes.length > 0)
      return this.finish('failed', `存在失败节点：${failedNodes.join(', ')}`, { failedNodes });
    return this.finish('done', '全部节点完成', { stopReason: 'done' });
```

`walk` 中的三步边界检查替换为单一判定（注意把原有 `>` 统一为 `>=`）：

```ts
      // 边界三查（层边界）：统一判定函数，顺序 超时 → 预算 → 步数（D7 时间优先；并发层内不做中途打断）
      const hit = guardrailStop({
        now: Date.now(),
        deadlineAt: ctx.startedAt + this.term.timeoutMs,
        tokensUsed: ctx.tokensUsed,
        tokenCap: this.term.maxTokens,
        iteration: this.steps,
        maxIterations: this.term.maxNodes,
      });
      if (hit === 'deadline')
        return this.finish('failed', `执行超时（超过 ${this.term.timeoutMs}ms）`, { stopReason: 'deadline' });
      if (hit === 'budget') return this.finish('paused', 'Token 预算超支，已暂停', { stopReason: 'budget' });
      if (hit === 'max-steps')
        return this.finish('failed', `节点步数耗尽（maxNodes=${this.term.maxNodes}）`, { stopReason: 'max-steps' });
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run build && node --test dist/loop/engine.guardrail.test.js dist/graph/engine.guardrail.test.js`
Expected: `# pass 4`、`# fail 0`

- [ ] **Step 7: 跑全量回归（既有 termination 断言不得因顺序变化而破）**

Run: `npm test`
Expected: 全绿。若 `src/loop/engine.test.ts` / `src/graph/engine.test.ts` 中已有「同时越限」的断言，按 D7 顺序断言更新（时间/预算优先于迭代），并在提交信息中说明

- [ ] **Step 8: 提交**

```bash
git add src/types.ts src/loop/engine.ts src/loop/engine.guardrail.test.ts src/graph/engine.ts src/graph/engine.guardrail.test.ts
git commit -m "refactor(engines): 节点边界复用 guardrailStop，顺序统一为 D7"
```

---

### Task 4: 剩余限额透传进 Reactor

**Files:**
- Modify: `src/loop/nodes.ts`（`agentNode`）
- Modify: `src/graph/agents.ts`（角色 agent 节点）
- Test: `src/loop/nodes.guardrail.test.ts`、`src/graph/agents.guardrail.test.ts`

**Interfaces:**
- Consumes: `ReactorOpts`（Task 2）
- Produces: 无新导出（行为变更：节点内构造的 Reactor 带上 `tokenCap` / `deadlineAt`）

- [ ] **Step 1: 写失败测试**

```ts
// src/loop/nodes.guardrail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentNode } from './nodes';
import { LoopDeps } from './engine';
import { LoopContext, LoopTermination } from '../types';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';

/** 计数适配器：用于断言「护栏挡在模型调用之前」 */
class CountingAdapter implements ModelAdapter {
  readonly provider = 'counting';
  calls = 0;
  constructor(private inner: ModelAdapter) {}
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.calls += 1;
    return this.inner.complete(prompt, hooks);
  }
}

function makeDeps(tmp: string, model: ModelAdapter): LoopDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

function ctxOf(state: Record<string, unknown>, over: Partial<LoopTermination> = {}): LoopContext {
  return {
    iteration: 0,
    state,
    tokensUsed: 0,
    startedAt: Date.now(),
    termination: { maxIterations: 4, maxTokens: 1_000, timeoutMs: 60_000, ...over },
  };
}

test('agentNode：剩余时间换算成 Reactor deadline，超时挡在模型调用之前', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-an-'));
  try {
    const rec = new CountingAdapter(new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}']));
    const out = await agentNode(makeDeps(tmp, rec)).run(ctxOf({ goal: 'x' }, { timeoutMs: 0 }), null);
    assert.equal(out.status, 'fail');
    assert.equal(rec.calls, 0, 'deadline 应在模型调用前收敛');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('agentNode：剩余 token 换算成 Reactor tokenCap，超额同样不调模型', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-an2-'));
  try {
    const rec = new CountingAdapter(new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}']));
    const out = await agentNode(makeDeps(tmp, rec)).run(ctxOf({ goal: 'x' }, { maxTokens: 0 }), null);
    assert.equal(out.status, 'fail');
    assert.equal(rec.calls, 0, 'tokenCap 应在模型调用前收敛');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

```ts
// src/graph/agents.guardrail.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeRoleAgent } from './agents';
import { GraphDeps } from './engine';
import { GraphContext, GraphTermination } from '../types';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';

class CountingAdapter implements ModelAdapter {
  readonly provider = 'counting';
  calls = 0;
  constructor(private inner: ModelAdapter) {}
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.calls += 1;
    return this.inner.complete(prompt, hooks);
  }
}

function makeDeps(tmp: string, model: ModelAdapter): GraphDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

test('makeRoleAgent：把剩余时间换算成 Reactor deadline（超时不调模型）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ag-'));
  try {
    const rec = new CountingAdapter(new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}']));
    const deps = makeDeps(tmp, rec);
    const node = makeRoleAgent('planner', deps);
    const ctx: GraphContext = {
      state: { goal: 'x' },
      tokensUsed: 0,
      startedAt: Date.now(),
      results: {},
      termination: { maxNodes: 10, maxTokens: 200_000, timeoutMs: 0 } as GraphTermination,
    };
    const out = await node.run(ctx, deps, {});
    assert.equal(out.status, 'failed');
    assert.equal(rec.calls, 0, 'deadline 应在模型调用前收敛');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/loop/nodes.guardrail.test.js dist/graph/agents.guardrail.test.js`
Expected: FAIL —— 模型被调用了（`calls` 为 1），节点状态为 `done` / `pass`

- [ ] **Step 3: 改 `src/loop/nodes.ts` 的 `agentNode`**

```ts
      const remaining = Math.max(0, ctx.termination.maxTokens - ctx.tokensUsed);
      const budget = toReactorBudget(remaining);
      const reactor = new Reactor(deps);
      const r = await reactor.run(
        { goal },
        {
          maxSteps: opts?.maxSteps,
          budget,
          tokenCap: remaining,
          deadlineAt: ctx.startedAt + ctx.termination.timeoutMs,
        },
      );
      return {
        status: r.done ? 'done' : 'fail',
        reply: r.reply,
        tokens: r.tokensUsed ?? 0,
        ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
      };
```

> 该块是**整体替换**：原实现为 `const budget = toReactorBudget(...)` + 单行 `reactor.run` + `return { status: r.done ? 'done' : 'fail', reply, tokens }`；三行都要换掉。若要领漏掉 `return`，`stopReason` 会在节点边界丢失，Task 7 的上屏链就断了。

- [ ] **Step 4: 改 `src/graph/agents.ts` 的角色节点**

```ts
      const remaining = Math.max(0, ctx.termination.maxTokens - ctx.tokensUsed);
      const budget = toReactorBudget(remaining);
      const result = await reactor.run(
        { goal: task },
        {
          maxSteps: opts.maxSteps,
          budget,
          tokenCap: remaining,
          deadlineAt: ctx.startedAt + ctx.termination.timeoutMs,
        },
      );
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run build && node --test dist/loop/nodes.guardrail.test.js dist/graph/agents.guardrail.test.js`
Expected: `# pass 3`、`# fail 0`

- [ ] **Step 6: 跑全量回归**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/loop/nodes.ts src/loop/nodes.guardrail.test.ts src/graph/agents.ts src/graph/agents.guardrail.test.ts
git commit -m "feat(engines): 节点向 Reactor 透传剩余 deadline 与 tokenCap"
```

---

### Task 5: 长任务 Loop 模板（单 agent 节点、4h）

**Files:**
- Modify: `src/loop/templates.ts`
- Test: `src/loop/templates.long-task.test.ts`

**Interfaces:**
- Consumes: `agentNode`（Task 4）、`assemble` / `TemplateOpts` / `LoopTemplate`（既有）
- Produces:
  - `LONG_TASK_TIMEOUT_MS = 14_400_000`（4h）
  - `LongTaskOpts extends TemplateOpts { agentMaxSteps?: number }`
  - `longTaskTemplate(deps: LoopDeps, opts?: LongTaskOpts): LoopTemplate`（`name === 'long-task'`）

- [ ] **Step 1: 写失败测试**

```ts
// src/loop/templates.long-task.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LONG_TASK_TIMEOUT_MS, longTaskTemplate } from './templates';
import { LoopDeps } from './engine';
import { ModelAdapter } from '../model/adapter';
import { ScriptedAdapter } from '../model/adapter';
import { ContextManager } from '../harness/context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import { DryRun } from '../harness/security/dryrun';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';

function makeDeps(tmp: string, model: ModelAdapter): LoopDeps {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  return { safety, registry, context: new ContextManager(tmp, new FileStore(tmp)), model };
}

function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-lt-'));
  return fn(tmp).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

test('longTaskTemplate：时间兜底为 4h，可被显式覆盖', () => {
  const deps = {} as LoopDeps;
  assert.equal(longTaskTemplate(deps).termination.timeoutMs, LONG_TASK_TIMEOUT_MS);
  assert.equal(longTaskTemplate(deps, { termination: { timeoutMs: 60_000 } }).termination.timeoutMs, 60_000);
});

test('longTaskTemplate：单 agent 节点，模型自报 done 即结束（不回绕）', async () => {
  await withTmp(async (tmp) => {
    const tpl = longTaskTemplate(makeDeps(tmp, new ScriptedAdapter(['{"done":true,"reply":"长任务完成"}'])));
    const r = await tpl.engine.run('做一件长活');
    assert.equal(r.status, 'done');
    assert.equal(r.stopReason, 'done');
    assert.equal(r.iterations, 1, '单节点模板必须一次即终态（execAgent 的 pass 降级会导致回绕 100 次）');
  });
});

// 需在文件顶部 import：import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';

/** 回传真实用量的适配器：累计量纲的 tokenCap 依赖 adapter usage，ScriptedAdapter 恒回 0 则永不可达 */
class UsageAdapter implements ModelAdapter {
  readonly provider = 'usage';
  calls = 0;
  constructor(private inner: ModelAdapter, private tokensPerCall: number) {}
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    this.calls += 1;
    hooks?.onUsage?.(this.tokensPerCall);
    return this.inner.complete(prompt, hooks);
  }
}

test('longTaskTemplate：时间兜底置 0 → 引擎边界先行收敛（模板覆盖必须生效）', async () => {
  await withTmp(async (tmp) => {
    const tpl = longTaskTemplate(makeDeps(tmp, new ScriptedAdapter(['{"done":true,"reply":"不该被调用"}'])), {
      termination: { timeoutMs: 0 },
    });
    const r = await tpl.engine.run('来不及了');
    assert.equal(r.status, 'failed');
    assert.equal(r.stopReason, 'deadline');
    assert.equal(r.iterations, 0, 'timeoutMs=0 → deadlineAt=startedAt：首节点前即收敛（Task 3 已冻结语义）');
  });
});

test('longTaskTemplate：节点内收敛同样只跑一次（不回绕）', async () => {
  await withTmp(async (tmp) => {
    // 越限必须落在「节点内部」：引擎边界用 maxTokens 判定，故取 maxTokens=1 让引擎放行、由节点内 tokenCap 收口
    const model = new UsageAdapter(new ScriptedAdapter(['{"tool":"glob","input":{"pattern":"*"},"done":false}']), 1);
    const tpl = longTaskTemplate(makeDeps(tmp, model), { termination: { maxTokens: 1 } });
    const r = await tpl.engine.run('预算极小');
    assert.equal(r.status, 'failed');
    assert.equal(r.stopReason, 'budget');
    assert.equal(r.iterations, 1, '节点内收敛也必须一步即终态（execAgent 的 pass 降级会导致此处为 100）');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/loop/templates.long-task.test.js`
Expected: 编译失败 —— `LONG_TASK_TIMEOUT_MS` / `longTaskTemplate` 不存在

- [ ] **Step 3: 实现**

在 `src/loop/templates.ts` 末尾追加：

```ts
/** 长任务时间兜底：4h（对齐 Graph DEFAULT_TERMINATION.timeoutMs，D3 单次提交计时口径） */
export const LONG_TASK_TIMEOUT_MS = 14_400_000;

export interface LongTaskOpts extends TemplateOpts {
  /** 单次 agent 的步数上限；缺省交给 Reactor 的 200 */
  agentMaxSteps?: number;
}

/**
 * 长任务：单 agent 节点，**无 check 节点**（D1：完成以模型自报 done 为准，不引入校验环节）。
 * 用 `agentNode` 而非 `execAgent` —— 后者把状态强制降为 pass（为 agent+check 模板设计），
 * 在单节点模板下会让引擎绕回自身直到 maxIterations 耗尽。同时本模板显式把时间兜底提到 4h，
 * 覆盖 Loop 层缺省的 2h（避免同一入口两套时长）。
 */
export function longTaskTemplate(deps: LoopDeps, opts?: LongTaskOpts): LoopTemplate {
  const agentOpts = opts?.agentMaxSteps !== undefined ? { maxSteps: opts.agentMaxSteps } : {};
  return assemble('long-task', [agentNode(deps, agentOpts)], deps, {
    ...opts,
    termination: { timeoutMs: LONG_TASK_TIMEOUT_MS, ...(opts?.termination ?? {}) },
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test dist/loop/templates.long-task.test.js`
Expected: `# pass 3`、`# fail 0`

- [ ] **Step 5: 提交**

```bash
git add src/loop/templates.ts src/loop/templates.long-task.test.ts
git commit -m "feat(loop): 新增长任务模板（单 agent 节点、4h 时间兜底）"
```

---

### Task 6: TUI `runTask` 改走长任务模板

**Files:**
- Modify: `src/tui/runtime.ts`
- Test: `src/tui/runtime.test.ts`（迁移既有断言 + 增护栏用例）

**Interfaces:**
- Consumes: `longTaskTemplate` / `LongTaskOpts`（Task 5）、`StopReason`（Task 1）
- Produces:
  - `RunOutcome { done: boolean; reply?: string; tokensUsed: number; stopReason?: StopReason }`
  - `TuiRuntime.runTask(goal: string, opts?: { maxSteps?: number }): Promise<RunOutcome>`

- [ ] **Step 1: 写失败测试（`src/tui/runtime.test.ts` 追加）**

```ts
test('createRuntime：主链经 Loop——不做任何事也走长任务模板（iterations 可观测）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt5-'));
  try {
    const rt = createRuntime({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const r = await rt.runTask('做一件事');
    assert.equal(r.done, true);
    assert.equal(r.stopReason, 'done');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：未完成时返回结构化 stopReason（不再只有 done=false）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt6-'));
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"tool":"glob","input":{"pattern":"*"},"done":false}']),
    });
    const r = await rt.runTask('一直调工具', { maxSteps: 1 });
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'max-steps');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

同时迁移既有 4 条用例：它们断言 `r.done`（不变）与 `rt.harness.ledger.summary().runs === 1`（不变，Loop 内嵌 Reactor 经 `ledger` 透传照常落账）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/tui/runtime.test.js`
Expected: FAIL —— `r.stopReason` 为 `undefined`

- [ ] **Step 3: 实现**

`src/tui/runtime.ts` 全量替换为：

```ts
import { Harness } from '../harness';
import { LoopDeps } from '../loop/engine';
import { longTaskTemplate } from '../loop/templates';
import { ModelAdapter } from '../model/adapter';
import { ApprovalDecision, ApprovalRequest, SessionEvent, StopReason } from '../types';

export interface TuiRuntimeOpts {
  root: string;
  model?: ModelAdapter;
  /** 事件流旁路注入：TUI 渲染层经 SessionController 消费；缺省零副作用 */
  onEvent?: (e: SessionEvent) => void;
  /** 权限模式（缺省 dontAsk）；manual 时配合 onApproval 走终端化审批 */
  mode?: 'dontAsk' | 'manual' | 'plan';
  /** manual 模式审批回调（guard asker 装配点）；会话结束由调用方 clearSessionAllows */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

/** TUI 提交的收口投影：只暴露会话层需要的「是否完成 / 终答 / 用量 / 终止原因」，不泄漏引擎结果内部形态 */
export interface RunOutcome {
  done: boolean;
  reply?: string;
  tokensUsed: number;
  stopReason?: StopReason;
}

export interface TuiRuntime {
  harness: Harness;
  runTask(goal: string, opts?: { maxSteps?: number }): Promise<RunOutcome>;
}

/** TUI 运行时接缝：同进程装配 Harness（数据底座 .data 天然同源）；GUI 阶段如需隔离可换 daemon 实现同契约 */
export function createRuntime(opts: TuiRuntimeOpts): TuiRuntime {
  const harness = new Harness({
    root: opts.root,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  if (opts.mode === 'manual' && opts.onApproval) harness.security.setAsker(opts.onApproval);

  // 主链唯一入口（D5）：提交经 Loop 长任务模板（内嵌 Reactor），不再直连 harness.reactor
  const loopDeps: LoopDeps = {
    safety: harness.safety,
    registry: harness.tools,
    context: harness.context,
    model: harness.model,
    ...(harness.ledger ? { ledger: harness.ledger } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  };

  return {
    harness,
    runTask: async (goal, o) => {
      const tpl = longTaskTemplate(loopDeps, o?.maxSteps !== undefined ? { agentMaxSteps: o.maxSteps } : {});
      const r = await tpl.engine.run(goal);
      return {
        done: r.status === 'done',
        ...(r.reply !== undefined ? { reply: r.reply } : {}),
        tokensUsed: r.tokensUsed,
        ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
      };
    },
  };
}
```

- [ ] **Step 4: 同步调用方类型**

`src/tui/session.ts` 中 `runTaskFlow` / `runPlanItems` 使用 `r.done` 与 `r.reply`，字段名不变；仅当 session.ts 直接 import 了 `RunResult` 时才改指向 `RunOutcome`（`npx tsc -p tsconfig.json` 会指出）。

Run: `npm run build`
Expected: 零报错

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run build && node --test dist/tui/runtime.test.js`
Expected: `# pass 6`、`# fail 0`

- [ ] **Step 6: 跑全量回归**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/tui/runtime.ts src/tui/runtime.test.ts src/tui/session.ts
git commit -m "feat(tui): 主链接入 Loop 长任务模板，runTask 返回结构化 RunOutcome"
```

---

### Task 7: 终止原因对用户可见

**Files:**
- Create: `src/tui/stop-reason.ts`
- Modify: `src/tui/session.ts`（`SessionOpts` 增可注入 `runtime`；`runTaskFlow` 与 `runPlanItems` 对未完成结果上屏）
- Test: `src/tui/stop-reason.test.ts`、`src/tui/session.incomplete.test.ts`

**Interfaces:**
- Consumes: `RunOutcome` / `TuiRuntime`（Task 6）、`StopReason`（Task 1）
- Produces:
  - `describeIncomplete(stopReason: StopReason | undefined): string`
  - `SessionOpts.runtime?: TuiRuntime`（测试接缝：会话层契约是「消费 RunOutcome 并上屏」，不该为验证它跑一次真 4h）

- [ ] **Step 1: 写失败测试**

```ts
// src/tui/stop-reason.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeIncomplete } from './stop-reason';

test('describeIncomplete：护栏原因各有明确文案', () => {
  assert.match(describeIncomplete('deadline'), /时间上限/);
  assert.match(describeIncomplete('budget'), /预算/);
  assert.match(describeIncomplete('max-steps'), /步数上限/);
});

test('describeIncomplete：正常完成与模型失败不由本函数重复上屏', () => {
  assert.equal(describeIncomplete('done'), '');
  assert.equal(describeIncomplete('model-error'), '', '模型失败已走 error 通道，避免双份提示');
  assert.equal(describeIncomplete(undefined), '');
});
```

```ts
// src/tui/session.incomplete.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { TuiRuntime, RunOutcome } from './runtime';
import { Harness } from '../harness';

/** 假运行时：只兑现会话层真正消费的契约 */
function fakeRuntime(harness: Harness, outcome: RunOutcome): TuiRuntime {
  return { harness, runTask: async () => outcome };
}

test('会话层：未完成终止必须上屏（R3）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inc-'));
  try {
    const harness = new Harness({ root: tmp, mode: 'dontAsk' });
    const ctrl = new SessionController({
      root: tmp,
      runtime: fakeRuntime(harness, { done: false, tokensUsed: 0, stopReason: 'deadline' }),
    });
    await ctrl.submit('做一件事');
    await ctrl.waitIdle();
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(texts, /未完成终止/, '未完成终止必须对用户可见，不得静默');
    assert.match(texts, /时间上限/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话层：完成后不追加未完成提示', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inc2-'));
  try {
    const harness = new Harness({ root: tmp, mode: 'dontAsk' });
    const ctrl = new SessionController({
      root: tmp,
      runtime: fakeRuntime(harness, { done: true, reply: '好了', tokensUsed: 3, stopReason: 'done' }),
    });
    await ctrl.submit('做一件事');
    await ctrl.waitIdle();
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(!/未完成终止/.test(texts));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/tui/stop-reason.test.js dist/tui/session.incomplete.test.js`
Expected: 编译失败 —— `describeIncomplete` 与 `SessionOpts.runtime` 均不存在

- [ ] **Step 3: 实现文案纯函数**

```ts
// src/tui/stop-reason.ts
import { StopReason } from '../types';

/**
 * 未完成终止的用户可见文案（纯函数）。正常完成返回空串；
 * 模型失败同样返回空串——它已由 error 通道上屏，重复提示只会干扰阅读。
 */
export function describeIncomplete(stopReason: StopReason | undefined): string {
  switch (stopReason) {
    case 'deadline':
      return '未完成终止：已达单次提交时间上限';
    case 'budget':
      return '未完成终止：token 预算耗尽（可续跑）';
    case 'max-steps':
      return '未完成终止：已达步数上限';
    default:
      return '';
  }
}
```

- [ ] **Step 4: 改 `src/tui/session.ts`**

`SessionOpts` 增注入位（放在 `TuiRuntimeOpts` 扩展字段里）：

```ts
export interface SessionOpts extends TuiRuntimeOpts {
  /** 运行时注入位：缺省自建 createRuntime(opts)；测试可注入假实现以隔离长任务 */
  runtime?: TuiRuntime;
}
```

构造函数里把自建改为注入优先（其余字段不变）：

```ts
    this.runtime = opts.runtime ?? createRuntime(opts);
```

导入调整：

```ts
import { RunOutcome, TuiRuntime } from './runtime';
import { describeIncomplete } from './stop-reason';
```

`runTaskFlow` 改为消费返回值：

```ts
    try {
      const r = await this.runtime.runTask(goal);
      const note = describeIncomplete(r.stopReason);
      if (!r.done && note.length > 0) this.pushMsg('system', note);
    } catch (e) {
      this.pushMsg('system', `发生错误：${e instanceof Error ? e.message : String(e)}`);
      this.state = { ...this.state, status: 'error' };
      this.notify();
    }
```

`runPlanItems` 里「非完成」不得再报成功（原实现会把未完成当成功推「已完成」）：

```ts
        const r: RunOutcome = await this.runtime.runTask(items[i]);
        if (!r.done) {
          const note = describeIncomplete(r.stopReason);
          if (note.length > 0) this.pushMsg('system', note);
          this.pushMsg('system', `步骤未完成：${items[i]}；剩余步骤暂停`);
          break;
        }
        const todos = [...this.state.todos];
        todos[i] = { ...todos[i], done: true };
        this.state = { ...this.state, todos };
        this.pushMsg('assistant', r.reply ?? '已完成：' + items[i]);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run build && node --test dist/tui/stop-reason.test.js dist/tui/session.incomplete.test.js`
Expected: `# pass 4`、`# fail 0`

- [ ] **Step 6: 跑全量回归**

Run: `npm test && npm run selfcheck`
Expected: 全绿；selfcheck 通过

- [ ] **Step 7: 提交**

```bash
git add src/tui/stop-reason.ts src/tui/stop-reason.test.ts src/tui/session.incomplete.test.ts src/tui/session.ts
git commit -m "fix(tui): 未完成终止显式上屏，规划项非完成不再误报成功"
```

---

### Task 8: `/plan` 规划段并入同一链（H1）

**Files:**
- Modify: `src/tui/session.ts`（`startPlanFlow`；清理 `makeRoleAgent` / `GraphContext` 残渣）
- Test: `src/tui/session.plan.test.ts`（新建；若同名文件已存在则在其中追加用例）

**Interfaces:**
- Consumes: `runTask` / `RunOutcome`（Task 6）、`describeIncomplete`（Task 7）
- Produces: 无新导出（行为变更：规划段经 Loop 链，手工构造的 `GraphContext.termination` 一并删除）

> **相对 spec §3 H1 的一处实现修正（需在提交信息中说明）**：H1 原文写「保留 `planner` 角色框定」。保留它意味着复用 `graph/agents.ts` 的 `makeRoleAgent`，而 `graph/agents.ts` 已依赖 `loop/nodes.ts`（`toReactorBudget`）——再让 session 侧的 Loop 链去依赖 graph 角色节点，会让 `loop → graph` 反向依赖、形成模块环。因此角色框定改为**提示词级**实现（见 Step 3 的规划指令），依赖方向保持 `graph → loop → harness`。

- [ ] **Step 1: 写失败测试**

```ts
// src/tui/session.plan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { createRuntime } from './runtime';
import { ScriptedAdapter } from '../model/adapter';

test('会话层：/plan 规划段经主链产出编号步骤并进确认卡', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-'));
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"1. 改 A 文件\\n2. 跑测试"}']),
    });
    const ctrl = new SessionController({ root: tmp, runtime: rt });
    await ctrl.submit('/plan 修一个 bug');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.status, 'awaiting-plan');
    assert.deepEqual(
      s.todos.map((t) => t.text),
      [],
      '确认前不应建待办（待办在确认后由 runPlanItems 建立）',
    );
    const texts = s.messages.map((m) => m.text).join('\n');
    assert.match(texts, /计划确认卡/);
    assert.match(texts, /改 A 文件/);
    assert.equal(rt.harness.ledger.summary().runs, 1, '规划 run 同样落账本（换通道不丢成本观测）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/tui/session.plan.test.js`
Expected: FAIL —— 规划段仍走 `makeRoleAgent('planner')` 裸节点，`runs` 断言与落账本路径不符（或规划文案不含规划指令）

- [ ] **Step 3: 改 `startPlanFlow`**

把 `const h = this.runtime.harness; ... const out = await planner.run(ctx, deps, {}); if (out.status !== 'pass') ...; planText = out.reply ?? '';` 整段替换为：

```ts
      // 规划段与执行段同链（H1）：经主链的 Loop 长任务模板。
      // 原实现是裸调 graph 角色节点——手工构造的 termination 无人读取（装饰性），
      // 且 loop → graph 会形成反向依赖；角色框定改为提示词级（依赖方向保持 graph → loop → harness）。
      const r = await this.runtime.runTask(
        `为下面的目标产出编号步骤计划，每行形如「1. 步骤」；只输出步骤行，不要解释、不要代码块。\n目标：${goal}`,
      );
      if (!r.done) {
        throw new Error(describeIncomplete(r.stopReason) || '规划未完成');
      }
      planText = r.reply ?? '';
```

删除因此不再使用的 import 与局部变量（`makeRoleAgent`、`GraphContext`、`GraphTermination` 等；`npx tsc` 与 `npm run build` 会指出残渣）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test dist/tui/session.plan.test.js`
Expected: `# pass 1`、`# fail 0`

- [ ] **Step 5: 跑全量回归 + 骨架自检**

Run: `npm test && npm run selfcheck`
Expected: 全绿；selfcheck 通过（`files` 行数字变化属正常）

- [ ] **Step 6: 提交**

```bash
git add src/tui/session.ts src/tui/session.plan.test.ts
git commit -m "refactor(tui): /plan 规划段并入主链，删除装饰性 GraphContext termination"
```

---

## 计划自审记录

**1. spec 覆盖**（spec §11 的 1–7 → 任务映射）

| spec §11 条目 | 本计划任务 |
| --- | --- |
| 1. `reactor.ts`：`ReactorLimits` / `ReactorOpts` / `stopReason` / 每步判定（含抽出纯函数） | Task 1 + Task 2 |
| 2. `loop/engine.ts`、`graph/engine.ts`：边界检查改调同一纯函数 | Task 3 |
| 3. `loop/nodes.ts`、`graph/agents.ts`：透传 `deadlineAt` | Task 4（并补 `tokenCap`，见 Global Constraints 说明） |
| 4. `loop/templates.ts`：长任务单 agent 模板 | Task 5 |
| 5. `tui/runtime.ts`：`runTask` 改走 Loop 模板；删除字面量 `12` | Task 6（字面量随 `runTask` 重写一并消失） |
| 6. `tui/session.ts`：消费返回值上屏未完成原因；`/plan` 规划段并入同一链 | Task 7 + Task 8 |
| 7. 测试补齐与既有断言回归 | 每个任务的 Step（`npm test` 全量回归） |
| 8. B+ 专有模式 `/pipeline` | **不在本计划**（另行出计划） |
| 9. C 运行态展示 `FlowStrip` | **不在本计划**（另行出计划） |

**2. 占位符扫描**：无 `TBD` / `TODO` / 「稍后补」；每个代码步骤均含可粘贴代码；每条命令均含预期结果。

**3. 类型一致性核对**：`guardrailStop`（Task 1）的入参键 `now / deadlineAt / tokensUsed / tokenCap / iteration / maxIterations` 在 Task 3 的两处调用中逐字一致；`ReactorOpts`（Task 2）在 Task 4 的 `reactor.run({ goal }, {...})` 与 Task 5 的模板装配中一致；`RunOutcome`（Task 6）在 Task 7 与 Task 8 的消费点字段名一致（`done` / `reply` / `tokensUsed` / `stopReason`）；`StopReason` 仅在 `src/types.ts` 定义一次，其余文件一律 import。

**4. 已识别并消解的风险**（对应 spec §12）

- 「`execAgent` 的 pass 降级会让单节点模板回绕」——Task 5 用 `agentNode` 并在测试中把 `iterations === 1` 固定为断言，防止回归。
- 「`budget.total` 被误当累计硬停」——Task 2 增设 `tokenCap`，并用「未给 `tokenCap` 时窗口预算不构成硬停」的用例把语义钉住。
- 「顺序变更属行为变更」——Task 3 用「同时越限报哪一条」的用例显式固定 D7 顺序，并在提交信息中声明。
- 「`stopReason` 会在节点边界丢失」——`agentNode` 原实现只回 `{ status, reply, tokens }`，引擎只能报笼统的「节点 fail」，TUI 那条「未完成必须可见」的链到此断掉。本计划据此给 `NodeOutput` 增设 `stopReason`（Task 3 Step 3），在 `agentNode` 写入（Task 4 Step 3）、在 Loop 引擎硬失败路径透传（Task 3 Step 4），使 **Reactor → 节点 → 引擎 → `RunOutcome` → 会话上屏** 全链贯通。`GraphNodeOutput` 有意不加该字段——本计划范围内 graph 的原因由引擎边界三查提供，节点级原因透传属 B+（`/pipeline` 要显示「哪个节点为何停」），避免现在留下无人读取的字段。
