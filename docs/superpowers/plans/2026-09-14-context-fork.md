# 上下文 fork 模型实施计划（Context Fork）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-09-14-context-fork-design.md` 落地「单一基座 + fork」上下文模型：会话链入 ContextManager、goal 槽与记忆段退出装配面、技能注入置尾、reactor 双作用域（主链自动回写 / fork 私有）、loop/plan 主链追加、graph 节点 fork 化、TUI/CLI 走链，全层前缀稳定。

**Architecture:** ContextManager 持有会话链账本（chainView/appendChain/trimChainFront/resetSession），assemble 段序收敛为 loader → rules → 压缩块 → history（会话链经 reactor 缺省 seed 流入）→ 技能块（尾）；reactor 缺省 seed = chainView()，session 作用域 run 收束自动回写全量步骤+结论/补丁行，fork 作用域私有且压缩只折叠私有段；loop 修正轮经链自然续接（deficits 走链行）；graph 节点 fork 组合并回写结论行；TUI/CLI 主链化。

**Tech Stack:** TypeScript strict（CommonJS）+ Node ≥ 22.9 + node:test；pnpm；零新增依赖。

## Global Constraints

- 前缀缓存第一要义（CLAUDE.md §11）：稳定段+压缩块逐字节冻结；会话链只尾追；任意相邻帧/跨任务帧/主链↔fork 首帧差异只可能出现在尾部。
- 会话链 append-only：条目行号在追加时定死、不重排（裁剪后允许跳号）；压缩是唯一合法重写点；压缩块与会话链经 trimChainFront 同步、永不双份。
- goal 槽取消：Task.goal 降级为纯观测字段（ledger/settle 留痕），不进提示词；真实任务文本只以「当前指令行」存在于链尾；恒定执行协议行折进 buildPrompt 稳定段。
- 记忆段退出装配面：working/episodic 逐帧注入职责取消，settle/compaction 事件行改走会话链尾追；跨会话沉淀仍走文件（学习技能/KB）。
- fork 仅限 graph 节点与显式内部任务（/init、/plan 规划轮）：私有步骤不回主链，仅回写一行结论/补丁。
- 提示词/链行文案用 `pick()`（模型侧）、界面文案用 `t()`，均运行期求值，禁止模块级冻结；会话内逐字节恒定。
- 每任务收尾：`pnpm build` + 定向测试通过后 commit（只 add 本任务列出的文件）；工作区现有的 2 个无关 WIP（src/harness/tools/builtin.ts、src/harness/tools/stability.test.ts）禁止卷入提交。
- 全量验证：`pnpm build && pnpm test && pnpm selfcheck` 全绿（pnpm test 自动钉仓内 .data-test）。
- 定向测试命令形如：`pnpm build && node --test dist/harness/context/assemble.test.js`。
- 禁止 /tmp 与越狱路径；路径一律 path.join/resolve；沙箱 cwd 固定 /workspace/wt-59f36a81fc。

---

### Task 1: ContextManager 会话链账本 + 装配段序改造（含全部调用点适配）

**Files:**
- Modify: `src/harness/context/index.ts`
- Modify: `src/harness/reactor.ts`（仅调用点适配：2 处 assemble 去 goal 实参、删 memory 引用、settle 失败改链行）
- Modify: `src/tui/session.ts`（仅 /compact 两处 assemble 调用适配）
- Delete: `src/harness/context/memory-lifecycle.ts`、`src/harness/context/memory-lifecycle.test.ts`
- Modify: `src/harness/context/assemble.test.ts`（整文件重写）
- Modify: `src/harness/context/compaction.test.ts`（签名与断言更新）
- Modify: `src/loop/skill-ref.test.ts`（assemble 覆写签名更新）

**Interfaces:**
- Produces（Task 2/3/4/5/6 依赖）:
  - `chainView(): HistoryStep[]`（自压缩水位起的存续条目，返回副本）
  - `appendChain(entries: Array<{ action?: string; observation: string }>): void`（行号由链内序号定死：自增不重排）
  - `trimChainFront(n: number): void`（压缩水位推进，防链+压缩块双份）
  - `resetSession(): void`（清链/水位/压缩块/pendingSkill）
  - `assemble(history?: ContextItem[], relPath?: string): ContextItem[]`（段序：loader → rules → 压缩块 → history → 技能块尾）
- 移除：`memory` 字段与 MemoryLifecycle 装配、`MEMORY_INJECT_BUDGET`、assemble 的 goal 入参位与记忆注入段、applyCompaction 的 `memory.record('compaction', …)`。

- [ ] **Step 1: 写失败测试**（整文件重写 `src/harness/context/assemble.test.ts`，沿用文件头既有 `setup()` 辅助的 ContextManager 构造方式，不改构造本身）

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-'));
  const cm = new ContextManager(root, /* 与原 setup 相同的 store 构造 */ undefined as never);
  return { root, cm };
}
```
> 注：`setup()` 内 ContextManager 的 store 实参逐字保留原文件的构造写法（原文件已有可运行构造），上面 `undefined as never` 仅示意占位位置，落盘时以原构造替换。

```ts
test('assemble 段序（fork 模型）：SUNSHINE.md → history → 技能块置尾；无 goal 位、无记忆段', () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 项目规范\n禁用 any 类型\n');
  cm.setSkillBlock('技能正文：示范');
  const items1 = cm.assemble([{ kind: 'history', content: '1: task -> 步骤一' }]);
  assert.ok(items1[0].content.includes('禁用 any 类型'), 'SUNSHINE.md 居首');
  assert.equal(items1[items1.length - 1].kind, 'system', '技能块必须置尾');
  assert.ok(items1[items1.length - 1].content.includes('技能正文'));
  assert.ok(!items1.some((i) => i.kind === 'instruction'), 'goal 槽已取消');
  assert.ok(!items1.some((i) => i.kind === 'memory'), '记忆段已退出装配面');
  // 技能消失帧：其余段逐字节稳定（§11 尾部差异公理）
  const items2 = cm.assemble([
    { kind: 'history', content: '1: task -> 步骤一' },
    { kind: 'history', content: '2: reply -> 完成' },
  ]);
  const text1 = items1.slice(0, -1).map((i) => i.content).join('\n');
  const text2 = items2.map((i) => i.content).join('\n');
  assert.ok(text2.startsWith(text1), '技能消失后其余段必须前缀稳定');
});

