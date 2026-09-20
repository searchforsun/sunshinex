# Session Rewind + Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TUI 会话补齐 /rewind（回退到过去任意任务轮，对话必选、代码可选）与 /fork（从任意会话任意轮复制平行会话），底层为 Codex 式不可变分档 + CC 式 write 影子快照。

**Architecture:** journal JSONL（schema v1 additive 扩展）为单一事实源：`branchFrom` 原语复制源档前缀到新档（header 记血缘、逐字节前缀）并切活动指针，rewind 与 fork 数据面同一、仅 kind 展示语义不同；代码回退由 write 工具执行前 pre-image 内容寻址快照（`<dataDir>/sessions/_blobs/<sha256>`）+ 单文件收集回退算法承载；交互复用 `askUser` 问询管线（选择器已就绪）。

**Tech Stack:** TypeScript strict + Node.js（node:fs / node:crypto / node:path，零新依赖）。

**Spec:** `docs/superpowers/specs/2026-09-20-session-rewind-fork-design.md`（含 §6.2 复审修正）

## Global Constraints

- 前缀缓存第一要义：rewind/fork 只发生在 idle 边界；零新工具、工具清单零变化、提示词装配面零改动。
- journal schema v1 内 additive：header 增可选 `forkedFrom`、user 事件增可选 `files`；**版本号不升（v 保持 1）**，`restoreFromSession` 的 `replay.version !== 1` 守卫零改动。
- 不可变分档：源档一个字节不动；新档第 2..upToLine 行与源档逐字节相等。
- 分支点语义：`upToLine = 锚点行号 − 1`，锚点 user 事件行不进新档；锚点轮输入经输入框回填由用户重发进链。
- 代码回退收集面=单一档案（行号 ≥ 锚点行号，含锚点轮自身写入，每文件取行号最早一条）；不上溯血缘、祖先平行时间线不参与。
- 代码快照只跟踪 write 工具；exec 副作用/外部编辑/symlink/hardlink 不跟踪；不是 git 替代。
- 错误通道：数据面错误 throw Error（`INVALID_ARG: ...` 前缀），session 层 catch 转 system 消息（warn），零静默吞。
- 回执/链行文案英文单语（写链零新增）；上屏 system 消息走 `t()` 双语。
- 本线与并发线 WIP（40+ 脏文件）混叠：**每任务提交只 add 本线文件**（新测试文件独立命名；session.ts / TUI-MANUAL.md 等重叠文件按 hunk 只挑本线改动，`git add -p`）。
- 门禁：`pnpm build` tsc strict 零报错 + `pnpm test` 全量 fail 0 + `pnpm selfcheck` OK。

## File Structure

| 文件 | 动作 | 职责（任务） |
|------|------|------|
| `src/tui/session-journal.ts` | 修改 | 类型扩展、buf 对象化 + amendLastUser、parseJournalFile 行号、listAnchors、branchFrom、SessionMeta.forkedFrom（T1/T5） |
| `src/harness/tools/write-snapshot.ts` | 新建 | WriteSnapshotCollector：pre-image 捕获 + blob 内容寻址存储（T2） |
| `src/harness/tools/builtin.ts` | 修改 | write executor 接 capture 钩子，builtinTools 增第 10 可选参（T2） |
| `src/harness/index.ts` | 修改 | Harness 装配 writeSnapshot sink 单点（T2） |
| `src/tui/session.ts` | 修改 | 任务轮起点登记 user 事件、flushJournal 清单回填（T3）；/rewind //fork、回填、/resume Fork from…、血缘标注（T5）；TuiState.backfill 瞬态字段（T5，L105 TuiState 内） |
| `src/tui/session-snapshots.ts` | 新建 | collectRestorePlan + applyRestorePlan 纯模块（T4） |
| `src/tui/components/App.tsx` | 修改 | backfill 消费 effect（回填输入框）（T5） |
| `src/tui/session-journal.branch.test.ts` | 新建 | T1 |
| `src/harness/tools/write-snapshot.test.ts` | 新建 | T2 |
| `src/tui/session.turnlog.test.ts` | 新建 | T3 |
| `src/tui/session-snapshots.test.ts` | 新建 | T4 |
| `src/tui/session.rewind.test.ts` | 新建 | T5 |
| `TUI-MANUAL.md` / `README.md` | 修改 | 文档同步（T6） |

---

### Task 1: journal 分档原语（branchFrom / listAnchors / amendLastUser）

**Files:**
- Modify: `src/tui/session-journal.ts`
- Test: `src/tui/session-journal.branch.test.ts`（新建，独立文件避免与并发线竞态）

**Interfaces:**
- Consumes: 既有 `JournalHeader`/`JournalEvent`/`parseJournalFile`/`newSessionId`/`writeActivePointer`/`sessionsDir`。
- Produces（后续任务依赖的精确签名）:
  - `export interface SnapshotEntry { path: string; hash: string; deleted?: true }`（path=相对项目根 POSIX；deleted=true 表示写入时文件不存在，hash 置空串）
  - `export interface ForkedFrom { sourceSessionId: string; upToLine: number; kind: 'rewind' | 'fork' }`
  - `JournalHeader` 增 `forkedFrom?: ForkedFrom`；`JournalEvent` 的 user 分支增 `files?: SnapshotEntry[]`
  - `parseJournalFile(file): ParsedJournal`，`ParsedJournal` 增 `lines: string[]`
  - `listAnchors(parsed: ParsedJournal): Array<{ line: number; text: string }>`（line=文件 1-based 行号）
  - `branchFrom(dataDir: string, sourceId: string, upToLine: number, kind: 'rewind' | 'fork', opts?: { now?: Date }): string`
  - `SessionJournal.amendLastUser(files: SnapshotEntry[]): boolean`

- [ ] **Step 1: 写失败测试**

新建 `src/tui/session-journal.branch.test.ts`：

