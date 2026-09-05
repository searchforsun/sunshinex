# 统一主链 · 1B 补深度 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 1B「补深度」三项交付，把主链从「骨架闭合」推进到「深度可证」：
① root 越界校验——`SafetyChain.evaluate` 对文件工具做路径边界校验并返回 `safePath`，builtin 删除自 resolve（单轨）；
② credentials mask——`SafetyChain.maskResult` 作为工具结果跨链的唯一脱敏出口（execute 出口统一调用）；
③ 压缩重注入闭环——`ContextWindow` checksum 三态门禁 + 纯计算摘要产出（`reinject` 落地），`ContextManager.applyCompaction` 协调摘要与最近文件重读注入，`Reactor` 持水位线并在 read/grep 成功后上报 `trackFile`。

**Architecture:** 对应 spec `docs/superpowers/specs/2026-09-04-harness-spine-1b-depth-design.md`。安全链扩展为 guard 守门 → 路径边界 → sandbox 执行 + dryrun 预览（mask 出口）；Context 管线形成「estimate → shouldCompact → compact → applyCompaction（checksum 门禁 + 摘要 + 重读）→ 下一轮 assemble 注入（goal 之后、history 之前）」闭环；Reactor 只管水位线与触发，不再直接触碰 window.checksum。

**Tech Stack:** TypeScript strict、Node.js `node --test`、CommonJS；零新增 npm 依赖。

## Global Constraints（逐字执行）

- 零新增 npm 依赖；mask 模式集为零依赖内置正则，不引第三方库。
- 测试仅用 `node --test`；`tsconfig` 保持 strict；模块 CommonJS，import 用相对路径。
- 提交前必须 `npm run build`（tsc 零报错）且 `npm run selfcheck` 通过、`node --test` 全绿。
- 仅通过 sandbox 工具读写 `/workspace/wt-59f36a81fc`；禁止写 `/skills`；工作目录固定为该 checkout，勿 cd 其它分支目录。
- **环境硬约束（1A 已验证）**：`src/` 及子目录属 `root:root 0755`，shell 对已有文件无写权限——新建文件用 `sandbox__write`、修改文件用 `sandbox__edit`（old_string 必须精确唯一）；不要用 shell 的 `>`/`rm`/`cat >>` 写 `src/` 下文件。
- **提交纪律**：显式 `git add <改动文件列表>`，禁止 `git add -A`（工作区有两个遗留 untracked 占位文件 `src/harness/context/auto-memory.ts`、`src/harness/memory.ts`，不得纳入提交）。
- 越界判据（spec 2.1）：`abs !== root && !abs.startsWith(root + path.sep)`；deny 走既有 `COMMAND_DENIED` 流程、reason 说明越界，不新增错误码。
- mask 命中片段替换为 `***`；模式集为 spec 2.3 逐字清单。
- trackFile 去重、LRU 上限 5；重读最近 ≤5 个文件、每文件截断前 500 行；重读失败跳过（spec 3.3）。
- verifyChecksum 三态 `first/replay/new`；replay 幂等：不重复注入、不重复记入记忆（spec 3.1 修正版）。
- 注入块固定位于 goal 之后、history 之前（spec 3.3）。
- Reactor 预算缺省不变 `{ total: 200_000, reserve: 40_000 }`，新增 `opts.budget` 仅用于测试注入（spec 3.4）。

## File Structure（改动面）

```
src/harness/security/guard.ts      [modify] GuardDecision 扩展 safePath（T1）
src/harness/security/chain.ts      [modify] root 注入 + evaluate 越界校验（T1）；maskResult/preview mask（T2）
src/types.ts                       [not changed] ContextItem.kind 无需扩展
src/harness/tools.ts               [modify] execute 传递 safePath 并替换 input.path；出口统一脱敏（T2）
src/harness/tools/builtin.ts       [modify] read/write/grep 删自 resolve（T2）
src/harness/index.ts               [modify] SafetyChain 构造传 base（T1）
src/harness/security/chain.test.ts [modify] 越界/mask 用例 + 构造点（T1/T2）
src/harness/tools/tools.test.ts    [modify] 构造点 + mask 集成用例（T1/T2）
src/harness/tools/stability.test.ts[modify] 构造点 + 越界/脱敏用例（T1/T2）
src/harness/reactor.test.ts        [modify] 构造点 + 闭环用例（T1/T5）
src/harness/context/window.ts      [modify] checksum 三态 + summarize/reinject/checksum（T3）
src/harness/context/window.test.ts [modify] 三态重写 + 摘要产出用例（T3）
src/harness/context/index.ts       [modify] trackFile/recentFiles/applyCompaction + assemble 注入（T4）
src/harness/context/compaction.test.ts [create] 注入管线用例（T4）
src/harness/reactor.ts             [modify] budget 参数化 + applyCompaction + 水位线 + trackFile（T5）
```

