# GUI 性能优化二期+三期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主包 9.4MB→<1.5MB（分包）、切屏零重建（keep-alive）、进会话尾窗 600 条秒开 + 后台自动补全历史 + chatMem 60min TTL。

**Architecture:** 三条正交线。三期传输面：daemon snapshot 端点加 `tail/before/limit` 分页参数（seq 天然游标）并在分页响应剥 `result.full`；GUI attach 只种尾窗，后台串行取页经 `prependSeed` 头部插入（流式尾部无扰）。二期打包面：registry 拆「同步元数据 + lazy 标签体」两层 + vite manualChunks；keep-alive 用自研 Freeze（Suspense 搁置语义）+ LRU-4。

**Tech Stack:** Node http（无框架路由）、React 18 + vite 5、vitest + node:test。

**Spec:** `docs/superpowers/specs/2026-10-26-gui-performance-phase2-3-design.md`（本计划从该 spec 论证，执行者两份都读）

## Global Constraints

- 无分页参数的 snapshot 调用行为逐字节不变（daemon.contract.test 钉住）；
- journal 落盘形态不动；`result.full` 裁剪只发生在快照序列化出口，TUI 读取面不动；
- prepend 不得扰动 openRun/openSeg 游标与尾部渲染；structureVersion 在头部插入时递增；
- 分页参数校验：tail/before/limit 为正整数，limit ≤ 2000；tail 与 before 互斥（同给 400）；
- 一期/二轮红线：映射缓存、组级 memo、帧隔离、content-visibility、30ms 合批全不回归；
- 每批独立可回滚、全量门禁（`pnpm test` + `pnpm --dir gui run test` + typecheck）过后才提交。

---

### Task 1: daemon — SessionSnapshot 分页形态与 stripFull

**Files:**
- Modify: `src/serve/session.ts:59`（SessionSnapshot 接口）与 `src/serve/session.ts:1141`（snapshotResponse）
- Test: `src/serve/session.test.ts`（追加用例）

**Interfaces:**
- Produces: `snapshotResponse(page?: { tail?: number; before?: number; limit?: number }): SessionSnapshot`；`SessionSnapshot` 增可选字段 `total?: number; oldestSeq?: number; hasMore?: boolean`（分页响应才带）。

- [ ] **Step 1: 写失败测试**（session.test.ts 追加；测试直接构造 sessionRuntime 或沿用文件内既有 session 构造夹具——先看文件内现有 snapshot 用例怎么拿 session，复用同款夹具）

```ts
test('⓿ snapshot 分页:tail 取尾窗+total/oldestSeq/hasMore+剥 full;无参行为不变', () => {
  // 夹具:种子 5 条(seq 1..5,奇数条带 result.full);直接调 runtime.snapshotResponse
  const rt = /* 沿用本文件既有 session runtime 夹具 */;
  const full = rt.snapshotResponse();
  assert.equal(full.messages.length, 5);
  assert.ok((full.messages[0] as { result?: { full?: string } }).result?.full !== undefined, '无参:full 保留(逐字节不变)');

  const tail = rt.snapshotResponse({ tail: 3 });
  assert.equal(tail.messages.length, 3);
  assert.equal(tail.total, 5);
  assert.equal(tail.oldestSeq, tail.messages[0]!.seq);
  assert.equal(tail.hasMore, true);
  assert.equal((tail.messages[0] as { result?: { full?: string } }).result?.full, undefined, '分页:full 剥离');
  assert.equal(tail.messages[2]!.seq, 5, '尾窗取最新');
});

test('⓿b snapshot 分页:before 游标+hasMore 收口', () => {
  const rt = /* 同上夹具 */;
  const page = rt.snapshotResponse({ before: 3, limit: 2 }); // seq<3 取 2 条 → seq 1,2
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0]!.seq, 1);
  assert.equal(page.messages[1]!.seq, 2);
  assert.equal(page.hasMore, false, '头部到底');
  assert.equal(page.total, 5);
  const page2 = rt.snapshotResponse({ before: 4, limit: 2 }); // seq 2,3
  assert.equal(page2.hasMore, true);
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test dist/serve/session.test.js`（先 `npx tsc -p tsconfig.json`）——Expected: FAIL（snapshotResponse 不接受分页参数/TS 编译错）

- [ ] **Step 3: 实现**（session.ts）

