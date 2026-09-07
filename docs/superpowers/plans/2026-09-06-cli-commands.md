# CLI 专项命令接入（阶段二收口 + 部署测试入口）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SunshineX 提供可部署、可交互验证的 CLI 入口，收口 ROADMAP 阶段二唯一未勾选项「CLI 专项命令接入」。

**Architecture:** 新建 `src/cli/` 专用入口，复用既有 `Harness` 门面与三大 Loop 模板 / Graph 流水线模板，零新增运行时依赖（`process.argv` 手工解析）。命令三件套：`selfcheck`（骨架自检）、`run`（单 Loop 模板驱动的修正环）、`pipeline`（五节点全链路流水线 + 人工审批交互）。装配方式与既有探针脚本保持一致，不新增抽象层。

**Tech Stack:** TypeScript（strict，CommonJS）、Node.js 内置 `node:fs` / `node:readline/promises`、零第三方依赖。

## Global Constraints

- TypeScript strict 零报错；提交前必须 `npm run build` 通过（CLAUDE.md §7）。
- 零新增依赖：CLI 解析用 `process.argv`，交互审批用 `node:readline/promises`。
- 所有 IO 集中在对应 adapter/store 内；CLI 只做参数解析与装配，不绕过 SafetyChain。
- 写操作前评估影响面；改动后运行 `npm run selfcheck` 自检。
- 安全模式缺省 `dontAsk`，审批 gate 用 readline 交互确认；`--yes` 时跳过交互直接批准（供脚本化部署冒烟）。
- 探针 / 真实模型冒烟不进 CI 门禁，手动执行（既有约定）。
- 提交信息格式沿用仓库惯例：`feat(cli): 中文描述（P2 T7)`。

---

### Task 1: CLI 骨架与 `selfcheck` 命令

**Files:**
- Create: `src/cli/index.ts`
- Modify: `src/index.ts`（自检逻辑迁出，仅保留提示语，指向 CLI）
- Modify: `package.json`（新增 `cli` script：`node --env-file-if-exists=.env dist/cli/index.js`）
- Test: `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `Harness`（`src/harness`，构造参数 `{ root?: string; model?: ModelAdapter; mode?: PermissionMode }`）；`softwarePipelineTemplate`、三大 Loop 模板（`deps: { safety; registry; context; model }`）。
- Produces: `export interface CliArgs { command: string; positional: string[]; flags: Record<string, string | boolean>; }` 与 `export function parseArgs(argv: string[]): CliArgs`（无参或未知命令时 `command` 为 `'help'`）。后续任务按此签名消费。

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/cli.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './index';

test('parseArgs：无参数回退 help', () => {
  assert.equal(parseArgs([]).command, 'help');
});

test('parseArgs：positional 与布尔 flag', () => {
  const a = parseArgs(['selfcheck', '--json']);
  assert.equal(a.command, 'selfcheck');
  assert.equal(a.flags.json, true);
});

test('parseArgs：--flag=value 与裸 positional 混排', () => {
  const a = parseArgs(['run', 'tests/fixtures/demo', '--template', 'test-loop', '--mode', 'dontAsk']);
  assert.equal(a.command, 'run');
  assert.deepEqual(a.positional, ['tests/fixtures/demo']);
  assert.equal(a.flags.template, 'test-loop');
  assert.equal(a.flags.mode, 'dontAsk');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/cli/cli.test.js`
Expected: FAIL，`Cannot find module './index'` 或 `parseArgs is not a function`。

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/index.ts
import { runSelfcheck } from './commands/selfcheck';
import { runLoop } from './commands/run-loop';
import { runPipeline } from './commands/run-pipeline';

/** CLI 参数解析：仅内置约定，零依赖。--flag=v → 字符串；--flag → true；其余为 positional */
export interface CliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