---

### Task 1: SafetyChain root 注入与文件工具越界校验（safePath）

**Files:**
- Modify: `src/harness/security/guard.ts`
- Modify: `src/harness/security/chain.ts`
- Modify: `src/harness/index.ts`
- Modify: `src/harness/security/chain.test.ts`（构造点迁移 + 新用例）
- Modify: `src/harness/tools/tools.test.ts`、`src/harness/tools/stability.test.ts`、`src/harness/reactor.test.ts`（构造点迁移）

**Interfaces:**
- Consumes: `path.resolve/startsWith`（Node 内置）
- Produces: `GuardDecision = { allowed: true; safePath?: string } | { allowed: false; reason: string }`；`new SafetyChain(guard, sandbox, dryrun, root: string)`（root 必填，防止静默用 cwd）
- 顺序契约：guard 决策先行（deny 直接返回），路径边界仅对 canonical `Read/Write/Grep` 生效；`Glob/Bash` 不做路径校验、无 `safePath`。

- [ ] **Step 1: 写失败测试**

`src/harness/security/chain.test.ts` 整体重写为（helper 加 root 参数，第二参选模式）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';

function chain(root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-chain-')), mode: 'manual' | 'dontAsk' = 'manual'): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), mode), new ProcessSandbox(), new DryRun(), root);
}

test('SafetyChain.evaluate 经 guard 拦截危险命令', () => {
  const p = new PolicyEngine();
  p.add('deny', 'Bash(rm *)');
  const c = chain(process.cwd());
  const d = c.evaluate('Bash', { command: 'rm -rf /' });
  assert.equal(d.allowed, false);
});

test('SafetyChain.run 经沙箱执行 echo', async () => {
  const r = await chain(process.cwd()).run('echo hi');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hi/);
});

test('SafetyChain.preview 透传 dryrun', () => {
  assert.equal(chain(process.cwd()).preview('echo hi'), 'echo hi');
});

test('evaluate 对 Read 越界相对路径 deny 并说明原因', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const d = chain(root).evaluate('Read', { path: '../outside.txt' });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.reason, /越出项目 root/);
});

test('evaluate 对绝对路径越出 root 的 Write deny（dontAsk 先行放行 guard）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-outside-'));
  const d = chain(root, 'dontAsk').evaluate('Write', { path: path.join(outside, 'x.txt') });
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.reason, /越出项目 root/);
});

test('evaluate 界内路径 allow 并返回绝对 safePath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-'));
  const d = chain(root, 'dontAsk').evaluate('Write', { path: 'sub/a.txt' });
  assert.equal(d.allowed, true);
  if (d.allowed) assert.equal(d.safePath, path.join(root, 'sub', 'a.txt'));
});

test('Glob 与 Bash 不做路径校验且无 safePath', () => {
  const c = chain(process.cwd());
  const g = c.evaluate('Glob', { pattern: '**/*' });
  assert.equal(g.allowed, true);
  if (g.allowed) assert.equal(g.safePath, undefined);
  const b = c.evaluate('Bash', { command: 'echo hi' });
  assert.equal(b.allowed, true);
  if (b.allowed) assert.equal(b.safePath, undefined);
});
```

同时在 Step 1 更新其余测试构造点（仅为编译通过，不新增断言）：
- `src/harness/tools/tools.test.ts`：3 处 `new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun())` → `new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), process.cwd())`；`new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), ...)` 同样补第 4 参 `process.cwd()`。
- `src/harness/tools/stability.test.ts`：`registryWith` 内改为 `new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), new DryRun(), root)`。
- `src/harness/reactor.test.ts`：`makeReactor` 内改为 `new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build`
Expected: FAIL —— `TS2554: Expected 3 arguments, but got 4`（SafetyChain 构造尚无 root）。

- [ ] **Step 3: 实现**

`src/harness/security/guard.ts`：把 `GuardDecision` 类型替换为：

```ts
export type GuardDecision =
  | { allowed: true; safePath?: string }
  | { allowed: false; reason: string };
```

`src/harness/security/chain.ts` 整体重写为：

```ts
import * as path from 'path';
import { GuardDecision, SecurityGuard } from './guard';
import { Sandbox } from './sandbox';
import { DryRun } from './dryrun';
import { ExecResult } from '../../types';
import { Result } from '../../result';

/** 需要路径边界校验的工具（安全链规范名） */
const PATH_TOOLS = new Set(['Read', 'Write', 'Grep']);

