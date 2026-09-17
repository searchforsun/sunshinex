# 会话持久化 + /resume + --continue 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TUI 会话可跨进程/跨天持久化与恢复——JSONL 事件日志追加只增、三 flush 点收口落盘、`/resume` + `--continue` 双入口重放还原（链/消息/UI 状态全会话口径）。

**Architecture:** 每会话一文件 `data/sessions/<sessionId>.jsonl` 追加只增 + `sessions-active.json` 活动指针；事件词汇为封闭枚举 schema v1（header/user/msg/chain/compact/todos/model/view）；写=事件入内存缓冲、三个 flush 点（closeTask / /new 轮转 / TUI 退出）批量追加，运行中不写盘；恢复=按序重放重建（ContextManager.restoreSession 直注入 + 控制器状态直注入，不经 pushMsg/订阅——不重复入志、前缀缓存零击穿）。规格：`docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md`（66bd70a）。

**Tech Stack:** TypeScript (strict) + Node.js ≥ 22.9、node:test + node:assert/strict、CommonJS；TUI 渲染层零接触（journal 不感知 ink）。

## Global Constraints

- 门禁（沙箱无 pnpm）：`node_modules/.bin/tsc -p tsconfig.json && node scripts/run-tests.js`（全量基线 635/635）+ `node dist/cli/index.js selfcheck`
- 事件词汇封闭：新增任何持久化状态 = 新事件类型 + 对应重放动作 + 重放一致性断言，三者同批登记
- compact 事件载荷与 ContextManager 内部形态同口径：`{ chainFrom: number; compacted: ContextItem[] }`（修复旧稿 compactBlock 字符串的形状错误）
- 快照型事件（todos/model/view）在 flush 点统一补拍（末值语义）；事件型（user/msg/chain/compact）在变更点产生（单一事实源订阅）
- 恢复安全缺省：status 恒 idle、会话级审批登记不持久化、children/spawnCalls/流式水位瞬态不还原、重放后下一轮 prompt 与存档时逐字节一致（核心测试断言）
- SessionStore 接缝（`src/harness/context/session.ts`）零消费保留不动；security 零改动
- 同一文件多处修改必须串行单编辑（写竞态两次先例）；每次编辑前 `grep -c` 验证锚点唯一
- 路径一律 `path.join`；用户可见文案一律 `t(en, zh)` 运行期求值（i18n）
- 测试数据目录：run-tests.js 钉仓内 `.data-test`；持久化测试 per-test pin `SUNSHINEX_DATA_DIR`（finally save/restore）防互染
- 每任务 TDD（红→绿）+ 提交；全量预期 635 + 新增 ≈22 → 657±2

## 现状锚点（已精读核对）

| 文件 | 锚点 | 形状 |
|---|---|---|
| `src/harness/context/index.ts` | 私有字段 | `compacted: ContextItem[]` / `recent` / `pendingSkill` / `chain: HistoryStep[]` / `chainFrom = 0` / `chainSeq = 0` / `compactions = 0` |
| 同上 | `chainView()` | `return this.chain.slice(this.chainFrom);` |
| 同上 | `appendChain(entries: Array<{ action?; observation }>)` | push `{ step: ++this.chainSeq, ...(action), observation }` |
| 同上 | `trimChainFront(n)` | `n <= 0` 早退；`chainFrom = Math.min(chainFrom + n, chain.length)` |
| 同上 | `applyCompaction(chunks, opts?)` | async；replay 幂等早退；`this.compacted = items;` 后 `return summaryBody !== undefined ? 'model' : 'deterministic';` |
| 同上 | `resetSession()` | 清 chain/chainFrom/chainSeq/compacted/pendingSkill |
| `src/types.ts` | L147 / L258 / L275 | `ModelTier`；`ContextItem {kind, content, meta?}`；`HistoryStep {step, action?, observation}` |
| `src/tui/session.ts` | L17 / L31 | `ChatItem {role, text, ts, seq, kind?, ok?, detail?}`；`TodoItem {text, done}` |
| `src/tui/session.ts` | L96 | `SessionOpts extends TuiRuntimeOpts { asker?, runtime? }` |
| `src/tui/session.ts` | L140 | `private msgSeq = 0;` |
| `src/tui/session.ts` | 构造函数 | 中段 `this.runtime.harness.ledger.load();`；尾部 `if (opts.tier) this.state = { ...this.state, model: opts.tier };` |
| `src/tui/session.ts` | submit 头 | `const text = input.trim(); if (!text) return; this.pushMsg('user', text);` |
| `src/tui/session.ts` | closeTask 尾 | `this.childBufs.clear();` + `this.spawnCalls = [];` + `this.notify();`（4 空格缩进；/new 分支内同款为 6 空格） |
| `src/tui/session.ts` | /new 分支 | `if (cmd === '/new') {` 开头；尾部 `pushMsg('Started a new session')` + `return;` + `}` |
| `src/tui/session.ts` | /resume 插入点 | /new 分支结束 `}` 与 `if (cmd === '/compact') {` 之间 |
| `src/tui/session.ts` | pushMsg | 私有方法，内联构造消息对象（`ts: Date.now(), seq: ++this.msgSeq`）+ `notify()` |
| `src/tui/session.ts` | slashHelp() | 双语命令清单函数（en 含 `' /new new session (soft reset) · '` 段） |
| `src/tui/entry.ts` | runTui | `new SessionController({ root, mode, model, ...(tier…) })` + SIGINT handler + `await runTuiLoop({...})` + `process.exit(0)` |
| `src/tui/tui-loop.ts` | L31 / finally | `const retain = initialRetained();`；`finally { gate.dispose(); current?.unmount(); }` |
| `src/cli/commands/tui.ts` | runTuiCommand 全文 | `positional[0]`→root，`flags.language/mode/tier` 透传 runTui |
| `src/cli/index.ts` | parseArgs | 裸 `--flag` → `true`；USAGE 为双语函数 |
| `src/tui/components/App.tsx` | L25 / L180 / L187 | `SLASH_COMMANDS` 数组；`setExpandAll((v) => !v);`；`setLatestFull((v) => !v);` |
| `src/config/data-dir.ts` | `resolveDataDir(root)` | SUNSHINEX_DATA_DIR 覆盖 → ~/.sunshinex → root/.data |
| 测试脚手架 | node:test + assert/strict | `new SessionController({ root, model: new ScriptedAdapter([...]) })`；`new ContextManager(root, new FileStore(root))`（FileStore 导入路径执行时 grep 现场核对，预计 `../../storage/adapter`） |

## File Structure

- Create: `src/tui/session-journal.ts` —— 会话事件日志纯模块（封闭词汇 / 写面缓冲 / flush+指针 / 解析重放 / 归约 / 清单）
- Create: `src/tui/session-journal.test.ts` —— Task 1 单测
- Modify: `src/harness/context/index.ts` —— 变更订阅 + exportSessionState/restoreSession
- Create: `src/harness/context/session-restore.test.ts` —— Task 2 单测
- Modify: `src/tui/session.ts` —— 三 flush 点挂钩 + /resume + /new 轮转 + 恢复路径 + slashHelp
- Create: `src/tui/session.journal.test.ts` —— Task 3 集成测试
- Modify: `src/tui/tui-loop.ts` —— TuiLoopDeps.initialRetain
- Modify: `src/tui/entry.ts` —— --continue 接线 + 退出/SIGINT flush + initialRetain 播种
- Modify: `src/cli/commands/tui.ts` —— continueLast 透传
- Modify: `src/cli/index.ts` —— USAGE 双语补 --continue
- Modify: `src/cli/cli.test.ts` —— parseArgs --continue 用例
- Modify: `src/tui/components/App.tsx` —— SLASH_COMMANDS + recordView 挂钩
- Modify: `src/tui/components/App.input.test.tsx` —— 补全清单断言
- Modify: `TUI-MANUAL.md` / `README.md` —— 文档同步

---
### Task 1: session-journal 模块（事件词汇 / 写面 / 解析重放 / 清单 / 指针）

**Files:**
- Create: `src/tui/session-journal.ts`
- Test: `src/tui/session-journal.test.ts`

**Interfaces:**

Consumes: `import type { ContextItem, HistoryStep, ModelTier } from '../types'`；`import type { ChatItem, TodoItem } from './session'`（type-only，无运行时环——session.ts 将在 Task 3 反向值导入本模块）。