const USAGE = `SunshineX CLI
  sunshinex selfcheck                     骨架自检（感知/工具/安全/上下文/Loop/Graph 就绪）
  sunshinex run <dir> [--template=...]    在目录上运行 Loop 模板修正环（goal 走交互或 --goal）
  sunshinex pipeline <dir> [--yes]        五节点全链路流水线，gate 审批交互（--yes 跳过交互直接批准）`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'selfcheck':
      return runSelfcheck(args);
    case 'run':
      return runLoop(args);
    case 'pipeline':
      return runPipeline(args);
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error('CLI-ERROR', e instanceof Error ? e.message : e);
  process.exit(1);
});
```

同任务创建占位命令文件（Task 2/3 各自替换实现，先保证可编译）：

```typescript
// src/cli/commands/selfcheck.ts
import type { CliArgs } from '../index';

/** Task 1 最小实现：复用根入口自检输出格式；Task 2/3 不改此文件 */
export function runSelfcheck(_args: CliArgs): void {
  console.log('selfcheck: 迁移自 src/index.ts（本任务内完成，见 Step 3b）');
}
```

- [ ] **Step 3b: 把 `src/index.ts` 的 `selfcheck()` 逻辑迁移进 `commands/selfcheck.ts`**（原样搬移六个 console 输出段；`src/index.ts` 保留 `--selfcheck` 时打印「已迁移至 `npm run cli -- selfcheck`」提示，避免旧用法静默失效）。迁移后 `runSelfcheck` 内部构造 `new Harness({ root: process.cwd() })` 并沿用原输出逐行照搬。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/cli/cli.test.js && npm run cli -- selfcheck`
Expected: 3 项测试 PASS；selfcheck 输出与迁移前一致（project/rules/files/tools/harness/loop/graph 七行）。

- [ ] **Step 5: Modify `package.json` scripts**（在 `scripts` 内新增一行，其余不动）

```json
"cli": "node --env-file-if-exists=.env dist/cli/index.js"
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/ src/index.ts package.json
git commit -m "feat(cli): CLI 骨架与 selfcheck 命令——自检逻辑迁入 src/cli（P2 T7-1）"
```

---

### Task 2: `run` 命令——Loop 模板修正环

**Files:**
- Create: `src/cli/commands/run-loop.ts`
- Create: `tests/fixtures/demo/math.js`（部署冒烟物料：正确实现）
- Create: `tests/fixtures/demo/math.test.js`（部署冒烟物料：错误断言，供修正环修复）
- Modify: `src/cli/index.ts`（`case 'run'` 指向真实实现，删除 Task 1 若留的占位分支）
- Test: `src/cli/commands/run-loop.test.ts`

**Interfaces:**
- Consumes: `parseArgs`（Task 1）；`Harness`；`codeRefactorTemplate` / `testLoopTemplate` / `codeReviewTemplate`（`opts?: { termination?; ruleCheckers? }`，`engine.run(goal): Promise<LoopRunResult>`，结果含 `status / criteria / tokensUsed`）；`OpenAIAdapter`（构造参数 `{}`，自动读 `.env` 三元组）。
- Produces: `export function buildDeps(root: string, flags: Record<string, string | boolean>): LoopDeps & { root: string }`——统一装配（安全链 + 工具表 + 上下文 + 模型），Task 3 直接复用，签名不得变更。

- [ ] **Step 1: Write the failing test**（用 StubAdapter 离线验证装配与模板选择，真实模型留给冒烟探针）

