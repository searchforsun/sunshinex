# 后台任务（对标 Claude Code 全形态）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 exec 命令与子代理提供统一后台执行面——统一任务账本（TaskRegistry）+ 参数化入口（exec `background` 入参 / spawn 两段式）+ 状态查询复用 read + task_stop 停止工具 + /tasks 用户命令。

**Architecture:** 统一性落在账本不落在工具：新增 `src/harness/tasks.ts`（TaskRegistry 单点，进程内 Map，ID 会话内递增确定性序号）承载 ID 空间/生命周期/状态；exec 与 spawn 保持各自工具、以 `background` 入参切异步；后台输出流式写 `<dataDir>/tasks/<id>.log`（read 数据目录只读放行既有先例，查询零新工具）；前台 exec 触超时自动转后台（sleep 开头除外）；task_stop 为本批唯一新增工具。规格：`docs/superpowers/specs/2026-09-22-background-tasks-design.md`（D1–D10）。

**Tech Stack:** TypeScript strict + Node.js（CJS）、`node:test`、零新依赖。

## Global Constraints

- 规格文件：`docs/superpowers/specs/2026-09-22-background-tasks-design.md`；裁决冲突时以规格 D1–D10 为准。
- 提示词恒英文单语（CLAUDE.md §15）：工具 description、链行/观察行、任务文案英文；用户面回执走 `t()` 双语。链行判据=「有无写链」。
- 每个新工具=一次全量前缀断点：本批仅新增 `task_stop` 一把（工具清单按名排序自动并入）；exec/spawn schema 变更与 task_stop 同批入库（同一断点买断）。
- 前缀缓存不变量（§11）：任务 ID/状态仅出现在链尾观察行；动态面盘点审计——新增装配面零时间戳/随机值/计数器进提示词前置段（ID 递增计数器属链尾观察行，合法）。
- 路径一律 `path.join`/`path.resolve`（§14）；数据目录经 `resolveDataDir(base)` 单点（§7）；进程平台分支只允许在 `security/sandbox.ts`（§14）。
- 测试与被测模块同目录 `*.test.ts`；测试数据目录钉仓内 `.data-test`（run-tests.js 启动器已承载），任务日志目录按测试根派生（见 Task 1），不写共享 `.data-test/tasks`。
- 提交纪律：工作区存在并发线 WIP，每步 `git add` 仅列本任务文件；提交信息中文、格式 `feat(harness): ...`。
- 门禁：每任务收口跑 `pnpm build`（tsc strict 零报错）；Task 5 收口加跑全量 `pnpm test` + `pnpm selfcheck`。

---

### Task 1: TaskRegistry 统一账本 + exec 后台化

**Files:**
- Create: `src/harness/tasks.ts`
- Create: `src/harness/tasks.test.ts`
- Modify: `src/harness/security/sandbox.ts`（ToolBackend 接口增 `execBackground`，ProcessSandbox 实现；平台细节只落本文件）
- Modify: `src/types.ts:328`（ToolBackend 接口，ExecResult 定义紧邻其上 L320–325）
- Modify: `src/harness/tools/builtin.ts:51–71`（exec 工具 schema+executor）
- Modify: `src/harness/index.ts:94`（装配行）

**Interfaces:**
- Consumes: `resolveDataDir(base: string): string`（`src/config/data-dir.ts`，既有）；`Result<T>`/`ok`/`fail`（`src/result.ts`，既有）；`ExecResult`（`src/types.ts:320`：`{exitCode,stdout,stderr,timedOut}`）；`CodedToolError`（`src/harness/tools.ts`）。
- Produces（后续任务依赖的精确签名）:
  - `src/harness/tasks.ts`：
    ```ts
    export interface BackgroundTask {
      id: string;            // 'b1'、'b2'…
      kind: 'exec' | 'subagent';
      label: string;         // exec=命令首段；subagent=finalLabel
      status: 'running' | 'done' | 'failed' | 'stopped';
      outputFilePath: string;
      startedAt: number;
      exitCode?: number;     // exec 终态
      ownerRun?: string;     // 收割归属键（规格 D9）；缺省='main'（主链任务，跨轮存活）
      stop?: () => void;     // 停止执行单点：exec=进程组 kill、subagent=abort 中断线；提交方挂载，账本透传
    }
    export class TaskRegistry {
      constructor(tasksDir: string);
      submit(input: { kind: 'exec' | 'subagent'; label: string; ownerRun?: string }): BackgroundTask; // 登记+同步创建日志文件
      append(taskId: string, chunk: string): void;             // 追加输出
      finish(taskId: string, status: 'done' | 'failed' | 'stopped', opts?: { exitCode?: number; marker?: string }): BackgroundTask | undefined; // 终态行落文件尾，重复终止幂等
      list(): BackgroundTask[];
      get(taskId: string): BackgroundTask | undefined;
      reap(ownerRun: string): BackgroundTask[];                // 收割该 owner 名下全部 running（触发 stop + [stopped] 终态行，规格 D9）
      stopAll(): BackgroundTask[];                             // 进程收口：终结全部 running（CLI run 终态/进程退出兜底）
      runInOwnerScope<T>(owner: string, fn: () => T): T;       // owner 作用域（AsyncLocalStorage）：作用域内 submit 缺省归属该 owner
      currentOwner(): string;                                  // 当前作用域 owner，缺省 'main'
    }
    ```
    ID 形态 `b<N>`（N 从 1 递增）；终态行格式：带 `exitCode` → `[exit <N>]`，带 `marker` → marker 行（subagent 结论/失败补丁行，规格 D3），否则 `[<status>]`；重复终止幂等（不翻转状态、不重写行）。
  - `src/types.ts`：`ToolBackend` 增可选成员 `execBackground?(cmd: string, opts?: { cwd?: string; onData?: (chunk: string) => void; onExit?: (exitCode: number) => void }): Promise<Result<{ pid: number }>>` 与 `killBackground?(pid: number): void`。
  - `src/harness/index.ts`：`Harness` 新增只读字段 `tasks: TaskRegistry`。

- [ ] **Step 1: 写失败测试（TaskRegistry 单元）**

