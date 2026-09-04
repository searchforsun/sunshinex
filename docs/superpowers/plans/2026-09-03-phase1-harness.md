# Phase 1 Harness 底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地生产级 Harness 底座，实现项目感知、统一工具、安全与权限、上下文与记忆管理、最小 Reactor 五大能力的最小可运行闭环。

**Architecture:** Harness 门面（`harness/index.ts`）聚合五大能力，上层只依赖门面。工具执行统一走 `SecurityGuard.preToolUse → Sandbox → DryRun` 安全链；Reactor 以 `observe → think → act → observe` 线性循环驱动底座；存储/沙箱/模型均走 adapter 接口，零新增 npm 依赖。

**Tech Stack:** TypeScript（strict）+ Node.js（CommonJS），Node 内置模块（fs/path/child_process/node:test/fetch），零新增 npm 依赖。

## Global Constraints

- TypeScript strict 模式，禁止无理由 any。
- 零新增 npm 依赖：仅用 Node 内置模块（fs / path / child_process / node:test / fetch）。
- 所有 IO 集中在 adapter/store 内；模型调用经 Node 内置 fetch 直连 OpenAI 兼容 API（需外网，无外网时降级）。
- 测试用 `node --test`，编译用 `tsc -p tsconfig.json`。
- 每个任务结束必须 `npm run build`（tsc 严格模式零报错）通过。
- 提交信息用 Conventional Commits 风格（feat/test/refactor/docs）。

---

### Task 1: 扩展全局类型与 Result 结果类型

**Files:**
- Create: `src/result.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: 无（本任务为类型基座）
- Produces:
  - `src/result.ts` 导出 `type Result<T>`、`function ok<T>(value: T): Result<T>`、`function fail<T>(code: string, message: string): Result<T>`
  - `src/types.ts` 新增 `ToolSpec` 扩展（带 `category`、`executor`）、`ExecResult`、`ToolInput`、`ContextItem`、`PermissionDecision` 等类型（后续任务按需引用）

- [ ] **Step 1: 写失败测试**

创建 `src/result.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail } from './result';

test('ok() 返回 ok 结果并携带 value', () => {
  const r = ok(42);
  assert.equal(r.ok, true);
  assert.equal(r.value, 42);
});

test('fail() 返回 error 结果并携带 code/message', () => {
  const r = fail<number>('IO_ERROR', '磁盘写入失败');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, 'IO_ERROR');
    assert.equal(r.error.message, '磁盘写入失败');
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/result.test.ts`
Expected: FAIL —— 找不到模块 `./result`

- [ ] **Step 3: 写最小实现**

创建 `src/result.ts`：

```ts
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/result.test.ts`
Expected: PASS

- [ ] **Step 5: 扩展 types.ts 并提交**

在 `src/types.ts` 末尾追加（不改动已有导出，避免破坏现有 index.ts）：

```ts
/** 工具类别：read/write/bash/network */
export type ToolCategory = 'read' | 'write' | 'bash' | 'network';

/** 工具输入 */
export interface ToolInput {
  [key: string]: unknown;
}

/** 沙箱执行结果 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 权限决策 */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** 上下文条目 */
export interface ContextItem {
  kind: 'system' | 'instruction' | 'memory' | 'history' | 'tool' | 'result';
  content: string;
  meta?: Record<string, unknown>;
}

/** 工具执行器签名（经安全链执行） */
export type ToolExecutor = (input: ToolInput) => Promise<ExecResult>;
```

```bash
npm run build && node --test src/result.test.ts
git add src/result.ts src/result.test.ts src/types.ts
git commit -m "feat: 新增 Result 结果类型与全局类型扩展"
```

---

### Task 2: StorageAdapter 接口 + FileStore 实现

**Files:**
- Create: `src/storage/adapter.ts`
- Create: `src/storage/adapter.test.ts`
- Modify: `src/storage/store.ts`（改造 LocalStore 实现 StorageAdapter）

**Interfaces:**
- Consumes: `src/result.ts` 的 `Result`、`ok`、`fail`
- Produces:
  - `interface StorageAdapter { read<T>(key: string, fallback: T): T; write<T>(key: string, value: T): void; }`
  - `class FileStore implements StorageAdapter { constructor(baseDir: string); read<T>(...): T; write<T>(...): void; }`

- [ ] **Step 1: 写失败测试**

创建 `src/storage/adapter.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStore } from './adapter';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-store-'));
}

test('FileStore 写入后可读取', () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  store.write('k', { a: 1 });
  assert.deepEqual(store.read('k', null), { a: 1 });
});

