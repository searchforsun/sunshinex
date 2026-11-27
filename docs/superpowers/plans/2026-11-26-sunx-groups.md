# Sunx 群组与群聊页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-11-26-sunx-groups-design.md` 交付 Sunx 群组、群聊页、@/全体分发回执、群命令、查询侧栏与群成员弹窗。

**Architecture:** daemon 新增群存储 + 房间 append-only 日志 + 同群对等投递作用域；群主（人）发言走既有 `submitExternal`/`steer` 用户消息语义，破坏性命令仅单目标。GUI 新增 SUNX 群树、创建弹窗群字段、主区群聊覆盖层（无右侧页签栏）、环形饼图回执、查询侧栏与群成员弹窗。不新增 agent 运行时。

**Tech Stack:** TypeScript（Node daemon，node:test）、React（GUI，vitest）、现有 journal/meta/seglog 链路、现有 SessionRuntime/runCommand。

**Spec:** `docs/superpowers/specs/2026-11-26-sunx-groups-design.md`（本计划的所有细节以 spec 为准；以下仅列实施任务与关键契约）

## Global Constraints

- 模型面文案恒英文；群名/成员名/品性/正文/命令输出原样，不翻译。
- 一个 Sunx 只属于一个群；缺失 `groupId` = `grp_default`，不批量改写存量。
- 群主=`{id: groupId, name:'群主', kind:'group'}` 虚拟身份，无会话、无 agent 轮。
- 房间是人的观察窗：成员只收到被 @ 或点对点发送的消息；`A→B` 不广播给 C。
- 破坏四件（`/delete`、`/skills-rm`、`/memory-rm`、`/memory-gc`）只在恰好 1 个显式成员时执行；`@all`/多目标 400，不写房间、不 fan-out。
- `@全体成员` 无上限、无二次确认；目标=发送时快照的未归档成员。
- 群聊页没有右侧页签栏；顶栏只有群名+`⋯`（新建 SUNX/编辑群名/复制群主 ID/群成员）；`[|]` 位置=查询图标，右侧查询侧栏。
- 图标 ≥14；`data-tip` 不用原生 `title`；暗亮双主题验收。
- 不夹带他批 WIP；只 stage 本计划文件。已知 HEAD-red：`gui/src/e2e.rewind.test.ts`。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/config/data-dir.ts` | `sunxGroupsDir()`（`sunxContainerDir() + '-groups'`） |
| `src/serve/sunx-groups.ts`（新） | 群 CRUD、默认群、成员扫描、房间 append/fold/read/search、群发送 fan-out、命令可用集/破坏件单目标、推断引用 |
| `src/serve/sunx-peers.ts` | 同群 list + 群目标；send 群/成员路由；房间镜像；跨群/归档校验；`deliverToSession` 核心 |
| `src/harness/tools/sunx-peer-tools.ts` | `SunxPeerInfo.kind/memberCount`；群目标行；`to` 描述；回执 kind |
| `src/serve/session-lifecycle.ts` | `CreateSessionOpts.groupId` → SessionRuntime |
| `src/serve/session.ts` | `persistBirthMeta` 写 `groupId`；runtime `groupId` 字段 |
| `src/serve/session-commands.ts` | `runCommand(..., fromSunx?)`；user 行携带归因 |
| `src/serve/daemon.ts` | `/sunx/groups*`（含 search）、`/session/:id/group`、send 路由；`sunxPeersFor` 群路由 |
| `src/serve/sessions-list-handlers.ts` | `/sunx/sessions` 行加 `groupId` |
| `src/session/journal.ts` | `SessionSidecarMeta.groupId` |
| `src/types.ts`、`src/session/entry.ts`、`src/session/seglog.ts` | `SunxPeerRef.kind` 净化/回放 |
| `gui/src/connection.ts` / `connection-api.ts` | 群 CRUD/消息/发送/查询/换群；`newSession` groupId；行 groupId |
| `gui/src/sidebar/project-menu-sunx.tsx`、`ProjectMenu.tsx`、`use-menu-sunx.ts` | 群树/群行动作/新建群组/降级 |
| `gui/src/welcome/NewSunxDialog.tsx`、`NewGroupDialog.tsx`（新） | 群字段下拉/筛选/行内新建/编辑换群；新群弹窗 |
| `gui/src/pages/group/*`（新） | 群聊页/列表/气泡/环形饼图/两栏回执/群成员弹窗/查询侧栏/composer/轮询 |
| `gui/src/app-shell-panes.tsx`、`App.tsx`、`use-app-tabs.ts`、`gui/src/window-shell.tsx` | 群聊层/无右侧页签栏/`groupChatId`/`[|]` 查询图标/打开关闭/群主归因跳转 |
| `gui/src/pages/chat/EntryViews.tsx`、`ToolEntry.tsx`、`tool-entry-body.tsx`、`tool-entry-data.ts`、`chat-reducer.ts` | `kind:'group'` 归因/群目标工具行 |
| `gui/src/app.css` | 群聊层/群树/气泡/饼图/两栏回执/查询侧栏/成员弹窗/亮暗主题 |

---

## P0 后端地基

### Task 1: 群目录 + 群存储 + 默认群

**Files:**
- Modify: `src/config/data-dir.ts`
- Create: `src/serve/sunx-groups.ts`
- Test: `src/serve/sunx-groups.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_GROUP_ID = 'grp_default'`
  - `SunxGroupRecord { id: string; name: string; createdAt: number; updatedAt?: number }`
  - `listGroups(): SunxGroupRecord[]`（惰性补种默认群；按名称排序）
  - `createGroup(name: string): { ok: true; group: SunxGroupRecord } | { ok: false; error: string }`
  - `renameGroup(id: string, name: string): ...`
  - `deleteGroup(id: string, memberCount: number): ...`（默认群/有成员拒绝）
  - `roomPath(groupId: string): string`
  - `sunxGroupsDir(): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/serve/sunx-groups.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_GROUP_ID, createGroup, deleteGroup, listGroups, renameGroup } from './sunx-groups';
import { sunxGroupsDir } from '../config/data-dir';

test('默认群惰性补种；建群/重名/改名/删空群/默认群不可删', () => {
  const root = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'sxg-'));
  process.env.SUNSHINEX_SUNX_DIR = path.join(root, 'sunx');
  const groups = listGroups();
  assert.equal(groups[0]?.id, DEFAULT_GROUP_ID);
  const c = createGroup('研发群');
  assert.equal(c.ok, true);
  assert.equal(createGroup('研发群').ok, false, '重名 409');
  assert.equal(createGroup('  ').ok, false, '空名 400');
  assert.equal(renameGroup(c.ok ? c.group.id : '', '研发二群').ok, true);
  assert.equal(deleteGroup(DEFAULT_GROUP_ID, 0).ok, false, '默认群不可删');
  assert.equal(deleteGroup(c.ok ? c.group.id : '', 1).ok, false, '有成员 409');
  assert.equal(deleteGroup(c.ok ? c.group.id : '', 0).ok, true);
  assert.ok(fs.existsSync(path.join(sunxGroupsDir(), 'groups.json')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/serve/sunx-groups.test.ts`（或 `npm test` 的子集）
Expected: FAIL `Cannot find module './sunx-groups'`.

- [ ] **Step 3: Implement**

`src/config/data-dir.ts`:
```ts
export function sunxGroupsDir(): string {
  return `${sunxContainerDir()}-groups`;
}
```

`src/serve/sunx-groups.ts`:
```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sunxGroupsDir } from '../config/data-dir';

export const DEFAULT_GROUP_ID = 'grp_default';
export interface SunxGroupRecord { id: string; name: string; createdAt: number; updatedAt?: number }
interface GroupsFile { version: 1; groups: SunxGroupRecord[] }

function file(): string { return path.join(sunxGroupsDir(), 'groups.json'); }
function read(): GroupsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<GroupsFile>;
    const groups = Array.isArray(raw.groups) ? raw.groups.filter((g): g is SunxGroupRecord =>
      typeof g === 'object' && g !== null && typeof (g as SunxGroupRecord).id === 'string' &&
      typeof (g as SunxGroupRecord).name === 'string' && typeof (g as SunxGroupRecord).createdAt === 'number') : [];
    if (!groups.some((g) => g.id === DEFAULT_GROUP_ID)) {
      groups.unshift({ id: DEFAULT_GROUP_ID, name: '默认群组', createdAt: Date.now() });
    }
    return { version: 1, groups };
  } catch {
    return { version: 1, groups: [{ id: DEFAULT_GROUP_ID, name: '默认群组', createdAt: Date.now() }] };
  }
}
function write(f: GroupsFile): void {
  fs.mkdirSync(sunxGroupsDir(), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(f), 'utf8');
  fs.renameSync(tmp, file());
}
function validName(name: string): string | undefined {
  const n = name.trim();
  return n.length >= 1 && n.length <= 60 ? n : undefined;
}
export function listGroups(): SunxGroupRecord[] {
  return [...read().groups].sort((a, b) => a.name.localeCompare(b.name));
}
export function createGroup(name: string): { ok: true; group: SunxGroupRecord } | { ok: false; error: string } {
  const n = validName(name);
  if (n === undefined) return { ok: false, error: 'group name must be 1-60 chars' };
  const f = read();
  if (f.groups.some((g) => g.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'group name already exists' };
  const group = { id: 'grp_' + Math.random().toString(36).slice(2, 10), name: n, createdAt: Date.now() };
  f.groups.push(group); write(f);
  return { ok: true, group };
}
export function renameGroup(id: string, name: string): { ok: true; group: SunxGroupRecord } | { ok: false; error: string } {
  const n = validName(name);
  if (n === undefined) return { ok: false, error: 'group name must be 1-60 chars' };
  const f = read();
  if (f.groups.some((g) => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'group name already exists' };
  const g = f.groups.find((x) => x.id === id);
  if (g === undefined) return { ok: false, error: 'group not found' };
  g.name = n; g.updatedAt = Date.now(); write(f);
  return { ok: true, group: g };
}
export function deleteGroup(id: string, memberCount: number): { ok: true } | { ok: false; error: string } {
  if (id === DEFAULT_GROUP_ID) return { ok: false, error: 'default group cannot be deleted' };
  if (memberCount > 0) return { ok: false, error: 'group has members' };
  const f = read();
  const i = f.groups.findIndex((g) => g.id === id);
  if (i < 0) return { ok: false, error: 'group not found' };
  f.groups.splice(i, 1); write(f);
  fs.rmSync(path.join(sunxGroupsDir(), id), { recursive: true, force: true });
  return { ok: true };
}
export function roomPath(groupId: string): string { return path.join(sunxGroupsDir(), groupId, 'room.jsonl'); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/serve/sunx-groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/data-dir.ts src/serve/sunx-groups.ts src/serve/sunx-groups.test.ts
git commit -m "feat(sunx): group store + default group + groups dir"
```

### Task 2: 实例归属（meta.groupId / 出生 / 换群 / 行投影）

**Files:**
- Modify: `src/session/journal.ts`（`SessionSidecarMeta.groupId?: string`）
- Modify: `src/serve/session-lifecycle.ts`（`CreateSessionOpts.groupId`）
- Modify: `src/serve/session.ts`（runtime opts/field；`persistBirthMeta`）
- Modify: `src/serve/sessions-list-handlers.ts`（行投影）
- Test: `src/serve/sunx-groups.test.ts`

**Interfaces:**
- Consumes: `SessionSidecarMeta`, `CreateSessionOpts`, `SessionRuntimeOpts`.
- Produces: `meta.groupId`; `CreateSessionOpts.groupId`; `/sunx/sessions` 行 `groupId`（有效值，缺失=`grp_default`）。

- [ ] **Step 1: Write failing test**

```ts
test('groupId 出生写 meta；缺失默认群；换群写 meta', () => {
  // 用 createSessionIn 建 sunx（groupId:'grp_x'）→ readSessionMeta(...).groupId==='grp_x'
  // 另建无 groupId → 行投影 groupId==='grp_default'
  // writeSessionMeta(dataDir, jid, {groupId:'grp_y'}) → 读回 grp_y
});
```

- [ ] **Step 2: Run + fail**
- [ ] **Step 3: Implement**

```ts
// journal.ts
export interface SessionSidecarMeta { /* ...existing */ groupId?: string }
```

```ts
// session-lifecycle.ts
export interface CreateSessionOpts { /* ...existing */ groupId?: string }
// new SessionRuntime({ ..., ...(opts?.groupId !== undefined ? { groupId: opts.groupId } : {}) })
```

```ts
// session.ts
interface SessionRuntimeOpts { /* ...existing */ groupId?: string }
private readonly groupIdInit?: string; // 构造赋值
persistBirthMeta(): void {
  // ...
  ...(this.groupIdInit !== undefined && this.groupIdInit !== '' ? { groupId: this.groupIdInit } : {}),
}
```

```ts
// sessions-list-handlers.ts（enumerateContainerSessions 行）
...(r.groupId !== undefined && r.groupId !== '' ? { groupId: r.groupId } : { groupId: DEFAULT_GROUP_ID }),
```

- [ ] **Step 4: Run test**
- [ ] **Step 5: Commit**

### Task 3: 同群 peers + 群目标行 + 群/成员 send 路由

**Files:**
- Modify: `src/harness/tools/sunx-peer-tools.ts`
- Modify: `src/serve/sunx-peers.ts`
- Modify: `src/serve/daemon.ts`（`sunxPeersFor.send` 路由）
- Test: `src/serve/sunx-peers.test.ts`, `src/harness/sunx-face.test.ts`

**Interfaces:**
- `SunxPeerInfo` 增 `kind?: 'sunx' | 'group'`、`memberCount?: number`
- `SunxPeerSendResult` 成功增 `kind?: 'sunx' | 'group'`
- `listSunxPeers` 只列同群（+ 群目标行）
- `sendSunxPeerGroup` / `deliverSunxPeerMessage`（组内）
- 群目标回执 `message delivered to <name> (<gid>) - posted to the group room`

- [ ] **Step 1: Write failing tests**

```ts
test('list 同群 + 群目标行；跨群不列', () => {
  // 建群 grp_a；A/B meta.groupId=grp_a，C=grp_b
  // listSunxPeers(sessions,'A') 含 B + 群目标 grp_a，不含 C
});
test('send 到群 id 写房间 peer；成员→成员镜像；跨群拒绝', () => {
  // deliverSunxPeerMessage(... 'B', 'hi') → B 收到；room 有 peer
  // send 到 grp_a → room peer to=群主
});
```

- [ ] **Step 2: Run + fail**
- [ ] **Step 3: Implement**

```ts
// sunx-peer-tools.ts
export interface SunxPeerInfo { /* ... */ kind?: 'sunx' | 'group'; memberCount?: number }
export type SunxPeerSendResult =
  | { ok: true; name: string; queued: boolean; kind?: 'sunx' | 'group' }
  | { ok: false; error: string };
