# 统一运行时主链 · 1A 串主链 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Harness 的 Context/Loop/Tool/Safety/Memory 五环节串成单一数据流主链，消除旁路（对应 spec 验收 A1/A2/A3/A4）。

**Architecture:** 本计划只落地 spec 第 7 节的子阶段 1A「串主链」，不动 1B-1E。三件交付：① 删除死代码 `src/harness/memory.ts`（内存 Map），把 `AutoMemory` 更名为 `MemoryLifecycle` 作为唯一记忆生命周期（A4）；② 给 `ContextManager` 增加 `assemble()` 统一上下文入口，Reactor 不再自拼 goal/steps，改由 assemble 串起 loader（SUNSHINE.md 分层指令）+ rules（路径规则）+ memory（记忆索引）（A1）；③ 新增 `SafetyChain` 统一安全链，`ToolRegistry.execute` 只接收一个 `safety` 参数，exec 经 `safety.run` 走沙箱、所有工具经 `safety.evaluate` 走 guard 守门（A3）。A2（动作唯一入口）现状已满足（所有执行都经 `ToolRegistry.execute`），本计划不新增动作通道，只加固。

**Tech Stack:** TypeScript 5.x（strict）、Node.js 内置 `node --test`、CommonJS 模块；零新增 npm 依赖。

## Global Constraints

- 零新增 npm 依赖；测试仅用 `node --test`；`tsconfig` 保持 strict。
- 模块体系为 CommonJS（`module: CommonJS`），import 路径用相对路径。
- 提交前必须 `npm run build`（tsc 零报错）且 `npm run selfcheck` 通过；`node --test` 全绿。
- 仅通过 sandbox 工具读写 `/workspace/wt-59f36a81fc`；禁止写 `/skills`；`.npm-cache/`、`.data/`、`node_modules/`、`dist/` 不入库。
- 本计划只实现 1A；1B（reinject/mask/越界校验）、1C（ModelRouter 内嵌）、1D（多后端）、1E（三级流转）留待后续 plan。

---

### Task 1: 统一记忆生命周期 —— 删除内存 Map，`AutoMemory` → `MemoryLifecycle`

**Files:**
- Create: `src/harness/context/memory-lifecycle.ts`
- Create: `src/harness/context/memory-lifecycle.test.ts`
- Delete: `src/harness/context/auto-memory.ts`
- Delete: `src/harness/memory.ts`
- Modify: `src/harness/context/index.ts`

**Interfaces:**
- Consumes: `StorageAdapter`（`src/storage/adapter.ts`：`read<T>(key, fallback): T` / `write<T>(key, value): void`）
- Produces: `MemoryLifecycle` —— `constructor(store: StorageAdapter)`；`index(): string[]`；`record(type: string, text: string): void`
- 说明：`src/types.ts` 的 `MemoryLevel` 类型本计划**保留**（spec 子阶段 1E 的 working/episodic/skill 三级流转要使用），仅删除它的唯一旧使用者 `src/harness/memory.ts`。

- [x] **Step 1: 写失败测试**

创建 `src/harness/context/memory-lifecycle.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryLifecycle } from './memory-lifecycle';
import { FileStore } from '../../storage/adapter';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ml-'));
}

test('MemoryLifecycle 记录并读取索引', () => {
  const store = new FileStore(tmpdir());
  const m = new MemoryLifecycle(store);
  m.record('project', '记住用户偏好 TDD');
  assert.deepEqual(m.index(), ['project: 记住用户偏好 TDD']);
});

test('MemoryLifecycle 索引上限 200 行，淘汰最旧', () => {
  const store = new FileStore(tmpdir());
  const m = new MemoryLifecycle(store);
  for (let i = 0; i < 201; i++) m.record('project', `n${i}`);
  const idx = m.index();
  assert.equal(idx.length, 200);
  assert.equal(idx[0], 'project: n1');
  assert.equal(idx[199], 'project: n200');
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/harness/context/memory-lifecycle.test.js`
Expected: FAIL —— `Cannot find module './memory-lifecycle'`

- [x] **Step 3: 写最小实现并删除死代码**

创建 `src/harness/context/memory-lifecycle.ts`：

```ts
import { StorageAdapter } from '../../storage/adapter';

/** 统一记忆生命周期：索引 + 主题文件（working/episodic/skill 三级流转留待 1E） */
export class MemoryLifecycle {
  constructor(private store: StorageAdapter) {}

  index(): string[] {
    return this.store.read<string[]>('memory.index', []);
  }

  record(type: string, text: string): void {
    const idx = this.index();
    const entry = `${type}: ${text}`;
    if (idx.length >= 200) idx.shift(); // 索引上限 200 行
    idx.push(entry);
    this.store.write('memory.index', idx);
  }
}
```

