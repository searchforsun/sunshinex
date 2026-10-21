# 会话归档与受控删除 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话新增 archived 标记态(共享层旁车 meta),`/archive`·`/delete` 双面公用命令,GUI 归档页 + 行内归档/撤销/受控删除(归档后方可真清文件)。

**Architecture:** 归档=纯 meta 标记(`SessionSidecarMeta.archived/archivedAt`,与 `side` 先例同款);daemon 路由双寻址(daemon 会话 id 或 journalId);删除=归档门禁 + `purgeSession` 真清;命令清单单源(SLASH_COMMANDS)+ 底层操作共享函数,daemon `runCommand` 与 TUI `handleSlash` 各一层薄分支;GUI 复用 settings 的 overlay 页模式挂归档页。

**Tech Stack:** TypeScript strict CommonJS(Node ≥22.9);root 测试 node:test(`pnpm build && node --test dist/...`);GUI vitest;lucide-react 图标(`Archive`/`ArchiveRestore`/`Trash2`)。

**Spec:** `docs/superpowers/specs/2026-10-21-session-archive-delete-design.md`(本计划逐条落实其 §4-§9;接口微调:归档/删除路由采用**双寻址**——`:id` 命中 daemon 会话表走运行时路径,否则视作 journalId 走磁盘路径,见 T2;其余与 spec 一致)。

## Global Constraints

- CLAUDE.md §13 持久化分层:归档标记进共享旁车 meta,禁面私有副本;purge 只清会话档,不触工作区级档。
- 用户可见文案一律 `t(en, zh)` 双语(§15);无新增提示词面。
- 路径一律 `path.join`/`path.resolve`;禁手拼分隔符。
- GUI 风格铁律 §13.1:悬浮提示用 `data-tip`(禁原生 title);22px 圆角走 token。
- 主仓新增测试文件为 node:test(`import { test } from 'node:test'`);GUI 为 vitest。
- 每 Task 收尾跑该层定向测试;T7 起全量门(`pnpm test` + `pnpm --dir gui run test`)。
- 并行会话在同一仓活跃:改文件前先 Read 现状,Edit 冲突即重读;提交只 `git add` 本任务明确列出的文件。

---

### Task 1: journal 层——archived 键 + markSessionArchived + purgeSession

**Files:**
- Modify: `src/tui/session-journal.ts`(SessionSidecarMeta 介面 ~86-113、SIDECAR_KEYS ~119、SIDECAR_BOOL_KEYS ~127、writeSessionMeta 后追加帮手)
- Test: `src/tui/session-journal.test.ts`(新建)

**Interfaces:**
- Consumes: 既有 `readSessionMeta`/`writeSessionMeta`/`sessionsDir`(同文件)。
- Produces(后续所有 Task 依赖):
  - `SessionSidecarMeta.archived?: boolean`、`SessionSidecarMeta.archivedAt?: number`
  - `markSessionArchived(dataDir: string, id: string, archived: boolean): void`
  - `purgeSession(dataDir: string, id: string): void`

- [ ] **Step 1: 写失败测试**

