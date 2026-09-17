# 会话持久化 + /resume + --continue 实施计划

> 规格：`docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md`（66bd70a）。
> 用户裁决：方案 B（JSONL 事件日志，理由=重放与回溯）；双入口（/resume + --continue）；归档化（/new 留存可找回）；收口落盘（仅 flush 点持久化）。
> 目标：TUI 会话可持久化、可列表、可恢复、可续接；空会话零文件；SessionStore 接缝先例保留不动（零消费）。

## 全局约束

- 测试框架：`node:test` + `node:assert/strict`；门禁 = `pnpm test`（tsc + scripts/run-tests.js）与 `pnpm selfcheck`。
- TDD：每任务先写失败测试（红）→ 最小实现（绿）→ 提交。
- 事件词汇封闭 schema v1：`user | msg | chain | compact | todos | model | view`（header 由 flush 自动生成）；新增状态 = 新事件类型随版本同步发布。
- 每次编辑前锚点唯一性：`grep -c` 计数必须为 1，不为 1 时扩大上下文锚。
- 禁改：`src/tui/session-store.ts`（既有接缝零消费不动）；`src/tui/ui-state.ts`（单例直读写即可）。

## 现状锚点（已精读核对）

| 锚点 | 位置 | 现状 |
|---|---|---|
| `ChatItem` | session.ts L17-25 | `{role, text, ts, seq, kind?, ok?, detail?}` |
| `TodoItem` | session.ts L27-30 | `{content, status}` |
| `private seq = 0` | session.ts L130 | 消息序号，恢复需续排 |
| 构造函数 | session.ts L149-153 | `opts/root/runtime/security/ledger.load()` 五行 |
| `submit` 头 | session.ts L228-231 | `pushMsg('user', text)` → slash 分流 |
| `closeTask` | session.ts L345-349 | idle 化 + `ledger.save()`（收口点 ①） |
| `/new` 分支 | session.ts L516-531 | idle guard → 清场 → `resetSession()`（收口点 ②；/resume 插在其后、`/compact` 前） |
| `pushMsg` | session.ts L687-695 | push + `return item`（消息流唯一入口） |
| `SLASH_HELP` | session.ts | 双语命令清单，`/new` 与 `/compact` 段之间插 `/resume` |
| `ContextManager` | harness/context/index.ts | 私有 `entries/chainFrom/chainSeq/compactBlock`；`chainView()=slice(chainFrom)`；`appendChain`(push+chainSeq+=)；`trimChainFront(n)`(chainFrom+=n)；`applyCompaction(opts {keep?, summaryModel?})` 异步 `{ok, reason?}`，尾行 `this.compactBlock = summary;`；`resetSession()` 清四字段；构造 `constructor(store, summarizer?)` |
| `HistoryStep` | types.ts L275-279 | `{step:number, action?:string, observation:string}` |
| `ModelTier` | types.ts L147 | `'small'|'medium'|'large'` |
| `RetainedUiState` | tui/ui-state.ts | 模块单例 `{buffer,cursor,expandAll,latestFull,history,histIdx}` |
| `SLASH_COMMANDS` | components/App.tsx L25 | `['/help','/init','/goal','/new','/compact','/status','/model','/plan']` |
| `runTuiCommand` | cli/commands/tui.ts（全文已读） | positional[0]→root，flags.language/mode/tier 透传 |
| `runTui` | tui/entry.ts | `new SessionController({root, model})` 后 `runTuiLoop` |
| `parseArgs` | cli/resolve-invocation.ts | 裸 `--continue` → `flags['continue']='true'` ✓ |
| 测试构造先例 | session.plan.test.ts / graph 测试 | `new SessionController({root: tmp, model: new ScriptedAdapter([...])})`；`new ContextManager(tmp, new FileStore(tmp))` |
| 手册 | `./TUI-MANUAL.md`（仓库根） | 命令表 `/goal` 行后插 `/resume` 行 |

## 重放状态机（三处共用）

