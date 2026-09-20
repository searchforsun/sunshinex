# 长任务终止参数收编 settings.json 与缺省放宽 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 长任务终止以步数/轮次/节点数为主承载并收编 settings.json 三枚语义键；墙钟降格为失控保底常量并大幅放宽（12h/24h）。

**Architecture:** 新增 `src/config/termination-config.ts` 解析单点（env 槽 > 内置缺省，消费点 `??` 兜底）；SEMANTIC_KEYS 表 +3 键；四处消费落点收口（reactor / graph agents 两处 `?? 200`，loop / graph 两处 assemble 合并序 `DEFAULT_TERMINATION < env < opts.termination`）；类型与 guardrail 零改动。

**Tech Stack:** TypeScript strict + Node.js `node:test`；零新依赖。

**规格：** `docs/superpowers/specs/2026-09-20-long-task-termination-settings-design.md`

## Global Constraints

- 门禁：`pnpm build`（tsc strict 零报错）+ 全量测试 fail 0 + `pnpm selfcheck` OK；每任务收口跑定向套件，Task 4 跑全量三门禁。
- TDD：红灯先行——每任务先写失败测试、跑红、最小实现、跑绿、提交。
- 优先级链（钉死）：**显式入参 > settings 语义键（env 槽）> 内置缺省**；墙钟时长不进 settings（D1）。
- 数值（规格 §3.2）：Reactor 缺省 200→**400**；Loop 轮数 100→**200**、墙钟 2h→**12h**（43_200_000）；LONG_TASK_TIMEOUT_MS 4h→**24h**（86_400_000）；Graph 节点 500→**1000**、墙钟 4h→**24h**（86_400_000）；token 预算 1M/2M 不动。
- 新增键（规格 §3.1）：`maxSteps`→`SUNSHINEX_MAX_STEPS`、`maxLoopIterations`→`SUNSHINEX_MAX_LOOP_ITERATIONS`、`maxGraphNodes`→`SUNSHINEX_MAX_GRAPH_NODES`；解析口径沿 memory-config `positiveInt`：未设/空串回 undefined，非正整数 fail-fast 抛错带槽名。
- **并发 WIP 隔离（强制）**：工作区混叠他线未提交改动（settings.ts / settings.test.ts 的 `reasoningEffort` 行、reactor.ts staged steering/ask 改动、CLAUDE.md 等）。本线编辑前先读现行字节、只做本线增量；提交用「临时索引 + commit-tree」流程（见下），他线 hunks 零卷入。
- **提交命令模板**（`.git` 为 worktree 链接文件，临时索引须放 git-dir 内）：

```bash
GIT_DIR=/opt/git/worktrees/wt-59f36a81fc
PARENT=$(git rev-parse HEAD)
IDX="$GIT_DIR/tmp-index-line"
rm -f "$IDX" "$IDX.lock"
GIT_INDEX_FILE="$IDX" git --git-dir="$GIT_DIR" read-tree HEAD
GIT_INDEX_FILE="$IDX" git --git-dir="$GIT_DIR" add <本线文件...>
TREE=$(GIT_INDEX_FILE="$IDX" git --git-dir="$GIT_DIR" write-tree)
COMMIT=$(git --git-dir="$GIT_DIR" commit-tree "$TREE" -p "$PARENT" -m "<message>")
git --git-dir="$GIT_DIR" update-ref refs/heads/dev1 "$COMMIT" "$PARENT"
rm -f "$IDX" "$IDX.lock"
```

- **混合文件 hunk 摩擦登记**：settings.test.ts 全表计数断言行（他线 26→27 在工作区、本线 27→30 叠加同一段）与 CLAUDE.md §12 若与他线 hunk 上下文重叠、无法按线拆分时，按「并发 WIP 随批入库并注明」先例随批提交并在提交说明登记两线叠加；可拆则仅暂存本线 hunks（对新增独立文件一律整文件 add）。
- 新增共享类型：无（本线零新类型，`LoopTermination`/`GraphTermination` 不动）。