/** 统一安全链：guard 守门 → 路径边界 → sandbox 执行 + dryrun 预览（mask 出口见 maskResult） */
export class SafetyChain {
  constructor(
    private guard: SecurityGuard,
    private sandbox: Sandbox,
    private dryrun: DryRun,
    private readonly root: string,
  ) {}

  evaluate(tool: string, input: unknown): GuardDecision {
    const decision = this.guard.preToolUse(tool, input);
    if (!decision.allowed) return decision;

    if (PATH_TOOLS.has(tool)) {
      const raw = typeof input === 'object' && input !== null ? (input as { path?: unknown }).path : undefined;
      const abs = path.resolve(this.root, String(raw ?? ''));
      if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
        return { allowed: false, reason: `COMMAND_DENIED: 路径越出项目 root：${abs}` };
      }
      return { allowed: true, safePath: abs };
    }
    return { allowed: true };
  }

  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    return this.sandbox.run(cmd, opts);
  }

  preview(cmd: string): string {
    return this.dryrun.preview(cmd);
  }
}
```

`src/harness/index.ts`：`this.safety = new SafetyChain(this.security, this.sandbox, this.dryrun);` → `this.safety = new SafetyChain(this.security, this.sandbox, this.dryrun, base);`（`base` 为该文件已有的项目根变量；若变量名不同以现场为准）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test dist/harness/security/chain.test.js && npm test`
Expected: PASS（chain 7 用例 + 既有 48 全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/harness/security/guard.ts src/harness/security/chain.ts src/harness/index.ts src/harness/security/chain.test.ts src/harness/tools/tools.test.ts src/harness/tools/stability.test.ts src/harness/reactor.test.ts
git commit -m "feat(harness): 安全链 root 注入与文件工具越界校验（safePath）"
```

---

### Task 2: builtin 消费 safePath + maskResult 统一脱敏出口

**Files:**
- Modify: `src/harness/tools.ts`
- Modify: `src/harness/tools/builtin.ts`
- Modify: `src/harness/tools/stability.test.ts`（新增用例）
- Modify: `src/harness/tools/tools.test.ts`（新增用例）
- Modify: `src/harness/security/chain.test.ts`（新增 mask 单测）

**Interfaces:**
- Consumes: Task 1 的 `safePath`
- Produces: `SafetyChain.maskResult(tool: string, result: ExecResult): ExecResult`；`ToolRegistry.execute` 出口统一脱敏；文件工具 `input.path` 在 execute 内被替换为 `safePath`（executor 不再感知解析）。

- [ ] **Step 1: 写失败测试**

`src/harness/security/chain.test.ts` 追加：

```ts
test('maskResult 按模式集脱敏 stdout 与 stderr', () => {
  const r = chain(process.cwd()).maskResult('Read', {
    exitCode: 0,
    stdout: ['key sk-abc12345678901234567890', 'Authorization: Bearer abcdefgh12345678', 'aws=AKIAIOSFODNN7EXAMPLE', 'password=hunter2', '"apiKey": "xyz123"'].join('\n'),
    stderr: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    timedOut: false,
  });
  assert.ok(!r.stdout.includes('sk-abc12345678901234567890'));
  assert.ok(!r.stdout.includes('Bearer abcdefgh12345678'));
  assert.ok(!r.stdout.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!r.stdout.includes('hunter2'));
  assert.ok(!r.stdout.includes('"apiKey": "xyz123"'));
  assert.equal(r.stderr, '***');
});

test('maskResult 无命中原样返回', () => {
  const r = chain(process.cwd()).maskResult('Read', { exitCode: 0, stdout: 'plain output 123', stderr: '', timedOut: false });
  assert.equal(r.stdout, 'plain output 123');
});

test('preview 输出过 mask', () => {
  const out = chain(process.cwd()).preview('curl -H "Authorization: Bearer abcdefgh12345678" https://x');
  assert.ok(!out.includes('abcdefgh12345678'));
  assert.match(out, /\*\*\*/);
});
```

`src/harness/tools/stability.test.ts` 追加（「路径来源唯一」的行为证明）：

```ts
test('read 落点跟随安全链 root（safePath 消费自 evaluate）', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-roota-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-rootb-'));
  fs.writeFileSync(path.join(dirA, 'in-a.txt'), 'A-content');
  const safety = new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), new DryRun(), dirA);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, dirB)) registry.register(t);
  const r = await registry.execute('read', { path: 'in-a.txt' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.stdout, 'A-content');
});