创建 `src/harness/tasks.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskRegistry } from './tasks';

function makeReg(): { reg: TaskRegistry; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tasks-'));
  return { reg: new TaskRegistry(dir), dir };
}

test('TaskRegistry：submit 递增确定性 ID 并创建日志文件', () => {
  const { reg, dir } = makeReg();
  const a = reg.submit({ kind: 'exec', label: 'npm run dev' });
  const b = reg.submit({ kind: 'subagent', label: 'reviewer' });
  assert.equal(a.id, 'b1');
  assert.equal(b.id, 'b2');
  assert.equal(a.status, 'running');
  assert.equal(a.kind, 'exec');
  assert.ok(a.outputFilePath.startsWith(path.join(dir, 'tasks')));
  assert.ok(fs.existsSync(a.outputFilePath));
});

test('TaskRegistry：append 与 finish 终态行、幂等与 marker 形态', () => {
  const { reg } = makeReg();
  const t = reg.submit({ kind: 'exec', label: 'tail -f x.log' });
  reg.append(t.id, 'line-1\n');
  reg.finish(t.id, 'done', { exitCode: 0 });
  assert.equal(fs.readFileSync(t.outputFilePath, 'utf8'), 'line-1\n[exit 0]\n');
  // 幂等：已终态再 finish 不翻转状态、不重写行
  reg.finish(t.id, 'stopped', { marker: '[stopped]' });
  assert.equal(reg.get(t.id)?.status, 'done');
  assert.equal(fs.readFileSync(t.outputFilePath, 'utf8'), 'line-1\n[exit 0]\n');
  const s = reg.submit({ kind: 'subagent', label: 'w' });
  reg.finish(s.id, 'failed', { marker: '[w] did not finish (failed)' });
  assert.ok(fs.readFileSync(s.outputFilePath, 'utf8').endsWith('[w] did not finish (failed)\n'));
});

test('TaskRegistry：reap 只收割指定 owner 名下 running 任务并触发 stop 句柄', () => {
  const { reg } = makeReg();
  let killed = false;
  reg.submit({ kind: 'exec', label: 'main-task' });
  const owned = reg.submit({ kind: 'subagent', label: 'child-bg', ownerRun: 'fork-1' });
  owned.stop = () => { killed = true; };
  const reaped = reg.reap('fork-1');
  assert.deepEqual(reaped.map((r) => r.id), [owned.id]);
  assert.equal(killed, true);
  assert.equal(reg.get(owned.id)?.status, 'stopped');
  assert.ok(fs.readFileSync(owned.outputFilePath, 'utf8').includes('[stopped: owner finished]'));
  assert.equal(reg.list().find((r) => r.label === 'main-task')?.status, 'running');
});

test('TaskRegistry：stopAll 终结全部 running（进程收口兜底，规格 D9）', () => {
  const { reg } = makeReg();
  reg.submit({ kind: 'exec', label: 'a' });
  reg.submit({ kind: 'subagent', label: 'b' });
  const done = reg.submit({ kind: 'exec', label: 'c' });
  reg.finish(done.id, 'done', { exitCode: 0 });
  assert.equal(reg.stopAll().length, 2);
  assert.equal(reg.list().filter((r) => r.status === 'running').length, 0);
});

test('TaskRegistry：owner 作用域（AsyncLocalStorage）内 submit 缺省归属', async () => {
  const { reg } = makeReg();
  const inside = await reg.runInOwnerScope('fork-1', async () => reg.submit({ kind: 'exec', label: 'scoped' }).ownerRun);
  assert.equal(inside, 'fork-1');
  assert.equal(reg.currentOwner(), 'main');
  assert.equal(reg.submit({ kind: 'exec', label: 'outside' }).ownerRun, 'main');
});

test('TaskRegistry：list 全量快照、get 未命中返回 undefined', () => {
  const { reg } = makeReg();
  reg.submit({ kind: 'exec', label: 'a', ownerRun: 'main' });
  reg.submit({ kind: 'subagent', label: 'b', ownerRun: 'reviewer#2' });
  assert.equal(reg.list().length, 2);
  assert.equal(reg.get('b9'), undefined);
  assert.equal(reg.list()[0].ownerRun, 'main');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/tasks.test.js`
Expected: FAIL——`Cannot find module './tasks'`（模块不存在）。

- [ ] **Step 3: 最小实现 `src/harness/tasks.ts`**

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { CodedToolError } from './tools';

/** 后台任务记录（规格 D2/D3）：账本进程内承载，不落盘不跨会话；输出流式追加 <dataDir>/tasks/<id>.log */
export interface BackgroundTask {
  id: string;
  kind: 'exec' | 'subagent';
  label: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  outputFilePath: string;
  startedAt: number;
  exitCode?: number;
  ownerRun?: string;
  /** 停止执行单点（exec=进程 kill、subagent=中断线 abort）；提交方挂载，账本透传——kill 与 abort 两类差异收敛在提交方闭包，账本零 kind 分派 */
  stop?: () => void;
}

/** owner 作用域（规格 D9）：AsyncLocalStorage 承载 fork 归属，并发 fork 互不串号 */
const ownerStorage = new AsyncLocalStorage<string>();

/** 统一任务账本单点（规格 D1/D10）：ID 空间/生命周期/状态统一承载；进程内 Map 不落盘不跨会话；ID=会话内递增确定性序号，零随机源 */
export class TaskRegistry {
  private seq = 0;
  private readonly tasks = new Map<string, BackgroundTask>();
  constructor(private readonly tasksDir: string) {}

  /** owner 作用域：fn 执行期内 submit 缺省归属 owner（fork 收割记账，规格 D9） */
  runInOwnerScope<T>(owner: string, fn: () => T): T {
    return ownerStorage.run(owner, fn);
  }

  currentOwner(): string {
    return ownerStorage.getStore() ?? 'main';
  }