---

### Task 1: termination-config 解析单点 + settings 语义键三枚

**Files:**
- Create: `src/config/termination-config.ts`
- Test: `src/config/termination-config.test.ts`
- Modify: `src/config/settings.ts`（SEMANTIC_KEYS 表 +3 行，插在 `stepDigestTotalChars` 行之后）
- Test: `src/config/settings.test.ts`（全表钉子计数 27→30 + 三键映射断言）

**Interfaces:**
- Consumes: 无（顶层解析器）。
- Produces: `reactorMaxStepsEnv(env?): number | undefined`、`loopIterationsEnv(env?): number | undefined`、`graphNodesEnv(env?): number | undefined`（Task 2/3 消费）。

- [ ] **Step 1: 写失败测试 `src/config/termination-config.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactorMaxStepsEnv, loopIterationsEnv, graphNodesEnv } from './termination-config';

test('未设/空串回 undefined，消费点取内置缺省', () => {
  assert.equal(reactorMaxStepsEnv({}), undefined);
  assert.equal(reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: '  ' }), undefined);
  assert.equal(loopIterationsEnv({}), undefined);
  assert.equal(graphNodesEnv({}), undefined);
});

test('合法正整数生效', () => {
  assert.equal(reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: '120' }), 120);
  assert.equal(loopIterationsEnv({ SUNSHINEX_MAX_LOOP_ITERATIONS: '300' }), 300);
  assert.equal(graphNodesEnv({ SUNSHINEX_MAX_GRAPH_NODES: '2500' }), 2500);
});

test('零/负/小数/非法文本 fail-fast 抛错且 message 带槽名', () => {
  for (const bad of ['0', '-1', '2.5', 'abc']) {
    assert.throws(() => reactorMaxStepsEnv({ SUNSHINEX_MAX_STEPS: bad }), /SUNSHINEX_MAX_STEPS/);
  }
  assert.throws(
    () => loopIterationsEnv({ SUNSHINEX_MAX_LOOP_ITERATIONS: 'x' }),
    /SUNSHINEX_MAX_LOOP_ITERATIONS/,
  );
  assert.throws(
    () => graphNodesEnv({ SUNSHINEX_MAX_GRAPH_NODES: '0' }),
    /SUNSHINEX_MAX_GRAPH_NODES/,
  );
});
```

- [ ] **Step 2: 跑红**

Run: `node --test dist/config/termination-config.test.js 2>/dev/null || npx tsc -p tsconfig.json --noEmit; node --import tsx --test src/config/termination-config.test.ts 2>/dev/null || pnpm exec tsc && node --test dist/config/termination-config.test.js`
Expected: FAIL（模块不存在）。以仓内现行单测跑法为准（`scripts/run-tests.js` 启动器；单文件调试可 `node --test dist/config/termination-config.test.js`，先 `pnpm build`）。

- [ ] **Step 3: 最小实现 `src/config/termination-config.ts`**

```ts
/**
 * 长任务终止参数解析单点（规格 §3.3）：env 槽 > 内置缺省（消费点 `??` 兜底）。
 * 口径沿 memory-config positiveInt：未设/空串回 undefined；非正整数 fail-fast 抛错带槽名——
 * 配置错误显式暴露，不静默吞。环境变量运行期不变，消费点 run/assemble 内解析一次
 * （对齐 CONTEXT_WINDOW / STRUCTURED_OUTPUT 先例）。
 */
function positiveIntOrUndefined(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${key}: ${raw} (expect positive integer)`);
  }
  return n;
}

/** Reactor 单 run 步数上限（缺省 400，见 src/harness/reactor.ts） */
export function reactorMaxStepsEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_STEPS');
}

/** Loop 修正环节点执行步上限（缺省 200，见 src/loop/templates.ts） */
export function loopIterationsEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_LOOP_ITERATIONS');
}