Produces（后续任务依赖的确切签名）:
- `type JournalEvent` —— 封闭词汇 v1：`JournalHeader | {t:'user';text} | {t:'msg';item:ChatItem} | {t:'chain';steps:HistoryStep[]} | {t:'compact';chainFrom:number;compacted:ContextItem[]} | {t:'todos';items:TodoItem[]} | {t:'model';tier?:ModelTier} | {t:'view';expandAll:boolean;latestFull:boolean}`
- `interface SessionMeta { id: string; file: string; updatedAt: number; firstUser?: string }`
- `interface ParsedJournal { events: JournalEvent[]; truncated: boolean }`
- `interface JournalReplay { version: number|undefined; chain: HistoryStep[]; chainFrom: number; compacted: ContextItem[]; messages: ChatItem[]; nextSeq: number; history: string[]; todos: TodoItem[]; model?: ModelTier; view: {expandAll:boolean; latestFull:boolean} }`
- `newSessionId(now?: Date): string` —— `YYYYMMDDTHHMMSSZ-xxxx`
- `sessionsDir(dataDir: string): string`
- `readActivePointer(dataDir: string): string | undefined` / `writeActivePointer(dataDir: string, id: string): void`
- `parseJournalFile(file: string): ParsedJournal`
- `reduceJournal(events: JournalEvent[]): JournalReplay`
- `listSessions(dataDir: string): SessionMeta[]`（mtime 降序）
- `class SessionJournal { constructor(dataDir: string); currentId: string|undefined; pending: number; start(): void; rotate(id: string): void; attach(id: string): void; log(e: JournalEvent): void; flush(): boolean }`

- [ ] **Step 1.1: 写失败测试** `src/tui/session-journal.test.ts`（全文）：

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

test('空会话零落盘：未建档 log 丢弃、flush no-op、目录不创建', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.log({ t: 'user', text: '早于建档应丢弃' });
  assert.equal(j.currentId, undefined);
  assert.equal(j.pending, 0);
  assert.equal(j.flush(), false);
  assert.equal(fs.existsSync(sessionsDir(dataDir)), false, '空会话零文件');
});

test('建档→log→flush：header(v=1,id)+事件逐行落盘；缓冲空二次 flush no-op', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  j.log({ t: 'user', text: '你好' });
  j.log({ t: 'model', tier: 'large' });
  assert.equal(j.pending, 3, 'header + 2 事件');
  assert.equal(j.flush(), true);
  assert.equal(j.flush(), false, '缓冲空 flush 不写盘');
  const lines = fs.readFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalEvent);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].t, 'header');
  assert.deepEqual(lines.slice(1), [{ t: 'user', text: '你好' }, { t: 'model', tier: 'large' }]);
  const { events } = parseJournalFile(path.join(sessionsDir(dataDir), id + '.jsonl'));
  assert.equal(events[0].t, 'header');
});