  submit(input: { kind: 'exec' | 'subagent'; label: string; ownerRun?: string }): BackgroundTask {
    this.seq += 1;
    const id = `b${this.seq}`;
    const outputFilePath = path.join(this.tasksDir, 'tasks', `${id}.log`);
    try {
      fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
      fs.writeFileSync(outputFilePath, '', 'utf8');
    } catch (e) {
      // 日志文件创建失败=启动失败显式报错（规格 §9），不静默吞
      throw new CodedToolError('EXEC_FAILED', `background task log unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const task: BackgroundTask = {
      id,
      kind: input.kind,
      label: input.label,
      status: 'running',
      outputFilePath,
      startedAt: Date.now(),
      ownerRun: input.ownerRun ?? this.currentOwner(),
    };
    this.tasks.set(id, task);
    return task;
  }

  append(taskId: string, chunk: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    fs.appendFileSync(t.outputFilePath, chunk, 'utf8');
  }

  /** 终态（规格 D3）：带 exitCode 落 [exit N]；带 marker 落 marker 行（subagent 结论/失败补丁行）；否则 [status]；重复终止幂等 */
  finish(taskId: string, status: 'done' | 'failed' | 'stopped', opts?: { exitCode?: number; marker?: string }): BackgroundTask | undefined {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'running') return t;
    const line = opts?.marker ?? (opts?.exitCode !== undefined ? `[exit ${opts.exitCode}]` : `[${status}]`);
    fs.appendFileSync(t.outputFilePath, `${line}\n`, 'utf8');
    t.status = status;
    if (opts?.exitCode !== undefined) t.exitCode = opts.exitCode;
    return t;
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /** ownerRun 收割（规格 D9）：终结该 owner 名下全部 running——触发 stop 句柄并落 [stopped] 终态行 */
  reap(ownerRun: string): BackgroundTask[] {
    const out: BackgroundTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === 'running' && t.ownerRun === ownerRun) {
        t.stop?.();
        this.finish(t.id, 'stopped', { marker: '[stopped: owner finished]' });
        out.push(t);
      }
    }
    return out;
  }

  /** 全量收口（宿主退出/CLI run 终态，规格 D9 任务属进程） */
  stopAll(): BackgroundTask[] {
    const out = this.list().filter((t) => t.status === 'running');
    for (const t of out) {
      t.stop?.();
      this.finish(t.id, 'stopped', { marker: '[stopped: process exit]' });
    }
    return out;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/tasks.test.js`
Expected: PASS（6/6）。

- [ ] **Step 5: 写失败测试（ProcessSandbox.execBackground）**

在 `src/harness/security/sandbox.test.ts` 末尾追加：

```ts
test('execBackground：提交即返回 pid，进程在跑，输出直写回调', async () => {
  const sb = new ProcessSandbox();
  const chunks: string[] = [];
  let exited: (() => void) | undefined;
  const done = new Promise<void>((r) => { exited = r; });
  const r = await sb.execBackground('echo bg-hello && sleep 1', {
    onData: (d) => chunks.push(d),
    onExit: () => exited?.(),
  });
  assert.ok(r.ok, '提交应成功');
  assert.ok(r.ok && r.value.pid > 0);
  await done;
  assert.ok(chunks.join('').includes('bg-hello'), 'stdout 应经 onData 回调');
});
```

Run: `pnpm build && node --test dist/harness/security/sandbox.test.js`
Expected: FAIL——`execBackground is not a function`。

- [ ] **Step 6: 实现 execBackground（ProcessSandbox）+ ToolBackend 接口登记**

`src/types.ts` 的 `ToolBackend`（L328 起）增可选成员（放 `exec` 之后）：

```ts
  /** 后台执行（后台任务线）：提交即返回 pid；stdout/stderr 经 onData 增量回调，进程退出经 onExit 回调（exitCode 语义同 exec）。
   *  平台形态（spawn/detached/进程组收割）只允许落 ProcessSandbox 本文件（CLAUDE.md §14） */
  execBackground?(cmd: string, opts?: { cwd?: string; onData?: (chunk: string) => void; onExit?: (exitCode: number) => void }): Promise<Result<{ pid: number }>>;
```

`src/harness/security/sandbox.ts`：`execFile` import 改 `spawn, execFile`；`ProcessSandbox` 类内 `exec` 方法后新增（平台细节单点收敛于此，注释登记决策背景）：

```ts
  /** 后台执行（后台任务线）：detached spawn 自成进程组，task_stop 按组收割；stdout/stderr 增量回调供 TaskRegistry 流式落盘。
   *  Windows 下 detached 即新进程组、taskkill /T 按树收割，POSIX 下按 -pid 组收割——平台差异收敛本单点 */
  async execBackground(cmd: string, opts?: { cwd?: string; onData?: (chunk: string) => void; onExit?: (exitCode: number) => void }): Promise<Result<{ pid: number }>> {
    const shell = resolveShell();
    const child = spawn(shell.file, [...shell.args, cmd], {
      cwd: opts?.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (d: Buffer) => opts?.onData?.(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => opts?.onData?.(d.toString('utf8')));
    child.on('error', (err: Error) => {
      opts?.onData?.(err.message);
      opts?.onExit?.(1);
    });
    child.on('close', (code: number | null) => opts?.onExit?.(code ?? 1));
    return ok({ pid: child.pid ?? 0 });
  }

  /** 按进程组/进程树终止后台任务（task_stop 单点后端）：POSIX 杀 -pid 组，Windows 杀 /T 树 */
  killBackground(pid: number): void {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出，终态行由 close 回调落 */ } }
    }
  }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/security/sandbox.test.js`
Expected: PASS（既有用例零误伤 + 新增 1）。

- [ ] **Step 8: 写失败测试（exec 工具 background 入参）**

在 `src/harness/subagent.test.ts` 末尾追加（该文件已有最齐全的桩夹具与 import）：

```ts
test('exec background:true 提交即返回，观察行含任务 ID 与输出路径，输出落任务日志', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bgexec-'));
  try {
    const store = new FileStore(path.join(root, 'data'));
    const ctx = new ContextManager(root, store);
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    const tasks = new TaskRegistry(path.join(root, 'data'));
    for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks)) registry.register(t);
    const input = { command: 'echo step-1 && echo step-2', background: true };
    const p = registry.execute('exec', input, safety);
    // 等终态：轮询任务账本至 done（echo 快命令进程收尾毫秒级；上限 2s 防挂起）
    const task = tasks.list().at(-1)!;
    assert.equal(task.kind, 'exec');
    assert.ok(task.outputFilePath.includes(path.join('data', 'tasks')), '日志落 <dataDir>/tasks/');
    for (let i = 0; i < 40 && tasks.get(task.id)?.status === 'running'; i++) await new Promise((r2) => setTimeout(r2, 50));
    const obs = await p.then((r) => (r.ok ? r.value.stdout : `EXEC_FAILED: ${r.error.message}`));
    assert.match(obs, /^task b1 started/);
    assert.ok(obs.includes(task.outputFilePath), '观察行含输出路径');
    const body = fs.readFileSync(task.outputFilePath, 'utf8');
    assert.ok(body.includes('step-1') && body.includes('step-2'), '输出流式落日志');
    assert.ok(body.endsWith('[exit 0]\n'), '终态行落文件尾');
    assert.equal(tasks.get(task.id)?.status, 'done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 小超时后端：把前台 exec 的 timeoutMs 钉到 120ms 构造超时转后台边界（CLAUDE.md §12 允许测试显式小值） */
class QuickTimeoutSandbox extends ProcessSandbox {
  exec(cmd: string, opts?: ExecOpts) {
    return super.exec(cmd, { ...opts, timeoutMs: opts?.timeoutMs ?? 120 });
  }
}

test('前台 exec 触超时转后台：观察行含 moved to background、任务接管存活子进程', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bgtimeout-'));
  try {
    const store = new FileStore(path.join(root, 'data'));
    const ctx = new ContextManager(root, store);
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new QuickTimeoutSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    const tasks = new TaskRegistry(path.join(root, 'data'));
    for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks)) registry.register(t);
    const r = await registry.execute('exec', { command: 'echo warm && sleep 5' }, safety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, /^command moved to background after timeout: task b1/);
    const task = tasks.get('b1')!;
    assert.equal(task.status, 'running', '超时瞬间任务转后台登记');
    assert.ok(fs.readFileSync(task.outputFilePath, 'utf8').includes('warm'), '超时前已缓冲输出随任务落日志');
    task.stop?.(); // 收尾：终结存活子进程
    for (let i = 0; i < 40 && tasks.get('b1')?.status === 'running'; i++) await new Promise((r2) => setTimeout(r2, 50));
    assert.notEqual(tasks.get('b1')?.status, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sleep 开头命令超时不转后台：EXEC_TIMEOUT 照旧失败（规格 D5 豁免）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sleepexc-'));
  try {
    const store = new FileStore(path.join(root, 'data'));
    const ctx = new ContextManager(root, store);
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new QuickTimeoutSandbox(), new DryRun(), root);
    const registry = new ToolRegistry();
    const tasks = new TaskRegistry(path.join(root, 'data'));
    for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks)) registry.register(t);
    const r = await registry.execute('exec', { command: 'sleep 5' }, safety);
    assert.ok(!r.ok);
    assert.match(r.error.message, /EXEC_TIMEOUT/);
    assert.equal(tasks.list().length, 0, '豁免路径零任务登记');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

注意：`builtinTools` 第 12 参 `tasks` 为本任务新增接缝（Step 9 实现）；同文件顶部 import 区补 `import { TaskRegistry } from './tasks';` 与 `import type { ExecOpts } from '../types';`（QuickTimeoutSandbox 签名用）。测试以账本状态轮询为唯一等待面——`execBackground` 提交即返回，进程收尾由其 `onExit` 回调异步落账，测试不额外构造 Promise。

Run: `pnpm build && node --test dist/harness/subagent.test.js`
Expected: FAIL——`builtinTools` 只收 11 参、`background` 入参未实现（`task b1 started` 观察行断言失败）。

- [ ] **Step 9: 实现 exec 工具 background 分支（builtin.ts）**

`src/harness/tools/builtin.ts`：

1. import 区补 `import { TaskRegistry } from '../tasks';`
2. `builtinTools` 签名追加第 12 个可选参 `tasks?: TaskRegistry`（位于 `activeRoot` 之后；未注入=旧行为逐字节不变，既有 13 处调用点零改动）。
3. exec 工具 schema（L51–57）：`required` 改 `['command', 'background']`，`properties` 增：
   ```ts
   background: { type: ['boolean', 'null'], description: 'Run in the background: returns immediately with a task id and an output file path; poll by reading that file' },
   ```
4. executor（L61–66）改为分支形态：

```ts
      executor: async (input: ToolInput) => {
        const cmd = String(input.command ?? '');
        if (input.background === true) {
          if (tasks === undefined) throw new CodedToolError('NOT_SUPPORTED', 'background execution requires a task registry (not wired in this assembly)');
          const backend = safety.backend;
          if (backend.execBackground === undefined) throw new CodedToolError('NOT_SUPPORTED', 'background exec requires a backend with execBackground');
          const task = tasks.submit({ kind: 'exec', label: cmd.trim().split(/\s+/)[0] ?? cmd, ownerRun: tasks.currentOwner() });
          const started = await backend.execBackground(cmd, {
            cwd: safety.execCwd(),
            onData: (chunk) => tasks.append(task.id, chunk),
            onExit: (code) => tasks.finish(task.id, code === 0 ? 'done' : 'failed', { exitCode: code }),
          });
          if (started.ok) task.stop = () => backend.killBackground?.(started.value.pid);
          return execOut(`task ${task.id} started (output: ${task.outputFilePath})`);
        }
        // exec cwd 判定单点（规格 §11）：chain.execCwd()——活动根在场取活动根，isolation 子链换根克隆取专属树，缺省装配根
        // 超时转后台（规格 D5）：账本在场且非 sleep 开头时以 timeoutToBackground 形态运行——同一次执行内超时即转登记，
        // 不重跑命令（零二次审批、零副作用重复）；sleep 开头豁免（照 CC 显式等待语义），照旧按超时失败
        const wantsBg = tasks !== undefined && !/^sleep\b/.test(cmd.trim());
        const r = await safety.run(cmd, { cwd: safety.execCwd(), ...(wantsBg ? { timeoutToBackground: true } : {}) });
        if (r.ok && r.value.timedOut && r.value.child) {
          const child = r.value.child;
          const task = tasks!.submit({ kind: 'exec', label: cmd.trim().split(/\s+/)[0] ?? cmd, ownerRun: tasks!.currentOwner() });
          child.stdout?.on('data', (c: Buffer) => tasks!.append(task.id, c.toString('utf8')));
          child.stderr?.on('data', (c: Buffer) => tasks!.append(task.id, c.toString('utf8')));
          task.stop = () => child.kill();
          child.on('close', (code) => tasks!.finish(task.id, code === 0 ? 'done' : 'failed', { exitCode: code ?? -1 }));
          return execOut(`command moved to background after timeout: task ${task.id} (output: ${task.outputFilePath})`);
        }
        if (r.ok) return { ...r.value, stdout: fitOut('exec', r.value.stdout) };
        throw new Error(`${r.error.code}: ${r.error.message}`);
      },
```

注：`ownerRun: tasks.currentOwner()` 让 fork 作用域内发起的后台命令归属当前 fork（规格 D9 收割记账）；`stop` 句柄在 execBackground 的 pid 返回后挂载——pid 就绪前的 stop 请求为良性 no-op（进程随后由 close 回调落终态）。

5. `src/harness/index.ts:94` 装配行：`builtinTools(...)` 调用末尾追加第 12 参。在 `this.tools = new ToolRegistry();`（L85 附近）之后、装配行之前创建 `this.tasks = new TaskRegistry(resolveDataDir(base));`；类字段声明区（`readonly runner: SubagentRunner;` L66 附近）加 `readonly tasks: TaskRegistry;`，import 区补 `import { TaskRegistry } from './tasks';`。装配行形态：`..., this.writeSnapshot, () => this.safety.activeRoot, this.tasks) this.tools.register(t);`

- [ ] **Step 10: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/subagent.test.js && node --test dist/harness/tasks.test.js`
Expected: PASS（新增 1 + 既有零误伤）。

- [ ] **Step 11: 提交**

```bash
git add src/harness/tasks.ts src/harness/tasks.test.ts src/harness/security/sandbox.ts src/harness/security/sandbox.test.ts src/types.ts src/harness/tools/builtin.ts src/harness/subagent.test.ts src/harness/index.ts
git commit -m "feat(harness): TaskRegistry 统一账本+exec 后台化（背景任务线 T1）"
```

---

### Task 2: 前台超时自动转后台 + spawn 两段式开通

**Files:**
- Modify: `src/types.ts`（新增 `ExecOpts`；`ExecResult` 增 `child`；`ToolBackend.exec` 签名换 `ExecOpts`）
- Modify: `src/harness/security/chain.ts`（`run()` opts 换 `ExecOpts` 透传）
- Modify: `src/harness/security/sandbox.ts`（`exec` 增 `timeoutToBackground` 形态；import 增 `spawn`）
- Modify: `src/harness/subagent.ts`（摘 NOT_SUPPORTED；Runner deps 增 `tasks`；`spawnBackground`；runSubagent 增 `signal`/`task` 通道；makeSpawnTool 分支与 schema description）
- Modify: `src/harness/index.ts`（Runner 构造 deps 增 `tasks: this.tasks`）
- Test: `src/harness/security/sandbox.test.ts` 追加；`src/harness/subagent.background.test.ts` 新建

**Interfaces:**
- Consumes: Task 1 的 `TaskRegistry.begin/append/finish` 与 `BackgroundTask`；`ReactorDeps.signal`（既有，reactor.ts L75 步边界消费）。
- Produces: `ExecOpts { cwd?; timeoutMs?; timeoutToBackground? }`（types.ts）；`ExecResult.child?: ChildProcess`；`SubagentRunnerDeps.tasks?: TaskRegistry`；`SubagentRunner.spawnBackground(input: SubagentSpawnInput): BackgroundTask`；`runSubagent` opts 增 `signal?: AbortSignal; task?: BackgroundTask`。

- [ ] **Step 1: 写失败测试（sandbox 超时转后台形态）**

在 `src/harness/security/sandbox.test.ts` 末尾追加：

```ts
test('exec timeoutToBackground：到点不杀进程、返回存活子进程与已缓冲输出', async () => {
  const sb = new ProcessSandbox();
  const r = await sb.exec('sleep 5', { timeoutMs: 150, timeoutToBackground: true });
  assert.ok(r.ok, `期望 ok，实际 ${r.ok ? '' : r.error.code}`);
  assert.equal(r.value.timedOut, true);
  const child = r.value.child!;
  assert.ok(child.pid);
  assert.equal(child.killed, false);
  child.kill();
});

test('exec timeoutToBackground：正常快速命令语义不变', async () => {
  const sb = new ProcessSandbox();
  const r = await sb.exec('echo fast-ok', { timeoutToBackground: true });
  assert.ok(r.ok);
  assert.equal(r.value.timedOut, false);
  assert.equal(r.value.stdout.trim(), 'fast-ok');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/security/sandbox.test.js`
Expected: FAIL——`timeoutToBackground` 未实现（`sleep 5` 照旧 EXEC_TIMEOUT fail）。

- [ ] **Step 3: 实现 ExecOpts / ExecResult.child / chain 透传 / sandbox 形态**

`src/types.ts`：import 区补 `import type { ChildProcess } from 'child_process';`；`ExecResult` 的 `timedOut: boolean;` 行后增：

```ts
  /** 超时转后台（规格 D5）：timedOut=true 时携带仍存活的子进程，调用方登记后台任务并接管输出流 */
  child?: ChildProcess;
```

`ExecResult` 定义之后新增：

```ts
/** exec 透传选项（后台任务线 T2）：timeoutToBackground=true 时超时不杀进程，把存活子进程经 ExecResult.child 交回调用方 */
export interface ExecOpts {
  cwd?: string;
  timeoutMs?: number;
  timeoutToBackground?: boolean;
}
```

`ToolBackend.exec` 签名改 `exec(cmd: string, opts?: ExecOpts): Promise<Result<ExecResult>>;`。

`src/harness/security/chain.ts`：import 补 `ExecOpts`；`run` 改：

```ts
  run(cmd: string, opts?: ExecOpts): Promise<Result<ExecResult>> {
    return this.backend.exec(cmd, opts);
  }
```

`src/harness/security/sandbox.ts`：import 改 `import { execFile, spawn } from 'child_process';`；`exec` 方法体首部（既有 execFile 分支之前）插入：

```ts
    if (opts?.timeoutToBackground) {
      // 超时转后台形态（规格 D5，对标 CC 超时自动转后台）：自管计时器——到点不杀进程，把存活子进程连同
      // 已缓冲输出交回调用方登记为后台任务；正常结束/真失败语义与 execFile 形态一致。
      return new Promise((resolve) => {
        const child = spawn(shell.file, [...shell.args, cmd], { cwd: opts?.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(ok({ exitCode: 0, stdout, stderr, timedOut: true, child }));
        }, timeoutMs);
        child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
        child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        child.on('error', (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(fail('EXEC_FAILED', e.message));
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(code === 0 ? ok({ exitCode: 0, stdout, stderr, timedOut: false }) : fail('EXEC_FAILED', stderr || `command failed with exit code ${code}`));
        });
      });
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/security/sandbox.test.js`
Expected: PASS（新增 2 + 既有零误伤）。

- [ ] **Step 5: 写失败测试（spawn 两段式）**

新建 `src/harness/subagent.background.test.ts`（预算挂载经 `attachParent`——subagent.ts L178，与 Reactor run 起止挂/摘同一对方法）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRegistry, SubagentRunner } from './subagent';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ScriptedAdapter } from '../model/adapter';
import { TaskRegistry } from './tasks';

function makeHarness(attachBudget: boolean): { tmp: string; runner: SubagentRunner; tasks: TaskRegistry; context: ContextManager } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-bg-test-'));
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const tasks = new TaskRegistry(path.join(tmp, '.data'));
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tasks)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const reg = new AgentRegistry();
  reg.registerBuiltins();
  const runner = new SubagentRunner(
    { registry, safety, context, model: new ScriptedAdapter([JSON.stringify({ done: true, reply: 'bg child report' })]), root: tmp, tasks },
    reg,
  );
  if (attachBudget) runner.attachParent(() => ({ maxSteps: 20 }));
  return { tmp, runner, tasks, context };
}