```typescript
// src/cli/commands/run-loop.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDeps, resolveTemplate } from './run-loop';
import { ScriptedAdapter } from '../../model/adapter';

test('buildDeps：装配四件套且安全链基准为 root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  const deps = buildDeps(tmp, {});
  assert.ok(deps.safety && deps.registry && deps.context && deps.model);
  assert.equal(deps.registry.list().length >= 5, true, '内置五工具已注册');
});

test('resolveTemplate：test-loop 模板可实例化且节点含 check', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  const deps = buildDeps(tmp, {});
  const tpl = resolveTemplate(deps, 'test-loop');
  assert.equal(tpl.name, 'test-loop');
  assert.ok(tpl.nodes.some((n) => n.id.includes('check')));
});

test('resolveTemplate：未知模板名报错不静默', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  assert.throws(() => resolveTemplate(buildDeps(tmp, {}), 'no-such'));
});

test('run-loop：ScriptedAdapter 驱动 test-loop 修正环 done（离线端到端）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  fs.writeFileSync(path.join(tmp, 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(tmp, 'math.test.js'), 'const assert = require("node:assert");\nconst { add } = require("./math");\nassert.equal(add(1, 2), 4);\n');
  const deps = buildDeps(tmp, { model: 'scripted' });
  (deps as { model: unknown }).model = new ScriptedAdapter([
    '{"tool":"write","input":{"path":"math.test.js","content":"const assert = require(\\"node:assert\\");\\nconst { add } = require(\\"./math\\");\\nassert.equal(add(1, 2), 3);\\n"},"done":false}',
    '{"done":true,"reply":"断言已修正为 3"}',
  ]);
  const tpl = resolveTemplate(deps, 'test-loop', {
    ruleCheckers: { c1: async () => fs.readFileSync(path.join(tmp, 'math.test.js'), 'utf8').includes('assert.equal(add(1, 2), 3)') },
  });
  const r = await tpl.engine.run('修正测试断言（验收标准：c1=断言 add(1,2)===3）');
  assert.equal(r.status, 'done');
  assert.equal(r.tokensUsed, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/cli/commands/run-loop.test.js`
Expected: FAIL，`Cannot find module './run-loop'`。

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/commands/run-loop.ts
import * as path from 'path';
import { Harness } from '../../harness';
import { LoopDeps } from '../../loop/engine';
import { LoopTemplate } from '../../loop/templates';
import { codeRefactorTemplate, codeReviewTemplate, testLoopTemplate } from '../../loop/templates';
import { OpenAIAdapter, ScriptedAdapter, StubAdapter } from '../../model/adapter';
import type { CliArgs } from '../index';

/** 统一装配（Task 3 复用）：root 为项目目录，--model 可选 openai|scripted|stub，缺省 openai */
export function buildDeps(root: string, flags: Record<string, string | boolean>): LoopDeps {
  const h = new Harness({ root, mode: (flags.mode as 'dontAsk') ?? 'dontAsk' });
  const model =
    flags.model === 'scripted' ? new ScriptedAdapter([]) :
    flags.model === 'stub' ? new StubAdapter() :
    new OpenAIAdapter({});
  return { safety: h.safety, registry: h.tools, context: h.context, model };
}

const FACTORIES: Record<string, (deps: LoopDeps) => LoopTemplate> = {
  'code-refactor': (d) => codeRefactorTemplate(d),
  'test-loop': (d) => testLoopTemplate(d),
  'code-review': (d) => codeReviewTemplate(d),
};

export function resolveTemplate(deps: LoopDeps, name: string, opts?: { ruleCheckers?: Record<string, (io: { ctx: import('../../types').LoopContext; goal: string }) => Promise<boolean> | boolean>; }): LoopTemplate {
  const f = FACTORIES[name];
  if (!f) throw new Error(`未知模板：${name}（可选 ${Object.keys(FACTORIES).join('/')}）`);
  return f(deps);
}