test('FileStore 未写入时返回 fallback', () => {
  const dir = tmpdir();
  const store = new FileStore(dir);
  assert.equal(store.read('missing', 'fb'), 'fb');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/storage/adapter.test.ts`
Expected: FAIL —— 找不到模块 `./adapter`

- [ ] **Step 3: 写最小实现**

创建 `src/storage/adapter.ts`：

```ts
import * as fs from 'fs';
import * as path from 'path';

export interface StorageAdapter {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
}

/** 文件 JSON 存储（零依赖默认实现） */
export class FileStore implements StorageAdapter {
  constructor(private baseDir: string) {}

  private ensure(): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  read<T>(key: string, fallback: T): T {
    const p = path.join(this.baseDir, `${key}.json`);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  }

  write<T>(key: string, value: T): void {
    this.ensure();
    fs.writeFileSync(path.join(this.baseDir, `${key}.json`), JSON.stringify(value, null, 2));
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/storage/adapter.test.ts`
Expected: PASS

- [ ] **Step 5: 改造 store.ts 并提交**

将 `src/storage/store.ts` 的 `LocalStore` 改为 re-export `FileStore`（保持向后兼容别名）：

```ts
import * as fs from 'fs';
import * as path from 'path';
import { StorageAdapter } from './adapter';

/** @deprecated 使用 FileStore，保留别名兼容旧引用 */
export class LocalStore implements StorageAdapter {
  private delegate: StorageAdapter;
  constructor(baseDir: string) {
    this.delegate = new (require('./adapter').FileStore)(baseDir);
  }
  read<T>(key: string, fallback: T): T { return this.delegate.read(key, fallback); }
  write<T>(key: string, value: T): void { this.delegate.write(key, value); }
}
```

> 注意：`require` 避免 import 语法改动过大；若 tsc 对 `require` 报类型缺失，改用 `import { FileStore } from './adapter';` 并将 `delegate` 字段声明为 `StorageAdapter`。

```bash
npm run build && node --test src/storage/adapter.test.ts
git add src/storage/adapter.ts src/storage/adapter.test.ts src/storage/store.ts
git commit -m "feat: 新增 StorageAdapter 接口与 FileStore 实现"
```

---

### Task 3: 项目感知引擎 perception.ts

**Files:**
- Create: `src/harness/perception.ts`
- Create: `src/harness/perception.test.ts`

**Interfaces:**
- Consumes: `src/result.ts` 的 `Result`、`ok`、`fail`；`src/config.ts` 的 `loadSunshinex`；`src/types.ts` 的 `ProjectContext`
- Produces:
  - `interface Perceived { files: string[]; dependencies: string[]; project: ProjectContext | null; gitBranch: string | null; }`
  - `class PerceptionEngine { constructor(root: string); scan(): Perceived; }`

- [ ] **Step 1: 写失败测试**

创建 `src/harness/perception.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PerceptionEngine } from './perception';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-perc-'));
}

test('scan 收集目录下文件', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.ts'), '');
  fs.writeFileSync(path.join(dir, 'b.json'), '');
  const p = new PerceptionEngine(dir).scan();
  assert.ok(p.files.includes('a.ts'));
  assert.ok(p.files.includes('b.json'));
});

test('无 package.json 时 dependencies 为空数组（降级）', () => {
  const dir = tmpdir();
  const p = new PerceptionEngine(dir).scan();
  assert.deepEqual(p.dependencies, []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/harness/perception.test.ts`
Expected: FAIL —— 找不到模块 `./perception`

- [ ] **Step 3: 写最小实现**

创建 `src/harness/perception.ts`：

```ts
import * as fs from 'fs';
import * as path from 'path';
import { loadSunshinex } from '../config';
import { ProjectContext } from '../types';

export interface Perceived {
  files: string[];
  dependencies: string[];
  project: ProjectContext | null;
  gitBranch: string | null;
}

/** 项目感知引擎：目录扫描 + 依赖解析 + SUNSHINE.md + Git 分支（降级不抛） */
export class PerceptionEngine {
  constructor(private root: string) {}

  scan(): Perceived {
    return {
      files: this.scanFiles(),
      dependencies: this.readDeps(),
      project: loadSunshinex(this.root),
      gitBranch: this.readGitBranch(),
    };
  }

  private scanFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(path.relative(this.root, full));
      }
    };
    walk(this.root);
    return out;
  }

  private readDeps(): string[] {
    try {
      const p = path.join(this.root, 'package.json');
      if (!fs.existsSync(p)) return [];
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) });
    } catch {
      return []; // 依赖解析失败降级为「依赖未知」
    }
  }

  private readGitBranch(): string | null {
    try {
      const head = fs.readFileSync(path.join(this.root, '.git', 'HEAD'), 'utf8').trim();
      const m = /refs\/heads\/(.+)$/.exec(head);
      return m ? m[1] : head;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/harness/perception.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npm run build && node --test src/harness/perception.test.ts
git add src/harness/perception.ts src/harness/perception.test.ts
git commit -m "feat: 项目感知引擎（目录扫描/依赖/SUNSHINE.md/Git）"
```

---

### Task 4: 权限规则引擎 security/rules.ts + policy.ts

**Files:**
- Create: `src/harness/security/rules.ts`
- Create: `src/harness/security/policy.ts`
- Create: `src/harness/security/policy.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `PermissionDecision`
- Produces:
  - `src/harness/security/rules.ts`：`function globMatch(pattern: string, s: string): boolean`、`function parseRule(rule: string): { tool: string; specifier: string | null }`
  - `src/harness/security/policy.ts`：`class PolicyEngine { add(decision: PermissionDecision, rule: string): void; decide(tool: string, specifier: string): PermissionDecision; }`

- [ ] **Step 1: 写失败测试**

创建 `src/harness/security/policy.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from './policy';

test('求值顺序 deny 优先于 allow', () => {
  const p = new PolicyEngine();
  p.add('allow', 'Bash(*)');
  p.add('deny', 'Bash(rm *)');
  assert.equal(p.decide('Bash', 'rm -rf /'), 'deny');
});

test('无匹配规则时返回 ask', () => {
  const p = new PolicyEngine();
  assert.equal(p.decide('Bash', 'ls -la'), 'ask');
});

test('通配符匹配子命令', () => {
  const p = new PolicyEngine();
  p.add('allow', 'Bash(git *)');
  assert.equal(p.decide('Bash', 'git status'), 'allow');
  assert.equal(p.decide('Bash', 'rm x'), 'ask');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/harness/security/policy.test.ts`
Expected: FAIL —— 找不到模块 `./policy`

- [ ] **Step 3: 写最小实现**

创建 `src/harness/security/rules.ts`：

```ts
/** glob 转正则（支持 * 与 ?） */
export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(
    '^' + pattern.split('*').map(escapeRegExp).join('.*').split('?').join('.') + '$'
  );
  return re.test(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 解析 "Tool(specifier)" 规则 */
export function parseRule(rule: string): { tool: string; specifier: string | null } {
  const m = /^(\w+)\((.*)\)$/.exec(rule.trim());
  if (m) return { tool: m[1], specifier: m[2] || null };
  return { tool: rule.trim(), specifier: null };
}
```

创建 `src/harness/security/policy.ts`：

```ts
import { PermissionDecision } from '../../types';
import { globMatch, parseRule } from './rules';

interface RuleEntry {
  decision: PermissionDecision;
  tool: string;
  specifier: string | null;
}

/** 三态权限规则引擎：deny → ask → allow 求值顺序，首个匹配生效 */
export class PolicyEngine {
  private deny: RuleEntry[] = [];
  private ask: RuleEntry[] = [];
  private allow: RuleEntry[] = [];

  add(decision: PermissionDecision, rule: string): void {
    const { tool, specifier } = parseRule(rule);
    const entry = { decision, tool, specifier };
    if (decision === 'deny') this.deny.push(entry);
    else if (decision === 'ask') this.ask.push(entry);
    else this.allow.push(entry);
  }

  decide(tool: string, specifier: string): PermissionDecision {
    for (const e of this.deny) if (this.matches(e, tool, specifier)) return 'deny';
    for (const e of this.ask) if (this.matches(e, tool, specifier)) return 'ask';
    for (const e of this.allow) if (this.matches(e, tool, specifier)) return 'allow';
    return 'ask';
  }

  private matches(e: RuleEntry, tool: string, specifier: string): boolean {
    if (e.tool !== tool && e.tool !== '*') return false;
    if (e.specifier === null || e.specifier === '*') return true;
    return globMatch(e.specifier, specifier);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/harness/security/policy.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npm run build && node --test src/harness/security/policy.test.ts
git add src/harness/security/rules.ts src/harness/security/policy.ts src/harness/security/policy.test.ts
git commit -m "feat: 三态权限规则引擎（deny→ask→allow）"
```

---

### Task 5: 权限模式 modes.ts + 只读白名单 + SecurityGuard

**Files:**
- Create: `src/harness/security/modes.ts`
- Create: `src/harness/security/guard.ts`
- Create: `src/harness/security/guard.test.ts`

**Interfaces:**
- Consumes: `src/harness/security/policy.ts` 的 `PolicyEngine`；`src/types.ts` 的 `PermissionDecision`
- Produces:
  - `src/harness/security/modes.ts`：`type PermissionMode = 'manual' | 'plan' | 'dontAsk'`、`const READONLY_WHITELIST: string[]`
  - `src/harness/security/guard.ts`：`class SecurityGuard { constructor(policy?: PolicyEngine, mode?: PermissionMode); preToolUse(tool: string, input: unknown): { allowed: boolean; reason?: string }; }`

- [ ] **Step 1: 写失败测试**

创建 `src/harness/security/guard.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';

test('dangerous rm 被拦截并附原因', () => {
  const p = new PolicyEngine();
  p.add('deny', 'Bash(rm *)');
  const g = new SecurityGuard(p, 'manual');
  const r = g.preToolUse('Bash', { command: 'rm -rf /' });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.ok(r.reason.includes('deny'));
});

test('只读白名单命令默认放行', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const r = g.preToolUse('Bash', { command: 'ls -la' });
  assert.equal(r.allowed, true);
});

test('plan 模式下写工具被拒', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'plan');
  const r = g.preToolUse('Write', { path: 'x', content: 'y' });
  assert.equal(r.allowed, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/harness/security/guard.test.ts`
Expected: FAIL —— 找不到模块 `./guard`

- [ ] **Step 3: 写最小实现**

创建 `src/harness/security/modes.ts`：

```ts
export type PermissionMode = 'manual' | 'plan' | 'dontAsk';

/** 只读命令内置集（默认 allow） */
export const READONLY_WHITELIST = [
  'ls', 'cat', 'pwd', 'grep', 'find', 'head', 'tail', 'wc', 'which', 'diff', 'stat', 'du', 'cd',
];
```

创建 `src/harness/security/guard.ts`：

```ts
import { PolicyEngine } from './policy';
import { READONLY_WHITELIST, PermissionMode } from './modes';

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
}

/** PreToolUse 决策点（enforcement 层） */
export class SecurityGuard {
  constructor(
    private policy: PolicyEngine = new PolicyEngine(),
    private mode: PermissionMode = 'manual',
  ) {}

  preToolUse(tool: string, input: unknown): GuardDecision {
    const specifier = this.extractSpecifier(tool, input);
    const decision = this.policy.decide(tool, specifier);

    if (decision === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: deny 规则匹配' };
    if (decision === 'allow') return { allowed: true };

    // decision === 'ask'
    if (this.mode === 'dontAsk') return { allowed: false, reason: 'COMMAND_DENIED: dontAsk 模式拒绝未批准操作' };
    if (this.mode === 'plan') {
      if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') {
        return { allowed: false, reason: 'COMMAND_DENIED: plan 模式仅允许只读操作' };
      }
      return { allowed: true };
    }
    // manual 模式：只读白名单放行，其余 ask（阶段一 CLI 未实现交互，ask 视为放行只读、拒绝写）
    if (tool === 'Bash' && this.isReadonlyCommand(specifier)) return { allowed: true };
    if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return { allowed: true };
    return { allowed: false, reason: 'COMMAND_DENIED: manual 模式需交互确认（阶段一未实现）' };
  }

  private extractSpecifier(tool: string, input: unknown): string {
    if (tool === 'Bash' && typeof input === 'object' && input !== null) {
      const cmd = (input as { command?: unknown }).command;
      return typeof cmd === 'string' ? cmd : '';
    }
    if (typeof input === 'string') return input;
    return '';
  }

  private isReadonlyCommand(specifier: string): boolean {
    const first = specifier.trim().split(/\s+/)[0] ?? '';
    const base = first.split('/').pop() ?? first;
    return READONLY_WHITELIST.includes(base);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/harness/security/guard.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npm run build && node --test src/harness/security/guard.test.ts
git add src/harness/security/modes.ts src/harness/security/guard.ts src/harness/security/guard.test.ts
git commit -m "feat: 权限模式与 SecurityGuard 决策点"
```

---

### Task 6: 沙箱 sandbox.ts + dryrun.ts

**Files:**
- Create: `src/harness/security/sandbox.ts`
- Create: `src/harness/security/dryrun.ts`
- Create: `src/harness/security/sandbox.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `ExecResult`；`src/result.ts` 的 `Result`、`ok`、`fail`
- Produces:
  - `interface Sandbox { run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>>; }`（spec 3.2 简写为 `Promise<ExecResult>`，此处按 spec 第 4 章统一 `Result`，超时/非零退出由 `EXEC_TIMEOUT`/`EXEC_FAILED` 承载）
  - `class ProcessSandbox implements Sandbox`
  - `class DryRun { preview(cmd: string): string; }`

- [ ] **Step 1: 写失败测试**

创建 `src/harness/security/sandbox.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';

test('ProcessSandbox 执行 echo 返回输出', async () => {
  const s = new ProcessSandbox();
  const r = await s.run('echo hello');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hello/);
});

test('ProcessSandbox 执行不存在命令返回失败', async () => {
  const s = new ProcessSandbox();
  const r = await s.run('nonexistent_cmd_xyz');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'EXEC_FAILED');
});