```ts
export interface SessionSnapshotPage {
  tail?: number;
  before?: number;
  limit?: number;
}

// SessionSnapshot 接口追加(可选,分页响应才带):
//   total?: number;
//   oldestSeq?: number;
//   hasMore?: boolean;

snapshotResponse(page?: SessionSnapshotPage): SessionSnapshot {
  const full = this.kernel.replay();
  let messages = full;
  let total: number | undefined;
  let oldestSeq: number | undefined;
  let hasMore: boolean | undefined;
  if (page !== undefined && (page.tail !== undefined || page.before !== undefined)) {
    total = full.length;
    const limit = Math.min(Math.max(page.limit ?? 600, 1), 2000);
    if (page.before !== undefined) {
      const idx = full.findIndex((m) => m.seq >= page.before!);
      const head = idx < 0 ? full : full.slice(0, idx); // seq < before 的全部
      const start = Math.max(0, head.length - limit);
      messages = head.slice(start);
      hasMore = start > 0;
      oldestSeq = messages.length > 0 ? messages[0]!.seq : undefined;
    } else {
      const start = Math.max(0, full.length - page.tail!);
      messages = full.slice(start);
      hasMore = start > 0;
      oldestSeq = messages.length > 0 ? messages[0]!.seq : undefined;
    }
    // 载荷瘦身:分页响应剥 result.full(全量观测按需另拉,§4.5)
    messages = messages.map((m) =>
      m.result?.full === undefined ? m : { ...m, result: { ...m.result, full: undefined } },
    );
  }
  return {
    ...(messages === full ? {} : { messages }),
    // ↑ 分页时覆盖 messages;无参保持 full 原数组引用(逐字节不变)
    messages: undefined as never, // 占位防 TS——实际实现见下方修正说明
    ...
  };
}
```

**修正说明（实现时照此写，上面块示意分页分支）**：实现保持原返回对象逐字段不动，仅 `messages` 字段在分页模式下替换为裁剪后的数组，并追加 `...(total !== undefined ? { total, oldestSeq, hasMore } : {})`。无参（page undefined）路径必须返回与改动前完全一致的对象形态。

- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 — Expected: PASS（本文件全部既有用例不回归）

- [ ] **Step 5: Commit** — `git add src/serve/session.ts src/serve/session.test.ts && git commit -m "feat(serve): snapshot 分页形态 tail/before/limit+载荷瘦身"`

### Task 2: daemon — 路由接分页参数 + 契约测试

**Files:**
- Modify: `src/serve/daemon.ts:654`（`/session/:id/snapshot` 路由）与 `:845`（legacy `/snapshot`）、`src/serve/daemon.ts:1387`（handleSnapshot）
- Test: `src/serve/daemon.contract.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `snapshotResponse(page?)`。
- Produces: HTTP 层 `?tail=&before=&limit=` 查询参数；校验失败 400 `{error}`。

- [ ] **Step 1: 写失败契约测试**（daemon.contract.test.ts 追加；复用文件内既有「起 daemon+建会话+HTTP GET」夹具）

```ts
test('snapshot 分页参数:tail=2 只回 2 条带 total/hasMore;tail+before 同给 400;非法 limit 400', async () => {
  // 夹具:s1 会话种子 ≥3 条(沿本文件既有 helper)
  const r1 = await getJson(`/session/${s1}/snapshot?tail=2`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.messages.length, 2);
  assert.ok(typeof r1.body.total === 'number' && r1.body.total >= 3);
  assert.equal(r1.body.hasMore, true);
  const r2 = await getJson(`/session/${s1}/snapshot?tail=2&before=3`);
  assert.equal(r2.status, 400);
  const r3 = await getJson(`/session/${s1}/snapshot?tail=abc`);
  assert.equal(r3.status, 400);
  const r4 = await getJson(`/session/${s1}/snapshot`); // 无参:行为不变
  assert.equal(r4.status, 200);
  assert.ok(Array.isArray(r4.body.messages));
  assert.equal(r4.body.total, undefined);
});
```

- [ ] **Step 2: 跑确认失败** — `node --test dist/serve/daemon.contract.test.js` — Expected: FAIL

- [ ] **Step 3: 实现**（daemon.ts）

```ts
// :654 与 :845 两条路由同改:
{ method: 'GET', path: '/session/:id/snapshot', auth: true, run: async (req, res, p) => this.handleSnapshot(req, res, p.id) },