export async function runLoop(args: CliArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) throw new Error('用法：sunshinex run <dir> [--template=test-loop] [--goal=...]');
  const root = path.resolve(dir);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"');
  const template = String(args.flags.template ?? 'test-loop');
  const deps = buildDeps(root, args.flags);
  const tpl = resolveTemplate(deps, template);
  console.log(`[run] root=${root} template=${template}`);
  const r = await tpl.engine.run(goal);
  console.log(JSON.stringify({ status: r.status, iterations: r.iterations, tokensUsed: r.tokensUsed, criteria: r.criteria, reply: r.reply, error: r.error }, null, 2));
  if (r.status !== 'done') process.exitCode = 1;
}
```

注意：`buildDeps` 支持 `flags.model` 注入测试替身（`scripted`/`stub`），测试里再覆盖 `deps.model` 亦可——两条路都允许，但生产路径缺省必须是 `OpenAIAdapter`。

- [ ] **Step 4: Create fixtures**（部署冒烟物料，供真实模型手动冒烟与用户验证）

```javascript
// tests/fixtures/demo/math.js
function add(a, b) { return a + b; }
module.exports = { add };
```

```javascript
// tests/fixtures/demo/math.test.js  （故意错误断言 4，供修正环演示）
const assert = require('node:assert');
const { add } = require('./math');
assert.equal(add(1, 2), 4);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test dist/cli/commands/run-loop.test.js`
Expected: 4 项 PASS。

- [ ] **Step 6: Manual real-model smoke（不进门禁）**

Run: `npm run cli -- run tests/fixtures/demo --template=test-loop --goal="修正 math.test.js 断言使其通过（验收标准：c1=断言 add(1,2)===3）"`
Expected: `status: done`、`tokensUsed > 0`、criteria 全过。

- [ ] **Step 7: Commit**

```bash
git add src/cli/ tests/fixtures/
git commit -m "feat(cli): run 命令——三大 Loop 模板驱动修正环 + 部署冒烟物料（P2 T7-2）"
```

---

### Task 3: `pipeline` 命令——全链路流水线与审批交互

**Files:**
- Create: `src/cli/commands/run-pipeline.ts`
- Modify: `src/cli/index.ts`（`case 'pipeline'` 指向真实实现）
- Test: `src/cli/commands/run-pipeline.test.ts`

**Interfaces:**
- Consumes: `buildDeps`（Task 2，签名不变）；`softwarePipelineTemplate(deps, opts: PipelineOpts)`，`PipelineOpts = { goal?; ruleCheckers?; maxSteps?; termination? }`；`engine.run(goal)` → `{ status: 'done' | 'paused' | 'failed', pendingGates: string[], tokensUsed, results }`；`engine.resume(approvals: Record<string, boolean>)` → 同构结果。
- Produces: `export async function confirmApprovals(gates: string[], readline: { question(q: string): Promise<string> }): Promise<Record<string, boolean>>`——交互审批（回答 `y/yes` 为批准，其余拒绝）；`--yes` 时调用方跳过该函数直接传全 true。

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/commands/run-pipeline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmApprovals } from './run-pipeline';

test('confirmApprovals：y 批准 / n 拒绝 / 多 gate 逐个询问', async () => {
  const answers = ['y', 'n'];
  const fake = { question: async () => answers.shift() ?? 'n' };
  const r = await confirmApprovals(['delivery-gate', 'release-gate'], fake);
  assert.deepEqual(r, { 'delivery-gate': true, 'release-gate': false });
});

test('confirmApprovals：Yes/YES 大小写不敏感', async () => {
  const fake = { question: async () => 'YES' };
  const r = await confirmApprovals(['g'], fake);
  assert.deepEqual(r, { g: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/cli/commands/run-pipeline.test.js`
Expected: FAIL，`Cannot find module './run-pipeline'`。

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/commands/run-pipeline.ts
import * as fs from 'node:fs';
import * as path from 'path';
import * as readline from 'node:readline/promises';
import { softwarePipelineTemplate } from '../../graph/templates';
import { buildDeps } from './run-loop';
import type { CliArgs } from '../index';

/** 交互审批：gate 名单 → {gate: bool}；readline 注入便于测试 */
export async function confirmApprovals(
  gates: string[],
  rl: { question(q: string): Promise<string> },
): Promise<Record<string, boolean>> {
  const approvals: Record<string, boolean> = {};
  for (const g of gates) {
    const ans = (await rl.question(`[审批] ${g} 批准交付？(y/N) `)).trim().toLowerCase();
    approvals[g] = ans === 'y' || ans === 'yes';
  }
  return approvals;
}