test('read 越界路径经 execute 被拦截（COMMAND_DENIED）', async () => {
  const root = tmpdir();
  const { registry, safety } = registryWith(root);
  const r = await registry.execute('read', { path: '../outside.txt' }, safety);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'COMMAND_DENIED');
    assert.match(r.error.message, /越出项目 root/);
  }
});
```

`src/harness/tools/tools.test.ts` 追加：

```ts
test('read 敏感文件内容经 execute 出口已脱敏', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mask-'));
  fs.writeFileSync(path.join(root, 'secret.env'), 'DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrst1234\n');
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  const r = await registry.execute('read', { path: 'secret.env' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(!r.value.stdout.includes('sk-abcdefghijklmnopqrst1234'));
    assert.ok(r.value.stdout.includes('***'));
  }
});

test('exec 回显密钥经 execute 出口已脱敏', async () => {
  const safety = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), process.cwd());
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, process.cwd())) registry.register(t);
  const r = await registry.execute('exec', { command: 'echo token=sk-abcdefghijklmnopqrst1234' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(!r.value.stdout.includes('sk-abcdefghijklmnopqrst1234'));
    assert.ok(r.value.stdout.includes('***'));
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/harness/security/chain.test.js`
Expected: FAIL —— `TS2339: Property 'maskResult' does not exist on type 'SafetyChain'`。

- [ ] **Step 3: 实现**

`src/harness/security/chain.ts`：在 `PATH_TOOLS` 常量后追加模式集与脱敏函数：

```ts
/** 内置凭据模式集：命中替换为 ***（零依赖，代码内可扩展；spec 2.3 逐字清单） */
const MASK_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /"(api[_-]?key|secret|token|password)"\s*:\s*"[^"]+"/gi,
  /(?:api[_-]?key|secret|token|password)\s*[=:]\s*\S+/gi,
];

function maskText(text: string): string {
  let out = text;
  for (const re of MASK_PATTERNS) out = out.replace(re, '***');
  return out;
}
```

类内新增方法、并改造 `preview`：

```ts
  /** 工具结果跨链的唯一脱敏出口：stdout 与 stderr 统一过凭据模式集 */
  maskResult(_tool: string, result: ExecResult): ExecResult {
    return { ...result, stdout: maskText(result.stdout), stderr: maskText(result.stderr) };
  }

  preview(cmd: string): string {
    return maskText(this.dryrun.preview(cmd));
  }
```

`src/harness/tools.ts` 的 `execute` 方法替换为：

```ts
  async execute(name: string, input: ToolInput, safety: SafetyChain): Promise<Result<ExecResult>> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `工具未注册：${name}`);

    const canonical = CANONICAL_TOOL_NAMES[name] ?? name;
    const decision = safety.evaluate(canonical, input);
    if (!decision.allowed) return fail('COMMAND_DENIED', decision.reason ?? '命令被安全策略拦截');

    // 文件工具：evaluate 已校验并返回 safePath（绝对路径），executor 直接消费，消除二次解析双轨
    const execInput: ToolInput = decision.safePath !== undefined ? { ...input, path: decision.safePath } : input;

    try {
      const result = await tool.executor(execInput);
      return ok(safety.maskResult(canonical, result));
    } catch (e) {
      return fail('EXEC_FAILED', e instanceof Error ? e.message : '工具执行失败');
    }
  }
```

`src/harness/tools/builtin.ts`：删除顶层 `const resolve = ...` helper；`read/write/grep` 三个 executor 改为直接消费 `String(input.path)`（此时已是安全链注入的绝对路径；`write` 的 `path.dirname` 保留，`path` import 保留；`glob` 的 root walk 与 `exec` 的 `cwd: root` 不变，`root` 参数保留）。示意（以现场 `execOut`/结构为准，仅替换目标行）：

```ts
      // read
      const content = fs.readFileSync(String(input.path), 'utf8');
      // write
      const target = String(input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(input.content ?? ''));
      // grep
      const content = fs.readFileSync(String(input.path), 'utf8');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（新增 9 用例 + 既有全绿；既有用例行为不变，`root-content`/`42` 等输出不含凭据模式）。

- [ ] **Step 5: 提交**

```bash
git add src/harness/security/chain.ts src/harness/tools.ts src/harness/tools/builtin.ts src/harness/security/chain.test.ts src/harness/tools/stability.test.ts src/harness/tools/tools.test.ts
git commit -m "feat(harness): 工具消费 safePath 并建立 execute 出口统一凭据脱敏"
```

---

### Task 3: ContextWindow checksum 三态门禁 + 摘要产出（reinject 落地）

**Files:**
- Modify: `src/harness/context/window.ts`
- Modify: `src/harness/context/window.test.ts`