```ts
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { test } from 'node:test';
import {
  branchFrom, listAnchors, parseJournalFile, readActivePointer, SessionJournal, sessionsDir,
} from './session-journal';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-branch-'));
}
/** 造一个最小合法档：header + N 轮（user+msg） */
function makeJournal(dataDir: string, id: string, turns: string[]): void {
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const lines = [`{"t":"header","v":1,"id":"${id}","createdAt":"2026-09-20T00:00:00.000Z"}`];
  for (const text of turns) {
    lines.push(`{"t":"user","text":${JSON.stringify(text)}}`);
    lines.push(`{"t":"msg","item":{"role":"assistant","text":"ok","seq":1}}`);
  }
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('branchFrom: 前缀逐字节复制 + header 重写 + 指针切换', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src01', ['first', 'second']);
  // 源档 5 行；锚点=第 2 轮 user 行（行 3）→ upToLine=2，新档含 1..2 行
  const newId = branchFrom(dataDir, 'src01', 2, 'rewind', { now: new Date('2026-09-20T01:00:00Z') });
  assert.notEqual(newId, 'src01');
  const rawSrc = fs.readFileSync(path.join(sessionsDir(dataDir), 'src01.jsonl'), 'utf8').split('\n');
  const rawNew = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').split('\n');
  assert.equal(rawNew.length, 3); // 2 行 + 尾空串
  assert.equal(rawNew[1], rawSrc[1]); // 逐字节相等
  const header = JSON.parse(rawNew[0]);
  assert.equal(header.v, 1);
  assert.equal(header.id, newId);
  assert.deepEqual(header.forkedFrom, { sourceSessionId: 'src01', upToLine: 2, kind: 'rewind' });
  assert.equal(readActivePointer(dataDir), newId);
});

test('branchFrom: upToLine=1 产出仅 header 的空会话档', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src02', ['only']);
  const newId = branchFrom(dataDir, 'src02', 1, 'fork');
  const raw = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').split('\n');
  assert.equal(raw.length, 2);
  assert.equal(JSON.parse(raw[0]).forkedFrom.upToLine, 1);
});

test('branchFrom: 源档一个字节不动', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src03', ['a']);
  const file = path.join(sessionsDir(dataDir), 'src03.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  const beforeMtime = fs.statSync(file).mtimeMs;
  branchFrom(dataDir, 'src03', 2, 'rewind');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
});

test('branchFrom: 越界/坏行/缺档拒绝', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src04', ['a']);
  assert.throws(() => branchFrom(dataDir, 'src04', 0, 'rewind'), /INVALID_ARG/);
  assert.throws(() => branchFrom(dataDir, 'src04', 99, 'rewind'), /INVALID_ARG/);
  fs.writeFileSync(path.join(sessionsDir(dataDir), 'broken.jsonl'),
    '{"t":"header","v":1,"id":"broken","createdAt":"x"}\n{broken\n', 'utf8');
  assert.throws(() => branchFrom(dataDir, 'broken', 2, 'rewind'), /INVALID_ARG/);
  assert.throws(() => branchFrom(dataDir, 'no-such', 1, 'rewind'));
});

test('listAnchors: 行号 1-based 且与 user 事件对应', () => {
  const dataDir = tmpRoot();
  makeJournal(dataDir, 'src05', ['first', 'second']);
  const parsed = parseJournalFile(path.join(sessionsDir(dataDir), 'src05.jsonl'));
  const anchors = listAnchors(parsed);
  assert.deepEqual(anchors.map((a) => a.line), [2, 4]);
  assert.equal(anchors[0].text, 'first');
});

test('listAnchors: 撕裂尾行不入锚点', () => {
  const dataDir = tmpRoot();
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), 'torn.jsonl'),
    '{"t":"header","v":1,"id":"torn","createdAt":"x"}\n{"t":"user","text":"ok"}\n{"t":"msg","item":{to', 'utf8');
  const anchors = listAnchors(parseJournalFile(path.join(sessionsDir(dataDir), 'torn.jsonl')));
  assert.deepEqual(anchors.map((a) => a.line), [2]);
});

test('amendLastUser: 缓冲内最后一条 user 事件回填 files 后随 flush 落盘', () => {
  const dataDir = tmpRoot();
  const j = new SessionJournal(dataDir);
  j.start();
  j.log({ t: 'user', text: 'task one' });
  j.log({ t: 'msg', item: { role: 'assistant', text: 'r', seq: 1 } });
  assert.equal(j.amendLastUser([{ path: 'a.txt', hash: 'h1' }]), true);
  assert.equal(j.flush(), true);
  const id = j.currentId!;
  const lines = fs.readFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(lines[1]), { t: 'user', text: 'task one', files: [{ path: 'a.txt', hash: 'h1' }] });
  assert.equal(j.amendLastUser([]), false); // flush 后缓冲空 → false
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session-journal.branch.test.js 2>&1 | tail -5`
Expected: FAIL（`branchFrom` / `listAnchors` 未导出，tsc 编译报错）

- [ ] **Step 3: 最小实现**

`src/tui/session-journal.ts` 修改（4 处）：

① 类型扩展（`JournalHeader` 之前插入两个新接口；`JournalHeader` 与 user 事件分支加字段）：

```ts
/** 分档血缘（规格 2026-09-20 rewind+fork §5.1）：upToLine=源档 1-based 行号，新档含源档第 1..upToLine 行 */
export interface ForkedFrom {
  sourceSessionId: string;
  upToLine: number;
  kind: 'rewind' | 'fork';
}

/** write 影子快照条目：path=相对项目根 POSIX；deleted=true 表示写入时文件不存在（hash 置空串） */
export interface SnapshotEntry {
  path: string;
  hash: string;
  deleted?: true;
}
```

`JournalHeader` 增：`forkedFrom?: ForkedFrom;`；user 事件分支改为 `| { t: 'user'; text: string; files?: SnapshotEntry[] }`。

② `ParsedJournal` 增 `lines: string[]`，`parseJournalFile` 同步收集：

```ts
export interface ParsedJournal {
  events: JournalEvent[];
  lines: string[];
  truncated: boolean;
}
```

```ts
export function parseJournalFile(file: string): ParsedJournal {
  const events: JournalEvent[] = [];
  const lines: string[] = [];
  let truncated = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
      lines.push(line);
    } catch {
      truncated = true;
      break;
    }
  }
  return { events, lines, truncated };
}
```

③ 新增锚点枚举与分档原语（放 `listSessions` 之后）：

```ts
export interface JournalAnchor {
  line: number;
  text: string;
}

/** 任务锚点枚举（规格 D4）：每条 user 事件一个锚点，line 为文件 1-based 行号 */
export function listAnchors(parsed: ParsedJournal): JournalAnchor[] {
  const anchors: JournalAnchor[] = [];
  parsed.events.forEach((e, i) => {
    if (e.t === 'user') anchors.push({ line: i + 1, text: e.text });
  });
  return anchors;
}

/**
 * 分档原语（规格 §5.2）：复制源档第 1..upToLine 行到新档（第 2..upToLine 行逐字节相等），
 * header 重写（新 id / 新 createdAt / forkedFrom 血缘），写新档并切活动指针；源档零改动。
 * 任一前缀行非合法 JSON、upToLine 越界、源档缺失即 throw Error('INVALID_ARG: ...')，零副作用。
 */
export function branchFrom(
  dataDir: string,
  sourceId: string,
  upToLine: number,
  kind: 'rewind' | 'fork',
  opts?: { now?: Date },
): string {
  const srcFile = path.join(sessionsDir(dataDir), sourceId + '.jsonl');
  const all = fs.readFileSync(srcFile, 'utf8').split('\n');
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  if (!Number.isInteger(upToLine) || upToLine < 1 || upToLine > all.length) {
    throw new Error(`INVALID_ARG: upToLine out of range: ${upToLine} (file has ${all.length} lines)`);
  }
  const kept = all.slice(0, upToLine);
  for (let i = 0; i < kept.length; i++) {
    try {
      JSON.parse(kept[i]);
    } catch {
      throw new Error(`INVALID_ARG: source journal line ${i + 1} is not valid JSON`);
    }
  }
  const header = JSON.parse(kept[0]) as JournalHeader;
  if (header.t !== 'header') throw new Error('INVALID_ARG: source journal line 1 is not a header');
  const newId = newSessionId(opts?.now);
  const now = (opts?.now ?? new Date()).toISOString();
  // spread 保持原字段序，id/createdAt 原位覆盖，forkedFrom 尾追
  const newHeader: JournalHeader = { ...header, id: newId, createdAt: now, forkedFrom: { sourceSessionId: sourceId, upToLine, kind } };
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), [JSON.stringify(newHeader), ...kept.slice(1)].join('\n') + '\n', 'utf8');
  writeActivePointer(dataDir, newId);
  return newId;
}
```