test('DryRun 预览返回原命令', () => {
  const d = new DryRun();
  assert.equal(d.preview('rm -rf /'), 'rm -rf /');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/harness/security/sandbox.test.ts`
Expected: FAIL —— 找不到模块 `./sandbox`

- [ ] **Step 3: 写最小实现**

创建 `src/harness/security/sandbox.ts`：

```ts
import { execFile } from 'child_process';
import { ExecResult } from '../../types';
import { Result, ok, fail } from '../../result';

export interface Sandbox {
  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>>;
}

/** process 子进程隔离沙箱（零依赖近似 OS 级强制，Docker 预留） */
export class ProcessSandbox implements Sandbox {
  async run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    return new Promise((resolve) => {
      execFile('/bin/sh', ['-c', cmd], { cwd: opts?.cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed) {
            resolve(fail('EXEC_TIMEOUT', `命令超时：${cmd}`));
          } else {
            resolve(fail('EXEC_FAILED', stderr || err.message || '命令执行失败'));
          }
          return;
        }
        resolve(ok({ exitCode: 0, stdout, stderr, timedOut: false }));
      });
    });
  }
}
```

创建 `src/harness/security/dryrun.ts`：

```ts
/** dry-run 预览 */
export class DryRun {
  preview(cmd: string): string {
    return cmd;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/harness/security/sandbox.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npm run build && node --test src/harness/security/sandbox.test.ts
git add src/harness/security/sandbox.ts src/harness/security/dryrun.ts src/harness/security/sandbox.test.ts
git commit -m "feat: ProcessSandbox 沙箱与 DryRun 预览"
```

---

### Task 7: 统一工具框架（扩展 ToolRegistry + 内置工具集）

**Files:**
- Modify: `src/harness/tools.ts`（扩展为带执行器 + 安全链）
- Create: `src/harness/tools/builtin.ts`
- Create: `src/harness/tools/tools.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `ToolSpec`、`ToolCategory`、`ToolInput`、`ToolExecutor`；`src/harness/security/guard.ts` 的 `SecurityGuard`；`src/harness/security/sandbox.ts` 的 `Sandbox`
- Produces:
  - `src/harness/tools.ts`：`interface RegisteredTool extends ToolSpec { category: ToolCategory; executor: ToolExecutor; }`、`class ToolRegistry { register(...); get(name): RegisteredTool | undefined; execute(name, input, guard, sandbox): Promise<Result<ExecResult>>; list(): RegisteredTool[]; }`
  - `src/harness/tools/builtin.ts`：`function builtinTools(sandbox: Sandbox): RegisteredTool[]`

- [ ] **Step 1: 写失败测试**

创建 `src/harness/tools/tools.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { builtinTools } from './builtin';

test('execute 经安全链：dangerous 命令被拦截', async () => {
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard();
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox)) registry.register(t);

  const r = await registry.execute('exec', { command: 'rm -rf /' }, guard, sandbox);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
});

test('execute 经安全链：只读命令放行', async () => {
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard();
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox)) registry.register(t);

  const r = await registry.execute('exec', { command: 'echo ok' }, guard, sandbox);
  assert.equal(r.ok, true);
});

test('未注册工具返回 TOOL_NOT_FOUND', async () => {
  const registry = new ToolRegistry();
  const r = await registry.execute('nope', {}, new SecurityGuard(), new ProcessSandbox());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'TOOL_NOT_FOUND');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/harness/tools/tools.test.ts`
Expected: FAIL —— 现有 tools.ts 无 execute 方法

- [ ] **Step 3: 写最小实现**

修改 `src/harness/tools.ts`：

```ts
import { ToolSpec, ToolCategory, ToolInput, ToolExecutor, ExecResult } from '../types';
import { Result, ok, fail } from '../result';
import { SecurityGuard } from './security/guard';
import { Sandbox } from './security/sandbox';

export interface RegisteredTool extends ToolSpec {
  category: ToolCategory;
  executor: ToolExecutor;
}

/** 统一执行面：工具注册表（工具只声明，不直接执行） */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(spec: RegisteredTool): void {
    this.tools.set(spec.name, spec);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, input: ToolInput, guard: SecurityGuard, sandbox: Sandbox): Promise<Result<ExecResult>> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `工具未注册：${name}`);

    const decision = guard.preToolUse(name, input);
    if (!decision.allowed) return fail('COMMAND_DENIED', decision.reason ?? '命令被安全策略拦截');

    try {
      return ok(await tool.executor(input));
    } catch (e) {
      return fail('EXEC_FAILED', e instanceof Error ? e.message : '工具执行失败');
    }
  }
}
```

创建 `src/harness/tools/builtin.ts`：

```ts
import * as fs from 'fs';
import { RegisteredTool } from '../tools';
import { Sandbox } from '../security/sandbox';
import { ExecResult, ToolInput } from '../../types';

/** 内置工具集：read/write/grep/glob/exec */
export function builtinTools(sandbox: Sandbox): RegisteredTool[] {
  const execOut = (stdout: string, stderr = ''): ExecResult => ({ exitCode: 0, stdout, stderr, timedOut: false });

  return [
    {
      name: 'exec',
      description: '在沙箱内执行 shell 命令',
      category: 'bash',
      executor: async (input: ToolInput) => {
        const cmd = String(input.command ?? '');
        const r = await sandbox.run(cmd);
        if (r.ok) return r.value;
        throw new Error(`${r.error.code}: ${r.error.message}`);
      },
    },
    {
      name: 'read',
      description: '读取文件内容',
      category: 'read',
      executor: async (input: ToolInput) => execOut(fs.readFileSync(String(input.path), 'utf8')),
    },
    {
      name: 'write',
      description: '写入文件内容',
      category: 'write',
      executor: async (input: ToolInput) => {
        fs.writeFileSync(String(input.path), String(input.content ?? ''));
        return execOut('written');
      },
    },
    {
      name: 'grep',
      description: '在文件中搜索正则',
      category: 'read',
      executor: async (input: ToolInput) => {
        const { pattern, path } = input as { pattern: string; path: string };
        const content = fs.readFileSync(path, 'utf8');
        const lines = content.split('\n').filter((l) => new RegExp(pattern).test(l));
        return execOut(lines.join('\n'));
      },
    },
    {
      name: 'glob',
      description: '按 glob 模式列出文件',
      category: 'read',
      executor: async (input: ToolInput) => {
        const pattern = String(input.pattern ?? '*');
        const matches = findFiles(pattern);
        return execOut(matches.join('\n'));
      },
    },
  ];
}

function findFiles(pattern: string): string[] {
  const dir = pattern.startsWith('/') ? '/' : '.';
  const re = new RegExp('^' + pattern.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = `${d}/${e.name}`.replace(/^\.\//, '');
      if (e.isDirectory()) walk(full);
      else if (re.test(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/harness/tools/tools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npm run build && node --test src/harness/tools/tools.test.ts
git add src/harness/tools.ts src/harness/tools/builtin.ts src/harness/tools/tools.test.ts
git commit -m "feat: 统一工具框架与内置工具集"
```

---

### Task 8: 上下文与记忆管理（context/ 模块组）

**Files:**
- Create: `src/harness/context/loader.ts`
- Create: `src/harness/context/rules.ts`
- Create: `src/harness/context/auto-memory.ts`
- Create: `src/harness/context/window.ts`
- Create: `src/harness/context/session.ts`
- Create: `src/harness/context/index.ts`
- Create: `src/harness/context/window.test.ts`

**Interfaces:**
- Consumes: `src/config.ts` 的 `loadSunshinex`、`parseSunshinex`；`src/storage/adapter.ts` 的 `StorageAdapter`；`src/types.ts` 的 `ContextItem`
- Produces:
  - `loader.ts`：`class ContextLoader { constructor(root: string); load(): ContextItem[]; }`（SUNSHINE.md 多 scope + `@path` import 展开）
  - `auto-memory.ts`：`class AutoMemory { constructor(store: StorageAdapter); index(): string[]; record(type: string, text: string): void; }`
  - `window.ts`：`interface ContextBudget { total: number; used: number; reserve: number; }`、`interface ContextItemEstimate { id: string; weight: number; }`、`interface ContextChunk { id: string; summary: string; type: string; priority: number; }`、`class ContextWindow { estimate(items: ContextItem[]): { used: number; items: ContextItemEstimate[] }; shouldCompact(b: ContextBudget): boolean; compact(items: ContextItem[], opts?: { force?: boolean }): Promise<ContextChunk[]>; verifyChecksum(chunks: ContextChunk[]): boolean; reinject(): ContextItem[]; }`
  - `index.ts`：`class ContextManager { constructor(root: string, store: StorageAdapter); loader: ContextLoader; memory: AutoMemory; window: ContextWindow; }`

- [ ] **Step 1: 写失败测试**

创建 `src/harness/context/window.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextWindow } from './window';
import { ContextItem } from '../../types';

test('estimate 按 kind 加权估算 token', () => {
  const w = new ContextWindow();
  const est = w.estimate([{ kind: 'instruction', content: 'abcd' }]);
  assert.equal(est.used, 2); // ceil(4 字符 × 1.2 / 4) = ceil(1.2) = 2
  assert.equal(est.items.length, 1);
  assert.equal(est.items[0].weight, 1.2);
  assert.ok(est.items[0].id.length > 0);
});

test('estimate 返回逐项 chunk id（可重现）', () => {
  const w = new ContextWindow();
  const a = w.estimate([{ kind: 'history', content: 'hello' }]);
  const b = w.estimate([{ kind: 'history', content: 'hello' }]);
  assert.equal(a.items[0].id, b.items[0].id);
});

test('used 超过 total 时 shouldCompact 为 true', () => {
  const w = new ContextWindow();
  assert.equal(w.shouldCompact({ total: 100, used: 101, reserve: 10 }), true);
  assert.equal(w.shouldCompact({ total: 100, used: 50, reserve: 10 }), false);
});

test('compact 产出结构化 chunk 并过滤 priority=0', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'history', content: '用户说你好' },
    { kind: 'history', content: '重复的冗余日志 x'.repeat(50) },
  ];
  const chunks = await w.compact(items);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((c) => c.priority > 0));
  assert.ok(chunks.every((c) => c.id.length > 0));
});

test('verifyChecksum 对相同 chunks 返回 true', () => {
  const w = new ContextWindow();
  const chunks = [{ id: 'a', summary: 'x', type: 'history', priority: 1 }];
  assert.equal(w.verifyChecksum(chunks), false); // 首次记录
  assert.equal(w.verifyChecksum(chunks), true);  // 内容未变
});

test('compact 摘要可重现（相同输入产生相同 chunk id）', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [{ kind: 'instruction', content: '## 规则一\n内容' }];
  const a = await w.compact(items);
  const b = await w.compact(items);
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/harness/context/window.test.ts`
Expected: FAIL —— 找不到模块 `./window`

- [ ] **Step 3: 写最小实现**

创建 `src/harness/context/window.ts`：

```ts
import * as crypto from 'crypto';
import { ContextItem } from '../../types';

export interface ContextBudget {
  total: number;
  used: number;
  reserve: number;
}

export interface ContextItemEstimate {
  id: string;
  weight: number;
}

export interface ContextChunk {
  id: string;
  summary: string;
  type: string;
  priority: number;
}

const KIND_WEIGHT: Record<ContextItem['kind'], number> = {
  system: 1.0,
  instruction: 1.2,
  memory: 0.8,
  history: 0.5,
  tool: 0.7,
  result: 0.6,
};

/** 上下文窗口：加权 token 估算 + 分块 compaction + checksum 重注入（Claude Code 稳定性增强） */
export class ContextWindow {
  private lastChecksum: string | null = null;

  /** 加权估算：used = Σ ceil(content.length * weight / 4)；逐项返回 chunk id */
  estimate(items: ContextItem[]): { used: number; items: ContextItemEstimate[] } {
    const out: ContextItemEstimate[] = [];
    let used = 0;
    for (const it of items) {
      const weight = KIND_WEIGHT[it.kind] ?? 0.5;
      used += Math.ceil((it.content.length * weight) / 4);
      out.push({ id: this.chunkId(it.content), weight });
    }
    return { used, items: out };
  }

  shouldCompact(b: ContextBudget): boolean {
    return b.used > b.total - b.reserve;
  }

  async compact(items: ContextItem[], opts?: { force?: boolean }): Promise<ContextChunk[]> {
    if (!opts?.force && !this.shouldCompact({ total: 200_000, used: this.estimate(items).used, reserve: 40_000 })) {
      return [];
    }
    const chunks = this.chunkByMarkdown(items);
    const merged = this.mergeChunks(chunks);
    const kept = merged.filter((c) => c.priority > 0);
    this.lastChunks = kept;
    return kept;
  }

  verifyChecksum(chunks: ContextChunk[]): boolean {
    const hash = crypto.createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
    if (this.lastChecksum === hash) return true;
    this.lastChecksum = hash;
    return false;
  }

  reinject(): ContextItem[] {
    // 阶段一：system prompt 不重注入（hardcode）；
    // SUNSHINE.md / MEMORY.md / 最近 5 文件的重读由 ContextManager 协调，
    // 本方法返回压缩摘要作为新 history（摘要本身由 ContextManager 注入）。
    return [];
  }

  private chunkId(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /** 按 ## / ### / --- / > 边界切分 */
  private chunkByMarkdown(items: ContextItem[]): ContextChunk[] {
    const out: ContextChunk[] = [];
    for (const it of items) {
      const lines = it.content.split(/\r?\n/);
      let cur = '';
      const flush = () => {
        if (cur.trim().length === 0) return;
        out.push({ id: this.chunkId(cur), summary: cur.trim().slice(0, 2000), type: it.kind, priority: this.priority(cur) });
        cur = '';
      };
      for (const l of lines) {
        if (/^(#{2,3}\s|---|>)/.test(l)) { flush(); cur = l; }
        else cur += (cur ? '\n' : '') + l;
      }
      flush();
    }
    return out;
  }

  /** priority：极短/高度重复内容判为 0，其余为 1 */
  private priority(content: string): number {
    if (content.trim().length < 4) return 0;
    const words = content.trim().split(/\s+/);
    if (words.length >= 4 && new Set(words).size <= 2) return 0; // 冗余重复
    return 1;
  }

  /** 去重合并：相同 id 或 Jaccard > 0.9 合并 */
  private mergeChunks(chunks: ContextChunk[]): ContextChunk[] {
    const out: ContextChunk[] = [];
    for (const c of chunks) {
      const dup = out.find((o) => o.id === c.id || this.jaccard(o.summary, c.summary) > 0.9);
      if (dup) {
        if (c.summary.length > dup.summary.length) dup.summary = c.summary;
        dup.priority = Math.max(dup.priority, c.priority);
      } else {
        out.push({ ...c });
      }
    }
    return out;
  }

  private jaccard(a: string, b: string): number {
    const sa = new Set(a.split(/\s+/).filter(Boolean));
    const sb = new Set(b.split(/\s+/).filter(Boolean));
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    return inter / (sa.size + sb.size - inter);
  }
}
```

> 阶段一 `summary` 为「截断文本」近似，chunk id / priority / checksum / 加权逻辑为真实实现；真实 LLM 摘要留阶段二。

创建 `src/harness/context/loader.ts`：

```ts
import * as fs from 'fs';
import * as path from 'path';
import { ContextItem } from '../../types';

/** 分层指令加载：SUNSHINE.md + @path import 展开（递归 4 层） */
export class ContextLoader {
  constructor(private root: string) {}

  load(): ContextItem[] {
    const items: ContextItem[] = [];
    const p = path.join(this.root, 'SUNSHINE.md');
    if (!fs.existsSync(p)) return items;
    this.collect(p, items, 0);
    return items;
  }

  private collect(file: string, items: ContextItem[], depth: number): void {
    if (depth > 4) return;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^@([\w./-]+\.md)$/.exec(line.trim());
      if (m) {
        const target = path.resolve(path.dirname(file), m[1]);
        if (fs.existsSync(target)) this.collect(target, items, depth + 1);
        continue;
      }
      if (line.trim().length > 0) items.push({ kind: 'instruction', content: line });
    }
  }
}
```

创建 `src/harness/context/auto-memory.ts`：

```ts
import { StorageAdapter } from '../../storage/adapter';

/** 自动记忆：索引 + 主题文件（四类 type，阶段一简化为索引列表） */
export class AutoMemory {
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

创建 `src/harness/context/rules.ts`：

```ts
import * as fs from 'fs';
import * as path from 'path';
import { ContextItem } from '../../types';

/** path-scoped 规则：.sunshine/rules/ 目录，命中匹配文件才加载 */
export class RulesRegistry {
  constructor(private root: string) {}

  forPath(relPath: string): ContextItem[] {
    const dir = path.join(this.root, '.sunshine', 'rules');
    if (!fs.existsSync(dir)) return [];
    const out: ContextItem[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = /^paths:\s*(.+)$/m.exec(raw);
      if (m && !m[1].split(',').some((p) => relPath.includes(p.trim()))) continue;
      out.push({ kind: 'instruction', content: raw });
    }
    return out;
  }
}
```

创建 `src/harness/context/session.ts`：

```ts
import { StorageAdapter } from '../../storage/adapter';

/** 会话状态：transcript 持久化 + 恢复 */
export class SessionStore {
  constructor(private store: StorageAdapter) {}

  save(id: string, data: unknown): void {
    this.store.write(`session.${id}`, data);
  }

  load<T>(id: string, fallback: T): T {
    return this.store.read<T>(`session.${id}`, fallback);
  }
}
```

创建 `src/harness/context/index.ts`：

```ts
import { StorageAdapter } from '../../storage/adapter';
import { ContextLoader } from './loader';
import { RulesRegistry } from './rules';
import { AutoMemory } from './auto-memory';
import { ContextWindow } from './window';
import { SessionStore } from './session';

/** 上下文与记忆管理门面 */
export class ContextManager {
  readonly loader: ContextLoader;
  readonly rules: RulesRegistry;
  readonly memory: AutoMemory;
  readonly window: ContextWindow;
  readonly session: SessionStore;

  constructor(root: string, store: StorageAdapter) {
    this.loader = new ContextLoader(root);
    this.rules = new RulesRegistry(root);
    this.memory = new AutoMemory(store);
    this.window = new ContextWindow();
    this.session = new SessionStore(store);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/harness/context/window.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npm run build && node --test src/harness/context/window.test.ts
git add src/harness/context/
git commit -m "feat: 上下文与记忆管理模块组（loader/auto-memory/window）"
```

---

### Task 9: 模型适配层（OpenAIAdapter + ScriptedAdapter）

**Files:**
- Modify: `src/model/adapter.ts`
- Create: `src/model/adapter.test.ts`

**Interfaces:**
- Consumes: 无（内置 fetch）
- Produces:
  - `interface LLMConfig { provider: 'openai' | 'stub' | 'scripted'; baseURL?: string; apiKey?: string; model?: string; }`
  - `class OpenAIAdapter implements ModelAdapter`
  - `class ScriptedAdapter implements ModelAdapter`（`constructor(steps: string[])`，`complete` 依次回放）
  - `StubAdapter`（保留）

- [ ] **Step 1: 写失败测试**

创建 `src/model/adapter.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedAdapter, StubAdapter, OpenAIAdapter } from './adapter';

test('ScriptedAdapter 依次回放脚本', async () => {
  const a = new ScriptedAdapter(['{"tool":"read","done":false}', '{"done":true}']);
  assert.equal(await a.complete('p'), '{"tool":"read","done":false}');
  assert.equal(await a.complete('p'), '{"done":true}');
});

test('StubAdapter 返回标记文本', async () => {
  const a = new StubAdapter();
  assert.match(await a.complete('hi'), /stub/);
});

test('OpenAIAdapter 无 key 时 complete 抛错', async () => {
  const a = new OpenAIAdapter({ provider: 'openai', baseURL: 'http://127.0.0.1:1/v1' });
  await assert.rejects(() => a.complete('hi'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/model/adapter.test.ts`
Expected: FAIL —— `ScriptedAdapter` / `OpenAIAdapter` 未定义

- [ ] **Step 3: 写最小实现**

在 `src/model/adapter.ts` 追加（保留 `StubAdapter` 与 `ModelRouter`）：

```ts
export interface LLMConfig {
  provider: 'openai' | 'stub' | 'scripted';
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

/** OpenAI 兼容适配器：Node 内置 fetch 直连 REST API */
export class OpenAIAdapter implements ModelAdapter {
  readonly provider = 'openai';
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(private cfg: LLMConfig) {
    this.baseURL = cfg.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = cfg.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  }

  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY 未配置');
    const resp = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`OpenAI 请求失败：${resp.status}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

/** 脚本化适配器：预置决策序列逐步回放（测试/离线兜底） */
export class ScriptedAdapter implements ModelAdapter {
  readonly provider = 'scripted';
  private i = 0;
  constructor(private steps: string[]) {}

  async complete(_prompt: string): Promise<string> {
    const s = this.steps[this.i];
    this.i = Math.min(this.i + 1, this.steps.length - 1);
    return s ?? '{"done":true}';
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/model/adapter.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
npm run build && node --test src/model/adapter.test.ts
git add src/model/adapter.ts src/model/adapter.test.ts
git commit -m "feat: OpenAI 兼容适配层与 ScriptedAdapter"
```

---

### Task 10: 最小 Reactor + Harness 门面 + selfcheck 集成

**Files:**
- Create: `src/harness/reactor.ts`
- Create: `src/harness/index.ts`
- Create: `src/harness/reactor.test.ts`
- Modify: `src/index.ts`（selfcheck 集成五大能力 + 端到端 Reactor）
- Modify: `package.json`（新增 `test` script）

**Interfaces:**
- Consumes: 上述所有模块（PerceptionEngine / ToolRegistry / SecurityGuard / ProcessSandbox / DryRun / ContextManager / ModelAdapter）
- Produces:
  - `interface Task { goal: string; }`
  - `interface StepRecord { step: number; action?: string; observation: string; }`
  - `interface RunResult { steps: StepRecord[]; done: boolean; reply?: string; }`
  - `class Reactor { constructor(deps: ReactorDeps); run(task: Task, opts?: { maxSteps?: number }): Promise<RunResult>; }`
  - `interface Harness`（门面，聚合五大能力）
  - `class Harness { static create(opts: HarnessOptions): Harness; }`

- [ ] **Step 1: 写失败测试**

创建 `src/harness/reactor.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reactor } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ProcessSandbox } from '../security/sandbox';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ToolRegistry } from '../tools';
import { builtinTools } from '../tools/builtin';
import { ContextManager } from '../context';
import { FileStore } from '../storage/adapter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('Reactor 用 ScriptedAdapter 跑通端到端闭环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-'));
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo hi"},"done":false}', '{"done":true}']);
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'echo hi' });
  assert.equal(r.done, true);
  assert.ok(r.steps.length >= 1);
});

test('Reactor 达到 maxSteps 强制终止', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor2-'));
  const store = new FileStore(tmp);
  const sandbox = new ProcessSandbox();
  const guard = new SecurityGuard(new PolicyEngine(), 'manual');
  const registry = new ToolRegistry();
  for (const t of builtinTools(sandbox)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const adapter = new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo x"},"done":false}']);
  const reactor = new Reactor({ registry, guard, sandbox, context, model: adapter });

  const r = await reactor.run({ goal: 'loop' }, { maxSteps: 2 });
  assert.equal(r.done, false);
  assert.equal(r.steps.length, 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/harness/reactor.test.ts`
Expected: FAIL —— 找不到模块 `./reactor`

- [ ] **Step 3: 写最小实现**

创建 `src/harness/reactor.ts`：

```ts
import { ContextItem, ExecResult } from '../types';
import { Result } from '../result';
import { ModelAdapter } from '../model/adapter';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { Sandbox } from '../security/sandbox';
import { ContextManager } from '../context';

export interface Task { goal: string; }
export interface StepRecord { step: number; action?: string; observation: string; }
export interface RunResult { steps: StepRecord[]; done: boolean; reply?: string; }

export interface ReactorDeps {
  registry: ToolRegistry;
  guard: SecurityGuard;
  sandbox: Sandbox;
  context: ContextManager;
  model: ModelAdapter;
}

interface Action { tool?: string; input?: Record<string, unknown>; done: boolean; }

/** 最小 Reactor：observe → think → act → observe 线性循环 */
export class Reactor {
  constructor(private deps: ReactorDeps) {}

  async run(task: Task, opts?: { maxSteps?: number }): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? 8;
    const steps: StepRecord[] = [];
    let done = false;
    let reply: string | undefined;

    for (let step = 1; step <= maxSteps; step++) {
      // observe: 装配上下文（阶段一：直接注入任务与历史轨迹）
      let history = this.assemble(task, steps);

      // 压缩稳定性集成：observe 后检查预算，必要时压缩并重注入（对齐 spec 9.3）
      const est = this.deps.context.window.estimate(history);
      if (this.deps.context.window.shouldCompact({ total: 200_000, used: est.used, reserve: 40_000 })) {
        const chunks = await this.deps.context.window.compact(history);
        if (!this.deps.context.window.verifyChecksum(chunks)) {
          history = [
            { kind: 'instruction' as const, content: task.goal },
            ...this.deps.context.window.reinject(),
          ];
        }
      }

      // think: 经 ModelAdapter 决策
      let action: Action;
      try {
        const raw = await this.deps.model.complete(JSON.stringify({ goal: task.goal, history }));
        action = this.parse(raw);
      } catch (e) {
        action = { done: true };
        reply = e instanceof Error ? e.message : '模型调用失败';
      }

      if (action.done) { done = true; reply = reply ?? '完成'; break; }

      // act: 经安全链执行
      let observation: string;
      if (!action.tool) { observation = '无动作'; }
      else {
        const r = await this.deps.registry.execute(action.tool, action.input ?? {}, this.deps.guard, this.deps.sandbox);
        observation = this.describe(r);
      }

      steps.push({ step, action: action.tool, observation });
      // observe: 写回记忆
      this.deps.context.memory.record('project', `step ${step}: ${observation}`);
    }

    return { steps, done, reply };
  }

  private assemble(task: Task, steps: StepRecord[]): ContextItem[] {
    return [
      { kind: 'instruction', content: task.goal },
      ...steps.map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` })),
    ];
  }

  private parse(raw: string): Action {
    try {
      const j = JSON.parse(raw) as Action;
      return { tool: j.tool, input: j.input, done: j.done === true };
    } catch {
      return { done: true };
    }
  }

  private describe(r: Result<ExecResult>): string {
    if (r.ok) return r.value.stdout || 'ok';
    return `${r.error.code}: ${r.error.message}`;
  }
}
```

创建 `src/harness/index.ts`：

```ts
import * as path from 'path';
import { PerceptionEngine } from './perception';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, StubAdapter } from '../model/adapter';
import { Reactor } from './reactor';

export interface HarnessOptions {
  root: string;
  model?: ModelAdapter;
}

/** Harness 门面：聚合五大能力，上层只依赖此门面 */
export class Harness {
  readonly perception: PerceptionEngine;
  readonly tools: ToolRegistry;
  readonly security: SecurityGuard;
  readonly sandbox: ProcessSandbox;
  readonly dryrun: DryRun;
  readonly context: ContextManager;
  readonly reactor: Reactor;

  constructor(opts: HarnessOptions) {
    const store = new FileStore(path.join(opts.root, '.data'));
    this.perception = new PerceptionEngine(opts.root);
    this.tools = new ToolRegistry();
    this.sandbox = new ProcessSandbox();
    for (const t of builtinTools(this.sandbox)) this.tools.register(t);
    this.security = new SecurityGuard(new PolicyEngine(), 'manual');
    this.dryrun = new DryRun();
    this.context = new ContextManager(opts.root, store);
    this.reactor = new Reactor({
      registry: this.tools,
      guard: this.security,
      sandbox: this.sandbox,
      context: this.context,
      model: opts.model ?? new StubAdapter(),
    });
  }
}
```

修改 `src/index.ts` 的 `selfcheck()`：

```ts
import { Harness } from './harness';

function selfcheck(): void {
  const h = new Harness({ root: ROOT });
  const perceived = h.perception.scan();
  console.log('SunshineX skeleton selfcheck OK');
  console.log('project :', perceived.project?.name ?? '(no SUNSHINE.md)');
  console.log('rules   :', perceived.project?.rules.length ?? 0);
  console.log('files   :', perceived.files.length, 'deps:', perceived.dependencies.length);
  console.log('tools   :', h.tools.list().map((t) => t.name).join(', '));
  console.log('harness :', [h.perception, h.tools, h.security, h.sandbox, h.dryrun, h.context, h.reactor].length, 'modules ready');
}
```

修改 `package.json` 的 scripts：

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "start": "node dist/index.js",
  "test": "node --test src/**/*.test.ts",
  "selfcheck": "npm run build && node dist/index.js --selfcheck"
}
```

> 注意：`node --test src/**/*.test.ts` 的 glob 由 shell 展开；若 shell 不支持，改用 `node --test`（自动发现 `*.test.ts` 需 Node 22+ 的 test runner glob 支持）。若两者都不生效，改用 `node --test src/` 显式目录。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && node --test src/harness/reactor.test.ts`
Expected: PASS

- [ ] **Step 5: 全量自检并提交**

```bash
npm run build && npm run test && npm run selfcheck
git add -A
git commit -m "feat: 最小 Reactor、Harness 门面与 selfcheck 集成"
```

---

### Task 11: 端到端验证与文档收尾

**Files:**
- Create: `src/e2e.test.ts`
- Modify: `docs/ROADMAP.md`（更新阶段一进度勾选）

**Interfaces:**
- Consumes: `Harness`、`ScriptedAdapter`
- Produces: 端到端验收测试

- [ ] **Step 1: 写端到端测试**

创建 `src/e2e.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Harness } from './harness';
import { ScriptedAdapter } from './model/adapter';

test('端到端：感知 → Reactor → 工具执行 → 记忆记录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-e2e-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const model = new ScriptedAdapter([
    '{"tool":"read","input":{"path":"a.txt"},"done":false}',
    '{"done":true}',
  ]);
  const h = new Harness({ root, model });

  const perceived = h.perception.scan();
  assert.ok(perceived.files.includes('a.txt'));

  const r = await h.reactor.run({ goal: '读取 a.txt' });
  assert.equal(r.done, true);
  assert.ok(r.steps.length >= 1);
  assert.ok(h.context.memory.index().length >= 1);
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npm run build && node --test src/e2e.test.ts`
Expected: PASS

- [ ] **Step 3: 更新 ROADMAP 进度并提交**

在 `docs/ROADMAP.md` 阶段一任务清单中，将已实现项勾选（三级 KV 缓存、统一工具框架、项目深度感知引擎、沙箱、dry-run、模型适配层、记忆体系、最小 Reactor），未实现项（凭据 mask 完整实现、OS 级沙箱）保留未勾选。

```bash
npm run build && npm run test && npm run selfcheck
git add -A
git commit -m "test: 端到端验收测试与进度文档更新"
```

---

## 完成标准

全部任务完成后，`npm run build`、`npm run test`、`npm run selfcheck` 三项必须零报错通过，满足 spec 第 6 章验收标准的 1/2/3/4/5/6 条。