test('会话链 API：追加定号、水位裁剪、跳号保留、resetSession 清空', () => {
  const { cm } = setup();
  cm.appendChain([{ action: 'task', observation: '当前指令：A' }]);
  cm.appendChain([{ action: 'reply', observation: 'A 完成' }, { action: 'task', observation: '当前指令：B' }]);
  assert.deepEqual(cm.chainView().map((s) => s.step), [1, 2, 3]);
  cm.trimChainFront(2);
  assert.deepEqual(cm.chainView().map((s) => s.step), [3]);
  cm.appendChain([{ action: 'reply', observation: 'B 完成' }]);
  assert.deepEqual(cm.chainView().map((s) => s.step), [3, 4]);
  cm.resetSession();
  assert.equal(cm.chainView().length, 0);
  cm.appendChain([{ action: 'task', observation: '新会话' }]);
  assert.deepEqual(cm.chainView().map((s) => s.step), [1]);
});

test('relPath 规则段仍按路径加载', () => {
  const { root, cm } = setup();
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rules', 'src.rules.md'), '- 规则X\n');
  const items = cm.assemble([{ kind: 'history', content: 'h' }], 'src/a.ts');
  assert.ok(items.some((i) => i.content.includes('规则X')));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/harness/context/assemble.test.js`
Expected: FAIL（assemble 签名/段序不符、链 API 不存在）

- [ ] **Step 3: 实现 ContextManager 改造**（src/harness/context/index.ts）

1) import 行增加 `HistoryStep`（与既有 ContextItem 同源）：
```ts
import { ContextItem, HistoryStep } from '../../types';
```
2) 删除 `MEMORY_INJECT_BUDGET` 常量、`MemoryLifecycle` import、`readonly memory` 字段与构造行。
3) 类内新增字段与四个 API（放在 setSkillBlock 附近）：
```ts
    /** 会话链（CLAUDE.md §11 只增不改）：主链对话事实的 append-only 账本 */
    private chain: HistoryStep[] = [];
    /** 压缩水位：chain 前 chainFrom 条已被压缩块代表（trimChainFront 推进，不回退） */
    private chainFrom = 0;
    private chainSeq = 0;

    /** 会话链只读视图：自压缩水位起的存续条目（reactor 缺省 seed 的单一来源） */
    chainView(): HistoryStep[] {
      return this.chain.slice(this.chainFrom);
    }

    /** 会话链尾追（唯一写入口）：行号由链内序号定死，追加后不重排（裁剪后允许跳号） */
    appendChain(entries: Array<{ action?: string; observation: string }>): void {
      for (const e of entries) {
        this.chain.push({ step: ++this.chainSeq, ...(e.action !== undefined ? { action: e.action } : {}), observation: e.observation });
      }
    }

    /** 压缩协调：压缩块已代表的链前缀条目数，推进水位防「链+压缩块」双份 */
    trimChainFront(n: number): void {
      if (n <= 0) return;
      this.chainFrom = Math.min(this.chainFrom + n, this.chain.length);
    }

    /** 会话级重置（/new）：清链、压缩水位、压缩块与待注入技能块；账本与最近文件登记保留 */
    resetSession(): void {
      this.chain = [];
      this.chainFrom = 0;
      this.chainSeq = 0;
      this.compacted = [];
      this.pendingSkill = null;
    }
```
4) assemble 整方法替换为：
```ts
    /** 统一装配（fork 模型段序）：loader → rules → 压缩块 → history（会话链经 reactor 缺省 seed 流入）→ 技能块（尾追）
     *  goal 槽与记忆段已取消（CLAUDE.md §11：真实任务文本走链尾「当前指令行」，链即记忆） */
    assemble(history: ContextItem[] = [], relPath?: string): ContextItem[] {
      const items: ContextItem[] = [];
      items.push(...this.loader.load());
      if (relPath) items.push(...this.rules.forPath(relPath));
      items.push(...this.compacted);
      items.push(...history);
      if (this.pendingSkill !== null) {
        items.push({ kind: 'system', content: this.pendingSkill });
        this.pendingSkill = null;
      }
      return items;
    }
```
5) applyCompaction 内删除 `this.memory.record('compaction', …)` 一行（压缩块本身即记录）。
6) 删除文件 `src/harness/context/memory-lifecycle.ts` 与 `src/harness/context/memory-lifecycle.test.ts`。

- [ ] **Step 4: 调用点适配（保 tsc 绿）**

src/harness/reactor.ts：
- 两处 `this.deps.context.assemble(task.goal, this.toHistory(steps, compactedUpTo))` → `this.deps.context.assemble(this.toHistory(steps, compactedUpTo))`。
- 删除运行收尾的 `this.deps.context.memory.endTask();` 一行。
- settle 失败分支 `this.deps.context.memory.record('settle', …)` → 链行（链即记忆，事件走链）：
```ts
        this.deps.context.appendChain([{ action: 'note', observation: `沉淀失败（不倒灌任务成败）：${e instanceof Error ? e.message : String(e)}` }]);
```

src/tui/session.ts（/compact 分支，约 L432/L436）：`this.runtime.harness.context.assemble('', [])` → `this.runtime.harness.context.assemble()`（两处）。

- [ ] **Step 5: 更新 compaction.test.ts**

- 所有 `cm.assemble('目标G', X)` → `cm.assemble(X)`。
- 删除「首个差异点在 goal」相关断言（goal 槽已取消），改为断言压缩块位于 history 之前：摘要条目下标 < 首条 history 条目下标。
- 删除 `cm.memory.index()` 相关断言（存储清退）。

- [ ] **Step 6: 更新 skill-ref.test.ts**

CapturingContext 覆写改为：
```ts
  assemble(history: ContextItem[] = [], relPath?: string): ContextItem[] {
    this.frames.push(history.map((i) => i.content).join('\n'));
    return super.assemble(history, relPath);
  }
```
技能位置断言从「首位」改为「末位」（尾追注入）。

- [ ] **Step 7: 全量 context/loop 定向测试**

Run: `pnpm build && node --test dist/harness/context/assemble.test.js dist/harness/context/compaction.test.js dist/loop/skill-ref.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/harness/context/index.ts src/harness/context/assemble.test.ts src/harness/context/compaction.test.ts src/harness/reactor.ts src/tui/session.ts src/loop/skill-ref.test.ts
git rm src/harness/context/memory-lifecycle.ts src/harness/context/memory-lifecycle.test.ts
git commit -m "feat(ctx): 会话链账本与装配段序改造——链即记忆、技能置尾、goal 槽取消"
```

---

### Task 2: Reactor 主链化（缺省链基 / 双作用域 / 收尾回写 / 压缩协调 / 执行协议行）

**Files:**
- Modify: `src/harness/reactor.ts`
- Modify: `src/harness/reactor.prefix.test.ts`（新增跨任务连续用例 + makeReactor 返回 context）
- Modify: `src/harness/reactor.test.ts`（压缩触发用例断言更新）

**Interfaces:**
- Consumes: Task 1 的 `chainView()/appendChain()/trimChainFront()`。
- Produces:
  - `ReactorOpts.scope?: 'session' | 'fork'`（缺省 'session'）；`seedHistory` 语义改为「fork 私有前缀（graph 组合角色行/任务行用）」，缺省 seed = chainView()。
  - `RunResult.compactedUpTo?: number`（>0 时携带：已折叠步骤的步骤号水位）。
  - 会话作用域 run 收束自动 `appendChain`（存活新步骤 + 结论行/补丁行）；fork 作用域零回写。
  - buildPrompt 稳定段新增恒定执行协议行。

- [ ] **Step 1: 写失败测试**（reactor.prefix.test.ts 追加；makeReactor 返回值补 `context` 字段——`return { reactor, prompts, context: cmInstance }`，既有解构不受影响）

```ts
test('跨任务主链连续：任务 B 首帧以任务 A 首帧为逐字节前缀（§11 只增不改）', async () => {
  const { reactor, context, prompts } = makeReactor(tmp, scripted([
    JSON.stringify({ done: true, reply: 'A done' }),
    JSON.stringify({ done: true, reply: 'B done' }),
  ]));
  context.appendChain([{ action: 'task', observation: 'Current instruction: task A' }]);
  await reactor.run({ goal: 'task A' });
  context.appendChain([{ action: 'task', observation: 'Current instruction: task B' }]);
  await reactor.run({ goal: 'task B' });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].startsWith(prompts[0]), '跨任务首帧必须严格前缀连续');
  assert.ok(prompts[1].includes('Current instruction: task B'));
});