④ `SessionJournal` 缓冲对象化 + amendLastUser：

- 字段 `private buf: string[] = []` 改 `private buf: JournalEvent[] = []`；
- `log()`：`this.buf.push(JSON.stringify(event))` 改 `this.buf.push(event)`；
- `flush()`：`this.buf.join('\n') + '\n'` 改 `this.buf.map((e) => JSON.stringify(e)).join('\n') + '\n'`；
- 新方法：

```ts
  /** 任务收口回填（规格 §6.1）：本任务 write 的影子快照清单补进该轮 user 事件；缓冲内无 user 事件返回 false */
  amendLastUser(files: SnapshotEntry[]): boolean {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].t === 'user') {
        if (files.length === 0) return true; // 空清单不写字段（与 v1 旧档形态一致）
        (this.buf[i] as Extract<JournalEvent, { t: 'user' }>).files = files;
        return true;
      }
    }
    return false;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build && node --test dist/tui/session-journal.branch.test.js dist/tui/session-journal.test.js 2>&1 | tail -5`
Expected: 新套件 7 用例全绿；既有 `session-journal.test.js` 全绿（`ParsedJournal.lines` 为新增字段，既有消费者零破坏）

- [ ] **Step 5: 提交（只含本任务两个文件）**

```bash
git add src/tui/session-journal.ts src/tui/session-journal.branch.test.ts
git commit -m "feat(journal): branchFrom 分档原语 + 任务锚点枚举 + user 事件 files 回填（rewind/fork T1）"
```

---

### Task 2: write 影子快照捕获（blob store + 工具接线）

**Files:**
- Create: `src/harness/tools/write-snapshot.ts`
- Modify: `src/harness/tools/builtin.ts`（write executor 约 L130-152；`builtinTools` 签名 L39 增第 10 可选参）
- Modify: `src/harness/index.ts`（装配行 L88 附近）
- Test: `src/harness/tools/write-snapshot.test.ts`（新建）

**Interfaces:**
- Consumes: T1 的 `SnapshotEntry`（type-only import，编译期擦除、零运行时层向依赖）。
- Produces:
  - `export class WriteSnapshotCollector { constructor(blobsDir: string); captureRooted(absPath: string, relPosix: string): void; drain(): SnapshotEntry[] }`
  - `export function makeWriteSnapshotSink(dataDir: string, root: string): { capture(p: string): void; drain(): SnapshotEntry[] }`
  - `Harness` 增 `readonly writeSnapshot: ReturnType<typeof makeWriteSnapshotSink>`（恒装配，capture 仅 write 执行时产生 IO）
  - `builtinTools(..., writeSnapshot?: { capture(p: string): void; drain(): SnapshotEntry[] })`（第 10 参）

- [ ] **Step 1: 写失败测试**

新建 `src/harness/tools/write-snapshot.test.ts`（构造参数与 `builtin.ask.test.ts` 现行形态对齐——落点时以该测试文件实际 import 为准）：

```ts
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { test } from 'node:test';
import { WriteSnapshotCollector, makeWriteSnapshotSink } from './write-snapshot';
import { builtinTools } from './builtin';
import { ToolRegistry } from './tools';
import { SafetyChain, SecurityGuard, ProcessSandbox, DryRun } from '../security/chain';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'write-snap-'));
}
function registry(root: string, sink?: ReturnType<typeof makeWriteSnapshotSink>): ToolRegistry {
  const r = new ToolRegistry();
  const safety = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), root);
  for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sink)) r.register(t);
  return r;
}

test('captureRooted: 存在文件 → hash 条目 + blob 内容寻址落盘', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const blobs = path.join(root, 'blobs');
  const c = new WriteSnapshotCollector(blobs);
  c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
  const entries = c.drain();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'a.txt');
  assert.equal(entries[0].deleted, undefined);
  assert.equal(fs.readFileSync(path.join(blobs, entries[0].hash)).toString(), 'hello');
});

test('captureRooted: 不存在文件 → deleted 条目且无 blob', () => {
  const root = tmp();
  const c = new WriteSnapshotCollector(path.join(root, 'blobs'));
  c.captureRooted(path.join(root, 'nope.txt'), 'nope.txt');
  assert.deepEqual(c.drain(), [{ path: 'nope.txt', hash: '', deleted: true }]);
});

test('captureRooted: 同文件两次捕获 → 两条目 + blob 各自单份', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'v1');
  const blobs = path.join(root, 'blobs');
  const c = new WriteSnapshotCollector(blobs);
  c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
  fs.writeFileSync(path.join(root, 'a.txt'), 'v2');
  c.captureRooted(path.join(root, 'a.txt'), 'a.txt');
  assert.equal(c.drain().length, 2);
  assert.equal(fs.readdirSync(blobs).length, 2);
});

test('makeWriteSnapshotSink: 相对路径按 root 解析、root 外跳过', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'b.txt'), 'old');
  const sink = makeWriteSnapshotSink(path.join(root, 'data'), root);
  sink.capture('b.txt');
  assert.equal(sink.drain().length, 1);
  sink.capture('/etc/hostname');
  assert.equal(sink.drain().length, 0);
});

test('builtin write 执行后 sink 收到 pre-image（dontAsk 免审批直写）', async () => {
  const root = tmp();
  const sink = makeWriteSnapshotSink(path.join(root, 'data'), root);
  const r = registry(root, sink);
  fs.writeFileSync(path.join(root, 'b.txt'), 'old');
  await r.execute('write', { path: 'b.txt', content: 'new' });
  const entries = sink.drain();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'b.txt');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'sessions', '_blobs', entries[0].hash)).toString(), 'old');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/harness/tools/write-snapshot.test.js 2>&1 | tail -5`
Expected: FAIL（`write-snapshot` 模块不存在）

- [ ] **Step 3: 最小实现**

① 新建 `src/harness/tools/write-snapshot.ts`：

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SnapshotEntry } from '../../tui/session-journal';