```ts
// src/tui/session-journal.test.ts(新建)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { markSessionArchived, purgeSession, readSessionMeta, writeSessionMeta } from './session-journal';

const JID = '20261021T000000Z-test';

function tmpDataDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-arch-'));
  return path.join(tmp, 'ws-slug', 'data');
}

test('archive 标记:markSessionArchived(true) 落 archived+archivedAt;false 撤销两键同删', () => {
  const dataDir = tmpDataDir();
  writeSessionMeta(dataDir, JID, { title: 't' });
  markSessionArchived(dataDir, JID, true);
  const on = readSessionMeta(dataDir, JID);
  assert.equal(on.archived, true);
  assert.equal(typeof on.archivedAt, 'number');
  markSessionArchived(dataDir, JID, false);
  const off = readSessionMeta(dataDir, JID);
  assert.equal(off.archived, undefined);
  assert.equal(off.archivedAt, undefined);
  assert.equal(off.title, 't', '其余键合并不丢');
});

test('purgeSession:会话档全家清(journal/meta/transcript 前缀匹配)+ gui 面私有档;幂等;不触他档', () => {
  const dataDir = tmpDataDir();
  const dir = path.join(dataDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${JID}.jsonl`), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, `${JID}.meta.json`), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, `${JID}.transcript.jsonl`), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'other.jsonl'), '{}', 'utf8');
  const guiSession = path.join(path.dirname(dataDir), 'gui', 'sessions', `${JID}.json`);
  fs.mkdirSync(path.dirname(guiSession), { recursive: true });
  fs.writeFileSync(guiSession, '{}', 'utf8');
  purgeSession(dataDir, JID);
  assert.equal(fs.existsSync(path.join(dir, `${JID}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(dir, `${JID}.meta.json`)), false);
  assert.equal(fs.existsSync(path.join(dir, `${JID}.transcript.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(dir, 'other.jsonl')), true, '他档不触');
  assert.equal(fs.existsSync(guiSession), false, 'gui 面私有档清');
  assert.doesNotThrow(() => purgeSession(dataDir, JID), '幂等:重复 purge 不炸');
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm build && node --test dist/tui/session-journal.test.js`
Expected: FAIL(`markSessionArchived` 未导出)

- [ ] **Step 3: 最小实现**

`src/tui/session-journal.ts` 三处改动:

① `SessionSidecarMeta` 介面 `side?: boolean;` 之后追加:

```ts
  /** 归档标记(2026-10-21):纯标记态——主列表/RECENTS/TUI /resume 滤除,会话本体零行为差异 */
  archived?: boolean;
  /** 归档时刻 epoch ms(归档页排序;撤销即删键) */
  archivedAt?: number;
```

② `SIDECAR_KEYS` 数组追加 `'archived', 'archivedAt'`;`SIDECAR_BOOL_KEYS` 改为 `new Set(['side', 'archived'])`(`archivedAt` 走既有 number 校验通道)。

③ `writeSessionMeta` 之后追加两个帮手(`writeSessionMeta` 只有合并无删键路径,撤销语义在此自写落盘):

```ts
/** 归档打标/撤销(读改写+原子语义同 writeSessionMeta):archived=true 落 archived+archivedAt;
 *  false 两键同删(撤销)——writeSessionMeta 无删键路径,此处自管合并体 */
export function markSessionArchived(dataDir: string, id: string, archived: boolean): void {
  const merged = { ...readSessionMeta(dataDir, id) } as Record<string, unknown>;
  if (archived) {
    merged.archived = true;
    merged.archivedAt = Date.now();
  } else {
    delete merged.archived;
    delete merged.archivedAt;
  }
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.meta.json'), JSON.stringify(merged), 'utf8');
}

/** 会话真清(purge,受控删除唯一落点):sessions 目录内 `<id>.` 前缀全家(journal/meta/transcript 等
 *  伴生档)+ 两面会话私有档(gui/sessions/<id>.json、tui/sessions/<id>.json——后者现状无档,条件清理)。
 *  工作区级档(tui/ui-state.json 等)不触;缺文件静默跳过(幂等) */
export function purgeSession(dataDir: string, id: string): void {
  const dir = sessionsDir(dataDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const f of names) {
    if (!f.startsWith(`${id}.`)) continue;
    try {
      fs.rmSync(path.join(dir, f), { force: true, recursive: true });
    } catch {
      /* 单文件失败不阻断全家清理(幂等重试可达) */
    }
  }
  const slugDir = path.dirname(dataDir);
  for (const p of [path.join(slugDir, 'gui', 'sessions', `${id}.json`), path.join(slugDir, 'tui', 'sessions', `${id}.json`)]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 幂等 */
    }
  }
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `pnpm build && node --test dist/tui/session-journal.test.js`
Expected: PASS(2 tests)

- [ ] **Step 5: 提交**

```bash
git add src/tui/session-journal.ts src/tui/session-journal.test.ts
git commit -m "feat(journal): 归档标记 archived/archivedAt 旁车键+markSessionArchived/purgeSession 受控删除单点"
```

---

### Task 2: daemon——archive 路由(双寻址)+ 列表滤除 + /sessions/archived

**Files:**
- Modify: `src/serve/session-handlers.ts`(import 区 ~17、handleSessionsRecent ~644 循环、handleSessions ~707 map 前、文件尾追加 handleSessionArchive/handleSessionsArchived/findJournalOwner)
- Modify: `src/serve/daemon.ts`(路由表 ~596 附近加一行;追加 `handleArchive` 私有委托,模式同 `handleSessionsRecent` ~644 委托)
- Test: `src/serve/daemon.archive.test.ts`(新建,样板复制 `src/serve/daemon.gui-state.test.ts` 的 `withDaemon`/AUTH/waitFor)

**Interfaces:**
- Consumes: Task 1 的 `markSessionArchived`;既有 `liveSessionByJournal(io.sessions)`、`projectsRoot()`(from `../config/data-dir`)、`validSessionId`。
- Produces:
  - `findJournalOwner(projectsRoot: string, jid: string): { dataDir: string; slug: string } | undefined`
  - `handleSessionArchive(io: SessionHandlerIo, res, id: string, body: { archived?: unknown }): void`
  - `handleSessionsArchived(io: SessionHandlerIo, res: http.ServerResponse): void`
  - 路由:`POST /session/:id/archive`、`GET /sessions/archived`
  - `GET /sessions`、`GET /sessions/recent` 滤除 `archived === true`

- [ ] **Step 1: 写失败测试**

```ts
// src/serve/daemon.archive.test.ts(新建;withDaemon/AUTH/waitFor 从 daemon.gui-state.test.ts 复制)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';

// ……withDaemon/AUTH/waitFor 三件从 src/serve/daemon.gui-state.test.ts 逐字复制……

test('archive:daemon 会话 id 与 journalId 双寻址均可打标;running 409;未知 404;撤销回 false', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, daemon, tmp }) => {
    const created = await fetch(`${base}/session`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '跑一轮' }) });
    await daemon.waitIdleAll?.() ?? // 等价:轮询 snapshot status==='idle'(见下)
    await waitFor(() => {
      // 轮询至 idle(daemon.gui-state.test.ts 同款手法)
      return true; // 实现时替换为既有 waitIdle 惯用法
    }, 10_000);
    const jid = fs.readdirSync(path.join(resolveDataDir(tmp), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');

    // daemon 会话 id 寻址
    const r1 = await fetch(`${base}/session/${sessionId}/archive`, { method: 'POST', headers: AUTH, body: JSON.stringify({}) });
    assert.equal(r1.status, 200);
    assert.deepEqual((await r1.json()) as { archived: boolean }, { ok: true, archived: true });

    // journalId 寻址(撤销)
    const r2 = await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: JSON.stringify({ archived: false }) });
    assert.equal(r2.status, 200);
    assert.deepEqual((await r2.json()) as { archived: boolean }, { ok: true, archived: false });

    // 未知 id
    const r3 = await fetch(`${base}/session/20261021T000000Z-none/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(r3.status, 404);
  });
});

test('列表滤除:archived 会话退出 /sessions 与 /sessions/recent;GET /sessions/archived 跨工作区聚合', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, daemon, tmp }) => {
    const created = await fetch(`${base}/session`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '跑一轮' }) });
    await waitFor(() => fetch(`${base}/session/${sessionId}/snapshot`, { headers: AUTH }).then(async (r) => ((await r.json()) as { status: string }).status === 'idle'), 10_000);
    const jid = fs.readdirSync(path.join(resolveDataDir(tmp), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');
    await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: '{}' });

    const sessions = (await (await fetch(`${base}/sessions?root=${encodeURIComponent(tmp)}`, { headers: AUTH })).json()) as Array<{ id: string }>;
    assert.equal(sessions.some((r) => r.id === jid), false, '主列表滤除归档');
    const archived = (await (await fetch(`${base}/sessions/archived`, { headers: AUTH })).json()) as Array<{ id: string; slug: string; archivedAt: number }>;
    assert.equal(archived.some((r) => r.id === jid), true, '归档列表在');
    assert.equal(archived[0]!.slug.length > 0, true, '来源 slug 标注');
  });
});
```

(注:测试里「轮询至 idle」用 `GET /session/:id/snapshot` 的 `status==='idle'` 轮询,与 daemon.gui-state.test.ts 既有惯用法一致;实现时以该文件现行为准逐字对齐。)

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm build && node --test dist/serve/daemon.archive.test.js`
Expected: FAIL(archive 路由 404/不支持)