test('会话作用域收束回写：全量步骤 + 结论行自动入链', async () => {
  const { reactor, context } = makeReactor(tmp2, scripted([JSON.stringify({ done: true, reply: '搞定' })]));
  context.appendChain([{ action: 'task', observation: 'Current instruction: do it' }]);
  await reactor.run({ goal: 'do it' });
  const chain = context.chainView();
  assert.equal(chain[chain.length - 1].action, 'reply');
  assert.equal(chain[chain.length - 1].observation, '搞定');
  assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('do it')));
});

test('fork 作用域：私有执行零回写主链', async () => {
  const { reactor, context } = makeReactor(tmp3, scripted([JSON.stringify({ done: true, reply: 'ok' })]));
  const before = context.chainView().length;
  await reactor.run({ goal: 'sub' }, { scope: 'fork' });
  assert.equal(context.chainView().length, before);
});

test('稳定段携带执行协议行（goal 槽取消后的任务锚点）', async () => {
  const { reactor, prompts } = makeReactor(tmp4, scripted([JSON.stringify({ done: true, reply: 'ok' })]));
  await reactor.run({ goal: 'anything' });
  assert.ok(prompts[0].includes('last task-instruction line'), '执行协议行必须进稳定段');
});
```
（scripted()/makeReactor 沿用本文件既有样板；若 scripted 入参为对象数组则按既有形态传 JSON 对象。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/harness/reactor.prefix.test.js`
Expected: FAIL（scope/缺省链基/回写/协议行不存在）

- [ ] **Step 3: 实现 Reactor 改造**（src/harness/reactor.ts）

1) `ReactorOpts` 增加并注释：
```ts
  /** 作用域：session=主链（收束自动回写）；fork=私有执行（零回写，graph 节点/内部任务用） */
  scope?: 'session' | 'fork';
  /** fork 私有前缀（graph 组合角色行/节点任务行用）；缺省 seed = 会话链视图（结构性 fork） */
  seedHistory?: StepRecord[];
```
2) `Task` 接口注释改为「goal 为观测标签（ledger/settle 留痕），不进提示词」；`RunResult` 增加：
```ts
  /** 压缩水位（步骤号）：>0 表示此号之前的步骤已折叠进压缩块 */
  compactedUpTo?: number;
```
3) run() 基座初始化段，将
```ts
    const seed = opts?.seedHistory ?? [];
    const steps: StepRecord[] = [...seed];
```
与 `let compactedUpTo = 0;` 一并替换为：
```ts
    // fork 模型缺省基座：会话链视图即本 run 前缀（结构性 fork，不传 seed 即续接主链）
    const scope = opts?.scope ?? 'session';
    const seed = opts?.seedHistory ?? this.deps.context.chainView();
    const seedLen = seed.length;
    const seedLastStep = seed.length > 0 ? seed[seed.length - 1].step : 0;
    const steps: StepRecord[] = [...seed];
    // 压缩水位线（步骤号口径）：此前 steps 已由摘要代表，不再进入 history
    let compactedUpToStep = seedLastStep;
```
4) for 循环头 `for (let step = seed.length + 1; ; step++) {` 替换为 `for (;;) {`，循环体首行加：
```ts
      const step = steps.length > 0 ? steps[steps.length - 1].step + 1 : 1;
```
guardrail 的 `iteration: step - 1 - seed.length` 替换为 `iteration: steps.length - seedLen`（其余引用 `step` 的行不变）。
5) 两处 assemble 调用（主装配 + 压缩收敛循环）确认为 Task 1 后的无 goal 形态：`this.deps.context.assemble(this.toHistory(steps, compactedUpToStep))`（原 `compactedUpTo` 标识符全局更名 `compactedUpToStep`）。
6) 压缩块内 `compactedUpTo = steps.length;` 替换为：
```ts
        compactedUpToStep = steps.length > 0 ? steps[steps.length - 1].step : seedLastStep;
        // fork 模型压缩协调：折叠的链前缀同步裁出会话链，压缩块与链永不双份
        const foldedSeed = seed.filter((s) => s.step <= compactedUpToStep).length;
        this.deps.context.trimChainFront(foldedSeed);
```
7) 运行收尾（原 `this.deps.context.memory.endTask();` 已删位置之后、settle 之前）插入：
```ts
    // 主链作用域收束回写：存续新步骤 + 结论行/补丁行尾追进链（fork 模型 §5；fork 作用域私有不回写）
    if (scope === 'session') {
      const foldedSeed = seed.filter((s) => s.step <= compactedUpToStep).length;
      if (foldedSeed > 0) this.deps.context.trimChainFront(foldedSeed);
      const cut = Math.max(compactedUpToStep, seedLastStep);
      this.deps.context.appendChain(
        steps
          .filter((s) => s.step > cut)
          .map((s) => ({ ...(s.action !== undefined ? { action: s.action } : {}), observation: s.observation })),
      );
      if (done && reply) {
        this.deps.context.appendChain([{ action: 'reply', observation: reply }]);
      } else {
        this.deps.context.appendChain([{ action: 'note', observation: pick(`Task ended without completion (${stopReason ?? 'unknown'})`, `任务未完成收束（${stopReason ?? 'unknown'}）`) }]);
      }
    }
```
8) return 行增加水位回传：
```ts
    return { steps, done, reply, tokensUsed, route, stopReason, ...(compactedUpToStep > seedLastStep ? { compactedUpTo: compactedUpToStep } : {}) };
```
9) buildPrompt 稳定段（工具选择政策行之后、JSON 协议行之前）插入执行协议行：
```ts
      pick(
        'Work on the task given by the last task-instruction line in the context; complete it fully, then end with done and give the final answer in reply.',
        '处理上下文中最后一条任务指令行给出的任务；完整完成后以 done 收束并在 reply 给出最终答复。',
      ),
      '',
```