// handleSnapshot 签名加 req;解析查询参数:
private handleSnapshot(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): void {
  const q = urlOf(req).searchParams;
  const num = (k: string): number | undefined => {
    const v = q.get(k);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : NaN; // NaN=非法
  };
  const tail = num('tail');
  const before = num('before');
  const limit = num('limit');
  if (Number.isNaN(tail) || Number.isNaN(before) || Number.isNaN(limit) || (tail !== undefined && before !== undefined)) {
    return this.send(res, 400, { error: 'invalid snapshot paging params' });
  }
  const session = id === undefined ? undefined : /* 既有 sessionFor 面 */;
  if (id !== undefined && session === undefined) return; // 既有 unknown-session 语义不动
  const snap = (session ?? /* legacy 无 id 面 */ this.legacySnapshotSource()).snapshotResponse(
    tail !== undefined || before !== undefined ? { tail, before, limit } : undefined,
  );
  this.send(res, 200, { ...snap, pending: session?.pendingSnapshot() });
}
```

（实现时按文件内既有 handleSnapshot 体逐行改——只加参数解析与分页透传，其余 pending/board/team 字段照旧。）

- [ ] **Step 4: 跑测试通过 + 全 daemon 契约回归** — `node --test dist/serve/daemon.contract.test.js dist/serve/daemon.test.js` — Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(serve): snapshot 路由分页参数+契约测试"`

### Task 3: gui — connection 分页透传 + 类型

**Files:**
- Modify: `gui/src/connection-types.ts:91`（SnapshotResponse 增 total/oldestSeq/hasMore 可选）、`gui/src/connection.ts:138/275`（sessionSnapshot 带 page 参数）

**Interfaces:**
- Produces: `sessionSnapshot(id: string, page?: { tail?: number; before?: number; limit?: number })`。

- [ ] **Step 1: 类型与实现**（无独立测试——由 Task 4/5 的 mount 夹具覆盖）

```ts
// connection-types.ts SnapshotResponse 追加:
  /** 2026-10-26 三期分页:tail/before 模式响应才带(无参全量缺省) */
  total?: number;
  oldestSeq?: number;
  hasMore?: boolean;

// connection.ts:
sessionSnapshot(id: string, page?: { tail?: number; before?: number; limit?: number }): Promise<SnapshotResponse & { lastSeq: number }>;
// fetchSessionSnapshot(id, page?): getJson(`...snapshot` + 分页 query 串(有 page 才拼));gen 抬高逻辑不变
```

- [ ] **Step 2: typecheck** — `npx tsc -p tsconfig.json --noEmit` — Expected: PASS

- [ ] **Step 3: Commit** — `git commit -m "feat(gui): snapshot 分页透传+类型"`

### Task 4: gui — chat-reducer prependSeed + ChatState.history

**Files:**
- Modify: `gui/src/chat-reducer.ts`
- Test: `gui/src/chat-reducer.test.ts`（追加）

**Interfaces:**
- Produces:
  - `prependSeed(s: ChatState, entries: ReadonlyArray<SnapshotTranscriptEntry>, meta: { oldestSeq: number; hasMore: boolean }): ChatState`（头部插入 + 更新 history meta；空页原样返回）；
  - `ChatState.history?: { total: number; oldestSeq: number; hasMore: boolean; complete: boolean; failed?: boolean }`。

- [ ] **Step 1: 写失败测试**（chat-reducer.test.ts 追加）

```ts
test('prependSeed:头部插入不扰尾部游标;hasMore=false 置 complete;空页原样返回', () => {
  let s = seedChatFromSnapshot(
    [{ seq: 10, ts: 1, kind: 'user', md: '新' }, { seq: 11, ts: 2, kind: 'assistant', md: '答' }],
    { openRun: -1, openSeg: -1 },
  );
  s = { ...s, history: { total: 20, oldestSeq: 10, hasMore: true, complete: false } };
  const before = s.entries;
  const out = prependSeed(
    s,
    [{ seq: 8, ts: 0, kind: 'user', md: '老1' }, { seq: 9, ts: 0, kind: 'user', md: '老2' }] as never,
    { oldestSeq: 8, hasMore: false },
  );
  assert.equal(out.entries.length, before.length + 2);
  assert.equal(out.entries[0]!.md, '老1');
  assert.equal(out.entries[2]!.md, '新');
  assert.deepEqual(out.entries.slice(-2).map((e) => e.md), ['新', '答']); // 尾部无扰
  assert.equal(out.history?.complete, true);
  assert.ok(out.structureVersion > s.structureVersion);
  const same = prependSeed(out, [], { oldestSeq: 8, hasMore: false });
  assert.equal(same, out); // 空页原样返回(引用相等)
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/chat-reducer.test.ts` — Expected: FAIL（prependSeed 未导出）