删除旧文件与死代码：

```bash
rm src/harness/context/auto-memory.ts src/harness/memory.ts
```

修改 `src/harness/context/index.ts`：把 import 与字段类型从 `AutoMemory` 改为 `MemoryLifecycle`。改后全文：

```ts
import { StorageAdapter } from '../../storage/adapter';
import { ContextLoader } from './loader';
import { RulesRegistry } from './rules';
import { MemoryLifecycle } from './memory-lifecycle';
import { ContextWindow } from './window';
import { SessionStore } from './session';

/** 上下文与记忆管理门面 */
export class ContextManager {
  readonly loader: ContextLoader;
  readonly rules: RulesRegistry;
  readonly memory: MemoryLifecycle;
  readonly window: ContextWindow;
  readonly session: SessionStore;

  constructor(root: string, store: StorageAdapter) {
    this.loader = new ContextLoader(root);
    this.rules = new RulesRegistry(root);
    this.memory = new MemoryLifecycle(store);
    this.window = new ContextWindow();
    this.session = new SessionStore(store);
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test dist/harness/context/memory-lifecycle.test.js`
Expected: PASS（2 tests）

- [x] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(harness): 统一记忆生命周期，删除内存 Map 版 memory"
```

---

### Task 2: Context.assemble() 统一上下文入口

**Files:**
- Create: `src/harness/context/assemble.test.ts`
- Modify: `src/harness/context/index.ts`
- Modify: `src/harness/reactor.ts`
- Modify: `src/harness/reactor.test.ts`

**Interfaces:**
- Consumes: `MemoryLifecycle`（Task 1）、`ContextLoader.load(): ContextItem[]`、`RulesRegistry.forPath(relPath: string): ContextItem[]`
- Produces: `ContextManager.assemble(goal: string, history?: ContextItem[], relPath?: string): ContextItem[]`
- 顺序约定：loader 分层指令 → rules 路径规则 → memory 记忆索引 → goal 指令 → history 历史。`relPath` 缺省时跳过规则注入。

- [x] **Step 1: 写失败测试（assemble 串起四个来源）**

创建 `src/harness/context/assemble.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { FileStore } from '../../storage/adapter';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-'));
  const cm = new ContextManager(root, new FileStore(root));
  return { root, cm };
}

test('assemble 串起 loader + memory + goal + history', () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), '# 项目规范\n禁用 any 类型\n');
  cm.memory.record('project', '记住偏好 TDD');

  const items = cm.assemble('完成任务', [{ kind: 'history', content: '步骤1 执行完毕' }]);
  const text = items.map((i) => i.content).join('\n');
  assert.ok(text.includes('禁用 any 类型'), '应含 SUNSHINE.md 分层指令');
  assert.ok(text.includes('记住偏好 TDD'), '应含记忆索引');
  assert.ok(text.includes('完成任务'), '应含 goal');
  assert.ok(text.includes('步骤1 执行完毕'), '应含 history');
});