```
msg     → state.messages.push(item)，maxSeq=max(maxSeq,item.seq)
user    → RetainedUiState.history.push(text)
chain   → steps 累积
compact → chainFrom/compactBlock 覆盖写（applyCompaction 后水位单调，覆盖语义正确）
todos/model/view → 覆盖写
末尾 → context.restoreSession({entries:steps, chainFrom, chainSeq:chainFrom+steps.length, compactBlock})
     → RetainedUiState.histIdx = history.length-1；this.seq = maxSeq
```
恢复注入一律直写 state，**不走 pushMsg**（不重复入志、seq 不回绕）；订阅回调不因 restore 触发。

---

## Task 1：session-journal 模块（纯新增）

**文件**：`src/tui/session-journal.ts`（新）、`src/tui/session-journal.test.ts`（新）。

### 步骤 1.1 失败测试 `session-journal.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionJournal, newSessionId, sessionsDir, JournalEvent } from './session-journal';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-jr-'));

test('newSessionId：UTC 时间戳 + 4 位后缀，文件名安全', () => {
  assert.match(newSessionId(), /^\d{8}T\d{6}Z-[0-9a-z]{4}$/);
});

test('buffer/flush：空 flush 不落盘；首 flush 补 header；二次 flush 不重复 header', () => {
  const dir = tmp();
  try {
    const j = new SessionJournal(dir, 'X');
    assert.equal(j.flush(), false, '空缓冲不写盘');
    assert.equal(fs.existsSync(j.filePath), false, '空会话零文件');
    j.buffer({ t: 'user', text: 'hi' });
    assert.equal(j.pending, 1);
    assert.equal(j.flush(), true);
    assert.equal(j.pending, 0);
    j.buffer({ t: 'user', text: 'yo' });
    j.flush();
    const lines = fs.readFileSync(j.filePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].t, 'header');
    assert.equal(lines[0].v, 1);
    assert.equal(lines.filter((o) => o.t === 'header').length, 1);
    assert.deepEqual(lines.slice(1), [{ t: 'user', text: 'hi' }, { t: 'user', text: 'yo' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replay：事件往返逐条相等', () => {
  const dir = tmp();
  try {
    const j = new SessionJournal(dir, 'A');
    const events: JournalEvent[] = [
      { t: 'user', text: 'q' },
      { t: 'msg', item: { role: 'user', text: 'q', ts: 1, seq: 1 } },
      { t: 'chain', steps: [{ step: 1, observation: 'o' }] },
      { t: 'compact', chainFrom: 3, compactBlock: 'S' },
      { t: 'todos', items: [{ content: 'x', status: 'pending' }] },
      { t: 'model', tier: 'large' },
      { t: 'view', expandAll: true, latestFull: false },
    ];
    for (const e of events) j.buffer(e);
    j.flush();
    const r = SessionJournal.replay(dir, 'A');
    assert.equal(r.truncated, false);
    assert.equal(r.unknownVersion, false);
    assert.deepEqual(r.events, events);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replay：尾行撕裂丢弃并标记 truncated；中段坏行停在上条完整事件', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'B.jsonl'), [
      JSON.stringify({ t: 'header', v: 1, id: 'B', createdAt: 'x' }),
      JSON.stringify({ t: 'user', text: 'ok1' }),
      '{"t":"user","tex',
    ].join('\n') + '\n', 'utf8');
    const r = SessionJournal.replay(dir, 'B');
    assert.equal(r.truncated, true);
    assert.equal(r.events.length, 1);
    // 中段坏行
    fs.writeFileSync(path.join(dir, 'C.jsonl'), [
      JSON.stringify({ t: 'header', v: 1, id: 'C', createdAt: 'x' }),
      '{"broken',
      JSON.stringify({ t: 'user', text: 'after' }),
    ].join('\n') + '\n', 'utf8');
    const r2 = SessionJournal.replay(dir, 'C');
    assert.equal(r2.truncated, true);
    assert.equal(r2.events.length, 0, '停在坏行前');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replay：未知版本拒载（unknownVersion=true，events 空）', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'D.jsonl'), JSON.stringify({ t: 'header', v: 2, id: 'D', createdAt: 'x' }) + '\n', 'utf8');
    const r = SessionJournal.replay(dir, 'D');
    assert.equal(r.unknownVersion, true);
    assert.deepEqual(r.events, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('listSessions：mtime 降序 + 首条用户输入截 60；activeId/setActive 往返；未设为 null', () => {
  const dir = tmp();
  try {
    assert.deepEqual(SessionJournal.listSessions(dir), []);
    assert.equal(SessionJournal.activeId(dir), null);
    const j1 = new SessionJournal(dir, 'S1');
    j1.buffer({ t: 'user', text: '第一个会话的输入'.repeat(10) });
    j1.flush();
    const j2 = new SessionJournal(dir, 'S2');
    j2.buffer({ t: 'user', text: '第二个' });
    j2.flush();
    fs.utimesSync(path.join(dir, 'S1.jsonl'), new Date(), new Date(2_000_000_000_000)); // S1 更新
    const metas = SessionJournal.listSessions(dir);
    assert.deepEqual(metas.map((m) => m.id), ['S1', 'S2']);
    assert.equal(metas[0].firstUserText.length, 60, '截断到 60');
    SessionJournal.setActive(dir, 'S1');
    assert.equal(SessionJournal.activeId(dir), 'S1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sessionsDir：位于数据目录的 sessions 子目录', () => {
  assert.ok(sessionsDir('/tmp/whatever').endsWith(path.join('sessions')));
});
```

### 步骤 1.2 实现 `session-journal.ts`

```ts
import * as fs from 'fs';
import * as path from 'path';
import type { ChatItem, TodoItem } from './session';
import type { HistoryStep } from '../types';
import { resolveDataDir } from '../config/data-dir';

/** 会话日志目录：<数据目录>/sessions */
export function sessionsDir(root: string): string {
  return path.join(resolveDataDir(root), 'sessions');
}

/** 会话 id：UTC 时间戳 + 4 位随机后缀（文件名安全） */
export function newSessionId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 封闭事件词汇 schema v1（新增状态 = 新事件类型，随版本同步发布） */
export type JournalEvent =
  | { t: 'user'; text: string }
  | { t: 'msg'; item: ChatItem }
  | { t: 'chain'; steps: HistoryStep[] }
  | { t: 'compact'; chainFrom: number; compactBlock: string | null }
  | { t: 'todos'; items: TodoItem[] }
  | { t: 'model'; tier: string }
  | { t: 'view'; expandAll: boolean; latestFull: boolean };

export interface SessionMeta { id: string; updatedAt: number; firstUserText: string }

const ACTIVE_FILE = 'active.json';

/** JSONL 事件日志：缓冲 → 收口批量追加；首个 flush 自动补 header（幂等：文件已存在不重复写） */
export class SessionJournal {
  private buf: JournalEvent[] = [];
  private created = false;

  constructor(
    readonly dir: string,
    readonly id: string,
  ) {}

  get filePath(): string { return path.join(this.dir, `${this.id}.jsonl`); }
  get pending(): number { return this.buf.length; }

  buffer(e: JournalEvent): void { this.buf.push(e); }

  /** 批量落盘；空缓冲返回 false（不落盘、不维护指针）。返回是否实际写盘 */
  flush(): boolean {
    if (!this.buf.length) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    const lines: string[] = [];
    if (!this.created && !fs.existsSync(this.filePath)) {
      lines.push(JSON.stringify({ t: 'header', v: 1, id: this.id, createdAt: new Date().toISOString() }));
    }
    this.created = true;
    for (const e of this.buf) lines.push(JSON.stringify(e));
    this.buf = [];
    fs.appendFileSync(this.filePath, lines.join('\n') + '\n', 'utf8');
    return true;
  }

  /** 重放：首行须 header(v=1) 否则拒载；坏行停在上一条完整事件并标 truncated；未知事件类型前向兼容跳过 */
  static replay(dir: string, id: string): { events: JournalEvent[]; truncated: boolean; unknownVersion: boolean } {
    const file = path.join(dir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return { events: [], truncated: false, unknownVersion: false };
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const events: JournalEvent[] = [];
    let truncated = false;
    let sawHeader = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line) as Record<string, unknown>; } catch { truncated = true; break; }
      if (!sawHeader) {
        if (obj?.t !== 'header' || obj.v !== 1) return { events: [], truncated, unknownVersion: true };
        sawHeader = true;
        continue;
      }
      switch (obj.t) {
        case 'user': events.push({ t: 'user', text: String(obj.text ?? '') }); break;
        case 'msg': events.push({ t: 'msg', item: obj.item as ChatItem }); break;
        case 'chain': events.push({ t: 'chain', steps: Array.isArray(obj.steps) ? (obj.steps as HistoryStep[]) : [] }); break;
        case 'compact': events.push({ t: 'compact', chainFrom: Number(obj.chainFrom ?? 0), compactBlock: (obj.compactBlock as string | null) ?? null }); break;
        case 'todos': events.push({ t: 'todos', items: Array.isArray(obj.items) ? (obj.items as TodoItem[]) : [] }); break;
        case 'model': events.push({ t: 'model', tier: String(obj.tier ?? '') }); break;
        case 'view': events.push({ t: 'view', expandAll: Boolean(obj.expandAll), latestFull: Boolean(obj.latestFull) }); break;
        default: break;
      }
    }
    return { events, truncated, unknownVersion: false };
  }

  static listSessions(dir: string): SessionMeta[] {
    if (!fs.existsSync(dir)) return [];
    const metas: SessionMeta[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      let firstUserText = '';
      try {
        for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
          const s = raw.trim();
          if (!s) continue;
          try {
            const obj = JSON.parse(s) as { t?: string; text?: unknown };
            if (obj.t === 'user') { firstUserText = String(obj.text ?? '').slice(0, 60); break; }
          } catch { /* 列表扫描容忍坏行 */ }
        }
      } catch { continue; }
      metas.push({ id: name.slice(0, -'.jsonl'.length), updatedAt: mtimeMs, firstUserText });
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static activeId(dir: string): string | null {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, ACTIVE_FILE), 'utf8')) as { id?: unknown };
      return typeof obj?.id === 'string' && obj.id ? obj.id : null;
    } catch { return null; }
  }

  static setActive(dir: string, id: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ACTIVE_FILE), JSON.stringify({ id }), 'utf8');
  }
}
```


### 步骤 1.3 门禁 + 提交
`pnpm test`；`git add src/tui/session-journal*.ts && git commit -m "feat(tui): 会话日志模块——封闭事件词汇 v1/缓冲收口/重放容错/列表与活动指针"`。

---

## Task 2：ContextManager 变更订阅 + restoreSession

**文件**：`src/harness/context/index.ts`（编辑）、`src/harness/context/session-restore.test.ts`（新）。

### 步骤 2.1 失败测试 `session-restore.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, SessionChange } from './index';
import { FileStore } from '../storage/file-store';
import { HistoryStep } from '../../types';