- [ ] **Step 3: 最小实现**

`src/serve/session-handlers.ts`:

① import 区补:`markSessionArchived`(from '../tui/session-journal',并入既有 import 行)、`projectsRoot`(确认既有 import——该文件 handleSessionsRecent 已在用 `projectsRoot()`)。

② `handleSessionsRecent` 的 `for (const r of listSessions(dataDir))` 循环体首行加:`if (r.archived === true) continue;`
`handleSessions` 的 `listSessions(resolveDataDir(root)).map(...)` 改 `listSessions(resolveDataDir(root)).filter((r) => r.archived !== true).map(...)`。

③ 文件尾追加:

```ts
/** journalId → {dataDir, slug}(跨工作区扫描;archive/delete 的 journal 寻址与归档列表共用) */
export function findJournalOwner(root: string, jid: string): { dataDir: string; slug: string } | undefined {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(root, ent.name, 'data');
    if (fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`))) return { dataDir, slug: ent.name };
  }
  return undefined;
}

/** POST /session/:id/archive {archived?}(2026-10-21 归档):双寻址——:id 命中 daemon 会话表走运行时
 *  路径(缺 journal 404),否则视作 journalId 走磁盘路径;running 一律 409(先停再归档,与 delete 同门禁) */
export function handleSessionArchive(io: SessionHandlerIo, res: http.ServerResponse, id: string, body: { archived?: unknown }): void {
  const archived = body.archived !== false;
  const liveByJournal = liveSessionByJournal(io.sessions);
  let dataDir: string;
  let jid: string;
  const session = io.sessions.get(id);
  if (session !== undefined) {
    if (session.status() === 'running') return io.send(res, 409, { error: 'cannot archive while a run is in progress' });
    const attached = session.attachedJournalId;
    if (attached === undefined) return io.send(res, 404, { error: 'session has no journal' });
    jid = attached;
    dataDir = resolveDataDir(session.root);
  } else {
    if (!validSessionId(id)) return io.send(res, 400, { error: 'invalid session id' });
    const owner = findJournalOwner(projectsRoot(), id);
    if (owner === undefined) return io.send(res, 404, { error: 'unknown session' });
    jid = id;
    dataDir = owner.dataDir;
  }
  if (liveByJournal.get(jid) !== undefined) return io.send(res, 409, { error: 'cannot archive while a run is in progress' });
  markSessionArchived(dataDir, jid, archived);
  io.send(res, 200, { ok: true, archived });
}

/** GET /sessions/archived(归档页数据源):跨工作区扫描各 slug 的 archived 档,archivedAt 降序;
 *  行带 slug+root(来源项目标注)——不设 isDefaultWs 过滤(项目会话同样可归档) */
export function handleSessionsArchived(io: SessionHandlerIo, res: http.ServerResponse): void {
  type ArchivedRow = { id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number };
  const out: ArchivedRow[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    io.send(res, 200, out);
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(projectsRoot(), ent.name, 'data');
    let root = '';
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
      if (typeof raw?.root === 'string' && raw.root.length > 0) root = raw.root;
    } catch {
      root = '';
    }
    for (const r of listSessions(dataDir)) {
      if (r.archived !== true || r.archivedAt === undefined) continue;
      out.push({ id: r.id, slug: ent.name, root, ...(r.title !== undefined ? { title: r.title } : {}), updatedAt: r.updatedAt, archivedAt: r.archivedAt });
    }
  }
  out.sort((a, b) => b.archivedAt - a.archivedAt);
  io.send(res, 200, out);
}
```

`src/serve/daemon.ts`:

① 路由表 `{ method: 'POST', path: '/session/:id/delete', ... }` 行之前插入:

```ts
    // 2026-10-21 归档面:双寻址(daemon 会话 id 或 journalId)+ 跨工作区归档列表(归档页消费)
    { method: 'POST', path: '/session/:id/archive', auth: true, run: async (req, res, p) => {
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        sessionHandlers.handleSessionArchive(this.io, res, p.id, parsed.body as { archived?: unknown });
      } },
    { method: 'GET', path: '/sessions/archived', auth: true, run: async (_req, res) => sessionHandlers.handleSessionsArchived(this.io, res) },