/**
 * write 影子快照收集器（规格 2026-09-20 rewind+fork §6.1）：
 * 每次 write 落盘前捕获目标文件当前状态（pre-image），内容寻址存 <blobsDir>/<sha256>（跨会话去重）；
 * 任务收口时 drain() 交 SessionJournal.amendLastUser 随 user 事件落盘。仅进程内存清单，零工具面变化。
 */
export class WriteSnapshotCollector {
  private pending: SnapshotEntry[] = [];

  constructor(private readonly blobsDir: string) {}

  /** absPath=绝对路径，relPosix=相对项目根的 POSIX 路径（调用方已解析） */
  captureRooted(absPath: string, relPosix: string): void {
    try {
      const content = fs.readFileSync(absPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      fs.mkdirSync(this.blobsDir, { recursive: true });
      const blob = path.join(this.blobsDir, hash);
      if (!fs.existsSync(blob)) fs.writeFileSync(blob, content);
      this.pending.push({ path: relPosix, hash });
    } catch {
      this.pending.push({ path: relPosix, hash: '', deleted: true }); // 写入时不存在（新建类写入）
    }
  }

  drain(): SnapshotEntry[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/** 装配接缝：capture 接受工具原始入参（相对项目根或绝对），内部解析；root 外路径跳过（安全链本应拒绝，防御性兜底） */
export function makeWriteSnapshotSink(dataDir: string, root: string): { capture(p: string): void; drain(): SnapshotEntry[] } {
  const collector = new WriteSnapshotCollector(path.join(dataDir, 'sessions', '_blobs'));
  return {
    capture(p: string): void {
      const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return;
      collector.captureRooted(abs, rel.split(path.sep).join('/'));
    },
    drain: () => collector.drain(),
  };
}
```

② `builtin.ts`：文件头加 `import type { SnapshotEntry } from '../../tui/session-journal';`；`builtinTools` 签名末尾增第 10 参 `writeSnapshot?: { capture(p: string): void; drain(): SnapshotEntry[] }`；write executor 内 memory 接缝块之后、`backend.writeFile(p, content);` 之前插一行：

```ts
        // write 影子快照（rewind/fork 规格 §6.1）：落盘前捕获 pre-image；记忆接缝路径不经过此处（上文已 return）
        writeSnapshot?.capture(p);
```

③ `src/harness/index.ts`：import `makeWriteSnapshotSink`；`this.tools = new ToolRegistry();` 前后加装配：

```ts
    // write 影子快照单点（rewind/fork 规格 §6.1）：blob 落数据目录，清单随任务收口进 user 事件（T3 接线）
    this.writeSnapshot = makeWriteSnapshotSink(resolveDataDir(base), base);
```

类体增 `readonly writeSnapshot: ReturnType<typeof makeWriteSnapshotSink>;`，`builtinTools(...)` 调用末尾补第 10 参 `this.writeSnapshot`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build && node --test dist/harness/tools/write-snapshot.test.js dist/tui/session-journal.branch.test.js 2>&1 | tail -5`
Expected: PASS（5 新用例 + T1 套件回归绿）

- [ ] **Step 5: 提交（只含本任务四个文件）**

```bash
git add src/harness/tools/write-snapshot.ts src/harness/tools/write-snapshot.test.ts src/harness/tools/builtin.ts src/harness/index.ts
git commit -m "feat(snapshot): write pre-image 影子快照捕获 + blob 内容寻址存储（rewind/fork T2）"
```

---

### Task 3: 收口回填接线（writeSnapshot.drain → amendLastUser）

**Files:**
- Modify: `src/tui/session.ts`（`flushJournal`，约 L543-556）
- Test: `src/tui/session.turnlog.test.ts`（新建）

**Interfaces:**
- Consumes: T1 `SessionJournal.amendLastUser`、T2 `Harness.writeSnapshot`。
- Produces: 无新接口（接线任务）；行为=任务收口时本任务 write 的影子快照清单随该轮 user 事件落盘。

- [ ] **Step 1: 写失败测试**

新建 `src/tui/session.turnlog.test.ts`：

```ts
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { parseJournalFile, readActivePointer, sessionsDir, type JournalEvent } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('任务收口：write 的影子快照随该轮 user 事件落盘，blob 为 pre-image', async () => {
  const tmp = tmpdir('rewind-t3-');
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data'); // 文件私有数据目录（免污染）
  try {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'old');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
      '{"phase":"act","tool":"write","input":{"path":"a.txt","content":"new"}}',
      '{"done":true,"reply":"done"}',
    ]) });
    await ctrl.submit('改 a.txt');
    await ctrl.waitIdle();
    const dataDir = resolveDataDir(tmp);
    const id = readActivePointer(dataDir);
    assert.ok(id);
    const parsed = parseJournalFile(path.join(sessionsDir(dataDir), id + '.jsonl'));
    const userEv = parsed.events.find((e): e is Extract<JournalEvent, { t: 'user' }> => e.t === 'user');
    assert.ok(userEv);
    assert.equal(userEv.files?.length, 1);
    assert.equal(userEv.files[0].path, 'a.txt');
    assert.equal(userEv.files[0].deleted, undefined);
    assert.equal(fs.readFileSync(path.join(dataDir, 'sessions', '_blobs', userEv.files[0].hash)).toString(), 'old');
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('任务收口：无 write 的任务 user 事件无 files 字段（v1 形态一致）', async () => {
  const tmp = tmpdir('rewind-t3b-');
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('纯对话');
    await ctrl.waitIdle();
    const dataDir = resolveDataDir(tmp);
    const id = readActivePointer(dataDir)!;
    const parsed = parseJournalFile(path.join(sessionsDir(dataDir), id + '.jsonl'));
    const userEv = parsed.events.find((e): e is Extract<JournalEvent, { t: 'user' }> => e.t === 'user');
    assert.ok(userEv);
    assert.equal(userEv.files, undefined);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session.turnlog.test.js 2>&1 | tail -5`
Expected: 第一条 FAIL（user 事件无 files 字段）；第二条 PASS（现状即无字段）

- [ ] **Step 3: 最小实现**

`src/tui/session.ts` `flushJournal` 内，快照型事件补拍（todos/model/view）之后、`j.flush()` 之前插：

```ts
    // 影子快照清单回填（rewind/fork 规格 §6.1）：本任务 write 的 pre-image 随该轮 user 事件落盘
    const snap = this.runtime.harness.writeSnapshot;
    if (snap) j.amendLastUser(snap.drain());
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build && node --test dist/tui/session.turnlog.test.js dist/harness/tools/write-snapshot.test.js 2>&1 | tail -5`
Expected: PASS（2 用例 + T2 回归绿）

- [ ] **Step 5: 提交（按 hunk 只挑本线改动）**

```bash
git add src/tui/session.turnlog.test.ts
git add -p src/tui/session.ts   # 只挑 flushJournal 内新增 3 行
git commit -m "feat(session): 任务收口回填影子快照清单至 user 事件（rewind/fork T3）"
```

---

### Task 4: 代码回退纯模块（collectRestorePlan / applyRestorePlan）

**Files:**
- Create: `src/tui/session-snapshots.ts`
- Test: `src/tui/session-snapshots.test.ts`（新建）

**Interfaces:**
- Consumes: T1 `parseJournalFile`/`SnapshotEntry`。
- Produces（T5 依赖的精确签名）:
  - `export function collectRestorePlan(file: string, anchorLine: number): SnapshotEntry[]`（复用 T1 `SnapshotEntry`，不另立类型；在 file 档内收集行号 ≥ anchorLine 的 user 事件 files，每文件取行号最早一条，按行号序输出、同文件去重）
  - `export function applyRestorePlan(root: string, plan: SnapshotEntry[], blobsDir: string): { restored: string[]; removed: string[]; skipped: string[] }`（deleted→删除；hash→blob 写回；blob 缺失→skipped 跳过；path 按平台拼 root 绝对路径，越界路径跳过计入 skipped）

- [ ] **Step 1: 写失败测试**

新建 `src/tui/session-snapshots.test.ts`：

```ts
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { collectRestorePlan, applyRestorePlan } from './session-snapshots';
import { sessionsDir } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
/** 造档：header(1) / user a→v1(2) / msg(3) / user a→v2+b→deleted(4) / msg(5) */
function makeJournal(dataDir: string, id: string): void {
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const lines = [
    '{"t":"header","v":1,"id":"' + id + '","createdAt":"x"}',
    '{"t":"user","text":"t1","files":[{"path":"a.txt","hash":"h-v1"}]}',
    '{"t":"msg","item":{"role":"assistant","text":"r1","seq":1}}',
    '{"t":"user","text":"t2","files":[{"path":"a.txt","hash":"h-v2"},{"path":"b.txt","hash":"","deleted":true}]}',
    '{"t":"msg","item":{"role":"assistant","text":"r2","seq":2}}',
  ];
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('collectRestorePlan: 每文件取锚点起最早一条（a 取行 2 的 v1 而非行 4 的 v2），b 带入 deleted', () => {
  const dataDir = tmpdir('snap-collect-');
  try {
    makeJournal(dataDir, 'j1');
    const file = path.join(sessionsDir(dataDir), 'j1.jsonl');
    const plan = collectRestorePlan(file, 2);
    assert.deepEqual(plan, [
      { path: 'a.txt', hash: 'h-v1' },
      { path: 'b.txt', hash: '', deleted: true },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('collectRestorePlan: 锚点行自身清单参与（含当轮写入回退）', () => {
  const dataDir = tmpdir('snap-collect2-');
  try {
    makeJournal(dataDir, 'j2');
    const file = path.join(sessionsDir(dataDir), 'j2.jsonl');
    const plan = collectRestorePlan(file, 4); // 锚=行 4 自身 → 只含行 4 清单
    assert.deepEqual(plan, [
      { path: 'a.txt', hash: 'h-v2' },
      { path: 'b.txt', hash: '', deleted: true },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('applyRestorePlan: 写回/删除/缺 blob skipped 三态', () => {
  const root = tmpdir('snap-apply-');
  try {
    const blobs = path.join(root, 'blobs');
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, 'h-v1'), 'content-v1');
    fs.writeFileSync(path.join(root, 'a.txt'), 'dirty');
    fs.writeFileSync(path.join(root, 'b.txt'), 'created-later');
    const r = applyRestorePlan(root, [
      { path: 'a.txt', hash: 'h-v1' },
      { path: 'b.txt', hash: '', deleted: true },
      { path: 'c.txt', hash: 'h-missing' },
    ], blobs);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt')).toString(), 'content-v1');
    assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
    assert.deepEqual(r, { restored: ['a.txt'], removed: ['b.txt'], skipped: ['c.txt'] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyRestorePlan: 越界路径拒绝计入 skipped', () => {
  const root = tmpdir('snap-apply2-');
  try {
    const r = applyRestorePlan(root, [{ path: '../escape.txt', hash: '' }], path.join(root, 'blobs'));
    assert.deepEqual(r.skipped, ['../escape.txt']);
    assert.equal(fs.existsSync(path.join(root, '..', 'escape.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session-snapshots.test.js 2>&1 | tail -5`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

新建 `src/tui/session-snapshots.ts`：

```ts
/** 代码回退算法（规格 2026-09-20 rewind+fork §6.2）：单一档案收集 + pre-image 写回；纯模块零会话依赖 */
import * as fs from 'fs';
import * as path from 'path';
import { parseJournalFile, type SnapshotEntry } from './session-journal';

/** 收集行号 ≥ anchorLine 的 user 事件 files（≥ 含锚点轮自身写入），每文件取行号最早一条，行号序输出 */
export function collectRestorePlan(file: string, anchorLine: number): SnapshotEntry[] {
  const parsed = parseJournalFile(file);
  const byPath = new Map<string, SnapshotEntry>();
  parsed.events.forEach((e, i) => {
    if (i + 1 < anchorLine || e.t !== 'user' || !e.files) return;
    for (const f of e.files) {
      if (!byPath.has(f.path)) byPath.set(f.path, { ...f });
    }
  });
  return [...byPath.values()];
}

export function applyRestorePlan(
  root: string,
  plan: SnapshotEntry[],
  blobsDir: string,
): { restored: string[]; removed: string[]; skipped: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const a of plan) {
    const abs = path.resolve(root, a.path);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      skipped.push(a.path);
      continue;
    }
    try {
      if (a.deleted) {
        fs.rmSync(abs, { force: true });
        removed.push(a.path);
        continue;
      }
      const content = fs.readFileSync(path.join(blobsDir, a.hash));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      restored.push(a.path);
    } catch {
      skipped.push(a.path); // blob 缺失等 IO 失败：跳过并如实列明
    }
  }
  return { restored, removed, skipped };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build && node --test dist/tui/session-snapshots.test.js 2>&1 | tail -5`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add src/tui/session-snapshots.ts src/tui/session-snapshots.test.ts
git commit -m "feat(snapshot): 代码回退纯模块 collectRestorePlan/applyRestorePlan（rewind/fork T4）"
```

---

### Task 5: /rewind //fork 命令 + 输入回填 + /resume 血缘

**Files:**
- Modify: `src/tui/session.ts`（TuiState L105 增瞬态 `backfill?: string`；`handleSlash` 增两分支；新增私有 `branchFlow(kind)`/`takeBackfill()`；`listSessions` 消费血缘；slashHelp L141 增两行）
- Modify: `src/tui/session-journal.ts`（`SessionMeta` 增 `forkedFrom?: ForkedFrom`；`listSessions` 扫描首行 header 提取血缘）
- Modify: `src/tui/components/App.tsx`（backfill 消费 effect；`SLASH_COMMANDS` L27 增 `'/rewind'`、`'/fork'`）
- Test: `src/tui/session.rewind.test.ts`（新建）

**Interfaces:**
- Consumes: T1 `branchFrom`/`listAnchors`、T4 `collectRestorePlan`/`applyRestorePlan`、既有 `askUser`/`resolveAskAnswer`/`restoreFromSession`。
- Produces:
  - `SessionController.takeBackfill(): string | undefined`（一次性取走回填文本；App effect 消费）
  - `/rewind`、`/fork` 斜杠命令（idle 守卫沿 /resume 先例）；`/resume` 无参选择器选中后二级卡 `Restore / Fork from…`（Restore=现行恢复路径）
  - `/resume` 列表血缘标注：description 前缀 `↳ rewind from <srcId 前 8 位>` / `↳ fork from <srcId 前 8 位>`

- [ ] **Step 1: 写失败测试**

新建 `src/tui/session.rewind.test.ts`（问询回填走 `resolveAskAnswer` 直调，沿问询管线测试先例；每用例先 `process.env.SUNSHINEX_DATA_DIR` 钉私有数据目录）：

```ts
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, readActivePointer, sessionsDir } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function twoTurnSession(tmp: string): Promise<SessionController> {
  const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
    '{"done":true,"reply":"first done"}',
    '{"done":true,"reply":"second done"}',
  ]) });
  await ctrl.submit('任务一');
  await ctrl.waitIdle();
  await ctrl.submit('任务二');
  await ctrl.waitIdle();
  return ctrl;
}