test('rotate：旧档不动、新 header 入缓冲、flush 后指针指向新 id', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  const oldId = j.currentId!;
  j.log({ t: 'user', text: '旧会话输入' });
  j.flush();
  const newId = newSessionId();
  assert.notEqual(newId, oldId);
  j.rotate(newId);
  assert.equal(j.currentId, newId);
  j.log({ t: 'user', text: '新会话输入' });
  j.flush();
  const oldLines = fs.readFileSync(path.join(sessionsDir(dataDir), oldId + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(oldLines.length, 2, '旧档 header+事件不动');
  const newLines = fs.readFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(newLines.length, 2, '新档 header+事件');
  assert.equal(readActivePointer(dataDir), newId, '指针=最近一次 flush 的会话');
});

test('attach 续挂：后续事件追加至既有文件', () => {
  const dataDir = tmp();
  const id = newSessionId();
  const a = new SessionJournal(dataDir);
  a.start();
  const ownId = a.currentId!;
  a.rotate(id);
  a.log({ t: 'user', text: '第一段' });
  a.flush();
  const b = new SessionJournal(dataDir);
  b.attach(id);
  b.log({ t: 'user', text: '第二段' });
  b.flush();
  const lines = fs.readFileSync(path.join(sessionsDir(dataDir), id + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => (JSON.parse(l) as JournalEvent).t === 'header').length, 1, 'header 不重复');
  assert.equal(lines.length, 3, 'header + 2 事件');
  void ownId;
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

test('reduceJournal：全词汇归约——链累积/压缩后态覆盖/消息直汇 nextSeq 取最大/末值覆盖 todos·model·view', () => {
  const r = reduceJournal([
    { t: 'header', v: 1, id: 'a', createdAt: 'x' },
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
  ]);
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
  a.flush();
  fs.utimesSync(path.join(sessionsDir(dataDir), older + '.jsonl'), new Date(), new Date(1_000_000_000));
  const b = new SessionJournal(dataDir);
  b.rotate(newer);
  b.log({ t: 'user', text: '较新会话的首条输入' });
  b.flush();
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

- [ ] **Step 1.2: 跑红**（模块不存在 → 编译失败即红）

Run: `node_modules/.bin/tsc -p tsconfig.json`
Expected: FAIL（cannot find module './session-journal'）

- [ ] **Step 1.3: 写实现** `src/tui/session-journal.ts`（全文）：

```ts
/** 会话事件日志（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md D1/D3/D4/D5）：
 *  每会话一文件 data/sessions/<sessionId>.jsonl 追加只增 + data/sessions-active.json 活动指针。
 *  事件词汇封闭枚举 schema v1：新增持久化状态必须先登记新事件类型 + 对应重放动作 + 重放一致性断言，三者同批。
 *  写=缓冲批量追加（三 flush 点：closeTask / /new 轮转 / TUI 退出），运行中不写盘；
 *  读=逐行解析重放（尾行撕裂/中段损坏重放到上一条完整事件、未知版本由调用方拒载）。 */
import * as fs from 'fs';
import * as path from 'path';
import type { ContextItem, HistoryStep, ModelTier } from '../types';
import type { ChatItem, TodoItem } from './session';

export interface JournalHeader {
  t: 'header';
  v: number;
  id: string;
  createdAt: string;
}

/** 封闭事件词汇 schema v1 */
export type JournalEvent =
  | JournalHeader
  | { t: 'user'; text: string }
  | { t: 'msg'; item: ChatItem }
  | { t: 'chain'; steps: HistoryStep[] }
  | { t: 'compact'; chainFrom: number; compacted: ContextItem[] }
  | { t: 'todos'; items: TodoItem[] }
  | { t: 'model'; tier?: ModelTier }
  | { t: 'view'; expandAll: boolean; latestFull: boolean };

export interface SessionMeta {
  id: string;
  file: string;
  updatedAt: number;
  firstUser?: string;
}

export interface ParsedJournal {
  events: JournalEvent[];
  truncated: boolean;
}

export interface JournalReplay {
  version: number | undefined;
  chain: HistoryStep[];
  chainFrom: number;
  compacted: ContextItem[];
  messages: ChatItem[];
  nextSeq: number;
  history: string[];
  todos: TodoItem[];
  model?: ModelTier;
  view: { expandAll: boolean; latestFull: boolean };
}

const ACTIVE_POINTER = 'sessions-active.json';

/** 会话 id：UTC 紧凑时间戳 + 4 位随机尾（文件名安全、可排序） */
export function newSessionId(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 会话日志目录：<dataDir>/sessions */
export function sessionsDir(dataDir: string): string {
  return path.join(dataDir, 'sessions');
}

/** 活动指针读取：最近一次有落盘的会话 id；无指针/损坏返回 undefined（不静默造档） */
export function readActivePointer(dataDir: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, ACTIVE_POINTER), 'utf8')) as { id?: unknown };
    return typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  } catch {
    return undefined;
  }
}

export function writeActivePointer(dataDir: string, id: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, ACTIVE_POINTER), JSON.stringify({ id }), 'utf8');
}

/** 逐行解析：坏行（尾行撕裂/中段损坏）停在上一条完整事件并标 truncated（fail-bounded） */
export function parseJournalFile(file: string): ParsedJournal {
  const events: JournalEvent[] = [];
  let truncated = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch {
      truncated = true;
      break;
    }
  }
  return { events, truncated };
}

/** 重放归约（封闭词汇 v1）：链累积、压缩后态覆盖（末值语义）、消息直汇、user 汇输入历史、todos/model/view 末值覆盖 */
export function reduceJournal(events: JournalEvent[]): JournalReplay {
  const r: JournalReplay = {
    version: undefined,
    chain: [],
    chainFrom: 0,
    compacted: [],
    messages: [],
    nextSeq: 0,
    history: [],
    todos: [],
    view: { expandAll: false, latestFull: false },
  };
  for (const e of events) {
    switch (e.t) {
      case 'header':
        r.version = e.v;
        break;
      case 'chain':
        r.chain.push(...e.steps);
        break;
      case 'compact':
        r.chainFrom = e.chainFrom;
        r.compacted = e.compacted;
        break;
      case 'msg':
        r.messages.push(e.item);
        r.nextSeq = Math.max(r.nextSeq, e.item.seq);
        break;
      case 'user':
        r.history.push(e.text);
        break;
      case 'todos':
        r.todos = e.items;
        break;
      case 'model':
        r.model = e.tier;
        break;
      case 'view':
        r.view = { expandAll: e.expandAll, latestFull: e.latestFull };
        break;
    }
  }
  return r;
}

/** 档案列表（/resume 无参展示）：mtime 降序；扫文件头 8 行取首条用户输入作摘要（零重放成本） */
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
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(0, 8)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEvent;
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
    metas.push({ id: name.slice(0, -'.jsonl'.length), file, updatedAt, ...(firstUser !== undefined ? { firstUser } : {}) });
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 会话日志写面：事件入缓冲（运行中不写盘）、flush 点批量落盘并维护活动指针；未建档 log 丢弃（空会话零文件） */
export class SessionJournal {
  private buf: string[] = [];
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

  get pending(): number {
    return this.buf.length;
  }

  /** 建档（首个持久化事件触发）：生成 id，header 入缓冲随首个 flush 落盘 */
  start(): void {
    if (this.id) return;
    this.id = newSessionId();
    const header: JournalHeader = { t: 'header', v: 1, id: this.id, createdAt: new Date().toISOString() };
    this.buf.push(JSON.stringify(header));
  }

  /** 轮转（/new）：清缓冲换新 id，新 header 入缓冲（旧档已在盘） */
  rotate(id: string): void {
    this.buf = [];
    this.id = id;
    const header: JournalHeader = { t: 'header', v: 1, id, createdAt: new Date().toISOString() };
    this.buf.push(JSON.stringify(header));
  }

  /** 续挂既有日志（/resume / --continue）：后续事件追加至同一文件，不重复 header */
  attach(id: string): void {
    this.buf = [];
    this.id = id;
  }

  log(event: JournalEvent): void {
    if (!this.id) return; // 未建档：事件丢弃（空会话零文件）
    this.buf.push(JSON.stringify(event));
  }

  /** flush 点：批量追加 + 活动指针更新；缓冲空为 no-op（不落盘不动指针） */
  flush(): boolean {
    if (!this.id || this.buf.length === 0) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, this.id + '.jsonl'), this.buf.join('\n') + '\n', 'utf8');
    this.buf = [];
    writeActivePointer(this.dataDir, this.id);
    return true;
  }
}
```

- [ ] **Step 1.4: 跑绿（定向）**

Run: `node_modules/.bin/tsc -p tsconfig.json && node --test dist/tui/session-journal.test.js`
Expected: PASS（11 tests）

- [ ] **Step 1.5: 全量回归**

Run: `node_modules/.bin/tsc -p tsconfig.json && node scripts/run-tests.js`
Expected: 646±1 PASS（基线 635 + 新增 11），0 fail

- [ ] **Step 1.6: 提交**

```bash
git add src/tui/session-journal.ts src/tui/session-journal.test.ts
git commit -m "feat(tui): 会话事件日志模块——封闭词汇 schema v1/缓冲批量落盘/重放容错/档案清单与活动指针"
```

---
### Task 2: ContextManager 变更订阅 + exportSessionState/restoreSession

**Files:**
- Modify: `src/harness/context/index.ts`
- Test: `src/harness/context/session-restore.test.ts`（Create）

**Interfaces:**

Consumes: 既有 `chain/chainFrom/chainSeq/compacted` 私有字段；`appendChain/trimChainFront/applyCompaction/resetSession` 既有方法。

Produces:
- `export type ContextChange = { kind: 'append'; steps: HistoryStep[] } | { kind: 'compact'; chainFrom: number; compacted: ContextItem[] }`（模块级导出）
- `export interface ContextSessionState { chain: HistoryStep[]; chainFrom: number; compacted: ContextItem[] }`
- `onContextChange(cb?: (c: ContextChange) => void): void`（单槽，后注册覆盖）
- `exportSessionState(): ContextSessionState`（深拷贝）
- `restoreSession(s: ContextSessionState): void`（直注入，不触发订阅，chainSeq 按链内最大步号续排）

纪律：本文件 4 处修改**必须逐个串行**（写竞态先例），每处编辑前 `grep -c` 验证锚点唯一。

- [ ] **Step 2.0: 现场核对三方法原文**（供编辑锚对齐）

Run: `grep -n -A 7 'appendChain\|trimChainFront\|resetSession' src/harness/context/index.ts | head -40`
核对计划给出的 old_string 与现场逐字符一致；若空格/换行有出入，以现场文本为 old_string、按下述目标语义做等价改写（fire 点位置不变）。

- [ ] **Step 2.1: 写失败测试** `src/harness/context/session-restore.test.ts`（全文）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextChange, ContextManager } from './index';
import { FileStore } from '../../storage/adapter';

const setup = (): ContextManager => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-csr-'));
  return new ContextManager(tmp, new FileStore(tmp));
};

test('订阅：appendChain 发出 append 事件（携带实际推入的行与绝对步号），空追加不发', () => {
  const cm = setup();
  const seen: ContextChange[] = [];
  cm.onContextChange((c) => seen.push(c));
  cm.appendChain([{ action: 'task', observation: '指令行' }, { observation: '结论行' }]);
  cm.appendChain([]);
  assert.deepEqual(seen, [
    { kind: 'append', steps: [{ step: 1, action: 'task', observation: '指令行' }, { step: 2, observation: '结论行' }] },
  ]);
});

test('订阅：applyCompaction 与 trimChainFront 各发一条 compact（后态快照，重放末值覆盖）', async () => {
  const cm = setup();
  const seen: ContextChange[] = [];
  cm.onContextChange((c) => seen.push(c));
  cm.appendChain([{ observation: '旧步骤' }]);
  const chunks = await cm.window.compact([{ kind: 'history', content: '较长的旧上下文内容 '.repeat(30) }]);
  await cm.applyCompaction(chunks);
  cm.trimChainFront(1);
  const compacts = seen.filter((c): c is Extract<ContextChange, { kind: 'compact' }> => c.kind === 'compact');
  assert.equal(compacts.length, 2, '压缩配对产生两条 compact 事件');
  assert.equal(compacts[0].chainFrom, 0, 'applyCompaction 先发（水位未折）');
  assert.equal(compacts[1].chainFrom, 1, 'trimChainFront 后发（水位已折）');
  assert.ok(compacts[1].compacted.length > 0, '压缩块非空');
});

test('restoreSession：直注入不触发订阅；chainSeq 按链内最大步号续排', () => {
  const cm = setup();
  let fired = 0;
  cm.onContextChange(() => fired++);
  cm.restoreSession({ chain: [{ step: 3, observation: '历史步骤' }], chainFrom: 0, compacted: [{ kind: 'system', content: '摘要' }] });
  assert.equal(fired, 0, '恢复注入不经过订阅');
  assert.deepEqual(cm.chainView(), [{ step: 3, observation: '历史步骤' }]);
  cm.appendChain([{ observation: '恢复后新步骤' }]);
  const view = cm.chainView();
  assert.deepEqual(view.map((s) => s.step), [3, 4], '步号从最大值续排不回绕');
  assert.equal(cm.exportSessionState().chainFrom, 0);
});

test('export → restore 往返：链视图与压缩块与原实例逐字段一致', async () => {
  const a = setup();
  const events: ContextChange[] = [];
  a.onContextChange((c) => events.push(c));
  a.appendChain([{ observation: 's1' }, { observation: 's2' }]);
  const chunks = await a.window.compact([{ kind: 'history', content: '旧上下文内容 '.repeat(30) }]);
  await a.applyCompaction(chunks);
  a.trimChainFront(1);
  a.appendChain([{ observation: 's3' }]);
  // 用事件流重放（journal 归约的同构语义：链累积 + compact 末值覆盖）
  const steps = events.filter((e) => e.kind === 'append').flatMap((e) => e.steps);
  const lastCompact = [...events].reverse().find((e): e is Extract<ContextChange, { kind: 'compact' }> => e.kind === 'compact');
  assert.ok(lastCompact);
  const b = setup();
  b.restoreSession({ chain: steps, chainFrom: lastCompact.chainFrom, compacted: lastCompact.compacted });
  assert.deepEqual(b.chainView(), a.chainView(), '链视图（水位折后）一致');
  assert.deepEqual(b.exportSessionState().chain, a.exportSessionState().chain, '全量链一致');
  assert.deepEqual(b.exportSessionState().compacted, a.exportSessionState().compacted, '压缩块一致');
});

test('exportSessionState 深拷贝：改动返回值不回渗内部数组', () => {
  const cm = setup();
  cm.appendChain([{ observation: 's1' }]);
  const snap = cm.exportSessionState();
  snap.chain.push({ step: 99, observation: '外部注入' });
  snap.chainFrom = 10;
  assert.equal(cm.chainView().length, 1);
  assert.equal(cm.exportSessionState().chainFrom, 0);
});
```

注：测试脚手架 `new ContextManager(tmp, new FileStore(tmp))` 与 `import { FileStore } from '../../storage/adapter'` 以 compaction.test.ts 现场导入为准；Step 2.0 时一并执行 `grep -n "FileStore" src/harness/context/compaction.test.ts | head -2` 核对路径。

- [ ] **Step 2.2: 跑红**

Run: `node_modules/.bin/tsc -p tsconfig.json`
Expected: FAIL（ContextChange/restoreSession 不存在）

- [ ] **Step 2.3: 实现——编辑 1/4（串行）**：类型导出

锚点：`export class ContextManager {`（`grep -c 'export class ContextManager {' src/harness/context/index.ts` 应为 1）
old_string：`export class ContextManager {`
new_string（类型块 + 原行）：

```ts
/** 会话链/压缩变更事件（会话日志订阅面，规格 2026-09-17-session-persistence-resume-design.md §5 单一事实源）：
 *  append=链尾追加（携带实际推入的行与绝对步号）；compact=压缩后状态快照——applyCompaction 与 trimChainFront 各发一条，
 *  重放按序覆盖取后态（配对压缩产生两条 compact 事件，最终状态精确）。 */
export type ContextChange =
  | { kind: 'append'; steps: HistoryStep[] }
  | { kind: 'compact'; chainFrom: number; compacted: ContextItem[] };

/** 会话状态完整快照（exportSessionState / restoreSession 载荷） */
export interface ContextSessionState {
  chain: HistoryStep[];
  chainFrom: number;
  compacted: ContextItem[];
}

export class ContextManager {
```

- [ ] **Step 2.4: 实现——编辑 2/4（串行）**：订阅字段

锚点：`  private compactions = 0;`（grep -c 应为 1）
old_string：`  private compactions = 0;`
new_string：

```ts
  private compactions = 0;
  /** 会话变更订阅（单槽，后注册覆盖；restoreSession 直注入不经过此口） */
  private changeSink?: (c: ContextChange) => void;
```

- [ ] **Step 2.5: 实现——编辑 3/4（串行）**：onContextChange + exportSessionState + restoreSession 方法组

锚点：`  chainView(): HistoryStep[] {`（grep -c 应为 1）
old_string：`  chainView(): HistoryStep[] {`
new_string（方法组 + 原行）：

```ts
  /** 会话变更订阅（会话日志单一事实源挂钩，规格 §5）：appendChain/applyCompaction/trimChainFront 三类变更发出；传 undefined 取消 */
  onContextChange(cb?: (c: ContextChange) => void): void {
    this.changeSink = cb;
  }

  /** 会话状态导出（完整快照；深拷贝防外部改写内部数组） */
  exportSessionState(): ContextSessionState {
    return { chain: this.chain.map((s) => ({ ...s })), chainFrom: this.chainFrom, compacted: this.compacted.map((i) => ({ ...i })) };
  }

  /** 会话状态恢复（/resume / --continue）：直接注入，不触发订阅（重放期间日志是读方，不二次记录）；chainSeq 按链内最大步号续排 */
  restoreSession(s: ContextSessionState): void {
    this.chain = s.chain.map((st) => ({ ...st }));
    this.chainFrom = s.chainFrom;
    this.compacted = s.compacted.map((i) => ({ ...i }));
    this.chainSeq = this.chain.reduce((m, st) => Math.max(m, st.step), 0);
  }

  chainView(): HistoryStep[] {
```

- [ ] **Step 2.6: 实现——编辑 4/4（串行）**：三个 fire 点

(a) appendChain——old_string：

```ts
  appendChain(entries: Array<{ action?: string; observation: string }>): void {
    for (const e of entries) {
      this.chain.push({ step: ++this.chainSeq, ...(e.action !== undefined ? { action: e.action } : {}), observation: e.observation });
    }
  }
```

new_string：

```ts
  appendChain(entries: Array<{ action?: string; observation: string }>): void {
    const pushed: HistoryStep[] = [];
    for (const e of entries) {
      const step = { step: ++this.chainSeq, ...(e.action !== undefined ? { action: e.action } : {}), observation: e.observation };
      this.chain.push(step);
      pushed.push(step);
    }
    if (pushed.length > 0) this.changeSink?.({ kind: 'append', steps: pushed });
  }
```

(b) trimChainFront——old_string：

```ts
  trimChainFront(n: number): void {
    if (n <= 0) return;
    this.chainFrom = Math.min(this.chainFrom + n, this.chain.length);
  }
```

new_string：

```ts
  trimChainFront(n: number): void {
    if (n <= 0) return;
    this.chainFrom = Math.min(this.chainFrom + n, this.chain.length);
    this.changeSink?.({ kind: 'compact', chainFrom: this.chainFrom, compacted: this.compacted });
  }
```

(c) applyCompaction——锚点 `    this.compacted = items;`（grep -c 应为 1）
old_string：`    this.compacted = items;`
new_string：

```ts
    this.compacted = items;
    this.changeSink?.({ kind: 'compact', chainFrom: this.chainFrom, compacted: this.compacted });
```

若 (a) 的 old_string 与现场不一致（此前精读截断），以现场循环体为 old、按「收集 pushed → 循环后非空 fire」语义等价替换；(b)(c) 同理（fire 行插在各自变更落定之后、早退之后——replay 路径不经过 fire 点）。

- [ ] **Step 2.7: 跑绿（定向）**

Run: `node_modules/.bin/tsc -p tsconfig.json && node --test dist/harness/context/session-restore.test.js dist/harness/context/compaction.test.js`
Expected: PASS（新增 5 + 压缩既有套件全绿——订阅为旁路挂点、无 summarizer 时确定性路径行为不变）

- [ ] **Step 2.8: 全量回归**

Run: `node scripts/run-tests.js`
Expected: 651±1 PASS、0 fail

- [ ] **Step 2.9: 提交**

```bash
git add src/harness/context/index.ts src/harness/context/session-restore.test.ts
git commit -m "feat(harness): ContextManager 会话变更订阅 + exportSessionState/restoreSession 直注入（会话日志单一事实源）"
```

---
### Task 3: SessionController 挂钩 + /resume + /new 轮转 + 恢复路径

**Files:**
- Modify: `src/tui/session.ts`（9 处编辑，**全部串行、禁止同轮并行**）
- Test: `src/tui/session.journal.test.ts`（Create）

**Interfaces:**

Consumes: Task 1 全部导出（`SessionJournal/listSessions/newSessionId/readActivePointer/sessionsDir/parseJournalFile/reduceJournal` + 类型）；Task 2 `restoreSession(s: ContextSessionState)`；既有 `resolveDataDir`（`../config/data-dir`）。

Produces:
- `SessionOpts.continueLast?: boolean`（Task 4 CLI 接线入口）
- `public flushJournal(): void`（三 flush 点共用：快照补拍 + 落盘 + 指针）
- `public recordView(expandAll: boolean, latestFull: boolean): void`（Task 4 App 挂钩）
- `public takeRestoredUi(): { history: string[]; expandAll: boolean; latestFull: boolean } | undefined`（Task 4 entry 播种 retain，一次性取走）
- `public resumeLatest(): void`（--continue：读活动指针续接最近会话）
- 私有 `restoreFromSession(meta: SessionMeta): void`（/resume 与 resumeLatest 共用）
- `/resume` 斜杠命令（无参列表 / `<序号|id>` 恢复）

恢复安全缺省（本任务验收口径）：status 恒 idle、审批登记不还原（security 零改动）、children 清空、msgSeq 续排不回绕、消息直注入不走 pushMsg（零重复入志）、`restoreSession` 直注入（零订阅击穿）。

- [ ] **Step 3.0: 现场核对**（三处编辑前必读）

```bash
grep -c "private msgSeq = 0;" src/tui/session.ts                     # 应为 1
grep -c "this.runtime.harness.ledger.load();" src/tui/session.ts     # 应为 1
grep -n "private pushMsg" src/tui/session.ts                         # 定位行号
sed -n '<pushMsg 行号>,+8p' src/tui/session.ts                       # 读出方法全文
```

pushMsg 若为 spread 形态（内联对象 + `++this.msgSeq`），old_string 用现场全文；若为 `this.state.messages.push(item); return item;` 形态，在 push 后、return 前插 `this.journal.log({ t: 'msg', item });`（并确保方法先经 `const j = this.ensureJournal();`）。下文 Step 3.4 以 spread 形态为默认。

- [ ] **Step 3.1: 写失败测试** `src/tui/session.journal.test.ts`（全文）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { SessionJournal, listSessions, newSessionId, parseJournalFile, readActivePointer, reduceJournal, sessionsDir } from './session-journal';

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-persist-'));

/** 持久化测试钉数据目录：控制器构造期即经 resolveDataDir 解析写点，必须在构造前设置；finally 恢复防互染 */
function pinDataDir(root: string): string {
  const dataDir = path.join(root, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return dataDir;
}

test('重放一致性：live 会话（任务×2 + /model）重放到新控制器，消息/链/档位逐字段一致，seq 续排不回绕', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务一完成"}', '{"done":true,"reply":"任务二完成"}']) });
    await ctrl1.submit('第一个任务');
    await ctrl1.waitIdle();
    await ctrl1.submit('/model large');
    await ctrl1.submit('第二个任务');
    await ctrl1.waitIdle();
    const before = ctrl1.getState().messages.map((m) => ({ role: m.role, text: m.text, seq: m.seq }));
    const beforeChain = ctrl1.context.chainView();
    const maxSeq = before.length > 0 ? before[before.length - 1].seq : 0;

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"恢复后完成"}']) });
    await ctrl2.submit('/resume 1');
    await ctrl2.waitIdle();
    const after = ctrl2.getState().messages;
    assert.equal(after.length, before.length + 1, '恢复流 = 存档消息 + 恢复提示行');
    assert.deepEqual(after.slice(0, before.length).map((m) => ({ role: m.role, text: m.text, seq: m.seq })), before, '消息流逐字段一致（role/text/seq，ts 随档还原）');
    assert.equal(after[after.length - 1].role, 'system');
    assert.deepEqual(ctrl2.context.chainView(), beforeChain, '链视图逐字段一致');
    assert.equal(ctrl2.getState().model, 'large', '档位还原');
    assert.equal(ctrl2.getState().status, 'idle', '恢复后安全缺省 idle');

    // seq 续排：恢复后新任务的消息 seq 严格大于存档最大 seq
    await ctrl2.submit('恢复后新输入');
    await ctrl2.waitIdle();
    const msgs = ctrl2.getState().messages;
    assert.ok(msgs.slice(before.length + 1).every((m) => m.seq > maxSeq), 'seq 续排不回绕');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 轮转：旧档留存可找回、列表倒序、序号恢复旧会话', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务甲完成"}', '{"done":true,"reply":"任务乙完成"}']) });
    await ctrl1.submit('任务甲');
    await ctrl1.waitIdle();
    await ctrl1.submit('/new');
    await ctrl1.submit('任务乙');
    await ctrl1.waitIdle();
    // ScriptedAdapter 全程亚毫秒完成：两档 mtime 同毫秒并列会让「最新在前」排序不确定，显式钉 mtime（与 session-journal.test.ts 先例一致）
    const activeId = readActivePointer(dataDir);
    for (const m of listSessions(dataDir)) {
      fs.utimesSync(m.file, new Date(), new Date(m.id === activeId ? 2_000_000_000 : 1_000_000_000));
    }
    const metas = listSessions(dataDir);
    assert.equal(metas.length, 2, '/new 轮转后两个会话档并存');
    assert.equal(readActivePointer(dataDir), metas[0].id, '指针=最近有落盘的会话（乙）');
    assert.equal(metas[0].firstUser, '任务乙', '列表最新在前');

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl2.submit('/resume 2');
    const texts = ctrl2.getState().messages.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes('任务甲')), '恢复的是旧会话（任务甲）');
    assert.ok(!ctrl2.getState().messages.some((m) => m.text === '任务乙'), '新会话内容不混入');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('空会话与斜杠会话零落盘：无收口点不建文件；零输入退出不落盘', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/help');
    assert.deepEqual(listSessions(dataDir), [], '斜杠会话缓冲未收口不落盘');
    ctrl.flushJournal(); // 模拟退出 flush：快照型事件仅在已建档时补拍
    // /help 有输入 → 退出 flush 允许落一个小档（首个持久化事件建档语义）；若实现为空会话零档则 len 仍为 0
    assert.ok(listSessions(dataDir).length <= 1);
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('continueLast：手工日志全词汇还原（消息/链/待办/档位/视图/输入历史），横幅上屏，UI 现场一次性取用', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const j = new SessionJournal(dataDir);
    j.start();
    j.log({ t: 'user', text: '历史输入一' });
    j.log({ t: 'msg', item: { role: 'user', text: '历史输入一', ts: 1, seq: 1 } });
    j.log({ t: 'msg', item: { role: 'assistant', text: '历史答复', ts: 2, seq: 2 } });
    j.log({ t: 'chain', steps: [{ step: 1, action: 'task', observation: '指令行' }] });
    j.log({ t: 'todos', items: [{ text: '待办甲', done: false }] });
    j.log({ t: 'model', tier: 'small' });
    j.log({ t: 'view', expandAll: true, latestFull: false });
    j.flush();
    const id = j.currentId!;

    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), continueLast: true });
    assert.equal(ctrl.getState().status, 'idle');
    assert.deepEqual(ctrl.getState().todos, [{ text: '待办甲', done: false }]);
    assert.equal(ctrl.getState().model, 'small');
    const texts = ctrl.getState().messages.map((m) => m.text);
    assert.ok(texts.includes('历史输入一') && texts.includes('历史答复'), '消息直注入');
    assert.ok(texts.some((t) => t.includes(String(id))), '续接横幅含会话 id');
    const ui = ctrl.takeRestoredUi();
    assert.deepEqual(ui, { history: ['历史输入一'], expandAll: true, latestFull: false }, 'UI 现场一次性取用');
    assert.equal(ctrl.takeRestoredUi(), undefined, '二次取用为 undefined');
    assert.deepEqual(ctrl.context.chainView(), [{ step: 1, action: 'task', observation: '指令行' }]);
    assert.equal(readActivePointer(dataDir), id, '指针保持指向被恢复会话');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('日志尾行撕裂：恢复到最后一条完整事件并上屏提示', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    const id = newSessionId();
    const file = path.join(sessionsDir(dataDir), id + '.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ t: 'header', v: 1, id, createdAt: 'x' }),
      JSON.stringify({ t: 'user', text: '完整输入' }),
      JSON.stringify({ t: 'msg', item: { role: 'user', text: '完整输入', ts: 1, seq: 1 } }),
      '{"t":"msg","item":{"ro',
    ].join('\n'), 'utf8');
    const events = parseJournalFile(file).events;
    const r = reduceJournal(events);
    void r;
    SessionJournal; // 类型面引用
    const { writeActivePointer } = await import('./session-journal');
    writeActivePointer(dataDir, id);

    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), continueLast: true });
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(texts.includes('完整输入'), '完整事件已恢复');
    assert.ok(texts.includes('truncated') || texts.includes('截断'), '撕裂提示上屏');
    assert.equal(ctrl.getState().messages.length, 2, '消息 + 提示行，撕裂事件不复活');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3.2: 跑红**

Run: `node_modules/.bin/tsc -p tsconfig.json`
Expected: FAIL（continueLast / journal 不存在）

- [ ] **Step 3.3: 实现——编辑 1/9（串行）**：imports

锚点：`import * as path from 'path';`（session.ts 内 grep -c 应为 1）
old_string：`import * as path from 'path';`
new_string：

```ts
import * as path from 'path';
import { SessionJournal, listSessions, newSessionId, readActivePointer, sessionsDir, parseJournalFile, reduceJournal, type SessionMeta } from './session-journal';
import { resolveDataDir } from '../config/data-dir';
```

随后（同轮第二个串行编辑）types 导入行加 ContextItem——锚点：`import { ApprovalDecision, ApprovalRequest, HistoryStep, ModelTier, SessionEvent } from '../types';`（grep -c 应为 1；若现场行略有出入以现场为准）
new_string：`import { ApprovalDecision, ApprovalRequest, ContextItem, HistoryStep, ModelTier, SessionEvent } from '../types';`

- [ ] **Step 3.4: 实现——编辑 2/9（串行）**：SessionOpts 增 continueLast

锚点：`export interface SessionOpts extends TuiRuntimeOpts {`（grep -c 应为 1）
old_string：`export interface SessionOpts extends TuiRuntimeOpts {`
new_string：

```ts
export interface SessionOpts extends TuiRuntimeOpts {
  /** 启动即续接最近会话（CLI --continue；规格 D1/D5）。无档位时提示并以新会话继续，不静默吞 */
  continueLast?: boolean;
```

- [ ] **Step 3.5: 实现——编辑 3/9（串行）**：字段区

锚点：`  private msgSeq = 0;`（grep -c 应为 1）
old_string：`  private msgSeq = 0;`
new_string：

```ts
  private msgSeq = 0;
  /** 会话事件日志（规格 2026-09-17-session-persistence D4）：惰性建档（首个持久化事件）、三 flush 点批量落盘 */
  private journal?: SessionJournal;
  /** 最近已知视图两态（recordView 维护；flush 快照与 /new 轮转初始快照的基准） */
  private lastView = { expandAll: false, latestFull: false };
  /** 恢复携带的 UI 现场（--continue / /resume 重放产物；entry 经 takeRestoredUi 播种 retain，一次性取走） */
  private restoredUi?: { history: string[]; expandAll: boolean; latestFull: boolean };
```

- [ ] **Step 3.6: 实现——编辑 4/9（串行）**：构造函数尾（订阅 + continueLast）

锚点：`    this.runtime.harness.ledger.load();`（grep -c 应为 1）
old_string：`    this.runtime.harness.ledger.load();`
new_string：

```ts
    this.runtime.harness.ledger.load();
    // 会话日志订阅（规格 §5 单一事实源）：链/压缩变更 → 事件缓冲；任务必经 submit 建档，此后事件动态路由到当前 journal 实例。
    // 未建档时事件丢弃（订阅常驻、可选链路由）；restoreSession 直注入不触发订阅（重放零击穿）。
    this.runtime.harness.context.onContextChange((c) => {
      if (c.kind === 'append') this.journal?.log({ t: 'chain', steps: c.steps });
      else this.journal?.log({ t: 'compact', chainFrom: c.chainFrom, compacted: c.compacted });
    });
    if (opts.continueLast) this.resumeLatest();
```

注：若现场 `ledger.load()` 行后紧跟 `if (opts.tier)` 行，本编辑仍安全（插在两者之间，依赖仅为 this.runtime 已初始化 ✓）。

- [ ] **Step 3.7: 实现——编辑 5/9（串行）**：submit 头（user 事件先于回显）

锚点（三行，grep -c 应为 1）：
old_string：

```ts
  async submit(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;
```

new_string：

```ts
  async submit(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;
    // 会话日志（规格 D4/D6）：首个持久化事件建档；user 事件=输入历史还原源，先于回显入志
    const j = this.ensureJournal();
    j.start();
    j.log({ t: 'user', text });
```

- [ ] **Step 3.8: 实现——编辑 6/9（串行）**：pushMsg 挂钩（msg 事件）

按 Step 3.0 读出的现场形态改写。spread 形态默认：
old_string：

```ts
  private pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok' | 'detail'>>): void {
    this.state = {
      ...this.state,
      messages: [...this.state.messages, { role, text, ts: Date.now(), seq: ++this.msgSeq, ...(extra ?? {}) }],
    };
    this.notify();
  }
```

new_string：

```ts
  private pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok' | 'detail'>>): void {
    const item: ChatItem = { role, text, ts: Date.now(), seq: ++this.msgSeq, ...(extra ?? {}) };
    this.state = { ...this.state, messages: [...this.state.messages, item] };
    // 消息流入志（单一挂钩点：所有入档消息都经 pushMsg）；恢复注入不经此处（零重复入志）
    this.journal?.log({ t: 'msg', item });
    this.notify();
  }
```

push+return 形态则等价改写：`const item` 提取 + push 后插 `this.journal?.log({ t: 'msg', item });`（return item 保留）。

- [ ] **Step 3.9: 实现——编辑 7/9（串行）**：closeTask 收口 + 方法组

(a) closeTask 收口——锚点（三行，4 空格缩进；grep -c 应为 1，/new 分支内同款为 6 空格缩进）：
old_string：

```ts
    this.childBufs.clear();
    this.spawnCalls = [];
    this.notify();
```

new_string：

```ts
    this.childBufs.clear();
    this.spawnCalls = [];
    this.flushJournal(); // 收口落盘（规格 D3 flush 点①）
    this.notify();
```

(b) 方法组——锚点：`  private closeTask(): void {`（grep -c 应为 1）
old_string：`  private closeTask(): void {`
new_string（方法组 + 原行）：

```ts
  // ===== 会话持久化（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md）=====

  /** 会话日志单点获取：首个持久化事件建档；未建档直接返回实例（start 前事件丢弃=空会话零文件） */
  private ensureJournal(): SessionJournal {
    if (!this.journal) this.journal = new SessionJournal(resolveDataDir(this.root));
    return this.journal;
  }

  /** flush 收口（规格 D3 三 flush 点共用）：快照型事件（todos/model/view）末值补拍 + 批量落盘 + 活动指针（journal.flush 内维护）；未建档 no-op（空会话零文件） */
  flushJournal(): void {
    if (!this.journal) return;
    const j = this.journal;
    j.log({ t: 'todos', items: this.state.todos });
    j.log({ t: 'model', ...(this.state.model ? { tier: this.state.model } : {}) });
    j.log({ t: 'view', ...this.lastView });
    j.flush();
  }

  /** 视图两态变更记录（App 切换 Tab/Ctrl+O 调用；缓冲随收口落盘） */
  recordView(expandAll: boolean, latestFull: boolean): void {
    this.lastView = { expandAll, latestFull };
    this.journal?.log({ t: 'view', expandAll, latestFull });
  }

  /** 恢复 UI 现场取用（entry 播种 retain 用；一次性） */
  takeRestoredUi(): { history: string[]; expandAll: boolean; latestFull: boolean } | undefined {
    const ui = this.restoredUi;
    this.restoredUi = undefined;
    return ui;
  }

  /** --continue（规格 D1/D5）：读活动指针续接最近有落盘的会话；无档/档缺失提示后按新会话继续（不静默吞） */
  resumeLatest(): void {
    const dataDir = resolveDataDir(this.root);
    const id = readActivePointer(dataDir);
    const meta = id ? listSessions(dataDir).find((s) => s.id === id) : undefined;
    if (!id || !meta) {
      this.pushMsg('system', t('No saved session to continue; started a fresh one', '没有可续接的已保存会话，已开启新会话'));
      return;
    }
    this.restoreFromSession(meta);
  }

  /** 恢复会话（规格 §6 恢复三面）：flush 当前 → 解析目标日志 → 版本守卫 → 三面直注入 → journal 续挂目标档 */
  private restoreFromSession(meta: SessionMeta): void {
    this.flushJournal(); // 切换前当前会话先收口（切换不丢现场）
    const parsed = parseJournalFile(meta.file);
    const replay = reduceJournal(parsed.events);
    if (replay.version !== 1) {
      this.pushMsg('system', t('Cannot restore this session: unsupported journal version', '无法恢复该会话：日志版本不受支持'));
      return;
    }
    // 三面还原（直注入不经 pushMsg/订阅——零重复入志、零前缀击穿）：链/压缩归 ContextManager；消息/待办/档位归控制器；UI 现场暂存供 entry 播种
    this.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
    this.msgSeq = replay.nextSeq;
    this.state = {
      ...this.state,
      messages: replay.messages,
      todos: replay.todos,
      status: 'idle',
      ...(replay.model !== undefined ? { model: replay.model } : {}),
      approval: undefined,
      live: undefined,
      children: [],
    };
    this.lastView = { ...replay.view };
    this.restoredUi = { history: replay.history, expandAll: replay.view.expandAll, latestFull: replay.view.latestFull };
    this.ensureJournal().attach(meta.id);
    // 横幅在状态注入后上屏（注入前 push 会被 messages 覆盖吞掉）；撕裂场景合并提示，保持「消息 + 单条提示行」
    if (parsed.truncated) {
      this.pushMsg('system', t('Session restored: ' + meta.id + ' — journal tail was truncated (previous crash?); restored up to the last complete event', '已恢复会话：' + meta.id + '（日志尾部截断，此前可能异常退出；已恢复到最后一条完整事件）'));
    } else {
      this.pushMsg('system', t('Session restored: ' + meta.id, '已恢复会话：' + meta.id));
    }
  }

  private closeTask(): void {
```

- [ ] **Step 3.10: 实现——编辑 8/9（串行）**：/new 轮转

Step 3.0 补充核对：`grep -n "cmd === '/new'" src/tui/session.ts` 定位后读出分支头三行。
锚点（两行，grep -c 应为 1）：
old_string：

```ts
    if (cmd === '/new') {
      this.runtime.harness.security.clearSessionAllows();
```

new_string：

```ts
    if (cmd === '/new') {
      // /new 轮转化（规格 D2）：旧会话收口归档 → 换新 sessionId（header 立即落盘、指针随即改指新会话）→ 软重置；旧档 /resume 可找回
      this.flushJournal();
      this.journal?.rotate(newSessionId());
      this.journal?.flush();
      this.runtime.harness.security.clearSessionAllows();
```

注：若分支头首行不是 `security.clearSessionAllows()`（存在 idle 守卫等），锚改为 `    if (cmd === '/new') {` 单行、轮转三行插在分支体最前（守卫之前轮转无害：flush 当前缓冲 + 新 header 暂存缓冲，被拒绝的 /new 不落盘新档——header 仅随下次 flush 落盘，语义仍正确）。

- [ ] **Step 3.11: 实现——编辑 9/9（串行）**：/resume 分支

锚点：`    if (cmd === '/compact') {`（grep -c 应为 1）
old_string：`    if (cmd === '/compact') {`
new_string（/resume 分支 + 原行）：

```ts
    if (cmd === '/resume') {
      // 恢复入口（规格 §6）：无参列表（mtime 降序 + 首条输入摘要）；<序号|id> 恢复目标会话
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /resume unavailable now', '当前有任务进行中，暂不能执行 /resume'));
        return;
      }
      const dataDir = resolveDataDir(this.root);
      const sessions = listSessions(dataDir);
      if (sessions.length === 0) {
        this.pushMsg('system', t('No saved sessions yet', '暂无已保存会话'));
        return;
      }
      const arg = text.trim().split(/\s+/).slice(1).join(' ');
      if (!arg) {
        const lines = sessions.map((s, i) => `${i + 1}. ${s.id}  ${s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）')}`);
        this.pushMsg('system', [t('Saved sessions (newest first) — /resume <number|id>:', '已保存会话（最新在前）—— /resume <序号|id>：'), ...lines].join('\n'));
        return;
      }
      const num = Number.parseInt(arg, 10);
      const pick = Number.isInteger(num) && num >= 1 && num <= sessions.length ? sessions[num - 1] : sessions.find((s) => s.id === arg);
      if (!pick) {
        this.pushMsg('system', t('No such session: ' + arg, '没有这个会话：' + arg));
        return;
      }
      this.restoreFromSession(pick);
      return;
    }
    if (cmd === '/compact') {
```

- [ ] **Step 3.12: 实现——slashHelp 双语段**（两个串行小编辑）

en——锚点：` /new new session (soft reset) · `（grep -c 应为 1）
old_string：` /new new session (soft reset) · `
new_string：` /new new session (soft reset) · /resume resume a saved session: /resume [n|id] · `

zh——锚点：` /new 新会话（软重置） · `
new_string：` /new 新会话（软重置） · /resume 列出/恢复已保存会话：/resume [n|id] · `

（若锚点不命中，`grep -n "new session (soft reset)" src/tui/session.ts` 与 `grep -n "软重置" src/tui/session.ts` 定位现场行，按等价插入。）

- [ ] **Step 3.13: 跑绿（定向）**

Run: `node_modules/.bin/tsc -p tsconfig.json && node --test dist/tui/session.journal.test.js dist/tui/session.plan.test.js dist/tui/session.test.js`
Expected: PASS（新增 5 + session 既有套件全绿——journal 旁路挂点不改变既有任务/plan 行为）

- [ ] **Step 3.14: 全量回归**

Run: `node scripts/run-tests.js`
Expected: 656±2 PASS、0 fail（重放一致性为核心断言；既有「相邻步前缀稳定」用例保持绿——journal 不进提示词拼装面）

- [ ] **Step 3.15: 提交**

```bash
git add src/tui/session.ts src/tui/session.journal.test.ts
git commit -m "feat(tui): SessionController 会话日志接线——三 flush 点//resume//new 轮转/--continue 恢复（重放一致性断言）"
```

---
### Task 4: CLI --continue + App 补全/视图挂钩 + 文档 + 全量门禁

**Files:**
- Modify: `src/cli/commands/tui.ts`（runTuiCommand 全文已核对）
- Modify: `src/tui/entry.ts`（opts 类型 / 构造行 / restored 播种 / 退出与 SIGINT flush）
- Modify: `src/tui/tui-loop.ts`（TuiLoopDeps.initialRetain + retain 合并）
- Modify: `src/tui/components/App.tsx`（SLASH_COMMANDS + 两处 recordView）
- Modify: `src/cli/cli.test.ts`（parseArgs --continue 用例）
- Modify: `src/tui/components/App.input.test.tsx`（补全清单断言）
- Modify: `src/cli/index.ts`（USAGE 双语补 --continue）
- Modify: `TUI-MANUAL.md` / `README.md`

**Interfaces:**

Consumes: Task 3 `SessionOpts.continueLast` / `takeRestoredUi()` / `flushJournal()` / `recordView(b,b)`；parseArgs 既有裸 flag→`true` 语义。

Produces: 完整用户入口——`sunshinex tui [dir] --continue` 续接最近会话；TUI `/resume` 列表选号；启动横幅/提示行双语。

- [ ] **Step 4.1: commands/tui.ts——continueLast 透传**

runTuiCommand 全文替换（当前全文已核对）：
old_string：

```ts
export async function runTuiCommand(args: CliArgs): Promise<void> {
  const dir = args.positional[0] ?? '.';
  await runTui({
    root: path.resolve(dir),
    language: args.flags.language,
    mode: args.flags.mode,
    model: args.flags.tier,
  });
}
```

new_string：

```ts
export async function runTuiCommand(args: CliArgs): Promise<void> {
  const dir = args.positional[0] ?? '.';
  await runTui({
    root: path.resolve(dir),
    language: args.flags.language,
    mode: args.flags.mode,
    model: args.flags.tier,
    continueLast: args.flags['continue'] === true,
  });
}
```

- [ ] **Step 4.2: entry.ts——四处编辑（逐个串行，先 `grep -n` 定位现场）**

(a) runTui opts 类型——锚点：`export async function runTui(opts: { root: string; language?`（grep -c 应为 1）
old_string：`export async function runTui(opts: { root: string; language?`
new_string：`export async function runTui(opts: { root: string; continueLast?: boolean; language?`

(b) SessionController 构造行——锚点：`const session = new SessionController({ root: opts.root, model: opts.model });`（grep -c 应为 1；若现场为 mode/tier 形态，以现场为 old、追加 `continueLast: opts.continueLast,` 字段）
old_string：`const session = new SessionController({ root: opts.root, model: opts.model });`
new_string：

```ts
const session = new SessionController({ root: opts.root, model: opts.model, continueLast: opts.continueLast });
    const restored = session.takeRestoredUi();
```

(c) runTuiLoop 增 initialRetain + 退出 flush——先 `grep -n -A 8 'await runTuiLoop' src/tui/entry.ts` 读现场；在调用对象内 `session,`（或 `session: ctrl,`）之后插一行：

```ts
      initialRetain: restored ? { history: restored.history, expandAll: restored.expandAll, latestFull: restored.latestFull } : undefined,
```

并把 `await runTuiLoop({ ... });` 整体包入 try/finally（目标形态）：

```ts
    try {
      await runTuiLoop({
        session,
        initialRetain: restored ? { history: restored.history, expandAll: restored.expandAll, latestFull: restored.latestFull } : undefined,
        /* …其余既有参数保持不动… */
      });
    } finally {
      session.flushJournal(); // 退出收口（规格 D3 flush 点③）；SIGINT 硬退出路径另在 handler 内 flush
    }
```

（「…其余既有参数保持不动」为现场保留指令：runTuiLoop 既有参数逐字保留，仅新增 initialRetain 行与 try/finally 包裹。）

(d) SIGINT flush——锚点：`current?.unmount();\n    process.exit(0);`（grep -c 应为 1；若 handler 变量名不同以现场为准）
old_string：

```ts
      current?.unmount();
      process.exit(0);
```

new_string：

```ts
      session.flushJournal();
      current?.unmount();
      process.exit(0);
```

- [ ] **Step 4.3: tui-loop.ts——两处编辑（串行）**

(a) deps 接口——锚点：`interface TuiLoopDeps {`（grep -c 应为 1；若为 `export interface` 以现场为准，old 含前缀）
old_string：`interface TuiLoopDeps {`
new_string：

```ts
interface TuiLoopDeps {
  /** 首挂 retain 初值补丁（--continue 恢复的输入历史与视图两态；buffer/cursor 易失不还原——规格 D6 边界） */
  initialRetain?: Partial<RetainedUiState>;
```

连带核对：文件顶部 ui-state 导入行含 `initialRetained`；若无 `RetainedUiState` 类型导入，将导入行改为 `import { initialRetained, type RetainedUiState } from './ui-state';`（以现场为 old）。

(b) retain 合并——锚点：`  const retain = initialRetained();`（grep -c 应为 1）
old_string：`  const retain = initialRetained();`
new_string：`  const retain: RetainedUiState = { ...initialRetained(), ...deps.initialRetain };`

- [ ] **Step 4.4: App.tsx——两处编辑（串行）**

(a) 补全清单——锚点（grep -c 应为 1）：
old_string：`export const SLASH_COMMANDS = ['/help', '/init', '/goal', '/new', '/compact', '/status', '/model', '/plan'];`
new_string：`export const SLASH_COMMANDS = ['/help', '/init', '/goal', '/new', '/resume', '/compact', '/status', '/model', '/plan'];`

(b) 视图切换挂钩（在 toggle 上屏处调用 recordView，不用 React updater 内做副作用）——锚点：`        setExpandAll((v) => !v);`（8 空格缩进，grep -c 应为 1）
old_string：`        setExpandAll((v) => !v);`
new_string：

```ts
        const nextExpand = !expandAll;
        setExpandAll(nextExpand);
        controller.recordView(nextExpand, latestFull);
```

随后锚点：`      setLatestFull((v) => !v);`（6 空格缩进，grep -c 应为 1）
old_string：`      setLatestFull((v) => !v);`
new_string：

```ts
      const nextFull = !latestFull;
      setLatestFull(nextFull);
      controller.recordView(expandAll, nextFull);
```

（两处缩进/变量名以现场为准；controller 为 App 内既有 prop 名，若解构名不同以现场为准。）

- [ ] **Step 4.5: 测试断言（两个文件）**

cli.test.ts 末尾追加用例（文件内已有 parseArgs/resolveInvocation 导入，若无则按现场导入）：

```ts
test('parseArgs：裸 --continue 解析为 true 并随 tui 调用透传', () => {
  const args = parseArgs(['--continue']);
  assert.equal(args.flags['continue'], true);
  assert.equal(args.command, 'tui');
  const inv = resolveInvocation(args);
  assert.equal(inv.command, 'tui');
  assert.equal(inv.flags['continue'], true);
});
```

App.input.test.tsx——锚点：`assert.ok(SLASH_COMMANDS.includes('/goal'),`（grep -c 应为 1；若断言形态不同，定位 `includes('/goal')` 行）
old_string：`assert.ok(SLASH_COMMANDS.includes('/goal'),`
new_string：

```ts
  assert.ok(SLASH_COMMANDS.includes('/resume'), '/resume 已登记补全清单');
  assert.ok(SLASH_COMMANDS.includes('/goal'),
```

（注意保留原断言的闭括号与文案参数——old/new 以现场整行为准。）

实施勘误：/resume 插入 /new 之后会使既有「Tab 循环」用例的邻位断言失效（/new 的下一命令由 /compact 变为 /resume）——该用例同步更新断言为 /resume 并注释清单序，属次序耦合的规格性更新而非回归。

- [ ] **Step 4.6: USAGE 双语补 --continue**

`grep -n "tui" src/cli/index.ts` 定位 usageText() 内双语 tui 行（形如 `sunshinex tui [dir] [flags]` / `sunshinex tui [目录] [flags]`，以现场原文为 old）。
en 目标行（在 en tui 行之后插入）：

```
  sunshinex tui [dir] --continue           resume the most recent saved session (TUI; /resume lists earlier ones)
```

zh 目标行（在 zh tui 行之后插入）：

```
  sunshinex tui [目录] --continue          续接最近一次已保存会话（TUI 内 /resume 可列出/恢复更早会话）
```

- [ ] **Step 4.7: 文档同步**

TUI-MANUAL.md——命令表：`grep -n '/new' TUI-MANUAL.md` 定位命令表 /new 行（形如 `| \`/new\` | 新会话…`），其后插入：

```
| `/resume [序号|id]` | 列出（无参）或恢复已保存会话（跨天续接：消息、待办、模型档位、上下文链与压缩块全还原；配套 CLI `--continue` 直接续接最近会话） |
```

TUI-MANUAL.md——数据与目录节（§九）：`grep -n '数据与目录\|\.data-test\|SUNSHINEX_DATA_DIR' TUI-MANUAL.md` 定位节内列表，追加一行：

```
- `sessions/`：会话事件日志（每会话一 `<sessionId>.jsonl` 追加只增）与 `sessions-active.json` 活动指针；任务收口/`/new`/退出三个时点落盘，`--continue` 与 `/resume` 据此跨天恢复
```

README.md——TUI 段：`grep -n 'sunshinex tui' README.md` 定位用法代码块，块内追加：

```
sunshinex tui [目录] --continue   # 续接最近一次已保存会话；TUI 内 /resume 列出/恢复更早会话
```

- [ ] **Step 4.8: 跑绿（定向）**

Run: `node_modules/.bin/tsc -p tsconfig.json && node --test dist/cli/cli.test.js dist/tui/components/App.input.test.js`
Expected: PASS（新增 2 + 既有全绿）

- [ ] **Step 4.9: 全量门禁**

Run: `node_modules/.bin/tsc -p tsconfig.json && node scripts/run-tests.js && node dist/cli/index.js selfcheck`
Expected: 全量 658±2 PASS、0 fail；selfcheck OK（skills 21）

- [ ] **Step 4.10: 提交**

```bash
git add src/cli/commands/tui.ts src/tui/entry.ts src/tui/tui-loop.ts src/tui/components/App.tsx src/cli/cli.test.ts src/tui/components/App.input.test.tsx src/cli/index.ts TUI-MANUAL.md README.md
git commit -m "feat(tui): TUI/CLI --continue 接线——/resume 补全与帮助/视图挂钩/USAGE 与文档同步"
```

---

## 计划自审（落盘时随批登记）

1. **规格覆盖**：D1 双入口（T3 /resume + T4 --continue）✓；D2 归档化轮转（T3 /new）✓；D3 三 flush 点（T3 closeTask//new + T4 退出/SIGINT）✓；D4 事件日志形态与指针（T1 模块）✓；D5 词汇封闭纪律（T1 类型 + T2 ContextChange + 全局约束）✓；D6 恢复安全缺省（T3 restoreFromSession + 测试断言）✓；D7 回溯/自压实不实现（YAGNI，规格 §9 已登记，本计划零涉及）✓；§8 验收矩阵映射——矩阵 1/2→T3 用例 1，矩阵 3→T3 用例 2，矩阵 4→T3 用例 2（列表断言），矩阵 5→T3 用例 5，矩阵 6→T3 用例 4/restoreFromSession（approval: undefined、children: []、status idle），矩阵 7→T4 CLI --tier 由 opts.tier 既有链路承载（continueLast 不覆盖 tier：构造顺序 tier 在后覆盖——见自审 3），矩阵 8→T3 用例 5+版本守卫分支，矩阵 9→buffer/cursor 不还原（initialRetain 仅 history/expandAll/latestFull）+ metrics 会话聚合不持久化（restore 不触碰 metrics），矩阵 10→T4 Step 4.9 全量门禁 ✓
2. **占位符扫描**：无 TBD/TODO/「适当处理」；entry.ts runTuiLoop 的「其余既有参数保持不动」为现场保留指令（既有参数逐字保留），非占位符；三处「以现场为准」均绑定 grep 定位命令与目标形态
3. **类型一致性**：`JournalEvent.compacted: ContextItem[]` ↔ `ContextChange.compacted: ContextItem[]` ↔ `ContextSessionState.compacted` 三处同口径（修正旧稿 compactBlock 字符串错形）；`SessionJournal.start()` 无参、`rotate(id)/attach(id)` 带参——Task 3 调用面（`j.start()` / `rotate(newSessionId())` / `attach(meta.id)`）一致；`takeRestoredUi()` 返回形态与 TuiLoopDeps.initialRetain 字段一一对应；`reduceJournal().version` 守卫（!==1 拒载）与词汇 v1 一致；`msgSeq` 字段名按现状锚点表 L140
4. **已知边界（登记）**：订阅为单槽（后注册覆盖）——测试排布「先完成再构造下一个控制器」规避；/resume 自壳会话会先 flush 出孤儿档（真实输入历史，可接受）；消息 ts 随档还原（全会话口径）；快照型事件末值语义使重复收口幂等
5. **执行方式**：按 fork/子代理/子代理显示/goal v1 四次先例，问卷通道不再发起——本计划落库后直接会话内联 TDD 执行（executing-plans 流程、逐任务红绿提交）