- [ ] **Step 4: 运行新用例与既有 reactor 套件**

Run: `pnpm build && node --test dist/harness/reactor.prefix.test.js dist/harness/reactor.test.js dist/harness/reactor.settle.test.js`
Expected: PASS（跨任务连续/回写/fork 隔离/协议行全绿；既有相邻步前缀连续用例零改动通过；压缩触发用例若因基座估算变化未触发，按 §12 纪律增大注入内容规模重标定，禁止调低产品缺省阈值）

- [ ] **Step 5: settle 失败断言收口**（reactor.settle.test.ts）

沉淀失败断言从记忆存储改为链行：
```ts
assert.ok(context.chainView().some((s) => s.action === 'note' && s.observation.includes('沉淀失败')));
```

- [ ] **Step 6: Commit**

```bash
git add src/harness/reactor.ts src/harness/reactor.prefix.test.ts src/harness/reactor.test.ts src/harness/reactor.settle.test.ts
git commit -m "feat(reactor): 主链化——缺省链基/双作用域/收尾回写/压缩协调/执行协议行"
```

---

### Task 3: Loop 主链追加（deficits 走链行 / fork 轮续接 / scope 线程）

**Files:**
- Modify: `src/loop/engine.ts`（LoopDeps 增加 scope）
- Modify: `src/loop/nodes.ts`（agentNode 改造、删除 withDeficits）
- Modify: `src/loop/nodes.test.ts`（若有 deficits/goal 断言则同步）
- Create: `src/loop/nodes.chain.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ReactorOpts.scope/seedHistory`、Task 1 的 `chainView/appendChain`。
- Produces: `LoopDeps.scope?: 'session' | 'fork'`（缺省 session）；agentNode 行为——session 作用域修正轮缺省 seed=chainView() 自然续接、deficits 以链行进入；fork 作用域轮间经 `ctx.state.seedHistory` 累积续接、零主链回写。

- [ ] **Step 1: 写失败测试**（新建 src/loop/nodes.chain.test.ts；deps 装配复用 src/loop/engine.test.ts 既有 LoopDeps 样板，仅 model 换 scripted、context 换真实 ContextManager（tmp））

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentNode } from './nodes';
import { LoopEngine } from './engine';
import type { LoopDeps, LoopContext, NodeOutput } from '../types';

function makeAgentDeps(scripted: object[]) {
  // 照抄 src/loop/engine.test.ts 的 LoopDeps 装配（safety/registry/context/model），context 用临时目录真实 ContextManager，
  // model 桩逐次返回 scripted JSON 信封。
  return makeLoopDeps(scripted) as LoopDeps & { context: { chainView(): unknown[]; appendChain(e: unknown[]): void } };
}

test('修正要求走链：deficits 非空时链尾出现修正要求行，下一轮 seed 含该行', async () => {
  const deps = makeAgentDeps([JSON.stringify({ done: true, reply: '修复完成' })]);
  const ctx = { state: { goal: '修复登录', deficits: [{ id: 'c1', desc: '边界未覆盖' }] } } as unknown as LoopContext;
  const node = agentNode(deps);
  await node.run(ctx, undefined);
  const chain = (deps.context as any).chainView();
  const fixLine = chain.find((s: any) => s.action === 'deficit');
  assert.ok(fixLine && fixLine.observation.includes('边界未覆盖'), '修正要求必须以链行进入');
});

test('fork 作用域跨轮接续：state.seedHistory 累积、主链零回写', async () => {
  const deps = makeAgentDeps([JSON.stringify({ done: false, reply: 'r1' }), JSON.stringify({ done: true, reply: 'r2 done' })]);
  const ctx = { state: { goal: '子任务', seedHistory: [{ step: 1, action: 'task', observation: '当前指令：子任务' }] } } as unknown as LoopContext;
  const node = agentNode({ ...(deps as LoopDeps), scope: 'fork' });
  const engine = new LoopEngine([node], { maxIterations: 3 });
  await engine.run('子任务', { state: ctx.state as Record<string, unknown> });
  const chain = (deps.context as any).chainView();
  assert.equal(chain.length, 0, 'fork 作用域零主链回写');
  const acc = (ctx.state as any).seedHistory as Array<{ observation: string }>;
  assert.ok(acc.length >= 2, 'fork 轮间必须经 state.seedHistory 累积');
  assert.ok(acc.some((s) => s.observation.includes('r1')), '上一轮步骤必须保留');
});
```
（`makeLoopDeps` 为本文件内对 engine.test.ts 装配样板的本地封装；engine 构造参数若与 `new LoopEngine(nodes, termination)` 形态不符，以 engine.ts 现有签名为准对齐。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/loop/nodes.chain.test.js`
Expected: FAIL（deficit 链行不存在、fork 累积不存在）

