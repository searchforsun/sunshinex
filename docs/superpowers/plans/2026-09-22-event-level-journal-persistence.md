# 事件级会话日志即时落盘（Crash-Resilient Journal）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话日志从「缓冲批量 + 三 flush 点」改为「逐事件即时落盘」，崩溃丢失窗口从整任务轮缩到在飞一个工具步（对标 Claude Code），影子快照清单改独立 `snapshots` 事件承载。

**Architecture:** `SessionJournal` 删除缓冲机制（`buf`/`flush()`/`pending`/`amendLastUser`），`log()` 直接 `appendFileSync`；生命周期点（建档/轮转/续挂）写 header 与活动指针；任务收口仅补拍 `snapshots` 事件；`collectRestorePlan` 把 `snapshots` 事件并入代码回退收集窗口。schema additive、header v 恒 1。

**Tech Stack:** TypeScript strict（CommonJS）、node:test + node:assert/strict、零新依赖。

**规格：** `docs/superpowers/specs/2026-09-22-event-level-journal-persistence-design.md`（D1–D8 裁决、§8 验收矩阵）

## Global Constraints

- 前缀缓存第一要义：本线零提示词面、零装配面改动（规格 §7）。
- schema v1 additive：新事件类型 `{ t: 'snapshots'; files: SnapshotEntry[] }`，header `v` 恒 1，`reduceJournal` 对未知事件类型天然跳过（switch 无 default，不得新增 default 分支改此语义）。
- append-only 与撕裂容忍不变：`parseJournalFile`、`branchFrom` 逐字节前缀复制、`listAnchors` 锚点语义零改动。
- 无残渣纪律（CLAUDE.md §10）：`buf`/`flush`/`pending`/`amendLastUser` 与「三 flush 点」表述最终全仓零残留。
- 门禁等价执行（沙箱 HOME 不可写、corepack 不可用）：构建 `node node_modules/typescript/bin/tsc -p tsconfig.json`；定向测试 `node --test dist/tui/<file>.test.js`；全量 `node scripts/run-tests.js`；selfcheck `node dist/cli/index.js selfcheck`。
- 工作区混叠多条并发线 WIP（git status 33 文件、`src/model/adapter.test.ts` 为并发线已暂存态 MM）：**提交一律 `git commit -- <pathspec>` 限定本线文件**，禁止裸 `git add -A`/裸 `git commit`；每次提交后 `git show --stat HEAD` 复核恰好只含本线文件。
- 本线允许触碰的文件白名单：`src/tui/session-journal.ts`、`src/tui/session.ts`、`src/tui/entry.ts`、`src/tui/session-snapshots.ts`、`src/harness/tools/write-snapshot.ts`、`src/tui/session-journal.test.ts`、`src/tui/session-journal.branch.test.ts`、`src/tui/session.journal.test.ts`、`src/tui/session-snapshots.test.ts`、`src/tui/session.rewind.test.ts`（如需）、TUI-MANUAL.md/README.md（仅当 grep 命中过时表述）。白名单外文件出现位移即停下核查并发线。
- 注释与测试名用中文（项目既有测试面惯例）；链行/回执不新增（本线零新用户可见文案）。

---

### Task 1: journal 核心重写 + 会话接线（事件级落盘主干）

**Files:**
- Modify: `src/tui/session-journal.ts`（头部注释、`JournalEvent` 联合、`SessionJournal` 类整体重写）
- Modify: `src/tui/session.ts`（closeTask、变更点接线、切换/退出/`/new` 收口调用清退、690 行注释）
- Modify: `src/tui/entry.ts:53,75`（退出收口调用删除）
- Modify: `src/harness/tools/write-snapshot.ts`（头注释去向句）
- Test: `src/tui/session-journal.test.ts`（重写）、`src/tui/session-journal.branch.test.ts`（删 amend 用例）、`src/tui/session.journal.test.ts`（两处用例改写）

**Interfaces:**
- Consumes: 既有 `SnapshotEntry`（`{ path, hash, deleted? }`）、`writeActivePointer`/`readActivePointer`、`JournalHeader`。
- Produces（后续任务依赖的精确签名）:
  - `class SessionJournal`：`get currentId(): string | undefined`；`start(): void`；`rotate(id: string): void`；`attach(id: string): void`；`log(event: JournalEvent): void`；`seal(files: SnapshotEntry[]): void`。**删除** `pending` getter、`flush()`、`amendLastUser()`、私有 `buf`。
  - `JournalEvent` 联合新增成员：`| { t: 'snapshots'; files: SnapshotEntry[] }`（置于 `user` 成员之后）。
  - `session.ts` 新增私有方法：`private logModel(): void`、`private logTodos(): void`、`private sealJournal(): void`。

