# 统一主链 · 1D 多后端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
>
> 设计依据：docs/superpowers/specs/2026-09-05-phase1-harness-spine-1d-design.md（评审稿，commit a72ff27）
> 验收目标：总纲 A2 扩展（所有执行经 Tool.execute 且 IO 经统一后端）+ 本 spec D1–D3

## Global Constraints（逐字执行）

- 零新增 npm 依赖；测试仅用 `node --test`；`tsconfig` 保持 strict；模块 CommonJS，import 用相对路径。
- **零回归红线**：现有全部测试（77 个）断言零改动全绿；仅允许在 `sandbox.test.ts` / `tools.test.ts` 末尾追加新用例。
- `types.ts` 新增 `ToolBackend` 需 `import type { Result, ExecResult }`（Result 为泛型类型，用 `import type` 避免运行时环）。
- **同一文件多处编辑分轮串行**（1B 教训：同轮并行多 edit 会覆盖丢失）。
- TDD 铁律：先写失败测试并亲眼确认红灯（编译错或断言失败），再实现转绿。
- 提交前必须 `npm run build`（零报错）+ `npm test` 全绿；每任务一提交，显式 `git add <文件列表>`，禁止 `git add -A`。
- 环境硬约束：`src/` 属 root:root——修改已有文件用 sandbox__edit，shell 无法写 src/。

## File Structure（改动面）

| 文件 | 改动 |
|---|---|
| `src/types.ts` | 登记并导出 `ToolBackend` 接口 |
| `src/harness/security/sandbox.ts` | 删 `Sandbox` 接口；`ProcessSandbox implements ToolBackend`；迁入文件 IO 三方法与 glob 逻辑 |
| `src/harness/security/chain.ts` | 构造第二参 `Sandbox` → `ToolBackend`；`run` 委托 `backend.exec`；暴露 `readonly backend` |
| `src/harness/tools/builtin.ts` | read/write/grep/glob 改经 `safety.backend`；删 fs/path import 与 `findFiles`/`globToRegex` |
| `src/harness/security/sandbox.test.ts` | 追加后端用例 |
| `src/harness/tools/tools.test.ts` | 追加探针后端用例 |

---

### Task 1: ToolBackend 接口与 process 后端文件 IO 迁入

**Goal**: `ToolBackend` 落 types.ts；ProcessSandbox 扩展为 process 后端（exec 不动 + 文件三方法 + glob 迁入）；旧 `Sandbox` 接口删除。本任务不动 chain/builtin（T2 消费）。

- [ ] **Step 1: 写失败测试**

`src/harness/security/sandbox.test.ts` 头部 import 区追加：

```ts
import { ToolBackend } from '../../types';
```

文件末尾追加 3 个用例：

```ts
test('ProcessSandbox 是 ToolBackend（name=process，含文件三方法）', () => {
  const b: ToolBackend = new ProcessSandbox();
  assert.equal(b.name, 'process');
  assert.equal(typeof b.readFile, 'function');
  assert.equal(typeof b.writeFile, 'function');
  assert.equal(typeof b.listFiles, 'function');
});

test('writeFile/readFile 往返（含父目录自动创建）', () => {
  const b = new ProcessSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1d-'));
  const file = path.join(dir, 'a/b/c.txt');
  b.writeFile(file, 'hello 1d');
  assert.equal(b.readFile(file), 'hello 1d');
});

test('listFiles glob 语义：** 跨目录段、跳过 node_modules', () => {
  const b = new ProcessSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1d-glob-'));
  fs.mkdirSync(path.join(dir, 'sub/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'node_modules', 'skip.txt'), 'x');
  const rel = b.listFiles(dir, '**/*.txt').sort();
  assert.deepEqual(rel, ['sub/deep.txt', 'top.txt']);
});
```

（若测试文件缺 `os`/`path`/`fs` import，补齐。）

- [ ] **Step 2: 红灯确认**

`npm run build 2>&1 | grep 'error TS'`：预期 `TS2339`——`ToolBackend` 不存在、`ProcessSandbox` 缺 `name/readFile/writeFile/listFiles`。

- [ ] **Step 3: 实现**

1. `src/types.ts`：文件内合适分区（ExecResult 附近）登记并导出：