test('/rewind：回退到任务二 → 对话面=仅任务一，任务二文本回填输入框，源档保留', async () => {
  const tmp = tmpdir('rewind-t5a-');
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const ctrl = await twoTurnSession(tmp);
    const dataDir = resolveDataDir(tmp);
    const srcId = readActivePointer(dataDir)!;

    const p = ctrl.submit('/rewind');
    await new Promise<void>((r) => setTimeout(r, 30)); // 锚点选择器挂起
    assert.equal(ctrl.getState().status, 'awaiting-question');
    const anchorsQ = ctrl.getState().question!;
    assert.equal(anchorsQ.options.length, 2); // 任务一/任务二
    ctrl.resolveAskAnswer({ type: 'selected', labels: [anchorsQ.options[1].label] }); // 选任务二锚点
    await new Promise<void>((r) => setTimeout(r, 30)); // 动作卡挂起
    assert.equal(ctrl.getState().status, 'awaiting-question');
    const actionQ = ctrl.getState().question!;
    assert.deepEqual(actionQ.options.map((o) => o.label), ['conversation only']); // 无 write 无 code 项
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['conversation only'] });
    await p;

    const s = ctrl.getState();
    assert.equal(s.status, 'idle');
    const texts = s.messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.ok(texts.includes('任务一') && !texts.includes('任务二'));
    assert.equal(ctrl.takeBackfill(), '任务二');
    assert.notEqual(readActivePointer(dataDir), srcId); // 指针切新档
    const metas = listSessions(dataDir);
    assert.equal(metas.length, 2); // 源档 + 新档
    const branched = metas.find((m) => m.id !== srcId)!;
    assert.equal(branched.forkedFrom?.sourceSessionId, srcId);
    assert.equal(branched.forkedFrom?.kind, 'rewind');
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/rewind 含 write 轮：Restore code 把文件回退到锚点时点', async () => {
  const tmp = tmpdir('rewind-t5b-');
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'v0');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
      '{"phase":"act","tool":"write","input":{"path":"a.txt","content":"v1"}}',
      '{"done":true,"reply":"t1 done"}',
      '{"phase":"act","tool":"write","input":{"path":"a.txt","content":"v2"}}',
      '{"done":true,"reply":"t2 done"}',
    ]) });
    await ctrl.submit('任务一：写 v1');
    await ctrl.waitIdle();
    await ctrl.submit('任务二：写 v2');
    await ctrl.waitIdle();
    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt')).toString(), 'v2');

    const p = ctrl.submit('/rewind');
    await new Promise<void>((r) => setTimeout(r, 30));
    const anchorsQ = ctrl.getState().question!;
    ctrl.resolveAskAnswer({ type: 'selected', labels: [anchorsQ.options[1].label] }); // 任务二锚点
    await new Promise<void>((r) => setTimeout(r, 30));
    const actionQ = ctrl.getState().question!;
    assert.deepEqual(actionQ.options.map((o) => o.label), ['code and conversation', 'conversation only', 'code only']);
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['code and conversation'] });
    await p;

    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt')).toString(), 'v1'); // 回到任务二开场时点（任务一写完的 v1）
    assert.equal(ctrl.takeBackfill(), '任务二：写 v2');
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/fork：复制平行会话，源档字节不动、两者均列于 /resume 且血缘标注正确', async () => {
  const tmp = tmpdir('rewind-t5c-');
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const ctrl = await twoTurnSession(tmp);
    const dataDir = resolveDataDir(tmp);
    const srcFile = path.join(sessionsDir(dataDir), readActivePointer(dataDir)! + '.jsonl');
    const srcBytes = fs.readFileSync(srcFile, 'utf8');

    const p = ctrl.submit('/fork');
    await new Promise<void>((r) => setTimeout(r, 30));
    const anchorsQ = ctrl.getState().question!;
    ctrl.resolveAskAnswer({ type: 'selected', labels: [anchorsQ.options[0].label] }); // 从任务一分叉
    await new Promise<void>((r) => setTimeout(r, 30));
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['fork'] }); // /fork 无二级 code 卡，直接确认卡
    await p;

    assert.equal(fs.readFileSync(srcFile, 'utf8'), srcBytes); // 源档零改动
    assert.equal(ctrl.takeBackfill(), '任务一');
    const metas = listSessions(dataDir);
    const fork = metas.find((m) => m.forkedFrom?.kind === 'fork')!;
    assert.equal(fork.forkedFrom?.sourceSessionId, path.basename(srcFile, '.jsonl'));
    assert.ok(fs.readFileSync(srcFile, 'utf8').includes('任务二')); // 源档仍含任务二（fork 不丢弃未来）
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/resume 血缘标注：fork 出的新档列表行带 ↳ 标注', async () => {
  const tmp = tmpdir('rewind-t5d-');
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  try {
    const ctrl = await twoTurnSession(tmp);
    const dataDir = resolveDataDir(tmp);
    const p = ctrl.submit('/fork');
    await new Promise<void>((r) => setTimeout(r, 30));
    ctrl.resolveAskAnswer({ type: 'selected', labels: [ctrl.getState().question!.options[0].label] });
    await new Promise<void>((r) => setTimeout(r, 30));
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['fork'] });
    await p;
    const metas = listSessions(dataDir);
    const fork = metas.find((m) => m.forkedFrom)!;
    const src = metas.find((m) => !m.forkedFrom)!;
    assert.ok(fork.firstUser?.startsWith('↳')); // 标注拼入展示摘要
    assert.ok(fork.firstUser!.includes(src.id.slice(0, 8)));
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