function until(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout waiting condition')) : setTimeout(tick, 25));
    tick();
  });
}

test('spawn 两段式：立即返回任务记录，结论行落任务日志、主链零追加', async () => {
  const h = makeHarness(true);
  const before = h.context.chainView().length;
  const rec = h.runner.spawnBackground({ prompt: 'independent subtask', label: 'bg1' });
  assert.equal(rec.id, 'b1');
  assert.equal(rec.status, 'running');
  await until(() => h.tasks.get(rec.id)?.status !== 'running');
  assert.equal(h.tasks.get(rec.id)?.status, 'done');
  const log = fs.readFileSync(rec.outputFilePath, 'utf8');
  assert.ok(log.includes('[bg1] bg child report'), `日志应含结论行，实际：${log}`);
  assert.equal(h.context.chainView().length, before, '后台子代理零主链污染');
});

test('spawn 两段式：budget 缺失 fail-bounded 报错，不静默起跑', async () => {
  const h = makeHarness(false);
  const rec = h.runner.spawnBackground({ prompt: 'x', label: 'nobudget' });
  await until(() => h.tasks.get(rec.id)?.status !== 'running', 3000);
  assert.equal(h.tasks.get(rec.id)?.status, 'failed');
  assert.ok(fs.readFileSync(rec.outputFilePath, 'utf8').includes('budget'));
});