- [ ] **Step 1: 重写单元测试（红灯）**

`src/tui/session-journal.test.ts` 整文件替换为下述内容（保留原文件中 `newSessionId` 用例、`parseJournalFile` 撕裂用例、`reduceJournal` 未知版本用例、`活动指针` 用例原文不动；其余重写）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SessionJournal,
  listSessions,
  newSessionId,
  parseJournalFile,
  readActivePointer,
  reduceJournal,
  sessionsDir,
  writeActivePointer,
  type JournalEvent,
} from './session-journal';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-jr-'));

test('newSessionId：UTC 紧凑时间戳 + 4 位随机尾，50 次无重复', () => {
  const id = newSessionId();
  assert.match(id, /^\d{8}T\d{6}Z-[0-9a-z]{4}$/);
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(newSessionId());
  assert.equal(seen.size, 50);
});

test('空会话零落盘：未建档 log 丢弃、目录不创建', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.log({ t: 'user', text: '早于建档应丢弃' });
  assert.equal(j.currentId, undefined);
  assert.equal(fs.existsSync(sessionsDir(dataDir)), false, '空会话零文件');
});

test('建档即落盘：header 立即写盘+指针；事件逐条 append（规格 2026-09-22 D1/D3）', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  const file = path.join(sessionsDir(dataDir), id + '.jsonl');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'header 先于任何事件在盘');
  assert.equal(readActivePointer(dataDir), id, '建档即切指针');
  j.log({ t: 'user', text: '你好' });
  j.log({ t: 'model', tier: 'large' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.equal(lines.length, 3, 'header + 2 事件逐行在盘（无缓冲）');
  assert.equal(lines[0].t, 'header');
  assert.deepEqual(lines.slice(1), [{ t: 'user', text: '你好' }, { t: 'model', tier: 'large' }]);
  const { events } = parseJournalFile(file);
  assert.equal(events[0].t, 'header');
});

test('rotate：旧档不动、新档 header 立即写盘、指针指向新 id', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const oldId = j.currentId!;
  j.log({ t: 'user', text: '旧会话输入' });
  const newId = newSessionId();
  assert.notEqual(newId, oldId);
  j.rotate(newId);
  assert.equal(j.currentId, newId);
  j.log({ t: 'user', text: '新会话输入' });
  const oldLines = fs.readFileSync(path.join(sessionsDir(dataDir), oldId + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(oldLines.length, 2, '旧档 header+事件不动');
  const newLines = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.equal(newLines.length, 2, '新档 header+事件');
  assert.equal(newLines[0].t, 'header');
  assert.equal(readActivePointer(dataDir), newId, '指针=轮转会话');
});

test('attach 续挂：换 id 更新指针、后续事件追加至既有文件', () => {
  const dataDir = tmp();
  const id = newSessionId();
  const a = new SessionJournal(dataDir);
  a.start();
  a.rotate(id);
  a.log({ t: 'user', text: '第一段' });
  const b = new SessionJournal(dataDir);
  b.attach(id);
  assert.equal(readActivePointer(dataDir), id, 'attach 即切指针');
  b.log({ t: 'user', text: '第二段' });
  const lines = fs.readFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => (JSON.parse(l) as JournalEvent).t === 'header').length, 1, 'header 不重复');
  assert.equal(lines.length, 3, 'header + 2 事件');
});

test('seal：清单非空尾追 snapshots 事件、空清单零事件（规格 D2）', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  const file = path.join(sessionsDir(dataDir), id + '.jsonl');
  j.seal([]);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, '空清单零事件');
  j.seal([{ path: 'src/a.ts', hash: 'h1' }]);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.deepEqual(lines[1], { t: 'snapshots', files: [{ path: 'src/a.ts', hash: 'h1' }] });
});

test('指针收敛：逐事件追加不重写指针（规格 D4）', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const pointerFile = path.join(dataDir, 'sessions-active.json');
  const before = fs.statSync(pointerFile).mtimeMs;
  for (let i = 0; i < 20; i++) j.log({ t: 'msg', item: { role: 'assistant', text: 'r' + i, ts: i, seq: i } });
  assert.equal(fs.statSync(pointerFile).mtimeMs, before, '同 id 内追加零指针写');
});