test('assemble 命中 relPath 时注入路径规则，否则跳过', () => {
  const { root, cm } = setup();
  fs.mkdirSync(path.join(root, '.sunshine', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshine', 'rules', 'src-only.md'), 'paths: src/\n本规则仅 src 生效\n');

  const hit = cm.assemble('x', [], 'src/a.ts');
  const miss = cm.assemble('x', [], 'lib/a.ts');
  assert.ok(hit.some((i) => i.content.includes('本规则仅 src 生效')));
  assert.ok(!miss.some((i) => i.content.includes('本规则仅 src 生效')));
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/harness/context/assemble.test.js`
Expected: FAIL —— `cm.assemble is not a function`

- [x] **Step 3: 实现 assemble**

修改 `src/harness/context/index.ts`，在 `ContextManager` 内新增方法（其余不变）：

```ts
import { ContextItem } from '../../types';

// 在 ContextManager 类内新增：
assemble(goal: string, history: ContextItem[] = [], relPath?: string): ContextItem[] {
  const items: ContextItem[] = [];
  items.push(...this.loader.load());
  if (relPath) items.push(...this.rules.forPath(relPath));
  const mem = this.memory.index();
  if (mem.length > 0) items.push({ kind: 'memory', content: mem.join('\n') });
  items.push({ kind: 'instruction', content: goal });
  items.push(...history);
  return items;
}
```

注意：import 区新增 `import { ContextItem } from '../../types';`（原文件未 import types）。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test dist/harness/context/assemble.test.js`
Expected: PASS（2 tests）

- [x] **Step 5: Reactor 改用 assemble（消除自拼 goal/steps）**

修改 `src/harness/reactor.ts`：

1. 删除私有方法 `private assemble(task: Task, steps: StepRecord[]): ContextItem[]`（整个方法体，约 6 行）。
2. 新增私有转换 `private toHistory(steps: StepRecord[]): ContextItem[]`。
3. observe 阶段改为调用 `context.assemble`；think 阶段 `buildPrompt` 改为接收 `ContextItem[]`。

改后关键片段：

```ts
// observe: 上下文统一装配 + 压缩稳定性检查
const items = this.deps.context.assemble(task.goal, this.toHistory(steps));
const est = this.deps.context.window.estimate(items);
if (this.deps.context.window.shouldCompact({ total: 200_000, used: est.used, reserve: 40_000 })) {
  const chunks = await this.deps.context.window.compact(items);
  this.deps.context.window.verifyChecksum(chunks);
}
```

```ts
// think: 经 ModelAdapter 决策
raw = await this.deps.model.complete(this.buildPrompt(items));
```

```ts
private buildPrompt(items: ContextItem[]): string {
  const tools = this.deps.registry.list().map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const contextText = items.map((i) => i.content).join('\n');
  return [
    '你是 SunshineX 智能体，通过调用工具完成任务。',
    '可用工具：',
    tools,
    '',
    '每次只回复一个 JSON 对象，不要输出任何其它文字。格式二选一：',
    '1) 调用工具：{"tool":"<工具名>","input":{...},"done":false}',
    '2) 任务完成：{"done":true,"reply":"<最终答复>"}',
    '',
    '上下文：',
    contextText,
  ].join('\n');
}

private toHistory(steps: StepRecord[]): ContextItem[] {
  return steps.map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` }));
}
```

- [x] **Step 6: 加 Reactor 回归测试（prompt 经 assemble 串起 SUNSHINE.md）**

在 `src/harness/reactor.test.ts` 末尾追加（沿用文件顶部已有的 import）：

```ts
test('Reactor prompt 经 Context.assemble 串起 SUNSHINE.md 指令', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor5-'));
  fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '# 规范\n禁用 any 类型\n');
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);

  let captured = '';
  const adapter = { provider: 'capture', complete: async (p: string) => { captured = p; return '{"done":true}'; } };
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  assert.ok(captured.includes('禁用 any 类型'), 'prompt 应包含 SUNSHINE.md 指令');
});
```

- [x] **Step 7: 跑全量测试确认通过**

Run: `npm test`
Expected: PASS（全部测试，含新增 3 个）

- [x] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(harness): Context.assemble 统一上下文入口，Reactor 不再自拼 goal/steps"
```

---

### Task 3: SafetyChain 统一安全链

**Files:**
- Create: `src/harness/security/chain.ts`
- Create: `src/harness/security/chain.test.ts`
- Modify: `src/harness/tools.ts`
- Modify: `src/harness/tools/builtin.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/harness/reactor.ts`
- Modify: `src/harness/reactor.test.ts`
- Modify: `src/harness/tools/tools.test.ts`
- Modify: `src/harness/tools/stability.test.ts`

**Interfaces:**
- Consumes: `SecurityGuard.preToolUse(tool: string, input: unknown): GuardDecision`、`Sandbox.run(cmd, opts?)`、`DryRun.preview(cmd: string): string`
- Produces: `SafetyChain` —— `constructor(guard, sandbox, dryrun)`；`evaluate(tool: string, input: unknown): GuardDecision`；`run(cmd: string, opts?: { cwd?: string; timeoutMs?: number })`；`preview(cmd: string): string`
- 说明：1A 的 SafetyChain 只组合「guard 守门 + sandbox 执行 + dryrun 预览」三个已有能力；credentials mask 与 root 越界校验属 1B，本任务不实现。

- [x] **Step 1: 写失败测试**

创建 `src/harness/security/chain.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';

function chain(): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun());
}

test('SafetyChain.evaluate 经 guard 拦截危险命令', () => {
  const p = new PolicyEngine();
  p.add('deny', 'Bash(rm *)');
  const c = new SafetyChain(new SecurityGuard(p, 'manual'), new ProcessSandbox(), new DryRun());
  const d = c.evaluate('Bash', { command: 'rm -rf /' });
  assert.equal(d.allowed, false);
});

test('SafetyChain.run 经沙箱执行 echo', async () => {
  const r = await chain().run('echo hi');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hi/);
});

test('SafetyChain.preview 透传 dryrun', () => {
  assert.equal(chain().preview('echo hi'), 'echo hi');
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/harness/security/chain.test.js`
Expected: FAIL —— `Cannot find module './chain'`