/** Graph 全链路节点步累计上限（缺省 1000，见 src/graph/templates.ts） */
export function graphNodesEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_GRAPH_NODES');
}
```

- [ ] **Step 4: SEMANTIC_KEYS +3 行（`src/config/settings.ts`，插在 `stepDigestTotalChars` 行后）**

```ts
  maxSteps: 'SUNSHINEX_MAX_STEPS',
  maxLoopIterations: 'SUNSHINEX_MAX_LOOP_ITERATIONS',
  maxGraphNodes: 'SUNSHINEX_MAX_GRAPH_NODES',
```

- [ ] **Step 5: settings.test.ts 全表钉子同步（读现行字节后改）**

工作区现态：`assert.equal(entries.length, 27, ...)`（他线 effort 已在工作区把 26→27，测试名同段）。本线在其上改为 `30`，并在逐键断言区追加：

```ts
  assert.equal(SEMANTIC_KEYS['maxSteps'], 'SUNSHINEX_MAX_STEPS', '长任务终止：Reactor 步数上限');
  assert.equal(
    SEMANTIC_KEYS['maxLoopIterations'],
    'SUNSHINEX_MAX_LOOP_ITERATIONS',
    '长任务终止：Loop 修正环轮数上限',
  );
  assert.equal(SEMANTIC_KEYS['maxGraphNodes'], 'SUNSHINEX_MAX_GRAPH_NODES', '长任务终止：Graph 节点步上限');