test('parseJournalFile：事件往返逐条相等；尾行撕裂与中段坏行截断并标 truncated', () => {
  const dataDir = tmp();
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const good = path.join(sessionsDir(dataDir), 'good.jsonl');
  fs.writeFileSync(good, [
    JSON.stringify({ t: 'header', v: 1, id: 'good', createdAt: 'x' }),
    JSON.stringify({ t: 'user', text: '完整事件' }),
  ].join('\n'), 'utf8');
  const ok = parseJournalFile(good);
  assert.equal(ok.truncated, false);
  assert.equal((ok.events[1] as { t: string }).t, 'user');

  const torn = path.join(sessionsDir(dataDir), 'torn.jsonl');
  fs.writeFileSync(torn, [
    JSON.stringify({ t: 'header', v: 1, id: 'torn', createdAt: 'x' }),
    JSON.stringify({ t: 'user', text: '完整' }),
    '{"t":"user","te',
  ].join('\n'), 'utf8');
  const rt = parseJournalFile(torn);
  assert.equal(rt.truncated, true);
  assert.equal(rt.events.length, 2, '停在上条完整事件');

  const mid = path.join(sessionsDir(dataDir), 'mid.jsonl');
  fs.writeFileSync(mid, [
    JSON.stringify({ t: 'header', v: 1, id: 'mid', createdAt: 'x' }),
    '{broken',
    JSON.stringify({ t: 'user', text: '坏行之后' }),
  ].join('\n'), 'utf8');
  const rm = parseJournalFile(mid);
  assert.equal(rm.truncated, true);
  assert.equal(rm.events.length, 1);
});

test('reduceJournal：未知版本上报 version（拒载判断由调用方守卫）', () => {
  const dataDir = tmp();
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  const file = path.join(sessionsDir(dataDir), 'v99.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ t: 'header', v: 99, id: 'v99', createdAt: 'x' }),
    JSON.stringify({ t: 'user', text: 'x' }),
  ].join('\n'), 'utf8');
  const r = reduceJournal(parseJournalFile(file).events);
  assert.equal(r.version, 99);
});

test('reduceJournal：全词汇归约 + 未知事件类型跳过（additive 兼容，规格 D6）', () => {
  const r = reduceJournal([
    { t: 'header', v: 1, id: 'a', createdAt: 'x' },
    { t: 'snapshots', files: [{ path: 'a.ts', hash: 'h1' }] }, // reduce 不消费（快照属回退面非恢复面）
    JSON.parse('{"t":"future-event","x":1}') as JournalEvent, // 真未知类型（未来版本事件）：跳过不炸（switch 无 default）
    { t: 'user', text: '问一句' },
    { t: 'msg', item: { role: 'user', text: '问一句', ts: 1, seq: 1 } },
    { t: 'chain', steps: [{ step: 1, observation: 's1' }] },
    { t: 'chain', steps: [{ step: 2, action: 'edit', observation: 's2' }] },
    { t: 'compact', chainFrom: 1, compacted: [{ kind: 'system', content: '摘要块' }] },
    { t: 'msg', item: { role: 'assistant', text: '答一句', ts: 2, seq: 5 } },
    { t: 'todos', items: [{ text: '旧待办', done: true }] },
    { t: 'todos', items: [{ text: '新待办', done: false }] },
    { t: 'model', tier: 'small' },
    { t: 'model', tier: 'large' },
    { t: 'view', expandAll: false, latestFull: true },
  ] as JournalEvent[]);
  assert.equal(r.version, 1);
  assert.deepEqual(r.history, ['问一句']);
  assert.deepEqual(r.chain, [{ step: 1, observation: 's1' }, { step: 2, action: 'edit', observation: 's2' }]);
  assert.equal(r.chainFrom, 1);
  assert.deepEqual(r.compacted, [{ kind: 'system', content: '摘要块' }]);
  assert.equal(r.messages.length, 2);
  assert.equal(r.nextSeq, 5);
  assert.deepEqual(r.todos, [{ text: '新待办', done: false }]);
  assert.equal(r.model, 'large');
  assert.deepEqual(r.view, { expandAll: false, latestFull: true });
});