- [x] **Step 3: 实现 SafetyChain**

创建 `src/harness/security/chain.ts`：

```ts
import { GuardDecision, SecurityGuard } from './guard';
import { Sandbox } from './sandbox';
import { DryRun } from './dryrun';
import { ExecResult } from '../../types';
import { Result } from '../../result';

/** 统一安全链：guard 守门 + sandbox 执行 + dryrun 预览（mask/越界校验留待 1B） */
export class SafetyChain {
  constructor(
    private guard: SecurityGuard,
    private sandbox: Sandbox,
    private dryrun: DryRun,
  ) {}

  evaluate(tool: string, input: unknown): GuardDecision {
    return this.guard.preToolUse(tool, input);
  }

  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    return this.sandbox.run(cmd, opts);
  }

  preview(cmd: string): string {
    return this.dryrun.preview(cmd);
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test dist/harness/security/chain.test.js`
Expected: PASS（3 tests）

- [x] **Step 5: ToolRegistry.execute 只接收 safety 一个参数**

修改 `src/harness/tools.ts`：

1. import 区删除 `SecurityGuard`、`Sandbox`，新增 `import { SafetyChain } from './security/chain';`
2. `execute` 签名由 `(name, input, guard, sandbox)` 改为 `(name, input, safety: SafetyChain)`。
3. 内部 guard 决策改为 `safety.evaluate(canonical, input)`。

改后 `execute` 方法：

```ts
async execute(name: string, input: ToolInput, safety: SafetyChain): Promise<Result<ExecResult>> {
  const tool = this.tools.get(name);
  if (!tool) return fail('TOOL_NOT_FOUND', `工具未注册：${name}`);

  const canonical = CANONICAL_TOOL_NAMES[name] ?? name;
  const decision = safety.evaluate(canonical, input);
  if (!decision.allowed) return fail('COMMAND_DENIED', decision.reason ?? '命令被安全策略拦截');

  try {
    return ok(await tool.executor(input));
  } catch (e) {
    return fail('EXEC_FAILED', e instanceof Error ? e.message : '工具执行失败');
  }
}
```

- [x] **Step 6: builtinTools 改收 SafetyChain，exec 经 safety.run**

修改 `src/harness/tools/builtin.ts`：

1. import `Sandbox` 改为 `SafetyChain`。
2. 函数签名 `builtinTools(sandbox: Sandbox, root: string)` 改为 `builtinTools(safety: SafetyChain, root: string)`。
3. `exec` 工具的 executor 内 `sandbox.run(...)` 改为 `safety.run(...)`。

改后 `exec` executor：

```ts
{
  name: 'exec',
  description: '在沙箱内执行 shell 命令',
  category: 'bash',
  executor: async (input: ToolInput) => {
    const cmd = String(input.command ?? '');
    const r = await safety.run(cmd, { cwd: root });
    if (r.ok) return r.value;
    throw new Error(`${r.error.code}: ${r.error.message}`);
  },
},
```

其余 read/write/grep/glob 的 executor 不变（它们仍经 `ToolRegistry.execute → safety.evaluate` 的 guard 守门）。

- [x] **Step 7: Harness 构造 SafetyChain 并接线**

修改 `src/harness/index.ts`：

1. 新增 import `SafetyChain`，新增公开字段 `readonly safety: SafetyChain;`
2. 构造顺序：security/dryrun 之后 `this.safety = new SafetyChain(this.security, this.sandbox, this.dryrun);`
3. `builtinTools(this.safety, base)` 替代 `builtinTools(this.sandbox, base)`。
4. Reactor 依赖改为 `{ registry, safety, context, model }`。

改后构造器核心：

```ts
this.sandbox = new ProcessSandbox();
this.security = new SecurityGuard(new PolicyEngine(), opts.mode ?? 'dontAsk');
this.dryrun = new DryRun();
this.safety = new SafetyChain(this.security, this.sandbox, this.dryrun);
this.tools = new ToolRegistry();
for (const t of builtinTools(this.safety, base)) this.tools.register(t);
this.context = new ContextManager(base, store);
this.reactor = new Reactor({
  registry: this.tools,
  safety: this.safety,
  context: this.context,
  model: opts.model ?? new StubAdapter(),
});
```