- [ ] **Step 3: 实现**（chat-reducer.ts；复用 applySeed——以 currentKernelState 为基 prepend 条目（seq 均小于现存最旧），种后**尾部游标重置回原值**）

```ts
export function prependSeed(
  s: ChatState,
  entries: ReadonlyArray<SnapshotTranscriptEntry>,
  meta: { oldestSeq: number; hasMore: boolean },
): ChatState {
  if (entries.length === 0) {
    return { ...s, history: { ...meta, complete: !meta.hasMore, failed: false } };
  }
  const { openRun, openSeg } = s.k;
  const k = applySeed(s.k, entries as unknown as ReadonlyArray<KernelEntry & { seq?: number }>);
  const restored: KernelState = { ...k, openRun, openSeg }; // 游标钉回:prepend 不改流式态
  const next: ChatState = {
    ...applySubagentChatEvent({ ...s, k: restored }, { type: 'route' } as never), // 走既有映射面(k 变更→重映射)
    history: { ...meta, complete: !meta.hasMore, failed: false },
  };
  return next;
}
```

（实现说明：`applySubagentChatEvent({type:'route'})` 是借道——route 事件零条目变更只触发重映射；若读代码后认为借道晦涩，可直接展开为 `applyChatEvent` 同款映射三行。ChatState 接口加 `history?: {...}` 字段。）

- [ ] **Step 4: 跑测试通过 + reducer 全量回归** — Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(gui): prependSeed 头部补史归约+history 元数据"`

### Task 5: gui — attach 尾窗播种 + 后台自动补全链

**Files:**
- Modify: `gui/src/pages/chat/use-session-events.ts`（reseed 用 tail=600；新增加载链 effect）
- Test: `gui/src/e2e.test.ts` 或新增 `gui/src/history-backfill.test.tsx`（Connection 桩可控分页应答）

**Interfaces:**
- Consumes: Task 3 sessionSnapshot(page)、Task 4 prependSeed。
- Produces: ChatState.history（MessageList/指示器消费）。

- [ ] **Step 1: reseed 切尾窗**（use-session-events reseed 内）

```ts
const snap = await conn.sessionSnapshot(sessionId, { tail: 600 });
// 后续 seeding 流程不变(seedChatFromSnapshot(snap.messages,...));
// 播种后写 history 元数据:
next = { ...next, history: snap.hasMore === true ? { total: snap.total ?? next.entries.length, oldestSeq: snap.oldestSeq ?? 0, hasMore: true, complete: false } : undefined };
```

- [ ] **Step 2: 后台加载链 effect**（use-session-events 返回前新增；依赖 conn/sessionId + chat.history 消费）

```ts
useEffect(() => {
  const h = chat.history;
  if (h === undefined || !h.hasMore || h.complete || h.failed === true) return;
  if (sessionId !== currentSessionRef.current) return; // 非当前会话不跑(切走暂停)
  let alive = true;
  let retries = 0;
  const step = async (): Promise<void> => {
    while (alive) {
      const cur = /* 读最新 history(ref) */;
      if (cur === undefined || !cur.hasMore || cur.complete) return;
      try {
        const page = await conn.sessionSnapshot(sessionId, { before: cur.oldestSeq, limit: 600 });
        if (!alive) return;
        setChat((c) => prependSeed(c, page.messages, { oldestSeq: page.oldestSeq ?? cur.oldestSeq, hasMore: page.hasMore === true }));
        retries = 0;
      } catch {
        retries += 1;
        if (retries >= 3) {
          if (alive) setChat((c) => ({ ...c, history: c.history ? { ...c.history, failed: true } : c.history }));
          return; // 停链,用户点重试(重置 failed)或下次 reseed 重启
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (retries - 1)));
      }
      await new Promise((r) => requestAnimationFrame(() => r())); // 页间让一帧
    }
  };
  void step();
  return () => { alive = false; };
}, [chat.history?.hasMore, chat.history?.complete, chat.history?.failed, chat.history?.oldestSeq, conn, sessionId]);
```

（currentSessionRef 由 Chat 持有 sessionId ref；实现时把加载链放进 Chat 域或经 deps 注入 ref。）