```

```ts
// sunx-peers.ts（核心）
export function callerGroup(sessions, callerId): string; // meta.groupId ?? DEFAULT_GROUP_ID
export function listSunxPeers(sessions, callerId): SunxPeerInfo[] {
  // 逐域枚举 → 过滤 effectiveGroup===callerGroup；排己/归档
  // unshift 群目标行 {kind:'group', id:gid, name:groupName, live:true, running:false,
  //   awaiting:false, root:'', updatedAt:lastMessageAt??createdAt, memberCount}
}
export function deliverSunxPeerMessage(sessions, callerId, to, text, opts): SunxPeerSendResult {
  // to 是 grp_ id：校验 caller 成员 → appendRoomPeer({from:callerRef,to:owner,text,推断引用})
  //   → {ok:true,name:群名,queued:false,kind:'group'}
  // to 成员：同群校验 → 现有 idle/running/409 投递 → 成功 appendRoomPeer
  // 跨群/归档/未知 → 英文错误
}
```

```ts
// daemon.ts sunxPeersFor.send
send: async (to, text) =>
  deliverSunxPeerMessage(this.sessions, sessionId, to, text, {
    ensureLive: (jid) => this.attachSunxRuntime(jid).ok,
  }),
```

- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

### Task 4: 房间日志 append/fold/cursor/search

**Files:**
- Modify: `src/serve/sunx-groups.ts`
- Test: `src/serve/sunx-groups.test.ts`

**Interfaces:**
- `appendRoomLine(groupId, line: Omit<RoomLine,'seq'>): number`（读末 seq+1）
- `readRoom(groupId, { after?, before?, limit? }): { messages: SunxRoomMessage[]; cursor: number; hasMore: boolean; reset?: boolean }`
- `searchRoom(groupId, q, limit): SearchHit[]`
- `appendRoomPeer(...)`、`appendRoomDelivery(...)`、`appendRoomCommand(...)`、`appendRoomHuman(...)`
- `inferQuote(groupId, fromId, toId?): { replyTo, replyPreview } | undefined`

- [ ] **Step 1: Write failing tests**（append/fold/delivery 覆盖/after/before/reset/search）
- [ ] **Step 2: Run + fail**
- [ ] **Step 3: Implement** per spec §3.3/§4.3.
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

### Task 5: 群主发送 + fan-out + 回执 + 破坏件单目标

**Files:**
- Modify: `src/serve/sunx-groups.ts`
- Modify: `src/serve/daemon.ts`
- Test: `src/serve/sunx-groups.test.ts`

**Interfaces:**
- `sendGroupMessage(groupId, body, deps): Promise<{ ok: true; messageId; seq; targets } | { ok: false; status; error }>`
- `deps = { sessions; ensureLive; deliver; runCommand; memberRows }`
- `destructive command + mentionAll/multi → 400`；单目标允许
- @all 快照；room-only；delivery 行；command 结果 message

- [ ] **Step 1: Write failing tests**（@1/@多/@all/room-only/破坏件单目标/@all 400/部分失败/命令结果）
- [ ] **Step 2: Run + fail**
- [ ] **Step 3: Implement** per spec §4.4/§5.1.
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

### Task 6: `runCommand` fromSunx + 命令输出房间化

**Files:**
- Modify: `src/serve/session-commands.ts`
- Modify: `src/serve/sunx-groups.ts`
- Test: `src/serve/sunx-commands.test.ts`（新）

- [ ] **Step 1: Write failing test**：`runCommand(s, '/status', capture, {id:'grp_x',name:'群主',kind:'group'})` → 捕获非空；user 行 fromSunx 归因。
- [ ] **Step 2: Run + fail**
- [ ] **Step 3: Implement**：`runCommand(s, line, capture?, fromSunx?)`；`s.pump({type:'user', text:line, ts, ...(fromSunx?{payload:{fromSunx}}:{})})`。
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

### Task 7: HTTP 路由 + daemon 接缝

**Files:**
- Modify: `src/serve/daemon.ts`
- Modify: `src/serve/session-handlers.ts`（换群 / send handler）
- Test: `src/serve/daemon.groups.test.ts`（新）

Routes: `/sunx/groups` GET/POST, `/sunx/groups/:id` GET/PATCH/DELETE, `/messages`, `/search`, `/send`, `/session/:id/group` PATCH.

- [ ] **Step 1: Write failing handler tests**
- [ ] **Step 2: Run + fail**
- [ ] **Step 3: Implement** per spec §4.1/§4.2.
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

### Task 8: `SunxPeerRef.kind` 全链

**Files:**
- Modify: `src/types.ts`、`src/session/entry.ts`、`src/session/seglog.ts`
- Modify: `gui/src/chat-reducer.ts`（P1 前置）
- Test: `src/session/sunx-peer-attribution.test.ts`

- [ ] **Step 1: Write failing test**：`parseSunxPeerRef({id:'grp_x',name:'群主',kind:'group'})` 保留 kind；journal/seg 回放保留。
- [ ] **Step 2: Run + fail**
- [ ] **Step 3: Implement**：`SunxPeerKind`；`parseSunxPeerRef` 白名单 `'sunx'|'group'`；seg 行读写。
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

---

## P1 GUI：数据/侧栏/弹窗

### Task 9: connection API + 类型

**Files:** `gui/src/connection.ts`、`gui/src/connection-api.ts`、`gui/src/chat-reducer.ts`、`gui/src/pages/chat/chat-types.ts`（如需）

- [ ] 添加 `sunxGroups()`, `createSunxGroup(name)`, `renameSunxGroup(id,name)`, `deleteSunxGroup(id)`, `sunxGroupDetail(id)`, `sunxGroupMessages(id, opts)`, `sunxGroupSearch(id,q)`, `sunxGroupSend(id, body)`, `setSessionGroup(id, gid)`；`newSession` opts groupId；`sunxSessions` 行 groupId。
- [ ] 添加 GUI 类型 `SunxGroupRow/SunxGroupMember/SunxRoomMessage/SunxGroupSendResult`（与 spec §3.4 对齐）。
- [ ] `ChatEntry.fromSunx.kind` 透传。
- [ ] 单测：connection 方法 URL/body；chat-reducer kind 拷贝。

### Task 10: 侧栏群树

**Files:** `gui/src/sidebar/project-menu-sunx.tsx`、`ProjectMenu.tsx`、`use-menu-sunx.ts`、`project-menu.test.tsx`、`project-menu-sunx.test.tsx`

- [ ] `ProjectMenu` 拉 `conn.sunxGroups()`，与 `/sunx/sessions` 行按 `groupId ?? 'grp_default'` 合并；群行+实例缩进+空群态。
- [ ] 群行动作：`MessagesSquare` 开群聊、`SunxIcon` 新建（预填本群）、`⋯` 改名/删除（空群）；SUNX 头新建改 `FolderPlus`。
- [ ] 折叠 localStorage；计数；旧 daemon 降级平铺。
- [ ] 测试：群树/空群/折叠/计数/动作/降级。

### Task 11: 创建弹窗群字段 + 新建群组弹窗

**Files:** `gui/src/welcome/NewSunxDialog.tsx`、`NewGroupDialog.tsx`（新）、`NewSunxDialog.test.tsx`、`project-menu.test.tsx`

- [ ] 群字段下拉（搜索+行内新建）复用工作目录弹层交互；创建带 `groupId`；编辑换群。
- [ ] 新建群组弹窗（SUNX 头）。
- [ ] 测试：筛选/新建/预填/编辑换群/失败降级。

### Task 12: App 群聊状态 + 覆盖层 + `[|]` 查询图标

**Files:** `gui/src/App.tsx`、`gui/src/use-app-tabs.ts`、`gui/src/app-shell-panes.tsx`、`gui/src/window-shell.tsx`、`gui/src/pages/group/GroupChatPage.tsx`（壳）

- [ ] `groupChatId` 状态/open/close；群行 toggle。
- [ ] 群聊层渲染；右侧 `aside.sx-sidebar` 不渲染；左侧菜单保留。
- [ ] `WindowControls` 群聊态显示 `Search` 图标；点击开查询侧栏。
- [ ] 群主归因 `kind:'group'` → `openGroupChat`；工具行群目标 → `openGroupChat`。
- [ ] 测试：层/无右栏/查询图标/打开关闭/归因。

---

## P2 群聊页

### Task 13: 页面骨架 + 顶栏 + 群成员弹窗 + 新建 SUNX

**Files:** `gui/src/pages/group/GroupChatPage.tsx`、`group-header.tsx`、`group-members-dialog.tsx`、`app.css`

- [ ] 顶栏群名+`⋯` 四项；编辑群名/复制群主 ID/群成员/新建 SUNX。
- [ ] 群成员弹窗：列表（名称/状态/root/runs/steps/时间）+ 点击跳转 + 复制 id；固定高滚动。
- [ ] 新建 SUNX 弹窗预填本群；成功后重拉成员/侧栏。
- [ ] 测试：四项菜单/无文件打开方式/成员弹窗/新 Sunx 预填。

### Task 14: 房间 hook（轮询/游标/滚动）

**Files:** `gui/src/pages/group/use-group-room.ts`、`group-message-list.tsx`

- [ ] 初次最近 200；`after=cursor` 1.5s；聚焦/发送后刷新；`clientMsgId` 去重；新消息胶囊；加载更早。
- [ ] 测试：增量/去重/滚动/重置。

### Task 15: 右侧气泡 + 环形饼图回执 + 两栏弹窗

**Files:** `gui/src/pages/group/group-right-bubble.tsx`、`group-receipt.tsx`、`group-delivery-pop.tsx`

- [ ] @ chips；环形饼图（成功占比；全成=√；0=失败色；tooltip k/N）。
- [ ] 两栏弹窗（左已接收/右未接收，固定高 260、各自滚动；成员名跳转）。
- [ ] 测试：饼图状态/两栏/跳转/空 target 无饼图。

### Task 16: 左侧气泡（上方发送行/单卡片/首行引用/展开）

**Files:** `gui/src/pages/group/group-left-bubble.tsx`

- [ ] 上方 `SunxIcon A 发送给 SunxIcon B`（目标群主+徽标；点名跳转）。
- [ ] 单卡片 480px 折叠；底部「展开全部」；第一行引用单行省略无发送者、点击滚到 seq；正文 md；命令 pre-wrap + 徽标；时间/复制。
- [ ] 测试。

### Task 17: Composer（@/命令/引用/发送）

**Files:** `gui/src/pages/group/group-composer.tsx`、`group-mention-palette.tsx`、`group-command-palette.tsx`

- [ ] @ 多选/@all（无上限）、面板过滤、token 映射；`/` 全部 COMMAND_SUPPORT + 破坏件「仅单个」徽标；@all/多破坏件阻断、单目标放行；引用 chip；Enter/Shift+Enter；room-only 提示；乐观/失败保留草稿。
- [ ] 无文件/图片/技能/子智能体/团队/模型/审批/上下文/终端。
- [ ] 测试。

### Task 18: 查询侧栏

**Files:** `gui/src/pages/group/group-search-sidebar.tsx`、`use-group-search.ts`

- [ ] 右侧占宽侧栏；第一行查询图标；输入+查询按钮；结果发送人/日期/命中高亮；点击按 seq 滚到消息；侧栏保持打开；空/无结果/错误。
- [ ] 测试。

### Task 19: 归因/工具行/Jumps

**Files:** `gui/src/pages/chat/EntryViews.tsx`、`ToolEntry.tsx`、`tool-entry-body.tsx`、`tool-entry-data.ts`、`App.tsx`、`use-app-tabs.ts`

- [ ] 群主归因（`kind:'group'`）蓝名点开群聊页；前缀/hint 同剥。
- [ ] `send_sunx_messages` 群目标工具行蓝名开群聊页；展开「群: 名 (id)」。
- [ ] 房间跳转：发送者 runSeq/目标 text；引用 seq；成员/回执/查询。
- [ ] 测试。

---

## P3 收尾

### Task 20: 未读/重试/总览页群标签/spec 回写/全量门

- [ ] 群行未读圆点（lastMessageAt + seen）、回执失败重试（可选）、总览页群名标签（可选）。
- [ ] 更新 spec 状态/实施实况；全量 `npm test` + `npx vitest run`；icon-min/英文/主题门禁。
- [ ] 部署验证（src 变更 reinstall；纯 GUI deploy）。

---

## Self-Review

- Spec coverage: 群存储/默认群（Task 1）、groupId/换群（2）、作用域/群目标（3）、房间/搜索（4）、群发送/回执/破坏件单目标（5）、命令（6）、路由（7）、kind（8）、侧栏（9-10）、弹窗（11）、层/查询图标（12）、群聊页（13-18）、归因跳转（19）、收尾（20）。
- 关键契约：`DEFAULT_GROUP_ID`、`SunxGroupRecord`、`SunxRoomMessage.seq/cursor`、`sendGroupMessage`、`GROUP_COMMAND_SINGLE_ONLY`、`SunxPeerInfo.kind`、`groupChatId`、`GroupDeliveryPop`。
- 无占位符/TBD；所有任务有测试与运行命令；提交只 stage 自己的文件。