注意：`ReactorDeps` 里 `guard`/`sandbox` 两个字段合并为 `safety`（见 Step 8）。

- [x] **Step 8: Reactor 依赖改为 safety**

修改 `src/harness/reactor.ts`：

1. import 区删除 `SecurityGuard`、`Sandbox`，新增 `import { SafetyChain } from './security/chain';`
2. `ReactorDeps` 由 `{ registry, guard, sandbox, context, model }` 改为 `{ registry, safety, context, model }`。
3. act 阶段执行改为 `this.deps.registry.execute(action.tool, action.input ?? {}, this.deps.safety)`。

改后 `ReactorDeps`：

```ts
export interface ReactorDeps {
  registry: ToolRegistry;
  safety: SafetyChain;
  context: ContextManager;
  model: ModelAdapter;
}
```

改后 act 片段：

```ts
const r = await this.deps.registry.execute(action.tool, action.input ?? {}, this.deps.safety);
```

- [x] **Step 9: 更新受影响测试**

`src/harness/reactor.test.ts`：4 个现有测试 + Step 6 新增的 1 个，构造处从「guard + sandbox」改为「safety」。在文件 import 区新增 `SafetyChain`、`DryRun`。为消除重复，新增 helper 并替换各测试的构造块：

```ts
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';

function makeReactor(tmp: string, adapter: { provider: string; complete: (p: string) => Promise<string> }): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun());
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter });
}
```

5 个测试体分别简化为 `const reactor = makeReactor(tmp, adapter);`（adapter 各测试沿用原 ScriptedAdapter 或自定义对象）。

`src/harness/tools/tools.test.ts`：3 个测试构造 `SafetyChain` 替代 `guard + sandbox`，`execute` 第 3 参传 safety。改后示例：

```ts
const safety = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun());
const registry = new ToolRegistry();
for (const t of builtinTools(safety, process.cwd())) registry.register(t);
const r = await registry.execute('exec', { command: 'rm -rf /' }, safety);
```

`src/harness/tools/stability.test.ts`：`registryWith` helper 的返回类型与构造改为 safety：

```ts
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';

function registryWith(root: string): { registry: ToolRegistry; safety: SafetyChain } {
  const safety = new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), new DryRun());
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { registry, safety };
}
```

各测试体 `execute('read', {...}, guard, sandbox)` 改为 `execute('read', {...}, safety)`（解构 `{ registry, safety }`）。

- [x] **Step 10: 跑全量测试 + selfcheck**

Run: `npm test && npm run selfcheck`
Expected: 全绿，selfcheck 打印骨架摘要正常。

- [x] **Step 11: 提交**

```bash
git add -A
git commit -m "feat(harness): SafetyChain 统一安全链，工具执行只经 safety 单入口"
```

---

## Self-Review（计划自检）

**1. Spec 覆盖（1A 部分）：**
- A4 记忆唯一生命周期 → Task 1（删内存 Map，MemoryLifecycle 唯一）✓
- A1 上下文唯一入口 → Task 2（Context.assemble，Reactor 不再自拼）✓
- A3 安全唯一链 → Task 3（SafetyChain 单入口）✓
- A2 动作唯一入口 → 现状已满足，Task 3 未新增旁路，加固 ✓
- 1B-1E 明确不在本 plan（Global Constraints 已声明）✓

**2. 占位符扫描：** 无 TBD/TODO；每个 Step 含实际代码与命令。

---

## 执行记录（2026-09-06 验收回写）

**提交链**：`8b709c0` 本计划 → `f141544` T1 统一记忆生命周期（删内存 Map，AutoMemory→MemoryLifecycle）→ `571e299` T2 Context.assemble 统一上下文入口 → `0c46132` T3 SafetyChain 统一安全链（工具执行只经 safety 单入口）。

**验收**：A1/A2/A3/A4 达成（A2 现状加固）；端到端验收由 1B 回写承接（B 系列用例含 1A 回归）；真实场景验证报告 R1/R5/R6 场景复核主链编排通过。

**3. 类型一致性：** `MemoryLifecycle`（Task 1 产出）被 Task 2 的 `ContextManager` 引用；`assemble(goal, history?, relPath?)`（Task 2 产出）被 Task 2 的 Reactor 与 Task 3 未改动处引用；`SafetyChain.evaluate/run/preview`（Task 3 产出）被 tools/builtin/reactor 一致调用。`execute(name, input, safety)` 签名在 tools.ts 定义、reactor.ts 与三个测试文件统一更新。字段 `ReactorDeps.safety` 在 index.ts 与 reactor.test.ts 一致。