**Interfaces:**
- Consumes: `crypto.createHash('sha256')`
- Produces: `export type ChecksumVerdict = 'first' | 'replay' | 'new'`；`verifyChecksum(chunks): ChecksumVerdict`（首次注册 `first`；与基线一致 `replay`；不同进入新一轮 `new` 并更新基线）；`checksum(): string | null`（基线前 16 位）；`summarize(chunks): ContextItem`（kind `history`，content 带 `checksum=` 标记）；`reinject(chunks): ContextItem[]`（摘要条目，重读由 ContextManager 追加）。
- 清理：删除 `lastChunks` 字段及 `compact` 内赋值（无读取方，无残渣）；删除旧空实现 `reinject(): ContextItem[] { return []; }`。

- [ ] **Step 1: 写失败测试**

`src/harness/context/window.test.ts`：删除现有「verifyChecksum 对相同 chunks 返回 true」用例，追加：

```ts
test('verifyChecksum 三态：first 注册 / replay 重放 / new 新一轮', () => {
  const w = new ContextWindow();
  const a = [{ id: 'a', summary: 'x', type: 'history', priority: 1 }];
  const b = [{ id: 'b', summary: 'y', type: 'history', priority: 1 }];
  assert.equal(w.verifyChecksum(a), 'first');
  assert.equal(w.verifyChecksum(a), 'replay');
  assert.equal(w.verifyChecksum(b), 'new');
  assert.equal(w.verifyChecksum(b), 'replay');
  assert.equal(w.verifyChecksum(a), 'new');
});

test('checksum 返回基线前 16 位，未注册时为 null', () => {
  const w = new ContextWindow();
  assert.equal(w.checksum(), null);
  w.verifyChecksum([{ id: 'a', summary: 'x', type: 'history', priority: 1 }]);
  assert.match(w.checksum() ?? '', /^[0-9a-f]{16}$/);
});

test('summarize/reinject 产出带 checksum 标记的压缩摘要条目', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [{ kind: 'instruction', content: '## 规则一\n重要背景内容' }];
  const chunks = await w.compact(items);
  const out = w.reinject(chunks);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'history');
  assert.match(out[0].content, /^\[压缩摘要 checksum=[0-9a-f]{16}\]/);
  assert.ok(out[0].content.includes('重要背景内容'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test dist/harness/context/window.test.js`
Expected: FAIL —— `TS2322: Type 'string' is not assignable to type 'boolean'`（verifyChecksum 现返回 boolean）。

- [ ] **Step 3: 实现**

`src/harness/context/window.ts`：
1. 导出类型并改造 `verifyChecksum`（替换旧 boolean 实现）：

```ts
export type ChecksumVerdict = 'first' | 'replay' | 'new';

/** checksum 门禁（三态）：first=注册基线；replay=同一压缩事件幂等重放；new=新一轮压缩并更新基线 */
verifyChecksum(chunks: ContextChunk[]): ChecksumVerdict {
  const hash = crypto.createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
  if (this.lastChecksum === null) {
    this.lastChecksum = hash;
    return 'first';
  }
  if (this.lastChecksum === hash) return 'replay';
  this.lastChecksum = hash;
  return 'new';
}

/** 当前基线 checksum 前 16 位；未注册时为 null（供压缩事件记忆对账） */
checksum(): string | null {
  return this.lastChecksum === null ? null : this.lastChecksum.slice(0, 16);
}
```

2. 新增摘要产出（类内方法）：

```ts
/** 压缩摘要条目（纯计算）：kept chunks 摘要拼接 + checksum 标记 */
summarize(chunks: ContextChunk[]): ContextItem {
  const hash = crypto.createHash('sha256').update(JSON.stringify(chunks)).digest('hex').slice(0, 16);
  const text = chunks.map((c) => `- [${c.type}] ${c.summary}`).join('\n');
  return { kind: 'history', content: `[压缩摘要 checksum=${hash}]\n${text}` };
}

/** reinject 落地：由压缩 chunks 产出重注入条目（摘要；最近文件重读由 ContextManager 协调后追加） */
reinject(chunks: ContextChunk[]): ContextItem[] {
  return [this.summarize(chunks)];
}
```

3. 删除旧空实现 `reinject(): ContextItem[] { return []; }`（连同其注释块）；删除 `lastChunks` 字段与 `compact` 内 `this.lastChunks = ...` 赋值行。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（含既有「压缩摘要可重现/分块确定性」用例；reactor 现有测试对 verifyChecksum 返回值的忽略不受类型变化影响）。

- [ ] **Step 5: 提交**

```bash
git add src/harness/context/window.ts src/harness/context/window.test.ts
git commit -m "feat(harness): ContextWindow checksum 三态门禁与压缩摘要产出"
```

---

### Task 4: ContextManager 注入管线（applyCompaction / trackFile / assemble 注入）