const step = (n: number): HistoryStep => ({ step: n, observation: `obs-${n}` });
const mkCtx = (): ContextManager => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ctxjr-'));
  return new ContextManager(dir, new FileStore(dir));
};

test('订阅：appendChain/trimChainFront 触发对应变更事件', () => {
  const ctx = mkCtx();
  const seen: SessionChange[] = [];
  ctx.setSessionListener((e) => seen.push(e));
  ctx.appendChain([step(1), step(2)]);
  ctx.trimChainFront(1);
  assert.deepEqual(seen, [{ kind: 'append', steps: [step(1), step(2)] }, { kind: 'trim', count: 1 }]);
});

test('restoreSession：直注入四元组，订阅零触发，chainView 反映恢复态', () => {
  const ctx = mkCtx();
  let fired = 0;
  ctx.setSessionListener(() => fired++);
  ctx.restoreSession({ entries: [step(1), step(2), step(3)], chainFrom: 1, chainSeq: 3, compactBlock: 'S' });
  assert.equal(fired, 0, '恢复注入不触发订阅');
  assert.deepEqual(ctx.chainView(), [step(2), step(3)]);
});

test('applyCompaction：触发 compact 事件（水位前移 + 确定性摘要块）', async () => {
  const ctx = mkCtx();
  const seen: SessionChange[] = [];
  ctx.setSessionListener((e) => seen.push(e));
  ctx.appendChain([step(1), step(2), step(3), step(4)]);
  const r = await ctx.applyCompaction({ keep: 1 });
  assert.equal(r.ok, true);
  const comp = seen.find((e) => e.kind === 'compact');
  assert.ok(comp && comp.kind === 'compact', '应有 compact 事件');
  assert.ok(comp.chainFrom >= 1, '水位前移');
  assert.ok(typeof comp.compactBlock === 'string' && comp.compactBlock.length > 0, '确定性摘要块');
});