test('listSessions：mtime 降序 + 首条用户输入摘要；缺目录返回空数组', () => {
  const dataDir = tmp();
  assert.deepEqual(listSessions(dataDir), []);
  const older = newSessionId();
  const newer = newSessionId();
  const a = new SessionJournal(dataDir);
  a.rotate(older);
  a.log({ t: 'user', text: '较早会话的首条输入' });
  fs.utimesSync(path.join(sessionsDir(dataDir), older + '.jsonl'), new Date(), new Date(1_000_000_000));
  const b = new SessionJournal(dataDir);
  b.rotate(newer);
  b.log({ t: 'user', text: '较新会话的首条输入' });
  const metas = listSessions(dataDir);
  assert.deepEqual(metas.map((m) => m.id), [newer, older], '最新在前');
  assert.equal(metas[0].firstUser, '较新会话的首条输入');
});

test('活动指针：写入后读回；无指针/损坏返回 undefined', () => {
  const dataDir = tmp();
  assert.equal(readActivePointer(dataDir), undefined);
  writeActivePointer(dataDir, 'abc-1');
  assert.equal(readActivePointer(dataDir), 'abc-1');
});
```

同批删除 `src/tui/session-journal.branch.test.ts` 中 `test('amendLastUser: 缓冲内最后一条 user 事件回填 files 后随 flush 落盘', ...)` 整个用例（第 90–103 行；该文件其余用例走原始字符串写档，不受影响）。

同批修改 `src/tui/session.journal.test.ts` 两处（保证 Task 1 收口即全绿、无跨任务临时红）：

① 「空会话与斜杠会话零落盘」用例（第 92–105 行）内：删除 `ctrl.flushJournal(); // 模拟退出 flush：快照型事件仅在已建档时补拍` 一行；删除其后注释行 `// /help 有输入 → 退出 flush 允许落一个小档（首个持久化事件建档语义）；若实现为空会话零档则 len 仍为 0`；断言 `assert.ok(listSessions(dataDir).length <= 1);` 替换为 `assert.deepEqual(listSessions(dataDir), [], '斜杠会话零持久化事件不建档');`（/help 零持久化事件，事件级形态下该会话永不建档）。

② 「continueLast：手工日志全词汇还原」用例内：删除 `j.flush();` 一行（事件级无 flush；`j.start()` 后各 log 已即时落盘，其后 `const id = j.currentId!` 照旧取到）。

- [ ] **Step 2: 运行确认红灯**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json && node --test dist/tui/session-journal.test.js dist/tui/session.journal.test.js
```

预期：`session-journal.test.js` 红灯（`j.start()` 后档文件不存在/`seal` 不存在等「建档即落盘」断言失败——旧实现是缓冲批量）；`session.journal.test.js` 的「continueLast」用例红灯（旧实现 `j.flush()` 缺失时手工日志不落盘）。红灯形态与本预期不符时先核对 Step 1 改写是否完整。

- [ ] **Step 3: 重写 `SessionJournal`（最小实现）**

`src/tui/session-journal.ts` 三处修改：

① 文件头注释第 4 行 `写=缓冲批量追加（三 flush 点：closeTask / /new 轮转 / TUI 退出），运行中不写盘；` 替换为：

```ts
 *  写=事件级即时落盘（逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；生命周期点写 header 与指针，
 *  规格 docs/superpowers/specs/2026-09-22-event-level-journal-persistence-design.md）；
```

② `JournalEvent` 联合中 `{ t: 'user'; text: string; files?: SnapshotEntry[] }` 之后插入一行：

```ts
  | { t: 'snapshots'; files: SnapshotEntry[] }