- [ ] **Step 3: 指示器与失败面**（Chat.tsx dock 上方内联行）

```tsx
{chat.history !== undefined && chat.history.hasMore && !chat.history.complete && (
  <div className="chat-history-loading" role="status">
    {chat.history.failed === true ? (
      <button type="button" onClick={() => setChat((c) => ({ ...c, history: c.history ? { ...c.history, failed: false } : c.history }))}>
        {t('Older history failed to load — retry', '更早的会话加载失败——重试')}
      </button>
    ) : (
      t('Loading earlier history…', '正在加载更早的会话…')
    )}
  </div>
)}
```
CSS: `.chat-history-loading { padding: 4px 12px; font-size: 12px; color: var(--fg-tertiary); }`。

- [ ] **Step 4: 测试**（history-backfill.test.tsx：Connection 桩按 before 返回两页后 hasMore=false；断言 entries 头部递增补齐、切会话（gen 失配）在途页丢弃、失败三 retreat 后 failed=true 且点重试重启链）

- [ ] **Step 5: 全量回归 + Commit** — `git commit -m "feat(gui): 尾窗秒开+后台自动分段补全历史链"`

### Task 6: gui — chatMem 60min TTL

**Files:**
- Modify: `gui/src/use-agent-projections.ts`（chatMem 桶加 lastTouch + 60s 周期清理）
- Test: 追加 `gui/src/use-agent-projections.test.ts*`（若无可挂 App.test;用 vi.useFakeTimers）

**Interfaces:**
- Consumes: 既有 chatMem（CHAT_MEM_LRU_MAX=4）。
- Produces: TTL=60min 剔除（runningIds 命中豁免——豁免名单经参数注入 `isRunning: (key: string) => boolean`）。

- [ ] **Step 1: 写失败测试**

```ts
it('chatMem TTL:60min 未触踢,运行中豁免,触碰续期', () => {
  vi.useFakeTimers();
  // put 3 桶 → 快进 61min → get(A)(运行中) 保留,B/C 被清;重新 put(B) 后快进,B 不被清
});
```

- [ ] **Step 2: 跑失败 → Step 3: 实现**（chatMem put/get 记 lastTouch=Date.now()；setInterval 60s 清理 lastTouch 超 3_600_000 且非 running 的桶——running 名单经 hook 参数注入，App 传 runningIds has 检查）→ **Step 4: 通过** → **Step 5: Commit**

### Task 7: gui — vite manualChunks

**Files:**
- Modify: `gui/vite.config.ts`