注：`/fork` 选中锚点后经一次 askUser 确认卡（`Fork a parallel session from this turn?` / 选项 `fork`，Esc 取消）防误触；测试按确认卡形态断言，实现不得另改形态。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session.rewind.test.js 2>&1 | tail -5`
Expected: FAIL（`/rewind` 未知命令走 usage 提示，选择器永不挂起 → waitFor 系断言失败）

- [ ] **Step 3: 最小实现**

① `src/tui/session-journal.ts`：`SessionMeta` 增 `forkedFrom?: ForkedFrom;`；`listSessions` 整函数替换为（头 8 行扫描循环内同时提取血缘与首条输入，标注在展示面单点拼接）：

```ts
/** 档案列表（/resume 无参展示）：mtime 降序；扫文件头 8 行取首条用户输入摘要与分档血缘（零重放成本） */
export function listSessions(dataDir: string): SessionMeta[] {
  const dir = sessionsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let firstUser: string | undefined;
    let forked: ForkedFrom | undefined;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(0, 8)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEvent;
          if (e.t === 'header' && e.forkedFrom) {
            forked = e.forkedFrom;
            continue;
          }
          if (e.t === 'user') {
            firstUser = e.text;
            break;
          }
        } catch {
          break;
        }
      }
    } catch {
      /* 读失败：无摘要 */
    }
    // 血缘标注随摘要单点拼接（/resume 列表展示面）
    const labeled = forked
      ? `↳ ${forked.kind} from ${forked.sourceSessionId.slice(0, 8)}${firstUser ? ' · ' + firstUser : ''}`
      : firstUser;
    metas.push({
      id: name.slice(0, -'.jsonl'.length),
      file,
      updatedAt,
      ...(labeled !== undefined ? { firstUser: labeled } : {}),
      ...(forked ? { forkedFrom: forked } : {}),
    });
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}
```

② `src/tui/session.ts`：

- `TuiState` 增 `backfill?: string;`（注释：瞬态回填文本，App 消费即取走，不进 journal）。
- 类体增：

```ts
  /** 输入框回填（/rewind //fork 用）：一次性取走，App 层 effect 消费 */
  takeBackfill(): string | undefined {
    const b = this.state.backfill;
    if (b !== undefined) {
      this.state = { ...this.state, backfill: undefined };
      this.notify();
    }
    return b;
  }