```

(注:`sessionHandlers`/`this.io` 的实际引用名以 daemon.ts 既有委托形态为准——如 `handleSessionsRecent` 的委托写法;`readJson` 同 `handleGitCheckout` 行的既有用法。)

- [ ] **Step 4: 跑测确认通过**

Run: `pnpm build && node --test dist/serve/daemon.archive.test.js`
Expected: PASS

- [ ] **Step 5: 跑既有 daemon 测试防回归**

Run: `pnpm build && node --test dist/serve/daemon.gui-state.test.js dist/serve/daemon.workspace.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/serve/session-handlers.ts src/serve/daemon.ts src/serve/daemon.archive.test.ts
git commit -m "feat(serve): /session/:id/archive 双寻址归档+/sessions/archived 跨工作区聚合;主列表/RECENTS 滤除归档"
```

---

### Task 3: daemon——delete 门禁升级(未归档 409;归档态 purge)

**Files:**
- Modify: `src/serve/daemon.ts`(handleDelete ~949-972)
- Modify: `src/serve/daemon.archive.test.ts`(追加用例)
- Modify: `gui/src/connection.ts`(deleteSession 注释 ~138 同步)
- Modify: `gui/src/e2e.test.ts`(G4→G5 delete 断言面 616-680:journal 保留 → purge 消失)

**Interfaces:**
- Consumes: Task 1 `purgeSession`/`readSessionMeta`;Task 2 `findJournalOwner`/`liveSessionByJournal`。
- Produces: `POST /session/:id/delete` 新契约——未归档 409 `{error:'archive the session before deleting'}`;归档态 200 且 `purgeSession` 已清全家;双寻址同 archive。

- [ ] **Step 1: 写失败测试**(追加到 `src/serve/daemon.archive.test.ts`)

```ts
test('delete 门禁:未归档 409;归档态 200 且 journal/meta/gui 私有档全消', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, daemon, tmp }) => {
    const created = await fetch(`${base}/session`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '跑一轮' }) });
    await waitFor(() => fetch(`${base}/session/${sessionId}/snapshot`, { headers: AUTH }).then(async (r) => ((await r.json()) as { status: string }).status === 'idle'), 10_000);
    const jid = fs.readdirSync(path.join(resolveDataDir(tmp), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');
    const guiSession = path.join(tmp, '..', 'gui', 'sessions', `${jid}.json`); // 归档页未开时可能不存在——存在性断言按 precondition 分支

    const denied = await fetch(`${base}/session/${sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(denied.status, 409, '未归档拒删');

    await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    const ok = await fetch(`${base}/session/${sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(ok.status, 200);
    const sessionsDir = path.join(resolveDataDir(tmp), 'sessions');
    assert.equal(fs.readdirSync(sessionsDir).filter((f) => f.startsWith(`${jid}.`)).length, 0, '会话档全家清');
    if (fs.existsSync(guiSession)) assert.equal(fs.existsSync(guiSession), false, 'gui 私有档清');
    const gone = await fetch(`${base}/session/${sessionId}/snapshot`, { headers: AUTH });
    assert.equal(gone.status, 404, 'daemon 会话出注册表');
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm build && node --test dist/serve/daemon.archive.test.js`
Expected: FAIL(未归档删除现返回 200)

- [ ] **Step 3: 最小实现**(`daemon.ts` handleDelete 重写)

```ts
  private async handleDelete(res: http.ServerResponse, id: string): Promise<void> {
    const session = this.sessions.get(id);
    let dataDir: string;
    let jid: string;
    if (session !== undefined) {
      if (session.status() === 'running') {
        this.send(res, 409, { error: 'cannot delete while a run is in progress' });
        return;
      }
      const attached = session.attachedJournalId;
      if (attached === undefined) {
        this.send(res, 404, { error: 'session has no journal' });
        return;
      }
      jid = attached;
      dataDir = resolveDataDir(session.root);
    } else {
      if (!validSessionId(id)) {
        this.send(res, 400, { error: 'invalid session id' });
        return;
      }
      const owner = findJournalOwner(projectsRoot(), id);
      if (owner === undefined) {
        this.send(res, 404, { error: 'unknown session' });
        return;
      }
      jid = id;
      dataDir = owner.dataDir;
      const live = liveSessionByJournal(this.sessions).get(jid);
      if (live !== undefined) {
        this.send(res, 409, { error: 'cannot delete while a run is in progress' });
        return;
      }
    }
    // 归档门禁(2026-10-21):未归档拒删——「下架但留档」职责已由归档态接管,删除即真清
    if (readSessionMeta(dataDir, jid).archived !== true) {
      this.send(res, 409, { error: 'archive the session before deleting' });
      return;
    }
    if (session !== undefined) {
      this.denyPendingFor(id);
      await session.teardown();
      this.sessions.delete(id);
      this.ptyManager.killAllFor(id);
      if (this.active === id) this.active = undefined;
    }
    purgeSession(dataDir, jid);
    this.send(res, 200, { ok: true });
  }
```

(import 区补 `readSessionMeta`/`purgeSession` from './tui/session-journal'、`findJournalOwner`/`liveSessionByJournal` from './session-handlers'、`validSessionId`/`projectsRoot` 按既有引用;`this.sessions`/`this.active`/`this.ptyManager` 为既有字段。)

`gui/src/connection.ts` 138 行注释改为:`/** POST /session/:id/delete(2026-10-21 受控删除):须先归档(未归档 409);真清会话档全家 */`。

`gui/src/e2e.test.ts` G4→G5 describe(616-680):标题改「…归档态删除→真清文件」;删除调用前先 `POST /session/s2/archive`;断言改为 journal 目录中 `s2 前缀` 文件数为 0、snapshot 404(删除 `journal 保留` 的旧断言)。

- [ ] **Step 4: 跑测确认通过**

Run: `pnpm build && node --test dist/serve/daemon.archive.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/serve/daemon.ts src/serve/daemon.archive.test.ts gui/src/connection.ts gui/src/e2e.test.ts
git commit -m "feat(serve+gui): delete 归档门禁升级——未归档 409,归档态 purgeSession 真清全家;journal 保留语义退役"
```

---

### Task 4: 命令面——/archive · /delete 入 SLASH_COMMANDS + daemon runCommand + TUI handleSlash

**Files:**
- Modify: `src/tui/slash-commands.ts`(SLASH_COMMANDS 数组、slashCommandDescriptions)
- Modify: `src/serve/session-commands.ts`(COMMAND_SUPPORT ~18、IDLE_ONLY ~23、runCommand 分支)
- Modify: `src/tui/session.ts`(handleSlash ~440 起:/archive、/delete 分支;/new 块 ~1062 提取 `softResetToNewSession()`)
- Test: `src/tui/session.archive.test.ts`(新建,样板同 `src/tui/session.detail.test.ts`);`src/serve/commands.test.ts` 自动护漂移(逐字同源钉)

**Interfaces:**
- Consumes: Task 1 `markSessionArchived`/`purgeSession`;既有 `resolveDataDir`、`SessionJournal.currentId`(getter,TUI 取档 id 用它,**非 `.id`**)。
- Produces: `/archive`、`/delete` 在三面一致:TUI handleSlash、daemon runCommand(COMMAND_SUPPORT + IDLE_ONLY)、GUI 面板经 GET /commands 自动可见可走。

- [ ] **Step 1: 写失败测试**

```ts
// src/tui/session.archive.test.ts(新建)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { readSessionMeta, sessionsDir } from './session-journal';
import { resolveDataDir } from '../config/data-dir';

test('/archive:/delete 门禁与真清(TUI)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-archcmd-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const jid = ctrl.journal?.currentId as string;
    const dataDir = resolveDataDir(tmp);

    await ctrl.submit('/delete');
    assert.equal(readSessionMeta(dataDir, jid).archived, undefined, '未归档 /delete 拒绝且档还在');
    assert.ok(fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`)), '档未被清');

    await ctrl.submit('/archive');
    assert.equal(readSessionMeta(dataDir, jid).archived, true, '/archive 打标');

    await ctrl.submit('/delete');
    assert.equal(fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`)), false, '归档态 /delete 真清');
    assert.equal(ctrl.journal?.currentId !== undefined && ctrl.journal.currentId !== jid, true, '已软重置到新会话档');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm build && node --test dist/tui/session.archive.test.js`
Expected: FAIL(/delete 未识别为命令,当文本提交)

- [ ] **Step 3: 最小实现**

① `src/tui/slash-commands.ts`:`SLASH_COMMANDS` 在 `'/side'` 之后插入 `'/archive', '/delete'`;`slashCommandDescriptions()` 加:

```ts
    archive: t('archive this session (move out of main lists)', '归档当前会话（移出主列表）'),
    delete: t('delete this session (must be archived first)', '删除当前会话（须先归档）'),
```

② `src/serve/session-commands.ts`:`COMMAND_SUPPORT` 改 `['/status', '/compact', '/context', '/memory-on', '/memory-off', '/archive', '/delete']`;`IDLE_ONLY` 改 `new Set(['/compact', '/archive', '/delete'])`;import 行补 `markSessionArchived, purgeSession, readSessionMeta`(from '../tui/session-journal')、`resolveDataDir`(from '../config/data-dir');`runCommand` 在 `unsupported` 兜底前加:

```ts
  if (cmd === '/archive') {
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice(t('Nothing to archive yet', '暂无可归档的会话档'));
      return 'ok';
    }
    markSessionArchived(resolveDataDir(s.root), jid, true);
    notice(t('Session archived', '已归档'));
    return 'ok';
  }
  if (cmd === '/delete') {
    const jid = s.attachedJournalId;
    if (jid === undefined) {
      notice(t('Nothing to delete yet', '暂无可删除的会话档'));
      return 'ok';
    }
    const dataDir = resolveDataDir(s.root);
    if (readSessionMeta(dataDir, jid).archived !== true) {
      notice(t('Archive first (/archive), then /delete', '先归档（/archive）再删除'));
      return 'ok';
    }
    purgeSession(dataDir, jid);
    notice(t('Session deleted', '已删除'));
    void s.teardown(); // 档已清,运行时同步收口防 append 复活(注册表残壳至重启,幂等无害)
    return 'ok';
  }
```

(注:`s.attachedJournalId`/`s.root`/`s.teardown()`/`notice` 为该文件既有消费面;`/delete` 的 running 拒绝走 `IDLE_ONLY` → 409。)

③ `src/tui/session.ts`:

- `/new` 分支(1062 起)整块提取为私有方法 `private softResetToNewSession(): void`(rotate + kernelSeedForRestore + clearSessionAllows + memoryOverride + taskStats + md.clear + state 清零,原代码逐字平移),`/new` 分支改为调用它。
- handleSlash 中(`cmd === '/new'` 分支前)加:

```ts
    if (cmd === '/archive') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /archive unavailable now', '当前有任务进行中，暂不能执行 /archive'), { level: 'warn' });
        return;
      }
      const jid = this.journal?.currentId;
      if (jid === undefined) {
        this.pushMsg('system', t('Nothing to archive yet', '暂无可归档的会话档'), { level: 'warn' });
        return;
      }
      markSessionArchived(resolveDataDir(this.root), jid, true);
      this.pushMsg('system', t('Session archived', '已归档'));
      return;
    }
    if (cmd === '/delete') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /delete unavailable now', '当前有任务进行中，暂不能执行 /delete'), { level: 'warn' });
        return;
      }
      const jid = this.journal?.currentId;
      if (jid === undefined) {
        this.pushMsg('system', t('Nothing to delete yet', '暂无可删除的会话档'), { level: 'warn' });
        return;
      }
      const dataDir = resolveDataDir(this.root);
      if (readSessionMeta(dataDir, jid).archived !== true) {
        this.pushMsg('system', t('Archive first (/archive), then /delete', '先归档（/archive）再删除'), { level: 'warn' });
        return;
      }
      purgeSession(dataDir, jid);
      this.softResetToNewSession();
      this.pushMsg('system', t('Session deleted; started a new session', '已删除，已开新会话'));
      return;
    }