test('validateSpawnInput：background:true 不再被拒（规格 D7 开通）', () => {
  const h = makeHarness(true);
  h.runner.validateSpawnInput({ prompt: 'x', background: true });
  assert.throws(() => h.runner.validateSpawnInput({}), /agent_id and prompt are both missing/);
});
```

注：预算挂载接缝=Runner.attachParent（subagent.ts L178–183，与 Reactor run 起止挂/摘同一对方法）；预算源缺省即抛 `Subagent budget source not attached`（INVALID_STATE，L253 `noBudget` 先例同形），runSubagent 返回 fail Result——后台通道转为任务 failed 终态落日志，不抛未处理异常。

Run: `pnpm build && node --test dist/harness/subagent.background.test.js`
Expected: FAIL——`spawnBackground is not a function`。

- [ ] **Step 6: 实现 spawn 两段式（subagent.ts）**

1. RunnerDeps 增字段（`onEvent?:` 行附近）：`tasks?: TaskRegistry;`；import 区补 `import { TaskRegistry } from './tasks';` 与 `import type { BackgroundTask } from './tasks';`。
2. `validateSpawnInput`：摘除 `if (input.background === true) { throw new CodedToolError('NOT_SUPPORTED', ...) }` 三行与方法注释中的该项（删除即无痕）。
3. Runner 增字段与方法（`runSubagent` 之前）：

```ts
  private ownerSeq = 0;

  /** 后台两段式（规格 D7）：登记任务并立即返回，子代理在后台跑完；结论/失败行写任务日志（模型 read 获取，
   * 主链零追加）；stop 挂中断线（规格 D8，AbortController→Reactor 步边界既有中断语义）；owner 归属=当前作用域（规格 D9） */
  spawnBackground(input: SubagentSpawnInput): BackgroundTask {
    if (this.deps.tasks === undefined) throw new CodedToolError('NOT_SUPPORTED', 'background spawn requires a task registry (not wired in this assembly)');
    this.validateSpawnInput(input);
    if (this.getBudget?.() === undefined) throw new CodedToolError('INVALID_STATE', 'Subagent budget source not attached');
    const controller = new AbortController();
    const rec = this.deps.tasks.submit({ kind: 'subagent', label: input.label ?? input.agent_id ?? 'subagent', ownerRun: this.deps.tasks.currentOwner() });
    rec.stop = () => controller.abort();
    void this.runSubagent(input, { signal: controller.signal, task: rec }).catch(() => {
      this.deps.tasks!.finish(rec.id, 'failed');
    });
    return rec;
  }
```

（同步预算检查先于登记——预算缺失即任务零登记、fail-bounded 不静默起跑；`begin` 的 `ownerRun` 取当前作用域，规格 D9 记账。）

4. `runSubagent` opts 增 `signal?: AbortSignal; task?: BackgroundTask;`；child Reactor 构造增一行：`...(opts?.signal ? { signal: opts.signal } : {})`。

4b. 收割接线（规格 D9）：Runner 增字段 `private ownerSeq = 0;`；`runSubagent` 内 `await child.run(...)` 调用改 owner 作用域包裹，收口收割——

```ts
        const owner = this.deps.tasks !== undefined ? `fork-${finalLabel}#${++this.ownerSeq}` : undefined;
        const runChild = () => child.run({ goal: spec.taskLine }, { maxSteps: budget.maxSteps, tokenCap: budget.tokenCap, ...(budget.deadlineAt !== undefined ? { deadlineAt: budget.deadlineAt } : {}), ...(budget.tier !== undefined ? { tier: budget.tier } : {}), scope: 'fork', seedHistory });
        let result;
        try {
          result = owner !== undefined ? await this.deps.tasks!.runInOwnerScope(owner, runChild) : await runChild();
        } finally {
          if (owner !== undefined) this.deps.tasks!.reap(owner);
        }