export async function runPipeline(args: CliArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) throw new Error('用法：sunshinex pipeline <dir> [--goal=...] [--yes]');
  const root = path.resolve(dir);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"——check 依赖结构化验收清单');
  const deps = buildDeps(root, args.flags);
  const tpl = softwarePipelineTemplate(deps, {
    goal,
    maxSteps: 8,
    termination: { maxTokens: 200_000, timeoutMs: 600_000 },
  });

  console.log(`[pipeline] root=${root} nodes=${tpl.nodes.map((n) => n.id).join('→')}`);
  const r1 = await tpl.engine.run(goal);
  console.log(`run   : ${r1.status} tokens=${r1.tokensUsed} pendingGates=[${r1.pendingGates}]`);

  if (r1.status === 'paused') {
    const approvals = args.flags.yes
      ? Object.fromEntries(r1.pendingGates.map((g) => [g, true]))
      : await confirmApprovals(r1.pendingGates, readline.createInterface({ input: process.stdin, output: process.stdout }));
    const r2 = await tpl.engine.resume(approvals);
    console.log(`resume: ${r2.status} tokens=${r2.tokensUsed} failedNodes=[${r2.failedNodes}]`);
    if (r2.status !== 'done') process.exitCode = 1;
    return;
  }
  if (r1.status !== 'done') process.exitCode = 1;
  void fs; // 占位避免未用导入告警？——不保留：直接删掉本行与 fs 导入（此处显式提醒实现者自查）
}
```

注意：实现时删除末行 `void fs;` 与顶部未用的 `fs` 导入（计划原文保留以提示自查——这是本计划唯一的「实现时删除」项，其余代码逐行照用）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/cli/commands/run-pipeline.test.js`
Expected: 2 项 PASS。

- [ ] **Step 5: 全量回归 + 自检**

Run: `npm test && npm run selfcheck`
Expected: 全量单测 PASS（新增 9 项全绿）；selfcheck 七行输出不变。

- [ ] **Step 6: Commit**

```bash
git add src/cli/
git commit -m "feat(cli): pipeline 命令——五节点流水线 + gate 审批交互（--yes 脚本化）（P2 T7-3）"
```

---

### Task 4: 部署测试探针与文档收口

**Files:**
- Create: `scripts/probe-cli-smoke.js`（部署冒烟：CLI 子命令级联调用，真实模型，手动执行）
- Modify: `docs/ROADMAP.md`（阶段二勾选 `- [x] CLI 专项命令接入`；§5 基线数字刷新为实际测试数；§7 表格 `src/cli/` 行改为「已建（selfcheck/run/pipeline）」）
- Modify: `README.md`（如存在则追加 Quick Start 段；不存在则跳过并在提交说明注明）

**Interfaces:**
- Consumes: `npm run cli -- ...`（Task 1–3 产出的完整命令面）；`.env` 三元组（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）。
- Produces: 无新代码接口；产出「可部署可验证」的验收记录。

- [ ] **Step 1: Write probe script**

```javascript
// scripts/probe-cli-smoke.js —— 部署冒烟：CLI × DeepSeek（手动执行，不进门禁）
//   npm run cli -- selfcheck && node --env-file-if-exists=.env scripts/probe-cli-smoke.js
// 断言：1) selfcheck 退出码 0 且含 graph 行；2) run 命令在 fixtures 上 done 且 tokensUsed>0；
//       3) pipeline 命令 --yes 全链路 done（gate 自动批准）。
const { execFileSync } = require('node:child_process');

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}: ${e.message.split('\n')[0]}`); }
}

check('selfcheck：退出码 0 且含 graph 行', () => {
  const out = sh('node', ['dist/cli/index.js', 'selfcheck']);
  if (!out.includes('graph')) throw new Error('selfcheck 缺 graph 行');
});