- [ ] **Step 3: 实现**（src/loop/nodes.ts + src/loop/engine.ts）

1) engine.ts `LoopDeps` 增加：
```ts
  /** 作用域：session=主链追加（缺省）；fork=私有执行（零主链回写，graph loop 节点用） */
  scope?: 'session' | 'fork';
```
2) nodes.ts agentNode 改造——删除 `const goal = withDeficits(...)` 的改写语义与 `withDeficits` 函数，改为：
```ts
    const goal = typeof ctx.state.goal === 'string' ? ctx.state.goal : '';
    const scope = deps.scope ?? 'session';
    const rawSeed = ctx.state.seedHistory;
    const seedHistory = Array.isArray(rawSeed) ? (rawSeed as HistoryStep[]) : undefined;
    // 修正要求走链（主链）/并入私有前缀（fork）：废弃 withDeficits 的 goal 改写（goal 已降级为观测标签）
    const deficits = Array.isArray(ctx.state.deficits) ? (ctx.state.deficits as Array<{ id: string; desc: string }>) : [];
    if (deficits.length > 0) {
      const line = `${pick('Fix requirements from last review:', '修正要求（上次未过验收项）：')}\n${deficits.map((d) => `- ${d.id}: ${d.desc}`).join('\n')}`;
      if (scope === 'session') {
        deps.context.appendChain([{ action: 'deficit', observation: line }]);
      } else if (seedHistory) {
        const next = (seedHistory.length > 0 ? seedHistory[seedHistory.length - 1].step : 0) + 1;
        seedHistory.push({ step: next, action: 'deficit', observation: line });
      }
    }
```
reactor.run 调用 opts 增加 `scope`：
```ts
    const r = await reactor.run({ goal }, { ..., scope, ...(seedHistory && seedHistory.length > 0 ? { seedHistory } : {}) });
```
run 之后、return 之前增加 fork 累积：
```ts
    if (scope === 'fork') ctx.state.seedHistory = r.steps; // fork 内跨轮接续（主链作用域由链自然续接，不线程）
```
3) 全仓 `grep -rn "withDeficits" src --include='*.ts'` 清零（函数删除 + 引用清理）。

- [ ] **Step 4: 运行定向 + 既有 loop 套件**

Run: `pnpm build && node --test dist/loop/nodes.chain.test.js dist/loop/nodes.test.ts 2>/dev/null || pnpm build && node --test dist/loop/*.test.js`
Expected: PASS（按 dist 实际产物路径执行 node --test）

- [ ] **Step 5: Commit**

```bash
git add src/loop/engine.ts src/loop/nodes.ts src/loop/nodes.chain.test.ts src/loop/nodes.test.ts
git commit -m "feat(loop): 主链追加化——deficits 走链行、修正轮链上续接、fork 作用域线程"
```

---

### Task 4: Graph fork 化（role agent / loop node 组合 + 结论回写）

**Files:**
- Modify: `src/graph/agents.ts`
- Modify: `src/graph/nodes.ts`
- Modify: `src/graph/agents.test.ts`、`src/graph/nodes.test.ts`（断言更新）

**Interfaces:**
- Consumes: Task 2 的 `scope/seedHistory`、Task 1 的 `chainView/appendChain/nextChainStep 语义`（下一行号 = chainView 末条 step+1，空链为 1）。
- Produces: role agent —— `reactor.run({ goal: label }, { scope: 'fork', seedHistory: [...chainView(), 角色行, 任务行] })`，终态回写 `节点结论行` 或 `补丁行`；loop node —— `factory({...deps, scope: 'fork'})` + `state.seedHistory = [...chainView(), 任务行]`，终态回写同上。

- [ ] **Step 1: 写失败测试**（src/graph/agents.test.ts 追加；装配沿用本文件既有 GraphDeps 样板，model 换 scripted）

```ts
test('role agent fork：私有执行零主链回写、终态回写结论行', async () => {
  const { deps, events } = makeGraphFixture([JSON.stringify({ done: true, reply: '规划完成' })]);
  const ctx = { state: { goal: '建设电商网站' } } as unknown as GraphContext;
  const node = makeRoleAgent('planner', { label: 'Planner', framing: '产出可执行计划', deps: [] });
  const out = await node.run(ctx, deps, {});
  assert.equal(out.status, 'pass');
  const chain = deps.context.chainView();
  const nodeLine = chain.find((s) => s.action === 'node');
  assert.ok(nodeLine && nodeLine.observation.includes('规划完成'), '终态必须回写一行结论');
  assert.ok(!chain.some((s) => s.action === 'read' || s.action === 'exec'), 'fork 私有步骤不得回写主链');
});
```
（makeGraphFixture 为本文件既有 GraphDeps 装配样板的封装名——以 agents.test.ts 现有构造为准；role 框定文案以 ROLE_PRESETS 实际字段拼接。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/graph/agents.test.js`
Expected: FAIL（结论回写不存在）

- [ ] **Step 3: 实现 makeRoleAgent 改造**（src/graph/agents.ts）

run 内整体替换为：
```ts
    run: async (ctx, _d, _inputs) => {
      const goalLabel = String(ctx.state.goal ?? '');
      const context = deps.context;
      // fork 组合：主链快照 + 角色行 + 节点任务行（上游结论已在链上，前置依赖天然可见，不再拼入任务文本）
      const base = context.chainView();
      const nextStep = base.length > 0 ? base[base.length - 1].step + 1 : 1;
      const seedHistory = [
        ...base,
        { step: nextStep, action: 'role', observation: pick(`Your role: ${preset.label} (${role}); duties: ${preset.framing}`, `你的角色：${preset.label}（${role}），职责：${preset.framing}`) },
        { step: nextStep + 1, action: 'task', observation: pick(`Current instruction: ${goalLabel}`, `当前指令：${goalLabel}`) },
      ];
      const result = await reactor.run(
        { goal: goalLabel },
        { maxSteps: opts.maxSteps, budget, tokenCap: remaining, deadlineAt: ctx.deadlineAt, ...(deps.tier ? { tier: deps.tier } : {}), scope: 'fork', seedHistory },
      );
      // 子代理返回制：私有步骤不回主链，终态仅回写一行结论/补丁（下游 fork 经主链快照天然可见）
      if (result.done && result.reply) {
        context.appendChain([{ action: 'node', observation: `${pick(preset.label, preset.label)}：${result.reply}` }]);
      } else {
        context.appendChain([{ action: 'note', observation: `${pick(preset.label, preset.label)}: ${pick('node did not finish', '节点未完成收束')} (${result.stopReason ?? 'failed'})` }]);
      }
      return { nodeId: role, status: result.done ? 'pass' : 'failed', reply: result.reply, tokens: result.tokensUsed ?? 0 };
    }