```

(import 区补 `markSessionArchived, purgeSession, readSessionMeta`——session-journal 既有 import 行扩展;`/help` 文案由 slashHelp 与清单同源自动带上,若 slashHelp 为手写清单则按既有格式补两行。)

- [ ] **Step 4: 跑测确认通过**

Run: `pnpm build && node --test dist/tui/session.archive.test.js dist/serve/commands.test.js`
Expected: PASS(commands.test 防漂移钉自动覆盖新命令)

- [ ] **Step 5: 提交**

```bash
git add src/tui/slash-commands.ts src/serve/session-commands.ts src/tui/session.ts src/tui/session.archive.test.ts
git commit -m "feat(commands): /archive·/delete 三面公用——SLASH_COMMANDS 单源+daemon runCommand+TUI handleSlash;/new 重置提取 softResetToNewSession"
```

---

### Task 5: GUI 连接面 + 快照归档态 + 顶栏归档钮/徽标

**Files:**
- Modify: `gui/src/connection.ts` + `gui/src/connection-types.ts`(ChatApi 增两方法;SnapshotResponse 增 `archived`)
- Modify: `src/serve/session.ts`(snapshot ~806 增 `archived` 字段)+ `src/serve/session.test.ts` 或 `gui/src/connection.test.ts`(契约钉)
- Modify: `gui/src/pages/chat/ChatTopbar.tsx`(归档钮/确认 morph/已归档徽标+撤销)
- Modify: `gui/src/pages/Chat.tsx`(快照 archived 播种,锚点=既有 `sessMode` 播种链;stale 注释 308 清理)
- Test: `gui/src/connection.test.ts`(新方法桩)、`gui/src/pages/Chat.test.tsx`(顶栏三态)

**Interfaces:**
- Consumes: T2 路由、T4 命令。
- Produces:
  - `conn.archiveSession(id: string, archived: boolean): Promise<void>`(POST /session/:id/archive)
  - `conn.archivedSessions(): Promise<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number }>>`(GET /sessions/archived)
  - `SnapshotResponse.archived?: boolean`;ChatTopbarProps += `archived: boolean`、`onArchive: (archived: boolean) => void`

- [ ] **Step 1: 写失败测试**

`gui/src/connection.test.ts` 追加(沿既有 FakeFetch/桩形态):

```ts
it('archiveSession/archivedSessions:POST archive 与 GET sessions/archived 的路径与载荷', async () => {
  // 依既有 connection.test.ts 的 fetch 桩形态:断言 method/path/body
  // archiveSession('s1', true) → POST /session/s1/archive body {"archived":true}
  // archivedSessions() → GET /sessions/archived → 行数组透传
});
```

`gui/src/pages/Chat.test.tsx` 追加:

```tsx
it('顶栏归档:未归档显 Archive 钮→点击变确认→确认调 archiveSession(true);已归档显徽标+撤销钮', async () => {
  // conn 桩:archiveSession vi.fn;快照 archived:false → 点击 Archive → 出「确认」→ 点击 → archiveSession 调 (id,true)
  // 快照 archived:true → .sx-archived-badge 在场;ArchiveRestore 钮点击 → archiveSession 调 (id,false)
});
```

(两测试的桩写法逐字对齐两文件既有用例形态——Chat.test 用 FakeConn,connection.test 用其 fetch 桩。)

- [ ] **Step 2: 跑测确认失败**

Run: `cd gui && npx vitest run src/connection.test.ts src/pages/Chat.test.tsx`
Expected: FAIL(方法/元素不存在)

- [ ] **Step 3: 最小实现**

① `src/serve/session.ts` snapshot()(~806 的响应对象)加一字段:

```ts
      archived: this.attachedJournalId !== undefined
        ? readSessionMeta(resolveDataDir(this.root), this.attachedJournalId).archived === true
        : false,