```

（`ownerSeq` 递增后缀消解同名 label 复用收割串号；`ownerRun: tasks.currentOwner()` 的 exec 后台提交（Task 1）在包裹作用域内自动归属本 fork；主链不经 runSubagent、恒缺省 `'main'`——主链任务跨轮存活、零收割，规格 D9/D10。收口收割钩子落 `runSubagent` 既有 finally（inFlight 计数复位处）同段。）
5. 成功分支（`result.done && result.reply` 处）改双通道：

```ts
        if (result.done && result.reply) {
          const keptNote = this.settleIsoWorktree(iso);
          if (opts?.task) {
            if (keptNote) this.deps.tasks!.append(opts.task.id, `[${finalLabel}] ${keptNote}\n`);
            this.deps.tasks!.append(opts.task.id, `[${finalLabel}] ${firstLine(result.reply)}\n`);
            this.deps.tasks!.finish(opts.task.id, 'done');
          } else {
            if (keptNote) this.deps.context.appendChain([{ action: 'note', observation: `[${finalLabel}] ${keptNote}` }]);
            this.deps.context.appendChain([{ action: 'node', observation: `[${finalLabel}] ${firstLine(result.reply)}` }]);
          }
          return ok({ reply: result.reply, tokens: result.tokensUsed ?? 0 });
        }