```

- 私有分支流程（`restoreFromSession` 之后）：

```ts
  /** /rewind //fork 共用分支流程（规格 §7）：锚点选择 → 分档 → 装载 → 代码回退（可选）→ 回执 + 输入回填 */
  private async branchFlow(kind: 'rewind' | 'fork'): Promise<void> {
    this.flushJournal(); // 当前任务先收口（含影子快照清单回填）
    const dataDir = resolveDataDir(this.root);
    const srcId = this.journal?.currentId;
    const srcFile = srcId ? path.join(sessionsDir(dataDir), srcId + '.jsonl') : undefined;
    if (!srcId || !srcFile || !fs.existsSync(srcFile)) {
      this.pushMsg('system', t('No journaled session to ' + kind, '当前会话无可' + (kind === 'rewind' ? '回退' : '分叉') + '的日志'), { level: 'warn' });
      return;
    }
    const parsed = parseJournalFile(srcFile);
    const anchors = listAnchors(parsed);
    if (anchors.length === 0) {
      this.pushMsg('system', t('No turns to ' + kind + ' yet', '暂无可' + (kind === 'rewind' ? '回退' : '分叉') + '的任务轮'), { level: 'warn' });
      return;
    }
    const a = await this.askUser({
      question: t(kind === 'rewind' ? 'Rewind to which turn?' : 'Fork from which turn?', kind === 'rewind' ? '回退到哪一轮？' : '从哪一轮分叉？'),
      options: anchors.map((x, i) => ({
        label: String(i + 1),
        description: x.text.length > 48 ? x.text.slice(0, 48) + '…' : x.text,
      })),
    });
    if (a.type === 'dismissed') {
      this.pushMsg('system', t(kind === 'rewind' ? 'Rewind cancelled' : 'Fork cancelled', kind === 'rewind' ? '已取消回退' : '已取消分叉'));
      return;
    }
    const idx = Number.parseInt(a.type === 'custom' ? a.text.trim() : (a.labels[0] ?? ''), 10) - 1;
    const anchor = Number.isInteger(idx) && idx >= 0 && idx < anchors.length ? anchors[idx] : undefined;
    if (!anchor) {
      this.pushMsg('system', t('No such turn', '没有这一轮'), { level: 'warn' });
      return;
    }
    let codeAction = false;
    if (kind === 'rewind') {
      const hasFiles = collectRestorePlan(srcFile, anchor.line).length > 0;
      const opts = hasFiles
        ? ['code and conversation', 'conversation only', 'code only']
        : ['conversation only'];
      const b = await this.askUser({
        question: t('What to restore?', '恢复哪些内容？'),
        options: opts.map((label) => ({ label })),
      });
      if (b.type === 'dismissed') {
        this.pushMsg('system', t('Rewind cancelled', '已取消回退'));
        return;
      }
      const picked = b.type === 'custom' ? b.text.trim() : (b.labels[0] ?? '');
      if (picked === 'code and conversation' || picked === 'code only') codeAction = true;
    } else {
      const c = await this.askUser({
        question: t('Fork a parallel session from this turn?', '从这一轮分叉出平行会话？'),
        options: [{ label: 'fork' }],
      });
      if (c.type === 'dismissed') {
        this.pushMsg('system', t('Fork cancelled', '已取消分叉'));
        return;
      }
    }
    let newId: string;
    try {
      newId = branchFrom(dataDir, srcId, anchor.line - 1, kind); // 锚点行不进新档（规格 §5.2）
    } catch (err) {
      this.pushMsg('system', t('Branch failed: ' + String((err as Error).message), '分档失败：' + String((err as Error).message)), { level: 'warn' });
      return;
    }
    this.restoreFromSession({ id: newId, file: path.join(sessionsDir(dataDir), newId + '.jsonl'), updatedAt: Date.now() });
    if (kind === 'rewind' && codeAction) {
      const blobsDir = path.join(dataDir, 'sessions', '_blobs');
      const plan = collectRestorePlan(srcFile, anchor.line); // 以分支前源档收集（规格 §6.2）
      const r = applyRestorePlan(this.root, plan, blobsDir);
      const parts = [
        r.restored.length > 0 ? `${r.restored.length} restored` : '',
        r.removed.length > 0 ? `${r.removed.length} removed` : '',
        r.skipped.length > 0 ? `${r.skipped.length} skipped` : '',
      ].filter(Boolean).join(', ');
      this.pushMsg('system', t('Code restored to turn start (' + parts + ')', '代码已回退到该轮起点（' + parts + '）'), r.skipped.length > 0 ? { level: 'warn' } : undefined);
    }
    this.state = { ...this.state, backfill: anchor.text }; // 锚点轮输入回填（重发经正常任务提交进链）
    this.notify();
    const verb = kind === 'rewind' ? 'Rewound to turn' : 'Forked new session from turn';
    const tail = kind === 'rewind' ? t(' — previous timeline kept, /resume to return', '——原时间线保留，/resume 可回') : t(' — new session active', '——新会话已激活（id ' + newId + '）');
    this.pushMsg('system', t(verb + ' ' + (anchors.indexOf(anchor) + 1), (kind === 'rewind' ? '已回退到第 ' : '已从第 ') + (anchors.indexOf(anchor) + 1) + ' 轮' ) + tail);
  }