```

(readSessionMeta/resolveDataDir 该文件已 import——605 行 persistSelection 在用。)

② `gui/src/connection.ts` ChatApi 接口 + 实现各加:

```ts
  /** POST /session/:id/archive {archived}:归档/撤销;running 409 */
  archiveSession(id: string, archived: boolean): Promise<void>;
  /** GET /sessions/archived:跨工作区归档列表(归档页数据源) */
  archivedSessions(): Promise<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number }>>;
```

```ts
    archiveSession(id: string, archived: boolean): Promise<void> {
      return postJson(`/session/${id}/archive`, { archived });
    },
    archivedSessions() {
      return getJson('/sessions/archived');
    },
```

(postJson/getJson 沿用该文件既有帮手名;SnapshotResponse 类型加 `archived?: boolean`;138 行 deleteSession 注释已在 T3 改。)

③ `ChatTopbar.tsx`:props 增 `archived: boolean`、`onArchive: (archived: boolean) => void`;组件内 `const [confirming, setConfirming] = useState(false)`;顶栏右侧(既有 header 内,侧栏展开钮之前)渲染:

```tsx
        {archived ? (
          <>
            <span className="sx-archived-badge">{t('Archived', '已归档')}</span>
            <button type="button" className="sx-iconbtn" data-tip={t('Unarchive', '撤销归档')}
              aria-label={t('Unarchive', '撤销归档')} onClick={() => onArchive(false)}>
              <ArchiveRestore size={14} strokeWidth={1.75} />
            </button>
          </>
        ) : confirming ? (
          <button type="button" className="sx-archive-confirm" aria-label={t('Confirm archive', '确认归档')}
            onClick={() => { setConfirming(false); onArchive(true); }}>
            {t('Confirm', '确认')}
          </button>
        ) : (
          <button type="button" className="sx-iconbtn" data-tip={t('Archive', '归档')}
            aria-label={t('Archive', '归档')} onClick={() => setConfirming(true)}>
            <Archive size={14} strokeWidth={1.75} />
          </button>
        )}
```

(import 增 `Archive, ArchiveRestore`;`onArchive` 落 `conn.archiveSession(sessionId, v)` 由 Chat.tsx 闭包传入并本地 `setArchived` 同步;点击面板外不复位可后续打磨,收起由确认/再点击完成。)

④ `Chat.tsx`:快照播种处(既有 `sessMode` 来源链)并行播种 `archived`(初始 false,快照到达即对齐);308-309 stale 注释删除;`<ChatTopbar>` 调用点补两 props。

- [ ] **Step 4: 跑测确认通过 + typecheck**

Run: `cd gui && npx vitest run src/connection.test.ts src/pages/Chat.test.tsx && pnpm --dir gui run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/serve/session.ts gui/src/connection.ts gui/src/connection-types.ts gui/src/pages/chat/ChatTopbar.tsx gui/src/pages/Chat.tsx gui/src/connection.test.ts gui/src/pages/Chat.test.tsx
git commit -m "feat(gui): 快照 archived 播种+顶栏归档钮(确认 morph)/已归档徽标+撤销;conn 增 archiveSession/archivedSessions"
```

---

### Task 6: GUI——侧栏行归档钮 + 归档页(撤销/红删除/来源项目/打开会话)

**Files:**
- Create: `gui/src/pages/Archived.tsx`(+ `gui/src/pages/Archived.test.tsx`)
- Modify: `gui/src/App.tsx`(page 态旁增 `archivedOpen` overlay,模式同 settingsOpen;`<ProjectMenu>` 传 onOpenArchived;渲染 ArchivedPage;行点击复用既有 attach-by-journal 链)
- Modify: `gui/src/sidebar/ProjectMenu.tsx`(Props += `onOpenArchived?: () => void`;组头渲染归档箱钮)
- Modify: `gui/src/sidebar/project-menu-projects.tsx` + `project-menu-recents.tsx`(会话行 hover 归档钮 + 确认 morph;`ProjectMenuConn` 增 `archiveSession`)
- Modify: `gui/src/app.css`(sx-archived-badge/sx-archive-confirm/sx-archived-page 行样式;复用既有行/钮 token)
- Test: `gui/src/pages/Archived.test.tsx`(新建)、`gui/src/sidebar/project-menu.test.tsx`(追加行内归档用例)

**Interfaces:**
- Consumes: T5 `conn.archiveSession/archivedSessions`。
- Produces: `ArchivedPage({ conn, onOpen, onClose })`;ProjectMenu `onOpenArchived`;侧栏行归档态由服务端列表滤除自然生效(T2c)。

- [ ] **Step 1: 写失败测试**

```tsx
// gui/src/pages/Archived.test.tsx(新建)
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchivedPage } from './Archived';

const rows = [
  { id: 'j1', slug: 'ws-a', root: 'D:/ws-a', title: '会话一', updatedAt: 2, archivedAt: 20 },
  { id: 'j2', slug: 'ws-b', root: 'D:/ws-b', updatedAt: 1, archivedAt: 10 },
];