```

失败分支（`did not finish` 处）同理：`opts?.task` 在场时 `this.deps.tasks!.append(opts.task.id, \`[${finalLabel}] did not finish (${reason})...\`)` + `this.deps.tasks!.finish(opts.task.id, 'failed')`，否则保持原 appendChain。task_stop 先行 finish('stopped') 时此处幂等不覆盖（Task 1 语义）。
6. `makeSpawnTool`：schema `background` description 改 `'true returns a task id immediately (two-phase); the subagent runs in the background and writes its conclusion line to the task output file'`；executor 首部（`validateSpawnInput` 之前）增：

```ts
      if (spec.background === true) {
        const rec = runner.spawnBackground(spec);
        return { exitCode: 0, stdout: `task ${rec.id} started (output: ${rec.outputFilePath})`, stderr: '', timedOut: false };
      }
```

7. `src/harness/index.ts`：Runner 构造 deps 增 `tasks: this.tasks,`。

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/subagent.background.test.js && node --test dist/harness/subagent.test.js`
Expected: PASS（新增 3 + 既有零误伤）。

- [ ] **Step 8: 提交**

```bash
git add src/types.ts src/harness/security/chain.ts src/harness/security/sandbox.ts src/harness/security/sandbox.test.ts src/harness/subagent.ts src/harness/subagent.background.test.ts src/harness/index.ts
git commit -m "feat(harness): 超时自动转后台+spawn 两段式开通（背景任务线 T2）"
```

---

### Task 3: task_stop 工具 + 类型登记 + 装配贯通

**Files:**
- Create: `src/harness/tools/task-stop.ts`
- Create: `src/harness/tools/task-stop.test.ts`
- Modify: `src/types.ts:215`（ToolCategory 增 `task`）
- Modify: `src/harness/security/guard.ts`（manual 分支 spawn 行后增 task_stop 免审批）
- Modify: `src/harness/tools/builtin.ts`（import 补 makeTaskStopTool）
- Modify: `src/harness/index.ts`（注册 task_stop）

**Interfaces:**
- Consumes: Task 1 `TaskRegistry`（`get/list`、`BackgroundTask.stop`）；`RegisteredTool`/`CodedToolError`（`src/harness/tools.ts`）；`SafetyChain`（执行面入参）。
- Produces: `makeTaskStopTool(tasks: TaskRegistry): RegisteredTool`（category `task`）；ToolCategory 联合含 `'task'`（并行闸门拒绝集不含 `task` → 天然可并行，规格 D8）。

- [ ] **Step 1: 写失败测试**

创建 `src/harness/tools/task-stop.test.ts`：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeTaskStopTool } from './task-stop';
import { ToolRegistry } from '../tools';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { DryRun } from '../security/dryrun';
import { TaskRegistry } from '../tasks';

function makeCtx() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-stop-test-'));
  const safety = new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const tasks = new TaskRegistry(path.join(tmp, '.data'));
  const registry = new ToolRegistry();
  registry.register(makeTaskStopTool(tasks));
  return { safety, tasks, registry };
}

test('task_stop 命中 running：触发 stop 句柄、终态 stopped、回执确认', async () => {
  const { tasks, registry, safety } = makeCtx();
  const rec = tasks.submit({ kind: 'exec', label: 'dev-server' });
  let stopped = false;
  rec.stop = () => { stopped = true; };
  const r = await registry.execute('task_stop', { id: rec.id }, safety);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  assert.equal(stopped, true);
  assert.equal(tasks.get(rec.id)?.status, 'stopped');
  assert.match(r.ok ? r.value.stdout : '', /^stopped b1 \(exec\) dev-server/);
});

test('task_stop 未命中 ID：报错列出现存任务 id+label（规格 D8 照 CC）', async () => {
  const { tasks, registry, safety } = makeCtx();
  tasks.submit({ kind: 'exec', label: 'watch-build' });
  const r = await registry.execute('task_stop', { id: 'b9' }, safety);
  assert.ok(!r.ok);
  assert.match(r.error.message, /Unknown task id: b9/);
  assert.match(r.error.message, /b1 \(exec, running\) watch-build/);
});

test('task_stop 命中已终态任务：幂等回执当前终态', async () => {
  const { tasks, registry, safety } = makeCtx();
  const rec = tasks.submit({ kind: 'subagent', label: 'w' });
  tasks.finish(rec.id, 'done');
  const r = await registry.execute('task_stop', { id: rec.id }, safety);
  assert.ok(r.ok);
  assert.match(r.ok ? r.value.stdout : '', /already done/);
  assert.equal(tasks.get(rec.id)?.status, 'done', '终态不被覆盖');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/tools/task-stop.test.js`
Expected: FAIL——`Cannot find module './task-stop'`。

- [ ] **Step 3: 类型登记 + guard 免审批 + 工具实现 + 装配**

`src/types.ts:215`：`ToolCategory` 联合追加 `| 'task'`（注释行补 `task=后台任务停止（后台任务线 D8）`）。

`src/harness/security/guard.ts`：manual 分支 `if (tool === 'spawn') return { allowed: true };` 之后增（deny 规则与硬底线仍先行——位于早退分支序内）：

```ts
    // task_stop 停止后台任务（规格 D8）：零新增破坏面（kill/abort 已批准运行中的任务），manual 下免审批对标 spawn 先例
    if (tool === 'task_stop') return { allowed: true };
```

创建 `src/harness/tools/task-stop.ts`：

```ts
import { RegisteredTool, CodedToolError } from '../tools';
import { TaskRegistry } from '../tasks';
import type { ExecResult, ToolInput } from '../../types';

/** task_stop 工具（规格 D8）：按 id 停止后台任务——stop 句柄由提交方挂载（exec=killBackground、subagent=中断线 abort）；
 * 未命中 ID 报错列出现存任务 id+label（照 CC TaskStop）；已终态幂等回执 */
export function makeTaskStopTool(tasks: TaskRegistry): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Background task id from a task-started observation line (e.g. b1)' },
      },
    },
    name: 'task_stop',
    description:
      'Stop a running background task (background exec command or background subagent) by id. The task receives a stop signal and its output file records the terminal line. If the id is unknown, the error lists all known tasks with id, kind and label.',
    category: 'task',
    executor: async (input: ToolInput) => {
      const id = String(input.id ?? '');
      const rec = tasks.get(id);
      if (!rec) {
        const rows = tasks.list().map((t) => `${t.id} (${t.kind}, ${t.status}) ${t.label}`).join('; ');
        throw new CodedToolError('INVALID_ARG', `Unknown task id: ${id}${rows ? ` — known tasks: ${rows}` : ' (no background tasks)'}`);
      }
      if (rec.status !== 'running') return { exitCode: 0, stdout: `task ${id} already ${rec.status}`, stderr: '', timedOut: false } as ExecResult;
      rec.stop?.();
      tasks.finish(id, 'stopped', { marker: '[stopped by task_stop]' });
      return { exitCode: 0, stdout: `stopped ${id} (${rec.kind}) ${rec.label}`, stderr: '', timedOut: false } as ExecResult;
    },
  };
}
```

（`ToolExecutor` 现行签名 `(input: ToolInput) => Promise<ExecResult>`（types.ts L358），executor 单参形态与其一致；`CodedToolError` 抛出经 `registry.execute` 统一面转 `fail(e.code, e.message)`，测试断言走 `r.error.message`。）

`src/harness/tools/builtin.ts`：文件尾 `builtinTools` 之后 export `makeTaskStopTool` 的再导出（供 index 装配）：`export { makeTaskStopTool } from './task-stop';`

`src/harness/index.ts`：`this.tools.register(makeSpawnTool(this.runner));` 行后增：

```ts
    this.tools.register(makeTaskStopTool(this.tasks));
```

import 行改：`import { AgentRegistry, SubagentRunner, makeSpawnTool } from './subagent';` → `import { AgentRegistry, SubagentRunner, makeSpawnTool } from './subagent';` + `import { makeTaskStopTool } from './tools/task-stop';`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/tools/task-stop.test.js && node --test dist/harness/tasks.test.js && node --test dist/harness/subagent.background.test.js`
Expected: PASS（新增 3 + Task 1/2 用例零误伤）。

- [ ] **Step 5: 提交**

```bash
git add src/harness/tools/task-stop.ts src/harness/tools/task-stop.test.ts src/types.ts src/harness/security/guard.ts src/harness/tools/builtin.ts src/harness/index.ts
git commit -m "feat(harness): task_stop 工具+task 类别登记+装配贯通（背景任务线 T3）"
```

---

### Task 4: /tasks 命令 + 收割贯通 + 文档同步 + 三门禁终验

**Files:**
- Modify: `src/tui/session.ts`（handleSlash 增 `/tasks` 分支；slashHelp 增行；`SessionController.dispose()` 增在飞任务收口回执——TUI 退出两路径（entry.ts `quit()` 与 runTuiLoop finally）共用该单点）
- Modify: `src/tui/components/App.tsx:27`（SLASH_COMMANDS 增 `/tasks`，第 19 条）
- Modify: `src/tui/tool-verbs.ts`（VERBS 增 `task_stop: 'TASK_STOP'`；TARGET_FIELD 增 `task_stop: 'id'`）
- Modify: `src/runtime.ts`（buildDeps 返回增 `tasks: h.tasks`）与 `src/loop/engine.ts`（LoopDeps 增可选 `tasks`）
- Modify: `src/cli/commands/run-loop.ts`、`src/cli/commands/run-pipeline.ts`（run 终态收口 stopAll，规格 D9）
- Modify: `src/harness/reactor.ts`（并行闸门 background exec 放行 + 协议行，规格 D6）
- Modify: `MANUAL.md`（会话命令表 +1 行）
- Test: `src/tui/session.tasks.test.ts` 新建；`src/harness/subagent.background.test.ts` 追加；`src/harness/reactor.test.ts` 追加

**Interfaces:**
- Consumes: Task 1 `TaskRegistry.list/currentOwner/runInOwnerScope/reap/stopAll`；Task 2 已落地的 fork 收割接线（runSubagent owner 作用域 + finally reap）；Harness `readonly tasks`；`this.runtime.harness.tasks`（session 访问面，沿 `/status` 经 `this.runtime.harness.ledger` 先例）。
- Produces: `/tasks` 用户命令；`LoopDeps.tasks?: TaskRegistry`（CLI 收割通道）；D6 并行闸门（background exec 进并行批）；TUI 退出收口（dispose 单点）。

- [ ] **Step 1: 写失败测试（/tasks 回执 + D6 闸门 + 收割记账）**

创建 `src/tui/session.tasks.test.ts`（构造契约与 src/tui/entry.ts L50 同形：`new SessionController({ root, mode, model })`）：

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

function makeSession(): { s: SessionController; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tasks-test-'));
  const s = new SessionController({
    root: tmp,
    mode: 'dontAsk',
    model: new ScriptedAdapter([
      JSON.stringify({ tool: 'exec', input: { command: 'echo bg-row', background: true } }),
      JSON.stringify({ done: true, reply: 'ok' }),
    ]),
  });
  return { s, tmp };
}

test('/tasks：空账本回执「暂无后台任务」', async () => {
  const { s, tmp } = makeSession();
  try {
    await s.submit('/tasks');
    const sys = s.messages.filter((m) => m.role === 'system').at(-1)!;
    assert.match(sys.text, /No background tasks|暂无后台任务/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/tasks：任务行回执 id/kind/status/label（背景任务线 D10）', async () => {
  const { s, tmp } = makeSession();
  try {
    await s.submit('起一个后台任务'); // 桩模型第 1 步 exec background:true、第 2 步 done
    await s.submit('/tasks');
    const sys = s.messages.filter((m) => m.role === 'system').at(-1)!;
    assert.match(sys.text, /b1\s+exec\s+(running|done)\s+echo/, '任务行含 id/kind/status/label');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

`src/harness/subagent.background.test.ts` 追加（收割记账单元，规格 D9）：

```ts
test('收割记账：owner 作用域内 submit 归属、reap 终结该 owner 名下 running', async () => {
  const h = makeHarness(true);
  await h.runner.runInOwnerScope('fork-1', async () => {
    const rec = h.tasks.submit({ kind: 'exec', label: 'serve' });
    assert.equal(rec.ownerRun, 'fork-1', '作用域内 submit 缺省归属当前 fork');
  });
  assert.equal(h.tasks.submit({ kind: 'exec', label: 'outside' }).ownerRun, 'main', '作用域外恒 main（跨轮存活）');
  h.tasks.reap('fork-1');
  assert.equal(h.tasks.get('b1')?.status, 'stopped');
  assert.equal(h.tasks.get('b2')?.status, 'running', 'main 任务不被误收割');
});
```

`src/harness/reactor.test.ts` 末尾追加（D6 闸门，规格 D6；`makeReactor` 夹具随 Step 3 增第 12 参 tasks 后本用例可执行）：

```ts
test('并行闸门：background exec 与其他工具同批放行（规格 D6）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-bggate-'));
  const adapter = new ScriptedAdapter([
    '{"tools":[{"tool":"exec","input":{"command":"echo bg-gate","background":true}},{"tool":"read","input":{"path":"package.json"}}],"done":false}',
    '{"done":true,"reply":"已并行"}',
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: '并行后台' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.ok(!r.steps.some((s) => s.observation.includes('Parallel batch rejected')), 'background exec 不应触发并行拒绝');
  assert.ok(r.steps.some((s) => s.observation.includes('task b1 started')), '后台 exec 提交观察行应入链');
  assert.ok(r.steps.some((s) => s.action === 'tool-call' && s.observation.includes('[tool] read')), '同批 read 照常执行');
});
```

Run: `pnpm build && node --test dist/tui/session.tasks.test.js && node --test dist/harness/subagent.background.test.js && node --test dist/harness/reactor.test.js`
Expected: FAIL——`/tasks` 报「无法识别命令」；D6 用例出现 `Parallel batch rejected`（闸门仍拦 background exec）；收割记账用例在 Task 1 语义下应已绿（作回归钉随批跑）。

- [ ] **Step 2: 实现 /tasks + slashHelp + SLASH_COMMANDS + tool-verbs**

`src/tui/session.ts` handleSlash 内 `if (cmd === '/status')` 分支之后增：

```ts
    if (cmd === '/tasks') {
      const rows = this.runtime.harness.tasks.list();
      if (rows.length === 0) {
        this.pushMsg('system', t('No background tasks', '暂无后台任务'));
        return;
      }
      const body = rows.map((r) => `${r.id}  ${r.kind.padEnd(8)} ${r.status.padEnd(8)} ${r.label}`).join('\n');
      this.pushMsg('system', t(`Background tasks:\n${body}`, `后台任务：\n${body}`));
      return;
    }