test('闭环：append/compact 事件重放到新实例，chainView 与原实例一致', async () => {
  const ctx = mkCtx();
  const changes: SessionChange[] = [];
  ctx.setSessionListener((e) => changes.push(e));
  ctx.appendChain([step(1), step(2), step(3), step(4)]);
  await ctx.applyCompaction({ keep: 1 });
  const entries: HistoryStep[] = [];
  let chainFrom = 0;
  let compactBlock: string | null = null;
  for (const e of changes) {
    if (e.kind === 'append') entries.push(...e.steps);
    else if (e.kind === 'compact') { chainFrom = e.chainFrom; compactBlock = e.compactBlock; }
  }
  const ctx2 = mkCtx();
  ctx2.restoreSession({ entries, chainFrom, chainSeq: chainFrom + entries.length, compactBlock });
  assert.deepEqual(ctx2.chainView(), ctx.chainView());
});
```

> 执行注记：`applyCompaction({keep:1})` 若因选块语义返回 `{ok:false}`，改为 6 步 + `keep:2` 重试一次再断言（以返回值自适应，不猜内部选块数）。`FileStore` 构造对齐 graph 测试两种先例之一（`new FileStore(tmp)`）。

### 步骤 2.2 实现（context/index.ts 编辑）

1. 类型（放 `ContextManager` 类声明前）：
```ts
/** 会话变更事件：供会话日志订阅（append=链尾追加，trim=水位推进，compact=压实落块） */
export type SessionChange =
  | { kind: 'append'; steps: HistoryStep[] }
  | { kind: 'trim'; count: number }
  | { kind: 'compact'; chainFrom: number; compactBlock: string | null };