**Files:**
- Modify: `src/harness/context/index.ts`
- Create: `src/harness/context/compaction.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `verifyChecksum/summarize/reinject/checksum`；`fs/path`
- Produces: `trackFile(relPath: string): void`（去重 + LRU 上限 5）；`recentFiles(): string[]`（快照副本）；`applyCompaction(chunks): Promise<void>`（replay 幂等跳过；摘要 + 重读最近 ≤5 文件、每文件前 500 行、失败跳过；`memory.record('compaction', ...)`）；`assemble` 注入块位于 goal 之后、history 之前。
- 状态：`private compacted: ContextItem[] = []`、`private recent: string[] = []`；构造器 root 改为参数属性以供重读解析（`constructor(private readonly root: string, store: StorageAdapter)`，调用点签名不变）。

- [ ] **Step 1: 写失败测试**

创建 `src/harness/context/compaction.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { ContextItem } from '../../types';
import { FileStore } from '../../storage/adapter';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-'));
  const cm = new ContextManager(root, new FileStore(root));
  return { root, cm };
}

async function compactOf(cm: ContextManager, content: string) {
  const items: ContextItem[] = [{ kind: 'history', content }];
  return cm.window.compact(items);
}

test('trackFile 去重且 LRU 上限 5', () => {
  const { cm } = setup();
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) cm.trackFile(f);
  cm.trackFile('c');
  assert.deepEqual(cm.recentFiles(), ['b', 'd', 'e', 'f', 'c']);
});

test('applyCompaction 注入摘要与重读条目，位于 goal 之后 history 之前', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'notes.md'), 'line1\nline2');
  cm.trackFile('notes.md');

  const chunks = await compactOf(cm, '很长的旧上下文 '.repeat(50));
  await cm.applyCompaction(chunks);

  const items = cm.assemble('目标G', [{ kind: 'history', content: '新步骤' }]);
  const goalIdx = items.findIndex((i) => i.content === '目标G');
  const histIdx = items.findIndex((i) => i.content === '新步骤');
  const sumIdx = items.findIndex((i) => i.content.startsWith('[压缩摘要'));
  const reIdx = items.findIndex((i) => i.content.startsWith('[重读] notes.md'));
  assert.ok(sumIdx > goalIdx && sumIdx < histIdx, '摘要应位于 goal 与 history 之间');
  assert.ok(reIdx > goalIdx && reIdx < histIdx, '重读应位于 goal 与 history 之间');
  assert.ok(items[reIdx].content.includes('line1'));
  assert.match(items[sumIdx].content, /^\[压缩摘要 checksum=[0-9a-f]{16}\]/);
  assert.ok(cm.memory.index().some((l) => l.startsWith('compaction: 摘要 checksum=')));
});

test('重复 applyCompaction 相同 chunks 幂等：不重复注入、不重复记录', async () => {
  const { cm } = setup();
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  await cm.applyCompaction(chunks);
  assert.equal(cm.assemble('g').filter((i) => i.content.startsWith('[压缩摘要')).length, 1);
  assert.equal(cm.memory.index().filter((l) => l.startsWith('compaction:')).length, 1);
});

test('重读失败（文件缺失）跳过该文件，注入不受影响', async () => {
  const { cm } = setup();
  cm.trackFile('ghost.md');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await assert.doesNotReject(() => cm.applyCompaction(chunks));
  const items = cm.assemble('g');
  assert.ok(!items.some((i) => i.content.startsWith('[重读] ghost.md')));
  assert.ok(items.some((i) => i.content.startsWith('[压缩摘要')));
  assert.ok(cm.memory.index().some((l) => l.includes('重读 0 个文件')));
});