check('run：fixtures 修正环 done（真实模型）', () => {
  const out = sh('node', ['--env-file-if-exists=.env', 'dist/cli/index.js', 'run', 'tests/fixtures/demo',
    '--template=test-loop', '--goal=修正 math.test.js 断言使其通过（验收标准：c1=断言 add(1,2)===3）']);
  if (!/"status": "done"/.test(out)) throw new Error(`run 未 done：${out.slice(0, 200)}`);
  if (/\"tokensUsed\": 0/.test(out)) throw new Error('tokensUsed=0，未走真实模型');
});

check('pipeline：--yes 全链路 done（真实模型）', () => {
  const out = sh('node', ['--env-file-if-exists=.env', 'dist/cli/index.js', 'pipeline', 'tests/fixtures/demo', '--yes',
    '--goal=实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）']);
  if (!/resume: done/.test(out)) throw new Error(`pipeline 未 done：${out.slice(0, 200)}`);
});

if (failed > 0) { console.error(`CLI-SMOKE-FAIL：${failed} 项未过`); process.exit(1); }
console.log('CLI smoke OK：selfcheck / run / pipeline 三命令部署可用。');
```

注意：fixtures 会被 `run` 探针真实修复——探针开头先把 `tests/fixtures/demo/math.test.js` 重置为错误断言版本（`fs.writeFileSync` 三行，内容与仓库提交版一致），保证探针可重复执行。

- [ ] **Step 2: Run probe（真实模型冒烟）**

Run: `node --env-file-if-exists=.env scripts/probe-cli-smoke.js`
Expected: `ok - selfcheck...`、`ok - run...`、`ok - pipeline...`、末行 `CLI smoke OK`，退出码 0。

- [ ] **Step 3: 更新 ROADMAP 与文档**（逐行精确替换）

- `docs/ROADMAP.md` 阶段二清单：`- [ ] CLI 专项命令接入` → `- [x] CLI 专项命令接入`
- `docs/ROADMAP.md` §5 当前基线行：`40 个测试全绿` → 按 Step 2 实际全量数填写（预期 158 项左右，以 `npm test` 输出为准）
- `docs/ROADMAP.md` §7 表格：`| src/cli/、src/gui/、src/server/ | 未建 | 阶段二 / 五 |` → 拆为三行：`src/cli/` 已建（selfcheck/run/pipeline，阶段二）；`src/gui/` 未建（阶段五）；`src/server/` 未建（按需）
- `README.md` 追加：

```markdown
## Quick Start（CLI）

​```bash
npm install --cache .npm-cache
npm run build
npm run cli -- selfcheck                                   # 骨架自检
npm run cli -- run tests/fixtures/demo --template=test-loop \
  --goal="修正 math.test.js 断言使其通过（验收标准：c1=断言 add(1,2)===3）"   # Loop 修正环
npm run cli -- pipeline tests/fixtures/demo --yes \
  --goal="实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）"  # 全链路流水线
​```

需配置 `.env`（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL，DeepSeek 兼容 OpenAI 协议）。
```

- [ ] **Step 4: 全量回归**

Run: `npm test && npm run selfcheck && node --env-file-if-exists=.env scripts/probe-cli-smoke.js`
Expected: 单测全绿、selfcheck 七行、探针三 ok。

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-cli-smoke.js docs/ROADMAP.md README.md
git commit -m "docs+probe: CLI 部署冒烟探针与 ROADMAP 阶段二收口回写（P2 T7-4）"
```

---

## Self-Review 记录

- **Spec coverage**：ROADMAP 阶段二唯一未勾项「CLI 专项命令接入」→ Task 1–4 全覆盖；验收口径「Loop 闭环跑通生成→校验→修正→终止，三大模板各可端到端演示」→ Task 2 三模板工厂 + Step 6 手动冒烟 + Task 4 探针固化。用户「部署测试」诉求 → `npm run cli -- selfcheck/run/pipeline` 三命令 + fixtures + 可重复探针。
- **Placeholder scan**：Task 3 Step 3 末行 `void fs;` 为显式标注的「实现时删除」项（防未用导入），已加粗说明；除此之外无 TBD/TODO/空泛描述。
- **Type consistency**：`parseArgs`/`CliArgs`（Task 1 定义，Task 2/3 消费）一致；`buildDeps`（Task 2 定义 `LoopDeps`，Task 3 复用）一致；`confirmApprovals` 签名与测试注入的 `fake.readline` 一致；`resolveTemplate` 第三参 opts 类型与 `TemplateOpts.ruleCheckers` 对齐。

## 验收与阶段门

- 全量单测含新增 9 项全绿；`npm run selfcheck` 通过。
- `scripts/probe-cli-smoke.js` 三项 ok（真实模型，手动执行）。
- ROADMAP 阶段二 6/6 勾选 → 阶段 1–3 全部完备，达成进入阶段四的前置条件。