```
2. 字段 + 注册（类体内，`private entries` 声明区附近）：
```ts
  private sessionListener?: (e: SessionChange) => void;
```
方法（放 `chainView()` 前后皆可）：
```ts
  /** 注册会话变更订阅（传 undefined 取消）；供会话日志以事件溯源方式记录链变更 */
  setSessionListener(cb?: (e: SessionChange) => void): void { this.sessionListener = cb; }
```
3. 三个触发点：
- `appendChain` 体内 `this.chainSeq += steps.length;` 之后追加：`this.sessionListener?.({ kind: 'append', steps });`
- `trimChainFront` 体内 `this.chainFrom += n;` 之后追加：`this.sessionListener?.({ kind: 'trim', count: n });`
- `applyCompaction` 体内锚 `this.compactBlock = summary;`（grep -c 应为 1；不唯一则含前一行扩大锚）之后追加：`this.sessionListener?.({ kind: 'compact', chainFrom: this.chainFrom, compactBlock: this.compactBlock });`
4. 恢复注入（放 `resetSession()` 相邻处）：
```ts
  /** 会话恢复：直接注入链状态（不触发订阅——重放期间日志是读方）；与 resetSession 对偶 */
  restoreSession(s: { entries: HistoryStep[]; chainFrom: number; chainSeq: number; compactBlock: string | null }): void {
    this.entries = s.entries;
    this.chainFrom = s.chainFrom;
    this.chainSeq = s.chainSeq;
    this.compactBlock = s.compactBlock;
  }