```ts
/** Tool 执行后端：命令与文件 IO 的统一执行面（process 现行，Docker/SSH 预留接口位） */
export interface ToolBackend {
  /** 后端标识，如 process / docker / ssh */
  readonly name: string;
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<import('./result').Result<ExecResult>>;
  readFile(absPath: string): string;
  /** 写入含父目录自动创建（维持现行 write 语义） */
  writeFile(absPath: string, content: string): void;
  listFiles(root: string, pattern: string): string[];
}
```

2. `src/harness/security/sandbox.ts` 重写为：

```ts
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExecResult, ToolBackend } from '../../types';
import { Result, ok, fail } from '../../result';

/** process 执行后端：本机进程隔离沙箱 + 文件 IO（Docker/SSH 后端同接口预留，1D 不实现） */
export class ProcessSandbox implements ToolBackend {
  readonly name = 'process';

  async exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
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

  readFile(absPath: string): string {
    return fs.readFileSync(absPath, 'utf8');
  }

  writeFile(absPath: string, content: string): void {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }

  listFiles(root: string, pattern: string): string[] {
    const re = new RegExp(globToRegex(pattern));
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else {
          const rel = path.relative(root, full);
          if (re.test(rel)) out.push(rel);
        }
      }
    };
    walk(root);
    return out;
  }
}

/** 文件路径 glob 转正则：双星号斜杠匹配零个或多个目录段，单星号与问号不跨越斜杠 */
function globToRegex(pattern: string): string {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      let j = i;
      while (pattern[j] === '*') j++;
      if (pattern[j] === '/') {
        out += '(?:[^/]*/)*';
        i = j + 1;
      } else {
        out += '[^/]*';
        i = j;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else {
      out += escapeRegExp(c);
      i++;
    }
  }
  return out + '$';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: 全绿确认**

`npm run build` 零报错；`npm test` 期望 80/80/0（既有 77 用例零改动全绿——`run` 方法消失会导致 chain.test 若引用 `.run` 编译失败即暴露消费点，属预期红灯引导，届时同步 T1 范围内最小修复并记录）。

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/harness/security/sandbox.ts src/harness/security/sandbox.test.ts
git commit -m "feat(harness): ToolBackend 接口与 process 后端文件 IO（1D/T1）"
```

---

### Task 2: SafetyChain 执行面切换与 builtin 去双轨

**Goal**: chain 构造改 ToolBackend、`run` 委托 `backend.exec`、暴露 `backend`；builtin 文件工具改经 `safety.backend`，删净 fs 直连；探针后端实证可替换（D2）。

- [ ] **Step 1: 写失败测试**

`src/harness/tools/tools.test.ts` 头部 import 区追加：

```ts
import { ToolBackend } from '../../types';
import { ExecResult } from '../../types';
import { Result, ok } from '../../result';
import { ProcessSandbox } from '../security/sandbox';
```

文件末尾追加 2 个用例：

```ts
test('文件工具经统一后端执行（write 走 backend.writeFile）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-1d-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), dir);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, dir)) registry.register(t);

  const r = await registry.execute('write', { path: 'out/x.txt', content: 'via backend' }, safety);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'x.txt'), 'utf8'), 'via backend');
  assert.ok(!('fs' in (safety.backend as object)), '后端经接口消费');
});

test('D2 后端可替换：探针 stub 注入即换', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-1d-stub-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'real');
  const real = new ProcessSandbox();
  const calls: string[] = [];
  const probe: ToolBackend = {
    name: 'probe',
    exec: async (cmd, opts) => { calls.push(`exec:${cmd}`); return real.exec(cmd, opts); },
    readFile: (p) => { calls.push(`read:${p}`); return real.readFile(p); },
    writeFile: (p, c) => { calls.push(`write:${p}`); return real.writeFile(p, c); },
    listFiles: (root, pattern) => { calls.push(`glob:${pattern}`); return real.listFiles(root, pattern); },
  };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), probe, new DryRun(), dir);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, dir)) registry.register(t);

  const w = await registry.execute('write', { path: 'a.txt', content: 'x' }, safety);
  const g = await registry.execute('glob', { pattern: '*.txt' }, safety);
  assert.equal(w.ok, true);
  assert.equal(g.ok, true);
  assert.ok(calls.some((c) => c.startsWith('write:')), 'write 经后端');
  assert.ok(calls.some((c) => c.startsWith('glob:')), 'glob 经后端');
});
```