```

- `handleSlash` 增两分支（/resume 分支之后；idle 守卫与 /resume 同款）：

```ts
    if (cmd === '/rewind' || cmd === '/fork') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; ' + cmd + ' unavailable now', '当前有任务进行中，暂不能执行 ' + cmd), { level: 'warn' });
        return;
      }
      await this.branchFlow(cmd === '/rewind' ? 'rewind' : 'fork');
      return;
    }
```

- `/resume` 无参选择器：选中 `pick` 后改走二级卡（Restore 保持现行路径）：

```ts
        const mode = await this.askUser({
          question: t('Restore this session, or fork from it?', '恢复该会话，还是从它分叉？'),
          options: [{ label: 'restore' }, { label: 'Fork from…' }],
        });
        if (mode.type === 'dismissed') { this.pushMsg('system', t('Resume cancelled', '已取消恢复')); return; }
        const mpick = mode.type === 'custom' ? mode.text.trim() : (mode.labels[0] ?? '');
        if (mpick === 'Fork from…') {
          this.restoreFromSession(pick); // 先装载源会话（branchFlow 基于当前会话分档）
          await this.branchFlow('fork');
          return;
        }
        this.restoreFromSession(pick);
        return;
```

（既有 `/resume <序号|id>` 显式路径保持一步恢复不变。）

- `slashHelp()` 增两行（/resume 行后）：

```ts
    t('  /rewind   rewind current session to an earlier turn (conversation, optionally code)', '  /rewind   把当前会话回退到更早的任务轮（对话必选、代码可选）'),
    t('  /fork     fork a parallel session from any past turn', '  /fork     从任意历史轮分叉出平行会话'),
```

③ `src/tui/components/App.tsx`：`SLASH_COMMANDS` 增 `'/rewind', '/fork'`（`'/resume'` 之后）；backfill 消费 effect（`takeRestoredUi` 消费形态旁）：

```tsx
  React.useEffect(() => {
    const b = controller.takeBackfill();
    if (b !== undefined) {
      setBuffer(b);
      setCursor(b.length);
    }
  }); // 每帧检查：takeBackfill 幂等（无回填时 no-op），取走即消费
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build && node --test dist/tui/session.rewind.test.js dist/tui/session.test.js dist/tui/session.rewrite.test.js 2>&1 | tail -8`
Expected: T5 新套件 4 用例全绿；既有 session 套件全绿（`/resume` 显式路径不变；若既有「无参 /resume 选中即恢复」用例存在，按二级卡交互更新断言——Restore 仍是默认首项）

注：规格 §8 钉子（分档续写下一帧与源会话锚点时点逐字节一致）由既有 restoreSession 钉子（session-restore.test.ts）传递覆盖——branchFrom 前缀逐字节复制 + restoreFromSession 同一路径，不另设重复测试。规格 §10.5 v1 兼容由全程测试档即 v1 形态覆盖（makeJournal 与 twoTurnSession 产档均无 files/forkedFrom 字段，新代码照常装载与分支）。

- [ ] **Step 5: 提交（session.ts 按 hunk 只挑本线改动）**

```bash
git add src/tui/session.rewind.test.ts src/tui/session-journal.ts src/tui/components/App.tsx
git add -p src/tui/session.ts
git commit -m "feat(tui): /rewind //fork 会话分支命令 + 输入回填 + /resume 血缘标注（rewind/fork T5）"
```

---

### Task 6: 文档同步 + 全量门禁收口

**Files:**
- Modify: `TUI-MANUAL.md`（命令表 /rewind //fork 两行、/resume 段补二级卡与血缘标注、新增「会话回退与分叉」小节：分支语义=原时间线保留可 /resume 回、代码回退只跟踪 write 工具且非 git 替代、blob 位置）
- Modify: `README.md`（特性清单一处一句话）

**Interfaces:** 无代码接口；文档与实现口径一致。

- [ ] **Step 1: TUI-MANUAL.md 更新**

命令表按现行格式增两行（/rewind、/fork，中英对照列随表）；「会话」相关章节补小节（约 15 行）：

```markdown
### 会话回退与分叉（/rewind · /fork）

- `/rewind`：回退当前会话到任意历史任务轮。恢复粒度=任务轮起点；被回掉的后续轮次**保留在原会话**（`/resume` 随时找回），锚点轮的输入自动回填输入框、可编辑重发。
- 恢复内容三选：`code and conversation`（对话+代码）/ `conversation only`（仅对话）/ `code only`（仅代码）。代码回退只跟踪 write 工具改写的文件（pre-image 影子快照，存于数据目录 `sessions/_blobs/`）；exec 命令副作用与外部编辑不跟踪——**不是 git 替代**。
- `/fork`：从任意历史轮复制出平行会话并切换过去，源会话原样保留；`/resume` 列表中分叉会话带 `↳ fork from …` 血缘标注，从列表选中历史会话还可选 `Fork from…` 二次分叉。
```

- [ ] **Step 2: README.md 特性一句话**

README 特性/亮点清单（会话持久化 resume 提及处）追加一句：`会话可回退（/rewind）与任意轮分叉（/fork）：Codex 式不可变分档 + write 影子快照代码回退。`

- [ ] **Step 3: 全量门禁 + 残渣终验**

Run: `pnpm build 2>&1 | tail -3 && pnpm test 2>&1 | tail -6 && pnpm selfcheck 2>&1 | tail -4`
Expected: tsc 零报错；全量 fail 0；selfcheck OK（工具清单零新增——本线零新工具）
终验：`grep -rn "TODO\|TBD" src/tui/session-snapshots.ts src/harness/tools/write-snapshot.ts src/tui/session-journal.ts` 零命中；`git log --oneline -6` 六笔提交齐全。

- [ ] **Step 4: 提交（文档文件若与并发线 WIP 重叠，按 hunk 拆分）**

```bash
git add TUI-MANUAL.md README.md   # 重叠时 git add -p 按 hunk 挑本线段落
git commit -m "docs: /rewind //fork 会话回退与分叉手册与 README 同步（rewind/fork T6）"
```