```

### 步骤 2.3 门禁 + 提交
`pnpm test`；提交 `feat(harness): ContextManager 会话变更订阅 + restoreSession 直注入`。

---

## Task 3：SessionController 挂钩 + /resume + /new 轮转 + 恢复

**文件**：`src/tui/session.ts`（编辑）、`src/tui/session.persist.test.ts`（新）。

### 步骤 3.1 失败测试 `session.persist.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { SessionJournal, sessionsDir, JournalEvent } from './session-journal';
import { ScriptedAdapter } from '../model/adapter';
import { RetainedUiState } from './ui-state';
import { setLanguage } from '../i18n';
import { HistoryStep } from '../types';

const ok = (reply: string) => new ScriptedAdapter([`{"done":true,"reply":"${reply}"}`]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-persist-'));

test('任务收口落盘：user/msg/chain 事件 + 活动指针', async () => {
  setLanguage('zh');
  const root = tmp();
  try {
    const ctrl = new SessionController({ root, model: ok('done-ok') });
    await ctrl.submit('跑个任务');
    const dir = sessionsDir(root);
    const metas = SessionJournal.listSessions(dir);
    assert.equal(metas.length, 1);
    const { events } = SessionJournal.replay(dir, metas[0].id);
    assert.ok(events.some((e) => e.t === 'user' && e.text === '跑个任务'));
    assert.ok(events.some((e) => e.t === 'msg' && e.item.role === 'assistant' && e.item.text.includes('done-ok')));
    assert.ok(events.some((e) => e.t === 'chain'), '链变更已入志');
    assert.equal(SessionJournal.activeId(dir), metas[0].id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('/new 轮转：旧档留存、指针指向新会话、列表新在前', async () => {
  setLanguage('zh');
  const root = tmp();
  try {
    const ctrl = new SessionController({ root, model: ok('r1') });
    await ctrl.submit('任务一');
    await ctrl.submit('/new');
    await ctrl.submit('任务二');
    const dir = sessionsDir(root);
    const metas = SessionJournal.listSessions(dir);
    assert.equal(metas.length, 2);
    assert.equal(SessionJournal.activeId(dir), metas[0].id, '指针=最近有内容会话');
    const old = SessionJournal.replay(dir, metas[1].id);
    assert.ok(old.events.some((e) => e.t === 'user' && e.text === '任务一'), '旧档保留可找回');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('/resume：恢复后消息流一致、seq 续排、继续入志到同一档', async () => {
  setLanguage('zh');
  const root = tmp();
  try {
    const ctrl = new SessionController({ root, model: ok('r1') });
    await ctrl.submit('第一轮输入');
    const before = JSON.parse(JSON.stringify(ctrl.getState().messages));
    await ctrl.submit('/new');
    await ctrl.submit('/resume 1');
    const after = ctrl.getState().messages;
    assert.equal(after.length, before.length + 1, '恢复消息 + 系统提示');
    assert.deepEqual(after.slice(0, before.length), before);
    assert.match(after[after.length - 1].text, /已恢复会话/);
    const dir = sessionsDir(root);
    const id = SessionJournal.activeId(dir);
    assert.equal(id, SessionJournal.listSessions(dir)[0].id, '指针指向被恢复会话');
    await ctrl.submit('恢复后新输入');
    const maxSeq = Math.max(...before.map((m) => m.seq));
    const msgs = ctrl.getState().messages;
    const echo = msgs.filter((m) => m.role === 'user' && m.text === '恢复后新输入')[0];
    assert.ok(echo && echo.seq > maxSeq, 'seq 续排不回绕');
    const { events } = SessionJournal.replay(dir, id!);
    assert.ok(events.some((e) => e.t === 'user' && e.text === '恢复后新输入'), '续写进被恢复档');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('/resume 无参列出会话；空会话零文件', async () => {
  setLanguage('zh');
  const root = tmp();
  try {
    const ctrl = new SessionController({ root, model: ok('x') });
    await ctrl.submit('有内容');
    await ctrl.submit('/new');
    await ctrl.submit('/resume');
    assert.match(ctrl.getState().messages.at(-1)?.text ?? '', /已保存会话/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const root2 = tmp();
  try {
    void new SessionController({ root: root2, model: ok('y') });
    assert.equal(SessionJournal.listSessions(sessionsDir(root2)).length, 0, '未产生持久化事件不落盘');
  } finally { fs.rmSync(root2, { recursive: true, force: true }); }
});

test('restoreFromJournal：七类事件直注入（msg/user/chain/compact/todos/model/view）', () => {
  setLanguage('zh');
  const root = tmp();
  try {
    const ctrl = new SessionController({ root });
    const steps: HistoryStep[] = [{ step: 1, observation: 'o1' }];
    const events: JournalEvent[] = [
      { t: 'user', text: '历史输入' },
      { t: 'msg', item: { role: 'user', text: '历史输入', ts: 1, seq: 3 } },
      { t: 'chain', steps },
      { t: 'compact', chainFrom: 5, compactBlock: '摘要' },
      { t: 'todos', items: [{ content: '待办', status: 'pending' }] },
      { t: 'model', tier: 'large' },
      { t: 'view', expandAll: true, latestFull: true },
    ];
    ctrl.restoreFromJournal(events);
    const st = ctrl.getState();
    assert.equal(st.messages.length, 1);
    assert.deepEqual(st.todos, [{ content: '待办', status: 'pending' }]);
    assert.equal(st.model, 'large');
    assert.equal(RetainedUiState.history[RetainedUiState.history.length - 1], '历史输入');
    assert.equal(RetainedUiState.histIdx, RetainedUiState.history.length - 1);
    assert.equal(RetainedUiState.expandAll, true);
    assert.equal(RetainedUiState.latestFull, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--continue（continueLast）：构造期续接最近档；无档提示并开新会', async () => {
  setLanguage('zh');
  const root = tmp();
  try {
    const first = new SessionController({ root, model: ok('r1') });
    await first.submit('首会话输入');
    const dir = sessionsDir(root);
    const savedId = SessionJournal.activeId(dir)!;
    const second = new SessionController({ root, model: ok('r2'), continueLast: true });
    const msgs = second.getState().messages;
    assert.ok(msgs.some((m) => m.text === '首会话输入'));
    assert.match(msgs[msgs.length - 1].text, /已续接会话/);
    assert.equal(SessionJournal.activeId(dir), savedId);
    await second.submit('续接后输入');
    const { events } = SessionJournal.replay(dir, savedId);
    assert.ok(events.some((e) => e.t === 'user' && e.text === '续接后输入'), '续写同一档');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const root2 = tmp();
  try {
    const fresh = new SessionController({ root: root2, model: ok('z'), continueLast: true });
    assert.match(fresh.getState().messages.at(-1)?.text ?? '', /没有可续接/);
  } finally { fs.rmSync(root2, { recursive: true, force: true }); }
});
```

### 步骤 3.2 实现（session.ts 编辑，锚点均已在库核对）

1. import 追加（既有 import 区尾部，`RetainedUiState` import 之后）：
```ts
import { SessionJournal, newSessionId, sessionsDir, type JournalEvent } from './session-journal';
```
2. 字段（锚 `  private seq = 0;` 后插）：
```ts
  private journal?: SessionJournal;
```
3. 构造函数（锚为构造函数体末两行，唯一）：
old:
```ts
    this.security = this.runtime.harness.security;
    this.runtime.harness.ledger.load();
  }
```
new:
```ts
    this.security = this.runtime.harness.security;
    this.runtime.harness.ledger.load();
    if (opts.continueLast) this.restoreLastSession();
    this.runtime.harness.context.setSessionListener((e) => {
      if (e.kind === 'append') this.journal?.buffer({ t: 'chain', steps: e.steps });
      else if (e.kind === 'compact') this.journal?.buffer({ t: 'compact', chainFrom: e.chainFrom, compactBlock: e.compactBlock });
      // kind==='trim'：水位推进由紧随的 compact 事件承载，不单独记录
    });
  }
```
4. `SessionOpts` 增加 `continueLast?: boolean;`（锚 `interface SessionOpts {` 行内或其下逐字段区，含 model/language/mode 的既有形态处追加一行）。
5. submit 头（锚两行，唯一）：
old:
```ts
  async submit(text: string): Promise<void> {
    this.pushMsg('user', text);
```
new:
```ts
  async submit(text: string): Promise<void> {
    this.ensureJournal().buffer({ t: 'user', text });
    this.pushMsg('user', text);
```
（user 事件=输入历史；回显 msg 由 pushMsg 钩子统一承担，不重复记。）
6. pushMsg（锚三行，唯一）：
old:
```ts
    this.state.messages.push(item);
    return item;
  }
```
new:
```ts
    this.state.messages.push(item);
    this.journal?.buffer({ t: 'msg', item });
    return item;
  }
```
7. closeTask（锚四行，唯一）：末行 `this.runtime.harness.ledger.save();` 后追加 `    this.flushJournal();`。
8. 私有方法组（插在 `  private closeTask(): void {` 之前）：
```ts
  /** 会话日志（惰性建档：首个持久化事件入缓冲即建；首个 flush 落盘并维护活动指针——空会话零文件） */
  private ensureJournal(): SessionJournal {
    if (!this.journal) this.journal = new SessionJournal(sessionsDir(this.root), newSessionId());
    return this.journal;
  }

  /** 收口落盘：待办/档位/视图快照入缓冲 + 批量追加（有实写才更新指针——指针恒指最近有内容会话） */
  private flushJournal(): void {
    const j = this.ensureJournal();
    if (this.state.todos.length) j.buffer({ t: 'todos', items: this.state.todos });
    if (this.state.model) j.buffer({ t: 'model', tier: this.state.model });
    j.buffer({ t: 'view', expandAll: RetainedUiState.expandAll, latestFull: RetainedUiState.latestFull });
    if (j.flush()) SessionJournal.setActive(sessionsDir(this.root), j.id);
  }

  /** /new 轮转：先归档当前会话，再切新档（旧档留存，/resume 可找回；指针随后续 flush 指向新会话） */
  private rotateJournal(): void {
    this.flushJournal();
    this.journal = new SessionJournal(sessionsDir(this.root), newSessionId());
  }

  /** 绑定并重放指定会话档（清场由调用方负责） */
  private restoreSessionById(id: string): { truncated: boolean; unknownVersion: boolean } {
    const dir = sessionsDir(this.root);
    const replay = SessionJournal.replay(dir, id);
    this.journal = new SessionJournal(dir, id);
    this.runtime.harness.context.resetSession();
    this.restoreFromJournal(replay.events);
    SessionJournal.setActive(dir, id);
    return { truncated: replay.truncated, unknownVersion: replay.unknownVersion };
  }

  /** --continue：续接最近有内容会话（无档则提示并保持新会话） */
  private restoreLastSession(): void {
    const id = SessionJournal.activeId(sessionsDir(this.root));
    if (!id) {
      this.pushMsg('system', t('No saved session to continue; started a fresh one', '没有可续接的已保存会话，已开启新会话'));
      return;
    }
    const r = this.restoreSessionById(id);
    const note = r.truncated ? t(' (tail truncated, partial restore)', '（尾部截断，已恢复部分）') : '';
    this.pushMsg('system', t(`Continued session ${id}${note}`, `已续接会话 ${id}${note}`));
    if (r.unknownVersion) this.pushMsg('system', t('Journal version unsupported; started empty on this session', '日志版本不受支持；该会话以空内容恢复'));
  }

  /** 重放恢复：消息/待办/档位/视图直注入（不走 pushMsg——不重复入志）；链与压缩经 restoreSession；seq 续排不回绕 */
  restoreFromJournal(events: JournalEvent[]): void {
    const steps: HistoryStep[] = [];
    let chainFrom = 0;
    let compactBlock: string | null = null;
    let maxSeq = this.seq;
    for (const e of events) {
      if (e.t === 'msg') {
        this.state.messages.push(e.item);
        maxSeq = Math.max(maxSeq, e.item.seq);
      } else if (e.t === 'user') {
        RetainedUiState.history.push(e.text);
      } else if (e.t === 'chain') {
        steps.push(...e.steps);
      } else if (e.t === 'compact') {
        chainFrom = e.chainFrom;
        compactBlock = e.compactBlock;
      } els