- [ ] **Step 1: 配置**

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'monaco': ['monaco-editor', '@monaco-editor/react'],
        'xterm': ['@xterm/xterm', '@xterm/addon-fit'],
        'hljs': ['highlight.js'],
      },
    },
  },
},
```

- [ ] **Step 2: 构建复核** — `npx vite build` — Expected: 主包显著下降（monaco/xterm/hljs 出主包），chunk 独立存在
- [ ] **Step 3: 全量回归（分包不改行为——既有测试全绿）+ Commit**

### Task 8: gui — registry 拆层 lazy + Suspense 骨架

**Files:**
- Modify: `gui/src/tabs/registry.tsx`、`gui/src/App.tsx`（tabbody 调用点）
- Create: `gui/src/tabs/TabSkeleton.tsx`

**Interfaces:**
- Produces: `TAB_REGISTRY` 元数据同步不变;`render` 返回 `React.lazy` 组件;调用点 `<Suspense fallback={<TabSkeleton />}>`。

- [ ] **Step 1: registry 拆层**——文件顶 `import { Files } ...` 全部改 `const Files = lazy(() => import('../pages/Files'));` 形态（九个标签体逐一）；`webPageName/normalizeWebUrl` 等纯函数导出改从 WebTab 拆出的 `tab-meta.ts`（防 lazy 依赖倒挂——WebTab 也 lazy 化后这些纯函数仍需同步可用）。
- [ ] **Step 2: TabSkeleton.tsx**（标题行+shimmer 三行,样式类 sx-tab-skeleton 复用 shimmer 既有 keyframes 或新增）
- [ ] **Step 3: App.tsx tabbody 包 Suspense**——`{tabEntry(...).render({...})}` 外包 `<Suspense fallback={<TabSkeleton />}>`。
- [ ] **Step 4: 构建复核**（主包进一步下降）+ 全量回归（jsdom lazy 组件测试——既有 tab 测试若因 lazy 异步挂载需 `await screen.findBy*`,逐个修）+ Commit

### Task 9: gui — monaco-setup 异步工厂

**Files:**
- Modify: `gui/src/monaco-setup.ts`、`gui/src/diff-panel.tsx`、`gui/src/pages/Files.tsx`

- [ ] **Step 1: monaco-setup 改异步**——`loader.config({ monaco })` 与 worker import 移入 `ensureMonaco(): Promise<void>`（模块内单例 Promise）;diff-panel/Files 挂载 effect `void ensureMonaco()` 后再渲 DiffEditor（@monaco-editor/react 的 loader 本就异步,仅确保 config 先行）。
- [ ] **Step 2: 回归 diff/files 测试 + Commit**

### Task 10: gui — Freeze keep-alive + LRU

**Files:**
- Create: `gui/src/tabs/Freeze.tsx`
- Modify: `gui/src/App.tsx`（tabbody 挂载反转 + LRU）
- Test: `gui/src/tabs/freeze.test.tsx`（冻结面:隐藏不重渲、恢复保状态）

**Interfaces:**
- Produces: `Freeze({ frozen, children })`;App 级 `keepAliveOrder` LRU-4。

- [ ] **Step 1: Freeze 失败测试**

```tsx
it('frozen=true 时子树 setState 不触发 DOM 更新;恢复后状态保留', async () => {
  // 计数器组件:按钮 setState;包 Freeze frozen → 点击后 DOM 数字不变;
  // frozen=false → 数字跳到最新(状态没丢)
});
```

- [ ] **Step 2: 实现**

```tsx
import { Suspense, unstable_SuspenseList as _unused } from 'react'; // 仅类型面;实现如下
// Freeze:借助「已显示过内容的 Suspense 在 promise 搁置期不提交更新」语义
function Freeze({ frozen, children }: { frozen: boolean; children: ReactNode }): JSX.Element {
  return <Suspense fallback={children}><FreezeFrame freeze={frozen}>{children}</FreezeFrame></Suspense>;
}
// FreezeFrame:freeze=true 时抛出一个恒 pending 的 thenable(捕获于上层 Suspense→更新搁置);
// freeze=false 正常返回 children。参考 react-freeze 同实现(~20 行)。
```

（实现照 react-freeze 源码形态:内部组件在 freeze 翻转时抛 `{ then() {} }` 且用 useState 记忆已抛防死循环。）

- [ ] **Step 3: App tabbody 反转 + LRU-4**——`openTabs.map` 全量挂载（活动=正常,非活动=wrapper `display:none+inert` + Freeze frozen）;重标签 LRU ref（terminal/file/diff/taskboard/directory 计重,超 4 卸最久——卸载即从 tabStates 移除+pty kill 沿关标签路径）;`key` 不再触发重挂（key 恒 uid）。
- [ ] **Step 4: 回归（tab 全家测试+e2e pty）+ Commit**

### Task 11: gui — 预热 + 微优化

**Files:**
- Modify: `gui/src/App.tsx`（idle 预取）、`gui/src/tabs/TabStrip.tsx`（hover 预取）、`gui/src/pages/Files.tsx`（LRU）、`gui/src/tabs/DirectoryTab.tsx`（模块级展开集）、`gui/src/tabs/TaskBoardTab.tsx`（agentOf useCallback）

- [ ] **Step 1: 预热**——App 挂载后 `requestIdleCallback(() => { void import('../pages/Files'); void import('../tabs/TerminalTab'); })`（降级 setTimeout 2s）;TabStrip「+」菜单项 onMouseEnter 预载对应 chunk（id→import 映射表）。
- [ ] **Step 2: Files 内容 LRU**（Map<path+mtime, content> cap 8,模块级）。
- [ ] **Step 3: DirectoryTab expanded 集合提模块级**（Record<sessionId, Set<string>>）。
- [ ] **Step 4: TaskBoardTab agentOf useCallback**。
- [ ] **Step 5: 全量回归 + 主包体积复核（<1.5MB 断言手工复核,超了按 spec §5.1 例外口降 hljs）+ Commit**

### Task 12: 终验 + 部署

- [ ] 全量门禁（`pnpm test` + `pnpm --dir gui run test` + typecheck）
- [ ] `npx vite build` 产物体积记录（主包 <1.5MB）
- [ ] 部署 `D:\MyWorkSoftware\Sunshinex`（既定流程:taskkill → dist-gui 覆盖 → 重启 → healthz）