```
（保留原 reactor 构造与 budget/remaining 计算不动；删除原 `task = goal+角色+上游` 拼接与 `_inputs` 的上游遍历——`inputs` 形参更名 `_inputs`。）

- [ ] **Step 4: 实现 makeLoopNode fork 线程**（src/graph/nodes.ts）

run 内：
```ts
      const forkDeps = { ...deps, scope: 'fork' as const };
      const tpl = factory(forkDeps, { agentMaxSteps: config.maxSteps });
      const taskText = config.goal ?? String(ctx.state.goal ?? '');
      const base = deps.context.chainView();
      const seedHistory = [
        ...base,
        { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: pick(`Current instruction: ${taskText}`, `当前指令：${taskText}`) },
      ];
      const r = await tpl.engine.run(taskText, { state: { seedHistory } });
      if (r.status === 'done' && r.reply) {
        deps.context.appendChain([{ action: 'node', observation: `${id}: ${r.reply}` }]);
      } else {
        deps.context.appendChain([{ action: 'note', observation: `${id}: ${pick('loop node did not finish', '子流程未完成收束')} (${r.status})` }]);
      }
```
（替换原 `tpl.engine.run(goal)` 直调段；`LoopDeps` 类型按需 import；gate/ci 节点不动。）

- [ ] **Step 5: 运行 graph 套件**

Run: `pnpm build && node --test dist/graph/agents.test.js dist/graph/nodes.test.js dist/graph/templates.test.js dist/graph/workflow.test.js`
Expected: PASS（既有用例中拼接「上游产出」的断言改为「上游结论经链可见」口径；plan 类用例若依赖大 goal 文本，改为断言 fork seed 行）

- [ ] **Step 6: Commit**

```bash
git add src/graph/agents.ts src/graph/nodes.ts src/graph/agents.test.ts src/graph/nodes.test.ts
git commit -m "feat(graph): 节点 fork 化——角色/子流程私有执行、结论回写主链"
```

---

### Task 5: TUI 主链化（runtime scope 线程 / session 走链 / 规划轮与 /init 隔离 / /new 清链）

**Files:**
- Modify: `src/tui/runtime.ts`
- Modify: `src/tui/session.ts`
- Modify: `src/tui/session.test.ts`、`src/tui/session.plan.test.ts`、`src/tui/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 `resetSession/chainView/appendChain`、Task 3 的 `LoopDeps.scope` 与 `ctx.state.seedHistory` 线程。
- Produces: `TuiRuntime.runTask(goal, opts?: { maxSteps?; seedHistory?; tier?; scope?: 'session'|'fork' })`——scope 线程至 LoopDeps；session 层——普通任务/plan 步骤先 `appendChain(当前指令行)` 再 runTask（reactor 会话作用域自动回写），`/init` 与规划轮经 `forkInstruction` 隔离执行，`/new` 调 `resetSession()`；`SessionController` 新增只读 `context` 访问器。

- [ ] **Step 1: 写失败测试**

src/tui/runtime.test.ts 追加：
```ts
test('runTask scope=fork：作用域线程至 LoopDeps、主链零回写', async () => {
  const rt = createRuntime({ root: tmp5, model: new ScriptedAdapter([DONE_SCRIPT]), onEvent: (e) => events5.push(e) });
  const before = rt.harness.context.chainView().length;
  await rt.runTask('子任务', { scope: 'fork' });
  assert.equal(rt.harness.context.chainView().length, before);
});
```
src/tui/session.test.ts 追加（SessionController 构造沿用本文件既有样板）：
```ts
test('普通任务走链：指令行 + 结论行入链', async () => {
  const ctrl = new SessionController({ root, model: new ScriptedAdapter([JSON.stringify({ done: true, reply: 'A 完成' })]) });
  await ctrl.submit('任务A');
  const chain = ctrl.context.chainView();
  assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('任务A')));
  assert.ok(chain.some((s) => s.action === 'reply' && s.observation === 'A 完成'));
});

test('/new 清空会话链与压缩块', async () => {
  const ctrl = new SessionController({ root, model: new ScriptedAdapter([JSON.stringify({ done: true, reply: 'x' })]) });
  await ctrl.submit('任务A');
  (ctrl as unknown as { handleSlash: (c: string) => Promise<void> }).handleSlash('/new');
  assert.equal(ctrl.context.chainView().length, 0);
});
```
src/tui/session.plan.test.ts 追加：
```ts
test('plan 步骤全量轨迹入链（废除只留结论行）', async () => {
  // 既有 plan 流程样板：两步计划、步骤 1 含一次工具调用
  const chain = ctrl.context.chainView();
  assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('步骤一')), '步骤指令行入链');
  assert.ok(chain.some((s) => (s.action ?? '') !== '' && s.observation.includes('步骤一')), '步骤 1 的工具观察行仍在链上（不再裁剪）');
  assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('步骤二')), '步骤 2 指令行尾追');
});
test('规划轮不进链：verbose 提示词不入会话链', async () => {
  // 触发 /plan 规划轮后
  const text = ctrl.context.chainView().map((s) => s.observation).join('\n');
  assert.ok(!text.includes('Produce a numbered step plan'), '规划轮 verbose 提示词不得入链');
});
```
（Scripted 脚本与确认卡确认方式沿用本文件既有样板；`ctrl.context` 依赖 Step 3 新增访问器。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tui/runtime.test.js dist/tui/session.test.js dist/tui/session.plan.test.js`
Expected: FAIL（scope 未线程、链未接入、context 访问器不存在）

- [ ] **Step 3: 实现 runtime.ts**

TuiRuntime 接口 runTask opts 与实现：
```ts
  runTask(goal: string, opts?: { maxSteps?: number; seedHistory?: HistoryStep[]; tier?: ModelTier; scope?: 'session' | 'fork' }): Promise<RunOutcome>;