function mkConn() {
  return {
    archivedSessions: vi.fn(async () => rows),
    archiveSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } as never;
}

describe('ArchivedPage 归档页', () => {
  it('行渲染:标题(无题回落 id)+来源 slug;撤销调 archiveSession(j,false);红删除走确认后 deleteSession', async () => {
    const conn = mkConn();
    const onOpen = vi.fn();
    render(<ArchivedPage conn={conn} onOpen={onOpen} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('会话一')).toBeDefined());
    expect(screen.getByText('ws-a')).toBeDefined();                    // 来源项目标注
    expect(screen.getByText('j2')).toBeDefined();                      // 无题回落 id
    fireEvent.click(screen.getByRole('button', { name: '撤销归档 j1' }));
    await waitFor(() => expect(conn.archiveSession).toHaveBeenCalledWith('j1', false));
    fireEvent.click(screen.getByRole('button', { name: '删除 j2' }));   // → 行内变「确认」
    fireEvent.click(screen.getByRole('button', { name: '确认删除 j2' }));
    await waitFor(() => expect(conn.deleteSession).toHaveBeenCalledWith('j2'));
  });
  it('点击行 → onOpen(root, journalId)', async () => {
    const onOpen = vi.fn();
    render(<ArchivedPage conn={mkConn()} onOpen={onOpen} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('会话一')).toBeDefined());
    fireEvent.click(screen.getByText('会话一'));
    expect(onOpen).toHaveBeenCalledWith('D:/ws-a', 'j1');
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd gui && npx vitest run src/pages/Archived.test.tsx`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

① `gui/src/pages/Archived.tsx`(新建;加载态/空态文案走 t();back 钮 `data-tip`;行结构两行式:标题 + slug 小字;行 hover 右侧 `[ArchiveRestore 撤销归档][Trash2 删除]`,删除点击后该行按钮位变红色「确认」再点才调 deleteSession,确认随 1.5s 超时或点他处复位不强制):

```tsx
import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, ArrowLeft, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import type { Connection } from '../connection';

type ArchivedRow = { id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number };

export function ArchivedPage({ conn, onOpen, onClose }: {
  conn: Connection;
  onOpen: (root: string, journalId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [rows, setRows] = useState<ArchivedRow[] | null>(null);
  const [confirmingId, setConfirmingId] = useState('');
  useEffect(() => {
    let alive = true;
    conn.archivedSessions().then(
      (r) => { if (alive) setRows(r); },
      () => { if (alive) setRows([]); },
    );
    return () => { alive = false; };
  }, [conn]);
  const unarchive = useCallback((id: string) => {
    void conn.archiveSession(id, false).then(() => setRows((cur) => (cur ?? []).filter((r) => r.id !== id)), () => undefined);
  }, [conn]);
  const remove = useCallback((id: string) => {
    void conn.deleteSession(id).then(() => setRows((cur) => (cur ?? []).filter((r) => r.id !== id)), () => undefined);
  }, [conn]);
  return (
    <div className="sx-archived-page" role="region" aria-label={t('Archived sessions', '归档会话')}>
      <div className="sx-archived-head">
        <button type="button" className="sx-iconbtn" data-tip={t('Back', '返回')} aria-label={t('Back', '返回')} onClick={onClose}>
          <ArrowLeft size={15} strokeWidth={1.75} />
        </button>
        <h2>{t('Archived sessions', '归档会话')}</h2>
      </div>
      {rows === null ? (
        <p className="insight-empty">{t('Loading…', '加载中…')}</p>
      ) : rows.length === 0 ? (
        <p className="insight-empty">{t('No archived sessions', '暂无归档会话')}</p>
      ) : (
        <ul className="sx-archived-list">
          {rows.map((r) => (
            <li key={r.id} className="sx-archived-row" onClick={() => onOpen(r.root, r.id)}>
              <div className="sx-archived-main">
                <span className="sx-archived-title">{r.title ?? r.id}</span>
                <span className="sx-archived-slug">{r.slug}</span>
              </div>
              <div className="sx-archived-actions" onClick={(e) => e.stopPropagation()}>
                {confirmingId === r.id ? (
                  <button type="button" className="sx-archive-confirm" aria-label={`${t('Confirm delete', '确认删除')} ${r.id}`}
                    onClick={() => { setConfirmingId(''); remove(r.id); }}>
                    {t('Confirm', '确认')}
                  </button>
                ) : (
                  <>
                    <button type="button" className="sx-iconbtn" data-tip={t('Unarchive', '撤销归档')}
                      aria-label={`${t('Unarchive', '撤销归档')} ${r.id}`} onClick={() => unarchive(r.id)}>
                      <ArchiveRestore size={13} strokeWidth={1.75} />
                    </button>
                    <button type="button" className="sx-iconbtn sx-danger" data-tip={t('Delete', '删除')}
                      aria-label={`${t('Delete', '删除')} ${r.id}`} onClick={() => setConfirmingId(r.id)}>
                      <Trash2 size={13} strokeWidth={1.75} />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

② `App.tsx`:`const [archivedOpen, setArchivedOpen] = useState(false);`;`<ProjectMenu>` 调用点(819)传 `onOpenArchived={() => setArchivedOpen(true)}`;主区域按 settings 的 overlay 形态渲染:

```tsx
        {archivedOpen && connInstance !== null && (
          <ArchivedPage
            conn={connInstance}
            onOpen={(root, journalId) => { setArchivedOpen(false); /* 复用 ProjectMenu onAttach 同一条 attach-by-journal 链: */ onAttachByJournal(root, journalId); }}
            onClose={() => setArchivedOpen(false)}
          />
        )}
```

(`onAttachByJournal` = App 传给 ProjectMenu 的行打开回调现名——实现时以 819-836 行 ProjectMenu props 实参为准取同一函数,保证归档页行点击与侧栏行点击同链。)

③ `ProjectMenu.tsx`:Props += `readonly onOpenArchived?: () => void;`;「项目 add workspace」组头按钮旁加:

```tsx
              {onOpenArchived !== undefined && (
                <button type="button" className="sx-iconbtn" data-tip={t('Archived sessions', '归档会话')}
                  aria-label="archived sessions" onClick={onOpenArchived}>
                  <Archive size={14} strokeWidth={1.75} />
                </button>
              )}
```

④ 侧栏行归档钮(`project-menu-projects.tsx` 会话行 `<li>` 内、`session-meta` 之后;`project-menu-recents.tsx` 行同款):`ProjectMenuConn` 增 `archiveSession(id, archived)`(Connection 结构化子集,随既有形状);行组件内 `confirming` state(行级,`useState('')` 存 id)+ hover 显示:

```tsx
                              <span className="session-row-actions">
                                {confirmId === sr.id ? (
                                  <button type="button" className="sx-archive-confirm" aria-label={`${t('Confirm archive', '确认归档')} ${sr.id}`}
                                    onClick={(e) => { e.stopPropagation(); setConfirmId(''); onArchiveRow(sr.id, true); }}>
                                    {t('Confirm', '确认')}
                                  </button>
                                ) : (
                                  <button type="button" className="sx-iconbtn" data-tip={t('Archive', '归档')}
                                    aria-label={`${t('Archive', '归档')} ${sr.id}`}
                                    onClick={(e) => { e.stopPropagation(); setConfirmId(sr.id); }}>
                                    <Archive size={12} strokeWidth={1.75} />
                                  </button>
                                )}
                              </span>
```

(`onArchiveRow = (id, archived) => conn.archiveSession(id, archived).then(重拉列表)`;列表重拉复用组件既有 sessions 装载函数。)

⑤ `app.css` 追加(圆角走 token、色走既有变量):

```css
/* 2026-10-21 归档面:徽标/确认钮/归档页(两行式行+hover 动作) */
.sx-archived-badge { flex: none; font-size: 11px; color: var(--fg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 0 6px; }
.sx-archive-confirm { flex: none; border: none; border-radius: var(--radius-sm); background: var(--err); color: #fff; font-size: 12px; padding: 2px 10px; cursor: pointer; }
.sx-iconbtn.sx-danger:hover { color: var(--err); }
.sx-archived-page { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 14px 18px; overflow: auto; }
.sx-archived-head { display: flex; align-items: center; gap: 8px; } .sx-archived-head h2 { margin: 0; font-size: 14px; color: var(--fg); }
.sx-archived-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sx-archived-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: var(--radius-md); cursor: pointer; }
.sx-archived-row:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); }
.sx-archived-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sx-archived-title { font-size: 12.5px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sx-archived-slug { font-size: 11px; color: var(--fg-tertiary); }
.sx-archived-actions { flex: none; display: none; align-items: center; gap: 2px; }
.sx-archived-row:hover .sx-archived-actions, .sx-archived-row:focus-within .sx-archived-actions { display: inline-flex; }
.session-row-actions { flex: none; display: none; align-items: center; }
.sx-session-row:hover .session-row-actions { display: inline-flex; }
```

- [ ] **Step 4: 跑测确认通过 + typecheck**

Run: `cd gui && npx vitest run src/pages/Archived.test.tsx src/sidebar/project-menu.test.tsx && pnpm --dir gui run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add gui/src/pages/Archived.tsx gui/src/pages/Archived.test.tsx gui/src/App.tsx gui/src/sidebar/ProjectMenu.tsx gui/src/sidebar/project-menu-projects.tsx gui/src/sidebar/project-menu-recents.tsx gui/src/app.css gui/src/sidebar/project-menu.test.tsx
git commit -m "feat(gui): 侧栏行归档钮(确认 morph)+归档页(来源项目/撤销/红删除受控删除/点击切工作区开会话)+项目组头归档入口"
```

---

### Task 7: 全量门 + 文档同步 + 构建部署

**Files:**
- Modify: `MANUAL.md`(命令表加 /archive、/delete 两行;GUI 章节补归档页/行内归档/受控删除说明)
- 验证面:root 全量、GUI 全量、typecheck、`pnpm gui:build`

- [ ] **Step 1: 全量门**

Run: `pnpm test && pnpm --dir gui run test && pnpm --dir gui run typecheck`
Expected: 全绿(root 套件含新 session-journal/daemon.archive/session.archive 测试;GUI 含 Archived/ChatTopbar 用例;既有 e2e 已在 T3 更新契约)。e2e 既有 5 个 daemon 拆除竞态噪声(unhandled ECONNREFUSED)为已知非阻塞。

- [ ] **Step 2: MANUAL.md 文档同步**

命令表(`MANUAL.md` 斜杠命令清单)按既有行格式补:

```markdown
| `/archive` | 归档当前会话(移出主列表/最近会话;GUI 归档页可见可撤销) |
| `/delete` | 删除当前会话(须先 `/archive`;真清会话档,不可恢复) |
```

GUI 章节补一段:侧栏行 hover 归档(二次确认)、顶栏已归档徽标+撤销、「项目」组头归档页(来源项目/撤销/红色删除二次确认)、归档后方可删除。

- [ ] **Step 3: 构建部署**

Run: `pnpm gui:build`
Expected: 构建成功(7788 daemon 刷新即见新面)。

- [ ] **Step 4: 提交**

```bash
git add MANUAL.md
git commit -m "docs(manual): /archive·/delete 命令与 GUI 归档面说明"
```

---

## Self-Review 记录

- **Spec 覆盖**:§4→T1;§5(archive 路由/列表/archived 列表/delete 升级)→T2+T3;§6→T4;§7(顶栏/侧栏/归档页/主列表滤除)→T5+T6(滤除由 T2c 服务端直达);§8(running 409 矩阵/幂等 purge/指针兜底无需新逻辑)→T2+T3;§9 四层测试→各 Task Step 1;§10 文档→T7。✅
- **接口微调已声明**:路由双寻址(spec 单寻址)在计划头部 Spec 节注明理由(GUI 侧栏/归档页只有 journalId;顶栏路径是 daemon 会话 id)。✅
- **占位扫描**:T2 Step1 测试中「轮询至 idle」标注了以 daemon.gui-state.test.ts 既有惯用法逐字对齐(真实锚点,非 TBD);T5/T6 的桩形态锚定既有文件用例形态;其余步骤均带实码。✅
- **类型一致性**:`markSessionArchived(dataDir,id,archived)`/`purgeSession(dataDir,id)` 各 Task 签名一致;`archiveSession(id,archived)`/`archivedSessions()` T5 定义 T6 消费;`SessionJournal.currentId`(getter)统一(非 `.id`)。✅