```

`slashHelp()`（session.ts L161）在 `/status` 行之前插：

```ts
    t('  /tasks         list background tasks and their output files', '  /tasks         列出后台任务及其输出文件'),
```

`src/tui/components/App.tsx:27` SLASH_COMMANDS 数组 `'/status'` 前插 `'/tasks'`。

`src/tui/tool-verbs.ts`：VERBS 增 `task_stop: 'TASK_STOP',`；TARGET_FIELD 增 `task_stop: 'id',`。

- [ ] **Step 3: 实现 fork 收割的 CLI/TUI 收口 + 并行闸门细化（规格 D9/D6）**

fork 收割接线已在 Task 2 Step 6 item 4b 落地（runSubagent owner 作用域包裹 + finally reap），本步补 CLI/TUI 收口与并行闸门：

`src/runtime.ts` buildDeps 返回对象 `pipeline: h.pipeline,` 行后增：

```ts
    // 后台任务账本透传（规格 D9）：CLI run 终态收口在飞任务
    tasks: h.tasks,
```

`src/loop/engine.ts:36` LoopDeps 接口增可选字段（import 区补 `import type { TaskRegistry } from '../harness/tasks';`）：

```ts
  /** 后台任务账本（后台任务线 D9）：CLI run 终态 stopAll 收口在飞任务 */
  tasks?: TaskRegistry;
```

`src/cli/commands/run-loop.ts`：`if (deps.pipeline) await deps.pipeline.drain();` 行前增：

```ts
  // CLI 非交互 run 终态收口在飞后台任务（规格 D9，对标 CC -p 语义）：收割经各任务 stop 句柄（kill/abort）
  deps.tasks?.stopAll();
```

`src/cli/commands/run-pipeline.ts` 同位置（pipeline 收尾段）增同一行。

`src/harness/reactor.ts` 并行闸门（L450–460）细化（规格 D6）：bash 类放行 `background=true` 的调用，拒绝文案同步——

```ts
    const rejected =
      overLimit ||
      (calls.length > 1 &&
        calls.some((c) => {
          const cat = this.deps.registry.get(c.name)?.category;
          // 后台 exec 提交即返回（规格 D6）：bash 类中 background=true 的调用可进并行批
          if (cat === 'bash' && (c.input as { background?: unknown } | undefined)?.background === true) return false;
          return cat === 'bash' || cat === 'ask' || cat === 'worktree' || cat === 'todo' || cat === undefined;
        }));
    const rejection = overLimit
      ? `Parallel batch rejected: exceeds the limit of ${PARALLEL_TOOLS_LIMIT} tools; use fewer calls per round`
      : 'Parallel batch rejected: foreground exec, ask, worktree and todo must run exclusively on their own; remove them and retry, or fall back to a single-tool call';
```

（`task` 类不在拒绝集，task_stop 天然可并行——规格 D8。既有「并行混入 exec 被整体拒绝」用例：混入的是前台 exec（无 background 字段）→ 仍拒绝，零改动保持绿；D6 新用例断言 background exec 放行。）

提示词并行协议行（reactor.ts L395，稳定段内一行）同步：

```ts
      'exec and ask tools run exclusively on their own; exec calls with background:true submit and return immediately, and multiple other tools may be called in parallel within a single round.',
```

TUI 退出收口（规格 D9「TUI 退出随进程终止、退出前回执登记」）：`src/tui/session.ts` `SessionController.dispose()` 内（空闲兜底定时器清理旁）增——entry.ts `quit()` 单点与 runTuiLoop finally 两退出路径共用该方法：

```ts
    // 在飞后台任务收口（规格 D9）：TUI 退出前收割并登记
    for (const t of this.runtime.harness.tasks.stopAll()) {
      this.pushMsg('system', t(`Background task stopped on exit: ${t.id} (${t.kind}) ${t.label}`, `后台任务随退出收割：${t.id} (${t.kind}) ${t.label}`));
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tui/session.tasks.test.js && node --test dist/harness/subagent.background.test.js && node --test dist/harness/reactor.test.js && node --test dist/tui/tool-verbs.test.js`
Expected: PASS（新增 4 + 既有零误伤；「并行混入 exec 被整体拒绝」既有用例保持绿——前台 exec 语义未变）。

- [ ] **Step 5: 文档同步（MANUAL.md，注意并发线 hunk 隔离）**

MANUAL.md 第四节会话命令表（L200–218）按字典序插入一行（`/rewind` 行之前）：

```markdown
| `/tasks` | 列出后台任务（id/kind/status/label 与输出文件路径；后台 exec 经 exec 的 `background` 参数发起，模型以 read 查看输出、以 task_stop 停止） |
```

MANUAL.md 若被并发线占用（工作区 WIP），编辑仅限本行、提交按 hunk 隔离（沿「HEAD 重放单任务增量」先例）。

- [ ] **Step 6: 三门禁终验**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: tsc strict 零报错；全量 fail 0（基线 1131+新增）；selfcheck OK、工具清单含 task_stop 且按名排序。
若全量出现「工具清单」断言失败：按名排序把 `task_stop` 补进期望清单后重跑（前缀断点随批消化，禁改断言结构）。

- [ ] **Step 7: 提交**

```bash
git add src/tui/session.ts src/tui/components/App.tsx src/tui/tool-verbs.ts src/runtime.ts src/loop/engine.ts src/harness/reactor.ts src/cli/commands/run-loop.ts src/cli/commands/run-pipeline.ts src/tui/session.tasks.test.ts src/harness/subagent.background.test.ts src/harness/reactor.test.ts MANUAL.md
git commit -m "feat(harness): /tasks 命令+收口贯通+并行闸门细化+文档同步（背景任务线 T4）"
```

---

## 验收矩阵对账（规格 §13 → 任务映射）

| 规格验收项 | 承载任务 |
|---|---|
| 1. exec background 提交即返回+日志增长+[exit N] | T1 Step 8（e2e）、T2 Step 1（sandbox 形态） |
| 2. 超时转后台观察行+sleep 豁免 | T1 Step 8（QuickTimeoutSandbox 两条集成用例）+ T2 Step 1（sandbox 形态） |
| 3. spawn 两段式立即返回+结论落文件+同步零破坏 | T2 Step 5/6 |
| 4. task_stop 命中转 stopped/未命中列任务 | T3 Step 1 |
| 5. background exec 进并行批/前台仍独占 | T4 Step 1（D6 闸门用例）+ T4 Step 3（闸门实现；既有「混入前台 exec 被拒」用例零改动保持绿） |
| 6. task_stop 免审批+deny 先行 | T3 Step 3（guard 分支位次） |
| 7. 前台子代理收口收割/主链跨轮存活//new 保留 | T2 Step 6 item 4b（收割接线）+ T4 Step 1（收割记账用例）+ T4 Step 3（CLI/TUI 收口） |
| 8. 前缀回归+动态面审计 | Global Constraints + T4 Step 6 全量 |
| 9. /tasks 双语回执+手册同步 | T4 Step 2/5 |
| 10. 三门禁 | T4 Step 6 |