```
```ts
    runTask: async (goal, o) => {
      const runDeps: LoopDeps = {
        ...loopDeps,
        ...(o?.tier ? { tier: o.tier } : {}),
        ...(o?.scope ? { scope: o.scope } : {}),
      };
      const tpl = longTaskTemplate(runDeps, { agentMaxSteps: o?.maxSteps });
      const r = await tpl.engine.run(goal, o?.seedHistory && o.seedHistory.length > 0 ? { state: { seedHistory: o.seedHistory } } : undefined);
      return { done: r.status === 'done', reply: r.reply, tokensUsed: r.tokensUsed ?? 0, stopReason: r.stopReason, history: r.history };
    },
```
（保持既有返回投影不变，仅增加 scope 线程。）

- [ ] **Step 4: 实现 session.ts**

1) 新增只读访问器（靠近其它 getter）：
```ts
  /** 会话链账本（测试与高级用法读取；常规写入经 runTaskFlow / runInternalTask） */
  get context(): ContextManager {
    return this.runtime.harness.context;
  }
```
（import `ContextManager` 类型自 '../harness/context'。）
2) runTaskFlow 增加可选 fork 形态并接入指令行（try 块首行前）：
```ts
  private async runTaskFlow(goal: string, opts?: { forkInstruction?: string }): Promise<void> {
```
```ts
    try {
      const ctx = this.runtime.harness.context;
      if (opts?.forkInstruction) {
        // 内部 verbose 任务（/init 等）：fork 隔离——提示词经 fork 尾追承载、不进会话链（防污染对话流）
        const base = ctx.chainView();
        const r = await this.runtime.runTask(goal, {
          scope: 'fork',
          seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: opts.forkInstruction }],
          ...(this.state.model ? { tier: this.state.model } : {}),
        });
        const noteF = describeIncomplete(r.stopReason);
        if (!r.done && noteF.length > 0) this.pushMsg('system', noteF);
        this.closeTask();
        return;
      }
      // 主链任务（§11 只增不改）：当前指令行尾追进链，reactor 会话作用域收束自动回写全量步骤与结论/补丁行
      ctx.appendChain([{ action: 'task', observation: t(`Current instruction: ${goal}`, `当前指令：${goal}`) }]);
      const r = await this.runtime.runTask(goal, this.state.model ? { tier: this.state.model } : undefined);
      const note = describeIncomplete(r.stopReason);
      if (!r.done && note.length > 0) this.pushMsg('system', note);
      this.closeTask();
```
（其后既有 catch 分支保持不变。）
3) 新增内部任务辅助（/init 使用；规划轮因需 planReplyNoArchive/planText 捕获保持独立实现）：
```ts
  /** 内部 verbose 任务（/init）：fork 隔离执行——提示词不进会话链（§11 边界登记） */
  private async runInternalTask(prompt: string, label: string): Promise<RunOutcome> {
    const ctx = this.runtime.harness.context;
    const base = ctx.chainView();
    return this.runtime.runTask(label, {
      scope: 'fork',
      seedHistory: [...base, { step: (base.length > 0 ? base[base.length - 1].step : 0) + 1, action: 'task', observation: prompt }],
      ...(this.state.model ? { tier: this.state.model } : {}),
    });
  }
```
4) /init 分支（约 L392）：`await this.runTaskFlow(sunshineInitGoal(this.root, existed));` →
```ts
      await this.runInternalTask(sunshineInitGoal(this.root, existed), t('/init: analyze project and write SUNSHINE.md', '/init：分析项目并写入 SUNSHINE.md'));
```
（保留分支内既有的状态置位与 closeTask 语义；如原分支直接复用 runTaskFlow 的 running 壳，则把壳内 runTask 调用替换为 runInternalTask 同参形态。）
5) startPlanFlow 规划轮：`runTask(<verbose 规划提示词>, …)` →
```ts
      const r = await this.runInternalTask(verbosePlanningPrompt, t('Produce a numbered step plan', '产出编号步骤计划'));
```
（planReplyNoArchive/planText 提取逻辑保持不变。）
6) runPlanItems 重写（删除 planGoal 常量、本地 seed 数组与 seedHistory 传参；保留状态/指标/todos/异常分支）：
```ts
    const ctx = this.runtime.harness.context;
    // 计划纪律走链（只增不改）：每轮只完成最后一条当前指令，不执行/预判/重排后续任务
    ctx.appendChain([{ action: 'note', observation: t(
      'Plan discipline: each round completes only the last "Current instruction"; do not execute, anticipate, or reorder other tasks.',
      '计划纪律：每轮只完成最后一条「当前指令」指定任务；不要执行、预判或重排后续任务。',
    ) }]);
    for (let i = 0; i < items.length; i++) {
      this.pushMsg('step', `Step ${i + 1}/${items.length} — ${items[i]}`);
      this.state = { ...this.state, metrics: { ...this.state.metrics, ... } };
      this.notify();
      ctx.appendChain([{ action: 'task', observation: t(`Current instruction: ${items[i]}`, `当前指令：${items[i]}`) }]);
      try {
        const r: RunOutcome = await this.runtime.runTask(items[i], this.state.model ? { tier: this.state.model } : undefined);
        if (!r.done) {
          const d = describeIncomplete(r.stopReason);
          if (d.length > 0) this.pushMsg('system', d);
          break;
        }
        // 步骤全量轨迹与结论行已由 reactor 会话作用域自动入链（fork 模型：不再只留结论行）
        if (this.pendingPlan) for (const t2 of this.pendingPlan.todos) if (t2.item === items[i]) t2.done = true;
        this.state = { ...this.state, todos: [...this.state.todos] };
        this.notify();
      } catch (e) {
        this.pushMsg('system', t(`Step failed: ${e instanceof Error ? e.message : String(e)}`, `步骤失败：${e instanceof Error ? e.message : String(e)}`));
        break;
      }
    }
    this.closeTask();