test('重读截断为每文件前 500 行', async () => {
  const { root, cm } = setup();
  const lines = Array.from({ length: 600 }, (_, i) => `line${i}`);
  fs.writeFileSync(path.join(root, 'big.md'), lines.join('\n'));
  cm.trackFile('big.md');
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks);
  const reread = cm.assemble('g').find((i) => i.content.startsWith('[重读] big.md'));
  assert.ok(reread);
  assert.ok(reread.content.includes('line499'));
  assert.ok(!reread.content.includes('line500'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build`
Expected: FAIL —— `TS2339: Property 'trackFile' does not exist on type 'ContextManager'`。

- [ ] **Step 3: 实现**

`src/harness/context/index.ts`：
1. 顶部 import 区新增：

```ts
import * as fs from 'fs';
import * as path from 'path';
import { ContextChunk } from './window';
```

2. 常量与状态（类外常量、类内私有字段）：

```ts
const RECENT_LIMIT = 5;
const REREAD_MAX_LINES = 500;
```

```ts
  private compacted: ContextItem[] = [];
  private recent: string[] = [];
```

3. 构造器签名改为 `constructor(private readonly root: string, store: StorageAdapter)`（body 内 `ContextLoader(root)` 等引用不变）。

4. 类内新增方法（置于 `assemble` 之前）：

```ts
  /** 最近读取文件登记：去重 + LRU 上限 5（供压缩后重读） */
  trackFile(relPath: string): void {
    const p = String(relPath ?? '').trim();
    if (!p) return;
    this.recent = this.recent.filter((f) => f !== p);
    this.recent.push(p);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
  }

  /** 最近读取文件快照（按登记顺序，最旧在前） */
  recentFiles(): string[] {
    return [...this.recent];
  }

  /** 压缩重注入：checksum 门禁 → 摘要 + 重读最近文件 → 注入块（生效于后续轮次 assemble） */
  async applyCompaction(chunks: ContextChunk[]): Promise<void> {
    if (this.window.verifyChecksum(chunks) === 'replay') return; // 同一压缩事件幂等重放
    const items: ContextItem[] = [...this.window.reinject(chunks)];
    for (const rel of this.recent) {
      try {
        const abs = path.resolve(this.root, rel);
        const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(0, REREAD_MAX_LINES);
        items.push({ kind: 'memory', content: `[重读] ${rel}:\n${lines.join('\n')}` });
      } catch {
        // 文件已删除或不可读：跳过该文件
      }
    }
    this.compacted = items;
    this.memory.record('compaction', `摘要 checksum=${this.window.checksum() ?? 'unknown'}，重读 ${items.length - 1} 个文件`);
  }
```

5. `assemble` 在 `items.push({ kind: 'instruction', content: goal });` 之后、`items.push(...history);` 之前插入：

```ts
  items.push(...this.compacted);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（新增 5 用例 + 既有全绿；`compacted` 缺省为空数组，既有 assemble 断言不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/harness/context/index.ts src/harness/context/compaction.test.ts
git commit -m "feat(harness): ContextManager 压缩重注入与最近文件重读"
```

---

### Task 5: Reactor 压缩闭环接线（budget 参数化 + 水位线 + trackFile 上报）

**Files:**
- Modify: `src/harness/reactor.ts`
- Modify: `src/harness/reactor.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `applyCompaction/trackFile`
- Produces: `run(task, opts?: { maxSteps?: number; budget?: { total: number; reserve: number } })`（缺省预算不变 `{ total: 200_000, reserve: 40_000 }`）；压缩分支改调 `context.applyCompaction` 并推进水位线；`toHistory(steps, fromStep)` 仅保留 `s.step > fromStep`；act 成功且 `action.tool` 为 `read`/`grep`（注册名小写）且 `input.path` 非空 → `context.trackFile(path)`。
- 不变式：Reactor 不再直接调用 `window.verifyChecksum`（checksum 门禁收敛在 applyCompaction 内）。

- [ ] **Step 1: 写失败测试**

`src/harness/reactor.test.ts` 追加（`makeReactor` 已在 Task 1 携带 root=tmp，可直接用）：

```ts
test('Read 成功后 trackFile 登记路径（recentFiles 含该文件）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor6-'));
  fs.writeFileSync(path.join(tmp, 'note.txt'), '笔记内容');
  const context = new ContextManager(tmp, new FileStore(tmp));
  const adapter = new ScriptedAdapter(['{"tool":"read","input":{"path":"note.txt"},"done":false}', '{"done":true}']);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const reactor = new Reactor({ registry, safety, context, model: adapter });

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  assert.deepEqual(context.recentFiles(), ['note.txt']);
});

test('压缩闭环：摘要回流、重读最近文件、水位线截断旧 history', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor7-'));
  fs.writeFileSync(path.join(tmp, 'big.txt'), 'X'.repeat(3000));

  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"big.txt"},"done":false}',
    '{"tool":"exec","input":{"command":"echo step2"},"done":false}',
    '{"done":true,"reply":"ok"}',
  ];
  let call = 0;
  const adapter = { provider: 'capture', complete: async (p: string) => { prompts.push(p); return replies[Math.min(call++, replies.length - 1)]; } };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model: adapter });

  const r = await reactor.run({ goal: 'x' }, { maxSteps: 3, budget: { total: 300, reserve: 40 } });
  assert.equal(r.done, true);
  assert.ok(prompts.length >= 3, `应有 3 轮 prompt，实际 ${prompts.length}`);
  assert.ok(!prompts[0].includes('[压缩摘要'), '第 1 轮不应有摘要（无历史可压缩）');
  assert.ok(!prompts[1].includes('[压缩摘要'), '第 2 轮 prompt 在本轮压缩前组装，摘要注入发生在后续轮');
  assert.ok(prompts[2].includes('[压缩摘要'), '第 3 轮应注入压缩摘要');
  assert.ok(prompts[2].includes('[重读] big.txt'), '第 3 轮应注入最近文件重读');
  assert.ok(!prompts[2].includes('1: read -> '), '水位线应滤掉压缩点前的 history');
  assert.ok(prompts[2].includes('2: exec -> step2'), '水位线后的 history 保留');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— 第 1 用例 `recentFiles` 不存在（TS2339）；第 2 用例 `prompts[2]` 不含 `[压缩摘要`（当前压缩分支丢弃产物）。

- [ ] **Step 3: 实现**

`src/harness/reactor.ts`：
1. `run` 签名与预算：

```ts
  async run(task: Task, opts?: { maxSteps?: number; budget?: { total: number; reserve: number } }): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? 8;
    const budget = opts?.budget ?? { total: 200_000, reserve: 40_000 };
```

2. `run` 内、循环前新增水位线变量：

```ts
    let compactedUpTo = 0; // 压缩水位线：此前 steps 已由摘要代表，不再进入 history
```

3. observe 段（装配 + 压缩分支）替换为：

```ts
    // observe: 上下文统一装配（仅取水位线后的 steps；压缩注入块由 ContextManager 并入）
    const items = this.deps.context.assemble(task.goal, this.toHistory(steps, compactedUpTo));
    const est = this.deps.context.window.estimate(items);
    if (this.deps.context.window.shouldCompact({ total: budget.total, used: est.used, reserve: budget.reserve })) {
      const chunks = await this.deps.context.window.compact(items);
      await this.deps.context.applyCompaction(chunks); // checksum 门禁 + 摘要/重读注入（幂等重放内部跳过）
      compactedUpTo = steps.length;
    }
```

4. act 段 `steps.push({ step, action: action.tool, observation });` 之后、`memory.record` 之前插入：

```ts
      if (r.ok && (action.tool === 'read' || action.tool === 'grep')) {
        const p = (action.input ?? {}).path;
        if (typeof p === 'string' && p.length > 0) this.deps.context.trackFile(p);
      }
```

5. `toHistory` 替换为（保留原格式 `${s.step}: ${s.action ?? ''} -> ${s.observation}`）：

```ts
  private toHistory(steps: StepRecord[], fromStep: number): ContextItem[] {
    return steps
      .filter((s) => s.step > fromStep)
      .map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` }));
  }
```

6. 删除 observe 段原 `this.deps.context.window.verifyChecksum(chunks);` 行（门禁已收敛进 applyCompaction）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test && npm run selfcheck`
Expected: PASS（新增 2 用例 + 既有全绿；selfcheck 正常打印骨架摘要）。

- [ ] **Step 5: 提交**

```bash
git add src/harness/reactor.ts src/harness/reactor.test.ts
git commit -m "feat(harness): Reactor 压缩闭环接线（水位线 + 文件登记）"
```

---

## 验收标准映射（spec 第 6 节）

| 编号 | 由哪些任务/测试证明 |
|---|---|
| B1 摘要回流 | T5「压缩闭环」——`prompts[2]` 含 `[压缩摘要`、不含 `1: read -> ` |
| B2 最近文件重读 | T5「压缩闭环」（`[重读] big.txt`）+ T4「重读条目/500 行截断」 |
| B3 跨链必脱敏 | T2 mask 单测 + `read secret.env` / `exec echo token=sk-…` 集成用例 |
| B4 越界拒绝 | T1 chain 用例 + T2 `read ../outside.txt` → `COMMAND_DENIED` |
| B5 幂等重放 | T4「重复 applyCompaction 幂等」 |

## Self-Review（计划自检）

1. **Spec 覆盖**：2.1/2.2→T1；2.3→T2；3.1→T3；3.2→T3/T5；3.3→T4/T5；3.4 数据流→T5；4 改动面 7 文件全部覆盖（`types.ts` 无需改动——safePath 经 `execute` 注入 `input.path`，未扩展 ToolExecutor 签名）；5 测试计划→各任务；6 验收 B1–B5 全部有对应用例。
2. **占位扫描**：无 TBD/TODO；builtin.ts 的 read/write/grep 改造以「目标行替换」表达（现场 `execOut` 结构已确认），非占位。
3. **类型一致性**：`safePath?: string`（guard）→ `evaluate` 产出 → `execute` 注入 `input.path`（string）→ builtin `String(input.path)` 消费；`ChecksumVerdict` 三态 → `applyCompaction` 仅对非 replay 注入；`checksum(): string|null` → memory 记录模板 `?? 'unknown'` 兜底；`toHistory(steps, fromStep)` 唯一签名。
4. **行为等价风险**：T2 删除 builtin 自 resolve 属行为等价重构（T1 已让 evaluate 产出 safePath；「read 落点跟随安全链 root」用例证明路径来源唯一）。