```

③ `SessionJournal` 类整体替换为：

```ts
/** 会话日志写面（事件级即时落盘，规格 2026-09-22 D1/D3/D4）：逐事件 appendFileSync、生命周期点写 header 与指针；未建档 log 丢弃（空会话零文件） */
export class SessionJournal {
  private id: string | undefined;
  private readonly dataDir: string;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dir = sessionsDir(dataDir);
  }

  get currentId(): string | undefined {
    return this.id;
  }

  /** 建档（首个持久化事件触发）：生成 id，header 立即写盘 + 指针 */
  start(): void {
    if (this.id) return;
    this.startId(newSessionId());
  }

  /** 轮转（/new）：换新 id，新 header 立即写盘 + 指针（旧档已在盘零改动） */
  rotate(id: string): void {
    this.startId(id);
  }

  /** 续挂既有日志（/resume / --continue / 分档）：档已在盘，仅切 id 与指针，不重复 header */
  attach(id: string): void {
    this.id = id;
    writeActivePointer(this.dataDir, id);
  }

  /** 事件级落盘（规格 D1）：逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；未建档丢弃 */
  log(event: JournalEvent): void {
    if (!this.id) return;
    fs.appendFileSync(path.join(this.dir, this.id + '.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  }

  /** 任务收口快照清单补拍（规格 D2）：本任务 write 的影子快照清单以 snapshots 事件尾追；空清单零事件 */
  seal(files: SnapshotEntry[]): void {
    if (!this.id || files.length === 0) return;
    this.log({ t: 'snapshots', files });
  }

  private startId(id: string): void {
    this.id = id;
    fs.mkdirSync(this.dir, { recursive: true });
    const header: JournalHeader = { t: 'header', v: 1, id, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, id + '.jsonl'), JSON.stringify(header) + '\n', 'utf8');
    writeActivePointer(this.dataDir, id);
  }
}
```

- [ ] **Step 4: 会话接线（session.ts / entry.ts / write-snapshot.ts）**

`src/tui/session.ts` 按锚点逐处修改：

① `flushJournal` 方法（现 545–555 行）整体替换为三个私有方法：

```ts
  /** 快照型事件接线（规格 2026-09-22 D5）：变更点即时 log 的单点构造器，防四处拼装漂移 */
  private logModel(): void {
    this.journal?.log({ t: 'model', ...(this.state.model ? { tier: this.state.model } : {}), ...(this.state.effort ? { effort: this.state.effort } : {}) });
  }

  private logTodos(): void {
    this.journal?.log({ t: 'todos', items: this.state.todos });
  }

  /** 任务收口（规格 2026-09-22 D2/D8）：仅补拍本轮 write 影子快照清单（snapshots 事件）；其余事件已随产生落盘 */
  private sealJournal(): void {
    this.journal?.seal(this.runtime.harness.writeSnapshot.drain());
  }
```

② `recordView` 内 `this.journal?.log({ t: 'view', expandAll, latestFull });` 保持不动（本就即时 log）。

③ `runPlanItems` 待办建档点（现 496 行）`this.state = { ...this.state, todos: items.map(...), status: 'running' };` 之后、`this.notify();` 之前插入一行：

```ts
    this.logTodos();
```

④ 步骤勾选点（现 524 行）`this.state = { ...this.state, todos };` 之后插入一行：

```ts
        this.logTodos();
```

⑤ `handleModel` 内三处赋值后接线。先定位：

```bash
grep -n "this.state = { ...this.state, effort\|this.state = { ...this.state, model" src/tui/session.ts
```

预期 3 处命中且全部位于 `handleModel` 内（effort 清除、effort 设置、tier 设置）；每处 `this.state = { ... }; this.notify();` 之后、`this.pushMsg(...)` 之前插入一行 `this.logModel();`。**不得**在 `restoreFromSession` 的重放赋值处插入（恢复不回写事件）。

⑥ `closeTask` 内（现 730 行）`this.flushJournal(); // 收口落盘（规格 D3 flush 点①）` 替换为：

```ts
    this.sealJournal(); // 快照清单补拍（事件级：其余事件已随产生落盘，规格 2026-09-22 D2/D8）
```

⑦ `restoreFromSession` 首行（现 594 行）`this.flushJournal(); // 切换前当前会话先收口（切换不丢现场）` 整行删除。

⑧ `/rewind`//fork` 执行路径（现 628 行）`this.flushJournal(); // 当前会话先收口（含影子快照清单回填）` 整行删除；紧邻的 690 行注释 `// 先续挂新档：restoreFromSession 首行 flushJournal 会补拍快照事件——不续挂则写回源档（破坏不可变分档）且指针拨回源会话` 替换为：

```ts
    // 续挂新档并切指针（不可变分档：源档零改动；事件级落盘下 restore 无收口写回面）
```

⑨ `/new` 分支（现 960–963 行）删除 `this.flushJournal();` 与 `this.journal?.flush();` 两行（`rotate` 已即时写 header + 指针），保留 `this.journal?.rotate(newSessionId());` 与其后清安全登记/软重置逻辑。

`src/tui/entry.ts`：删除第 53 行 `ctrl.flushJournal(); // 退出收口（规格 D3 flush 点③）`（其上方注释「优雅退出单点：SIGINT 与空闲态 Ctrl+C（App onExit）共用——flush 会话日志→清定时器→卸载渲染→退出」改为「优雅退出单点：SIGINT 与空闲态 Ctrl+C（App onExit）共用——清定时器→卸载渲染→退出」）；删除第 75 行 finally 块内 `ctrl.flushJournal(); // 退出收口（规格 D3 flush 点③）`（`ctrl.dispose()` 与注释保留）。

`src/harness/tools/write-snapshot.ts` 头注释第 9 行「任务收口时 drain() 交 SessionJournal.amendLastUser 随 user 事件落盘。」替换为：

```
 * 任务收口时 drain() 以 snapshots 事件尾追落盘（规格 docs/superpowers/specs/2026-09-22-event-level-journal-persistence-design.md D2）。
```

- [ ] **Step 5: 编译 + 定向测试转绿**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json \
  && node --test dist/tui/session-journal.test.js \
  && node --test dist/tui/session-journal.branch.test.js \
  && node --test dist/tui/session.journal.test.js \
  && node --test dist/tui/session.rewind.test.js
```

预期：四个文件全绿（`session.journal.test.ts` 两处改写已在本任务完成，无跨任务临时红）。出现其他红回到 Step 3/4 修复。

- [ ] **Step 6: 提交（pathspec 限定）**

```bash
git commit -m "feat(tui): 会话日志事件级即时落盘（崩溃丢失窗口缩至在飞一步）" -- src/tui/session-journal.ts src/tui/session.ts src/tui/entry.ts src/harness/tools/write-snapshot.ts src/tui/session-journal.test.ts src/tui/session-journal.branch.test.ts
git show --stat HEAD
```

复核 `git show --stat HEAD` 恰好 6 个文件；`src/model/adapter.test.ts` 等并发文件不得出现。

---

### Task 2: 代码回退收集扩展（snapshots 事件并入恢复窗口）+ 端到端验收

**范围裁决说明**：`session.rewind.test.ts:103` 存在「真实 write → /rewind 代码回退」端到端用例，Task 1 落地 snapshots 事件后若 `collectRestorePlan` 不同批识别该事件，端到端用例必红——故本扩展为 Task 1 的语义闭环、独立成任务但**必须与 Task 1 同批完成**（执行时合并推进、允许 Task 1/Task 2 分两笔提交但不得隔夜跨验证）。

**Files:**
- Modify: `src/tui/session-snapshots.ts`（`collectRestorePlan` 扩展）
- Test: `src/tui/session-snapshots.test.ts`（新增 2 用例）、`src/tui/session.rewind.test.ts`（新增端到端用例）
- Docs: `TUI-MANUAL.md` / `README.md`（仅当 grep 命中过时表述）

**Interfaces:**
- Consumes: Task 1 的 `JournalEvent` 新成员 `{ t: 'snapshots'; files: SnapshotEntry[] }`（实施者只看本任务时，按此字面类型与 `SnapshotEntry`（`{ path, hash, deleted? }`）消费）。
- Produces: `collectRestorePlan(file: string, anchorLine: number): SnapshotEntry[]` 签名不变，行为扩展——收集窗口（行号 ≥ anchorLine）内 `user.files` 与 `snapshots.files` 两载体合并，按行号序每路径取最早一条。

- [ ] **Step 1: 新增收集用例（红灯）**

`src/tui/session-snapshots.test.ts` 在「collectRestorePlan: 锚点行自身清单参与」用例之后追加（沿用该文件 `tmpdir`/原始字符串造档惯例，无需动 `makeJournal`）：

```ts
test('collectRestorePlan: snapshots 事件并入收集（user.files 与 snapshots 两载体合并，行序每路径取最早）', () => {
  const dataDir = tmpdir('snap-collect3-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    const file = path.join(sessionsDir(dataDir), 'j3.jsonl');
    // 行 2 user.files a→v1 / 行 4 snapshots a→v1b / 行 6 user b→v0 / 行 8 snapshots a→v2
    fs.writeFileSync(file, [
      '{"t":"header","v":1,"id":"j3","createdAt":"x"}',
      '{"t":"user","text":"t1","files":[{"path":"a.txt","hash":"h-v1"}]}',
      '{"t":"snapshots","files":[{"path":"a.txt","hash":"h-v1b"}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r1","ts":0,"seq":1}}',
      '{"t":"user","text":"t2","files":[{"path":"b.txt","hash":"h-v0"}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r2","ts":0,"seq":2}}',
      '{"t":"snapshots","files":[{"path":"a.txt","hash":"h-v2"}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r3","ts":0,"seq":3}}',
    ].join('\n') + '\n', 'utf8');
    const plan = collectRestorePlan(file, 2);
    assert.deepEqual(plan, [
      { path: 'a.txt', hash: 'h-v1' },
      { path: 'b.txt', hash: 'h-v0' },
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('collectRestorePlan: 纯 snapshots 档（无任何 user.files）照常收集', () => {
  const dataDir = tmpdir('snap-collect4-');
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    const file = path.join(sessionsDir(dataDir), 'j4.jsonl');
    fs.writeFileSync(file, [
      '{"t":"header","v":1,"id":"j4","createdAt":"x"}',
      '{"t":"user","text":"t1"}',
      '{"t":"snapshots","files":[{"path":"c.txt","hash":"h-c","deleted":true}]}',
      '{"t":"msg","item":{"role":"assistant","text":"r1","ts":0,"seq":1}}',
    ].join('\n') + '\n', 'utf8');
    const plan = collectRestorePlan(file, 2);
    assert.deepEqual(plan, [{ path: 'c.txt', hash: 'h-c', deleted: true }]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认红灯**

```bash
node --test dist/tui/session-snapshots.test.js
```

预期：两条新用例失败（`collectRestorePlan` 尚不识别 snapshots 事件，plan 为空/缺项）；既有 4 条用例绿。

- [ ] **Step 3: 扩展 `collectRestorePlan`（最小实现）**

`src/tui/session-snapshots.ts`：头注释下方行为说明行「收集行号 ≥ anchorLine 的 user 事件 files（≥ 含锚点轮自身写入），每文件取行号最早一条，行号序输出」替换为：

```ts
/** 收集行号 ≥ anchorLine 的 user 事件 files 与 snapshots 事件 files（两载体，≥ 含锚点轮自身写入），每路径取行号最早一条，行号序输出 */
```

`collectRestorePlan` 内判定行：

```ts
    if (i + 1 < anchorLine || e.t !== 'user' || !e.files) return;
```

替换为：

```ts
    if (i + 1 < anchorLine) return;
    if ((e.t !== 'user' && e.t !== 'snapshots') || !e.files) return;
```

其余逻辑（`byPath` 每路径取最早、行号序输出）零改动。

- [ ] **Step 4: 运行定向测试转绿**

```bash
node --test dist/tui/session-snapshots.test.js
```

预期：全部用例绿（既有 4 条零误伤 + 新增 2 条）。

- [ ] **Step 5: 端到端钉子（session.rewind.test.ts 新增用例）**

在 `src/tui/session.rewind.test.ts` 末尾追加（该文件已有「真实 write → /rewind」用例先例，本用例验证「**多个 write 轮 + snapshots 事件跨轮合并**」形态；ScriptedAdapter 步骤与 env 钉法照抄第 103 行用例现场惯例）：

```ts
test('/rewind 含 write 多轮：snapshots 事件跨轮合并回退（事件级落盘形态）', async () => {
  // 现场惯例照抄 :103 用例（env 钉私有数据目录、ScriptedAdapter 两轮 write、root 内预置 a.txt='v0'）；
  // 断言差异点：
  //   1. 任务收口后读档：含两条 snapshots 事件（每轮一条、files 非空）；
  //   2. /rewind code 回退后 a.txt === 'v0'（collectRestorePlan 合并两轮清单、每路径取最早 pre-image）；
  //   3. 回执含 restored=1；
  //   4. /resume 列表该会话 ↳ 血缘标注不受影响。
});
```

> 实施注记：本用例的 ScriptedAdapter 步骤数组、`pinDataDir` 钉法、审批模式桩、rewind 菜单驱动方式**逐行照抄同文件 :103 起的既有端到端用例**（该用例已证明可运行），仅替换脚本内容与断言面；禁止引入新的测试基建。步骤数组样例：两轮各自 `{"phase":"act","tool":"write","input":{"path":"a.txt","content":"v1"}}` / `v2`（配 `{"done":true,"reply":"..."}` 收尾，形态照抄既有用例）。断言 1 读档用 `parseJournalFile`；断言 4 复用既有血缘标注断言语句（:103 用例附近如有）或 `listSessions` 检 `forkedFrom` 缺省形态。

- [ ] **Step 6: 文档 grep 复核**

```bash
grep -n "flush\|缓冲\|amendLastUser\|三 flush" TUI-MANUAL.md README.md
```

预期零命中（初查已零命中；如命中按正文语境补一句事件级口径，不展开机制叙事）。

- [ ] **Step 7: 提交（pathspec 限定）**

```bash
git commit -m "feat(tui): 代码回退收集扩展 snapshots 事件载体 + 端到端钉子" -- src/tui/session-snapshots.ts src/tui/session-snapshots.test.ts src/tui/session.rewind.test.ts
git show --stat HEAD
```

复核恰好 3 个文件、零并发文件卷入。

---

### Task 3: 残渣清零 + 全量门禁收口

**Files:**
- Verify: 全仓 grep（`flush`/`pending`/`buf`/`amendLastUser`/「三 flush 点」表述）
- Verify: 全量门禁（构建 + 全量测试 + selfcheck）

- [ ] **Step 1: 无残渣终验**

```bash
grep -rn "amendLastUser\|sealJournal" src/ --include="*.ts" | grep -v test
grep -rn "j\.flush()\|\.flushJournal()\|j\.pending\|this\.buf" src/tui/ --include="*.ts"
grep -rn "三 flush 点\|缓冲批量" src/ TUI-MANUAL.md README.md --include="*.ts" --include="*.md"
```

预期：第一行仅命中 `session-journal.ts` 的 `seal` 定义与 `session.ts` 的 `sealJournal` 定义/调用；第二、三行零命中。`write-snapshot.ts` 的 `pending` 私有字段属该收集器自身队列语义，不在清退范围（名称撞车属局部语义，如需强求改名反而扩大并发面——登记豁免）。

- [ ] **Step 2: 全量门禁**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json \
  && node scripts/run-tests.js \
  && node dist/cli/index.js selfcheck
```

预期：tsc strict 零报错；全量 fail 0（基线 1082 + 本线新增 5 − 删除 1（amendLastUser 用例）≈ 1086，允许 ±3 浮动，硬门槛是 fail 0）；selfcheck OK。若非本线文件红：按失败落点与 `git status` 取证归属并发线，如实登记、不卷入修复。

- [ ] **Step 3: 提交（如 Step 1 有文档性残渣清理）**

```bash
git commit -m "chore(tui): 事件级落盘残渣清零" -- <实际触碰文件>
git show --stat HEAD
```

无残渣则本步跳过（零改动不提交）。

---

## 计划自审记录（Self-Review）

1. **规格覆盖**：D1 缓冲删除→Task 1 Step 3；D2 snapshots 事件+`amendLastUser` 删除→Task 1 Step 1/3/4；D3 生命周期落盘→Task 1 Step 3（`startId` 单点）；D4 指针收敛→Task 1 Step 1（指针收敛用例）+Step 3；D5 变更点接线→Task 1 Step 4（todos 两处、/model 三处、view 现状）；D6 additive 兼容→Task 1 Step 1（reduce 未知事件钉子）+Task 2 Step 3（旧档 `user.files` 保留消费）；D7 收口调用清退→Task 1 Step 4（⑦⑧⑨+entry 两处）；D8 更名→Task 1 Step 4（①⑥）。§6 恢复/锚点/分档零变化→Task 1 既有 rewind 测试套件回归承载。§8 验收矩阵 1→Task 1 用例「事件逐条 append」；2→Task 1「continueLast」与 Task 2 端到端；3→Task 2 Step 5；4→Task 1 `seal([])` 用例；5→Task 1 reduce 兼容钉子+Task 2 旧档用例；6→Task 1 指针收敛用例；7→Task 3 Step 1；8→Task 3 Step 2。无缺口。
2. **占位符扫描**：Task 2 Step 5 端到端用例采用「断言面骨架 + 照抄 ：103 既有用例现场惯例」形态——该文件存在可运行的完整先例且逐行可照抄，属「重复既有代码」的替代形态（以文件行号指名先例），非 TBD/TODO；其余步骤全部含完整代码或精确锚点。Task 2 范围裁决说明已把「为何 Task 2 不得晚于 Task 1 验证」钉死。
3. **类型一致性**：`seal(files: SnapshotEntry[])`（Task 1 Produces）与 Task 2 消费的 `{ t: 'snapshots'; files: SnapshotEntry[] }`、`collectRestorePlan` 签名不变扩展、`logModel/logTodos/sealJournal` 私有方法签名——跨任务引用名与 Task 1 Produces 块逐字一致。
4. **范围与并发面**：白名单 10 文件全部在落点表内；`src/model/adapter.test.ts` 等并发文件零触碰；提交一律 pathspec 限定并 `git show --stat` 复核（本线规格落库时已发生一次并发暂存卷入事故并已按先例修复，计划层面把复核固化为提交步骤）。