```
（以文件内现有字段/方法名为准对齐：pendingPlan/todos 结构、metrics 字段、异常文案保持原样，仅替换「seed 构建 + runTask(planGoal, {seedHistory})」为「appendChain 指令行 + runTask(items[i])」。）
7) /new 分支：状态重置区追加
```ts
      this.runtime.harness.context.resetSession();
```
pushMsg 文案更新为：
```ts
      this.pushMsg('system', t('Soft reset: messages, todos, session chain and compacted summary cleared; session approvals cleared (memory & ledger kept)', '软重置：消息、待办、会话链与压缩摘要已清空，会话级审批登记已清除（记忆与账本保留）'));
```
8) /compact 分支：`assemble('', [])` 两处 → `assemble()`。

- [ ] **Step 5: 运行 TUI 套件**

Run: `pnpm build && node --test dist/tui/runtime.test.js dist/tui/session.test.js dist/tui/session.plan.test.js dist/tui/session.incomplete.test.js`
Expected: PASS（既有断言中 planGoal 恒定/goal 文本类断言改为「runTask 首参=当前步骤文本、指令行走链」；incomplete 用例的 fake runtime 签名兼容不变）

- [ ] **Step 6: Commit**

```bash
git add src/tui/runtime.ts src/tui/session.ts src/tui/session.test.ts src/tui/session.plan.test.ts src/tui/runtime.test.ts
git commit -m "feat(tui): 主链化——指令行走链、plan 全量轨迹保留、规划轮与 /init fork 隔离、/new 清链"
```

---

### Task 6: CLI 主链化（run / pipeline 指令行入链）

**Files:**
- Modify: `src/cli/commands/run-loop.ts`
- Modify: `src/cli/commands/run-pipeline.ts`

**Interfaces:**
- Consumes: Task 1 `appendChain`、Task 2 reactor 缺省链基。
- Produces: CLI 单发 run 与 pipeline 启动前各追加一条任务指令行（空链起，行为对外不变——goal 不再经 goal 槽进提示词，改由链行承载）。

- [ ] **Step 1: 实现**（两文件同构：在 `tpl.engine.run(goal, …)` 调用前插入）

```ts
  // fork 模型（CLAUDE.md §11）：goal 槽取消，任务指令以链行承载（单发 run 空链起，行为对外不变）
  deps.context.appendChain([{ action: 'task', observation: goal }]);
```
（`deps` 为两文件内既有 LoopDeps 变量名；pipeline 的 resume 分支同样在 engine.run 前追加。）

- [ ] **Step 2: 运行 CLI 套件**

Run: `pnpm build && node --test dist/cli/commands/run-loop.test.js dist/cli/commands/run-pipeline.test.js dist/cli/cli.test.js`
Expected: PASS（既有用例直调 tpl.engine.run 不受影响；如有用例经命令函数断言 prompt，补链行存在断言）

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/run-loop.ts src/cli/commands/run-pipeline.ts
git commit -m "feat(cli): 主链化——单发 run 与 pipeline 指令行走链"
```

---

### Task 7: 回归矩阵收口 + 文档同步 + 全量验证

**Files:**
- Modify: `TUI-MANUAL.md`
- Verify only: 全仓

**Interfaces:** 无新接口；对照规格 §9 回归矩阵逐项核对。

- [ ] **Step 1: 回归矩阵核对**（逐条确认有用例钉死，缺失则补）

1. 跨任务严格前缀连续 → Task 2（reactor 跨 run 用例）+ Task 5（session 链内容用例）
2. fork 首帧 = 主链末帧严格前缀 + 尾追 → Task 4（role agent fork 用例补断言：`prompt.startsWith(前一次主链 prompt)`，经 capture 适配器取帧）
3. 同层并发 fork 共享基线 → Task 4（两 role agent 并发，断言两者首帧共享 chainView 前缀）
4. fork 内相邻步连续 → Task 2（既有相邻步用例迁移后仍绿）
5. 压缩后基线重置 + 链/压缩块不双份 → Task 2（压缩触发用例：`chainView` 不含已折叠条目、assemble 文本含 `[Compacted summary]` 且早期标记仅出现一次）
6. 技能出现/消失零击穿 → Task 1（assemble 置尾用例）
7. 全量 build/test/selfcheck → 本任务 Step 3

若 2/3 缺用例，在 src/graph/agents.test.ts 以 capture 适配器补齐（断言 `prompts[1].startsWith(prompts[0])` / 两个并发 fork 的首帧共享 chainView 前缀）。

- [ ] **Step 2: TUI-MANUAL 同步**

- 定位「长 plan 任务 ctx 每步回落 16k 级」段（92ab44a 引入），整段改写为：
```markdown
会话链跨任务与跨步骤持续增长（对标 Claude Code 全对话保留）：任务指令行、全量执行轨迹与结论行依次尾追，上下文占用随之上升；仅在触发上下文压缩时回落为「压缩块 + 存续链」口径。
```
- /new 命令行补「并清空会话链与压缩摘要（记忆与账本保留）」。
- grep 校验：`grep -n "16k\|只留结论\|每步回落" TUI-MANUAL.md` → 零残留。

- [ ] **Step 3: 全量验证**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: 全绿（用例数较 548 净增）

- [ ] **Step 4: 残留扫描**

Run: `grep -rn "withDeficits\|planGoal\|MEMORY_INJECT_BUDGET\|memory.endTask\|memory-lifecycle" src --include='*.ts' | grep -v test`
Expected: 无输出（零残渣）

- [ ] **Step 5: Commit**

```bash
git add TUI-MANUAL.md src/graph/agents.test.ts
git commit -m "docs(tui): 手册同步会话链语义；回归矩阵收口"
```

---

## Self-Review

执行前自检已运行：规格 §3-§8 各节均映射到任务（§3.1→T1、§3.2→T2、§3.3→T3、§3.4→T4、§3.5→T5、§4→T2/T1、§5→T4/T5、§6→T2/T4、§7→T1-T6、§8→T3/T5、§9→T7、§10→T7、§12→T7）；无 TBD/TODO 占位；`scope/seedHistory/chainView/appendChain/trimChainFront/resetSession/compactedUpTo` 签名跨任务一致；规格 §7「compactedUpTo 回传 RunResult」在 T2 落实为步骤号水位口径（count→step-number 修正已在 T2 步骤中显式说明）。