```

- [ ] **Step 6: 跑绿**

Run: `pnpm build && node --test dist/config/termination-config.test.js dist/config/settings.test.js`
Expected: PASS（新增 3 用例 + 全表钉子 30 键）。

- [ ] **Step 7: 提交（临时索引流程；settings.test.ts 若与他线 hunk 不可拆随批注明）**

```bash
# message: feat(config): 长任务终止参数语义键三枚 + termination-config 解析单点
# add: src/config/termination-config.ts src/config/termination-config.test.ts src/config/settings.ts src/config/settings.test.ts
```

---

### Task 2: Reactor / graph agents 缺省步数接 env 并放宽 200→400

**Files:**
- Modify: `src/harness/reactor.ts:127`（`run` 内缺省步数行；本行在他线 staged 改动区域之外，编辑前先读现行字节核对）
- Modify: `src/graph/agents.ts:52`（`budget.maxSteps` 行）
- Test: `src/harness/reactor.test.ts`（追加 1 用例）

**Interfaces:**
- Consumes: Task 1 `reactorMaxStepsEnv()`。
- Produces: 两处缺省 400 且同源接 env（D3 防漂移）；无接口变化。

- [ ] **Step 1: 写失败测试（`src/harness/reactor.test.ts` 追加；夹具 `makeDeps` 沿该文件现行形态）**

```ts
test('缺省步数接 SUNSHINEX_MAX_STEPS；显式入参优先于 env', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-env-steps-'));
  try {
    const reactor = new Reactor(makeDeps(tmp)); // 桩模型每轮产出工具调用、永不 done（沿既有 maxSteps 用例夹具）
    process.env.SUNSHINEX_MAX_STEPS = '1';
    const r1 = await reactor.run({ goal: 'x' });
    assert.equal(r1.steps.length, 1, '未传 maxSteps 时 env=1 生效');
    const r2 = await reactor.run({ goal: 'x' }, { maxSteps: 3 });
    assert.equal(r2.steps.length, 3, '显式入参优先：env=1 不覆盖 maxSteps=3');
  } finally {
    delete process.env.SUNSHINEX_MAX_STEPS;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

（`r.steps` 字段名以现行 `RunResult` 为准——参照同文件既有用例 `'Reactor 达到 maxSteps 强制终止'` 的断言面，若其经 stopReason/事件计数，则同形态改写两断言，保持「env 生效 / 显式优先」两个判据不变。）

- [ ] **Step 2: 跑红**

Run: `pnpm build && node --test dist/harness/reactor.test.js`
Expected: 新用例 FAIL（env=1 时仍跑 400 步缺省前的 200——实际表现为步数非 1）。

- [ ] **Step 3: 实现（两处同源）**

`src/harness/reactor.ts`（文件头 import 区加一行；L127 改缺省链）：

```ts
import { reactorMaxStepsEnv } from '../config/termination-config';
```

```ts
    const maxSteps = opts?.maxSteps ?? reactorMaxStepsEnv() ?? 400;
```

`src/graph/agents.ts`（import 区加同源 import；L52 改）：

```ts
import { reactorMaxStepsEnv } from '../config/termination-config';
```

```ts
            maxSteps: opts.maxSteps ?? reactorMaxStepsEnv() ?? 400,
```

- [ ] **Step 4: 跑绿 + graph 侧盘查**

Run: `pnpm build && node --test dist/harness/reactor.test.js dist/graph/agents.test.js dist/graph/agents.guardrail.test.js`
盘查：`grep -rn "?? 200\|maxSteps.*200" src/graph src/harness --include="*.ts" | grep -v test`——确认仓内无第二处硬编码 200 缺省残留。
Expected: PASS（既有用例全部显式传 maxSteps，不受影响）。

- [ ] **Step 5: 提交（临时索引流程；reactor.ts 仅暂存本线 hunk，他线 staged steering/ask 改动零触碰——若 apply --cached 与他线 hunks 冲突，登记偏差延后与他线协调提交，先推进 Task 3）**

```bash
# message: feat(harness): Reactor/graph 缺省步数接 SUNSHINEX_MAX_STEPS 并放宽 200→400
# add: src/harness/reactor.ts src/graph/agents.ts src/harness/reactor.test.ts
```

---

### Task 3: Loop / Graph 模板缺省放宽 + assemble 注入 env

**Files:**
- Modify: `src/loop/templates.ts`（`DEFAULT_TERMINATION` 数值放宽 + assemble 合并序插 env + `LONG_TASK_TIMEOUT_MS` 4h→24h）
- Modify: `src/graph/templates.ts`（`DEFAULT_TERMINATION` 数值放宽 + assemble 合并序插 env）
- Test: `src/loop/templates.test.ts`、`src/graph/templates.test.ts`（各追加合并序/数值用例）

**Interfaces:**
- Consumes: Task 1 `loopIterationsEnv()` / `graphNodesEnv()`。
- Produces: 模板缺省 = `DEFAULT_TERMINATION < env < opts.termination` 合并序（TUI /goal、CLI run/pipeline、graph 内嵌 loop 全路径生效）；无接口变化。

- [ ] **Step 1: 写失败测试（各文件追加）**

`src/loop/templates.test.ts`：

```ts
test('缺省放宽与 env 注入：DEFAULT < env < opts.termination 合并序', () => {
  const deps = makeLoopDeps(); // 沿该文件现行 deps 夹具构造形态
  // 放宽后缺省（规格 §3.2）
  const t0 = resolveTemplate(deps, 'test-loop');
  assert.equal(t0.termination.maxIterations, 200);
  assert.equal(t0.termination.timeoutMs, 43_200_000);
  assert.equal(t0.termination.maxTokens, 1_000_000);
  // env 注入轮数
  process.env.SUNSHINEX_MAX_LOOP_ITERATIONS = '50';
  try {
    const t1 = resolveTemplate(deps, 'test-loop');
    assert.equal(t1.termination.maxIterations, 50);
    assert.equal(t1.termination.timeoutMs, 43_200_000, 'env 只注轮数，墙钟仍为内置保底');
  } finally {
    delete process.env.SUNSHINEX_MAX_LOOP_ITERATIONS;
  }
  // 显式 opts 覆盖 env
  const t2 = resolveTemplate(deps, 'test-loop', {
    termination: { maxIterations: 7 },
  });
  assert.equal(t2.termination.maxIterations, 7);
});
```

（`makeLoopDeps`/夹具名沿该文件现行形态；graph 内嵌 loop 节点走同两工厂、无须独立断言。）

`src/graph/templates.test.ts`：

```ts
test('缺省放宽与 env 注入：DEFAULT < env < opts.termination 合并序', () => {
  const deps = makeGraphDeps(); // 沿该文件现行 deps 夹具构造形态
  const t0 = softwarePipelineTemplate(deps);
  assert.equal(t0.termination.maxNodes, 1000);
  assert.equal(t0.termination.timeoutMs, 86_400_000);
  assert.equal(t0.termination.maxTokens, 2_000_000);
  process.env.SUNSHINEX_MAX_GRAPH_NODES = '60';
  try {
    const t1 = softwarePipelineTemplate(deps);
    assert.equal(t1.termination.maxNodes, 60);
  } finally {
    delete process.env.SUNSHINEX_MAX_GRAPH_NODES;
  }
  const t2 = softwarePipelineTemplate(deps, { termination: { maxNodes: 9 } });
  assert.equal(t2.termination.maxNodes, 9);
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build && node --test dist/loop/templates.test.js dist/graph/templates.test.js`
Expected: 新用例 FAIL（缺省仍为旧值 100/2h/500/4h、env 不生效）。

- [ ] **Step 3: 实现（两处 assemble 同构）**

`src/loop/templates.ts`：

```ts
import { loopIterationsEnv } from '../config/termination-config';
```

```ts
/** 三大模板缺省终止参数（opts.termination 可按项覆盖；env 语义键可放宽轮数，墙钟不进 settings） */
const DEFAULT_TERMINATION: LoopTermination = { maxIterations: 200, maxTokens: 1_000_000, timeoutMs: 43_200_000 };
```

```ts
function assemble(
  name: string,
  nodes: LoopEngineNode[],
  deps: LoopDeps,
  opts?: TemplateOpts,
): LoopTemplate {
  const envIters = loopIterationsEnv();
  const termination: LoopTermination = {
    ...DEFAULT_TERMINATION,
    ...(envIters !== undefined ? { maxIterations: envIters } : {}),
    ...(opts?.termination ?? {}),
  };
  return { name, nodes, termination, engine: new LoopEngine(nodes, deps, termination) };
}
```

`src/loop/templates.ts` 尾部常量：

```ts
/** 长任务时间兜底：24h（对齐 Graph `DEFAULT_TERMINATION.timeoutMs`（src/graph/templates.ts），失控保底、不进 settings） */
export const LONG_TASK_TIMEOUT_MS = 86_400_000;
```

（longTaskTemplate 的 spread 位次不动——`{ timeoutMs: LONG_TASK_TIMEOUT_MS, ...(opts?.termination ?? {}) }` 已保证显式覆盖优先。）

`src/graph/templates.ts`：

```ts
import { graphNodesEnv } from '../config/termination-config';
```

```ts
/** 全链路流水线缺省终止参数（opts.termination 可按项覆盖；env 语义键可放宽节点步，墙钟不进 settings） */
const DEFAULT_TERMINATION: GraphTermination = { maxNodes: 1000, maxTokens: 2_000_000, timeoutMs: 86_400_000 };
```

`softwarePipelineTemplate` 内合并行改为：

```ts
  const envNodes = graphNodesEnv();
  const termination: GraphTermination = {
    ...DEFAULT_TERMINATION,
    ...(envNodes !== undefined ? { maxNodes: envNodes } : {}),
    ...(opts.termination ?? {}),
  };
```

- [ ] **Step 4: 跑绿 + 既有缺省断言盘查**

Run: `pnpm build && node --test dist/loop/templates.test.js dist/loop/templates.long-task.test.js dist/graph/templates.test.js`
盘查：`grep -rn "7_200_000\|14_400_000\|maxIterations: 100\|maxNodes: 500" src --include="*.test.ts"`——命中既有断言按新缺省同步。
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
# message: feat(loop,graph): 终止缺省放宽（步数/轮次/节点 ×2）+ 墙钟 12h/24h + assemble 注入 env
# add: src/loop/templates.ts src/graph/templates.ts src/loop/templates.test.ts src/graph/templates.test.ts
```

---

### Task 4: 文档同步 + 全量三门禁收口

**Files:**
- Modify: `CLAUDE.md` §12（缺省清单数值与「墙钟=失控保底、不进 settings」定位一句；本线 hunk 与他线并存、可拆则拆）
- Modify: `README.md`（settings 语义键示例/键表 +3 行）
- Modify: `TUI-MANUAL.md`（settings.json 配置模板 +3 行注释键）
- Test: 全量回归（无新测试文件）

**Interfaces:**
- Consumes: Task 1–3 全部落点。
- Produces: 文档口径与实现一致；全仓门禁绿。

- [ ] **Step 1: CLAUDE.md §12 同步（读现行字节后改；他线 CLAUDE.md 有未提交改动，只做本线增量 hunk）**

现行句：

> 模型调用超时 600s（深度推理 + 长生成）、命令执行超时 1800s（install/build/test 套件）、命令输出缓冲 32MB、Reactor 200 步（对标「无步数上限、完成驱动」）、修正环 100 轮 / 1M tokens / 2 小时、全链路 500 节点步 / 2M tokens / 4 小时。宁可放宽缺省，不靠保守中断制造假失败。

改为：

> 模型调用超时 600s（深度推理 + 长生成）、命令执行超时 1800s（install/build/test 套件）、命令输出缓冲 32MB、Reactor 400 步（对标「无步数上限、完成驱动」，`SUNSHINEX_MAX_STEPS` 可调）、修正环 200 轮 / 1M tokens / 12 小时（`SUNSHINEX_MAX_LOOP_ITERATIONS` 可调轮数）、全链路 1000 节点步 / 2M tokens / 24 小时（`SUNSHINEX_MAX_GRAPH_NODES` 可调节点数）；墙钟时长为失控保底、不进 settings 常规配置面。宁可放宽缺省，不靠保守中断制造假失败。

（若 §12 同段还有「Reactor maxSteps、Loop 修正环轮数」等表述，数值一并核对同步。）

- [ ] **Step 2: README / TUI-MANUAL settings 键表同步（读现行字节，找既有键表/配置模板段，同形态 +3 行）**

```json
    "maxSteps": 400,
    "maxLoopIterations": 200,
    "maxGraphNodes": 1000,
```

- [ ] **Step 3: 全量三门禁**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: tsc strict 0 报错、全量 fail 0、selfcheck OK。

- [ ] **Step 4: 收口提交**

```bash
# message: docs: 长任务终止参数缺省清单与 settings 键表同步
# add: CLAUDE.md README.md TUI-MANUAL.md（本线 hunks）
```

（CLAUDE.md 若与他线 hunk 不可拆，随批注明；提交前 `git diff --cached` 复核只含本线内容。）

---

## 自审（写完计划跑一遍）

1. **规格覆盖**：§3.1 三键→Task 1；§3.2 五项放宽→Task 2（步数）+ Task 3（轮次/墙钟/节点/长任务兜底）；§3.3 四落点→Task 2 两处 + Task 3 两处；§4 验证面→各任务 Steps + Task 4 全量门禁；§4 文档同步→Task 4。全覆盖，无缺口。
2. **占位符扫描**：测试代码均给出可跑断言；夹具构造以「沿该文件现行形态」指向真实既有夹具（reactor.test.ts `makeDeps`、templates.test.ts deps 构造、settings.test.ts 现行全表钉子段），实施者落点前先读现行字节——非占位符，属并发 WIP 环境下防凭记忆写错的必要指令。
3. **类型一致性**：`reactorMaxStepsEnv` / `loopIterationsEnv` / `graphNodesEnv` 命名与签名在 Task 1 Produces 与 Task 2/3 Consumes 一致；env 槽名全局唯一且与 SEMANTIC_KEYS 表逐字一致。
4. **数值一致性**：200/100/500→400/200/1000；2h/4h→12h/24h；`43_200_000` / `86_400_000` 各出现处一致；token 1M/2M 未动。