（若测试文件已 import 上述符号则去重；`DryRun`/`SecurityGuard`/`PolicyEngine` 等按该文件既有 import 为准。）

- [ ] **Step 2: 红灯确认**

`npm run build 2>&1 | grep 'error TS'`：预期 `TS2551/TS2339`——SafetyChain 第二参不接受 `ToolBackend`（构造签名仍是旧 Sandbox 或 `.run` 不存在导致 probe 缺方法）、`safety.backend` 不存在。

- [ ] **Step 3: 实现**

1. `src/harness/security/chain.ts`：

```ts
// import 区：删 `import { Sandbox } from './sandbox';`，改
import { ToolBackend } from '../../types';

export class SafetyChain {
  constructor(
    private guard: SecurityGuard,
    readonly backend: ToolBackend,
    private dryrun: DryRun,
    private readonly root: string,
  ) {}
  // ...
  /** exec 委托统一后端：命令执行单一执行路径 */
  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    return this.backend.exec(cmd, opts);
  }
```

2. `src/harness/tools/builtin.ts`：

- 删 `import * as fs from 'fs';` 与 `import * as path from 'path';`（path 仅 write 用过；确认无其他引用后删净）。
- read：`executor: async (input) => execOut(safety.backend.readFile(String(input.path)))`
- write：`safety.backend.writeFile(String(input.path), String(input.content ?? ''))`（父目录创建已在后端内），返回 `execOut('written')`
- grep：`const content = safety.backend.readFile(String(input.path));` 其余行过滤不变
- glob：`const matches = safety.backend.listFiles(root, String(input.pattern ?? '*'));`
- 删除文件尾部 `findFiles` 与 `globToRegex`（逻辑已迁 sandbox.ts）

- [ ] **Step 4: 全绿确认**

`npm run build` 零报错；`npm test` 期望 82/82/0（既有用例零改动全绿：chain/tools/stability/reactor 全部以 ProcessSandbox 传入，类型兼容即回归证明）；`npm run selfcheck` 通过。

- [ ] **Step 5: 提交 + A2 扩展结构复核**

```bash
grep -n 'fs\.' src/harness/tools/ | grep -v test   # 期望仅 builtin.ts 无命中（fs 引用只在 sandbox.ts 后端实现）
git add src/harness/security/chain.ts src/harness/tools/builtin.ts src/harness/tools/tools.test.ts
git commit -m "feat(harness): 执行面统一——chain 切 ToolBackend，builtin 文件工具去 fs 直连（1D/T2）"
```

---

## 验收标准映射（D1–D3 / A2 扩展）

| 编号 | 判据 | 对应用例 |
|---|---|---|
| D1 执行面统一 | 全部工具 IO 经 ToolBackend；builtin 零直连 fs | T2 两用例 + `grep 'fs\.' src/harness/tools/` 复核 |
| D2 后端可替换 | 接口注入即换 | T2 探针 stub 用例 |
| D3 预留不残渣 | 无 Docker/SSH 空壳类 | 收尾 `grep -rn 'docker\|Docker' src/` 复核 |
| A2 扩展 | 所有执行经 Tool.execute 且 IO 经统一后端 | D1 + 既有 tools/stability 用例零回归 |

## Self-Review

1. 既有 77 用例是否零改动？——是；ProcessSandbox 类名不变、构造点全兼容，新用例全部追加。
2. `run` 方法改名会否破坏消费者？——`SafetyChain.run` 保留（唯一消费者 builtin），内部委托 `backend.exec`；`ProcessSandbox.run` 更名 `exec` 由接口统一，其直接消费者仅 chain（经 T2 委托后无外部直调）与 sandbox.test 既有用例——**注意：sandbox.test 既有用例若调用 `.run(`，在 T1 红灯/绿灯阶段同步改为 `.exec(` 并记为 T1 范围内必要适配（属测试与接口同名对齐，非行为变更）**。
3. 档位行/checksum/水位线是否受影响？——否；1B/1C 语义零触碰。
4. glob 行为是否逐字节一致？——globToRegex 与 findFiles 逐行搬迁，T2 用例 `**/*.txt` 断言兜底。
5. Docker/SSH 预留形态？——仅接口 + 注入位，无空壳类（D3 复核兜底）。
