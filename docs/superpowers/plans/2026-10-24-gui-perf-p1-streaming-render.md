# GUI P1 流式渲染链快赢实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除流式生成时的逐帧全量重渲染——memo 补齐 + 派生冻结 + 滚动收敛 + WS 合帧 + App 级节流，使 token 突发期间除尾行外可见行零重渲染。

**Architecture:** 四个正交面：①chat-reducer 增 `structureVersion`（成员变更计数）作派生 memo key；②MessageList 回调稳定化 + ToolEntryView/ToolSegBlock memo 化（行壳每帧重建、memo 视图 bail-out，**不做整树 useMemo**——尾条目 key 恒定身份变，整树缓存会冻结流式文本）；③daemon 泵出口 30ms 合帧（`?batch=1` 握手门控，老客户端逐字节不变）+ 客户端 batch 解包（React 18 自动批处理天然合一次 setState）；④App 级后台帧 100ms trailing 节流（水合回放路径旁路）。

**Tech Stack:** TypeScript strict + React 18（自动批处理）+ ws（daemon）+ vitest（gui/ 主仓两套）。

**Spec:** docs/superpowers/specs/2026-10-24-gui-performance-optimization-design.md §3（P1 快赢）

## Global Constraints

- TS strict 零报错；注释沿用仓库中文惯例；禁止新增 npm 依赖
- WS 协议向后兼容：未声明 `?batch=1` 的客户端行为逐字节不变（daemon.contract.test.ts 为锚）
- 提示词面零接触（§11 前缀缓存不变量）；`data/` 落盘形态不动
- 既有优化不回归：WeakMap 视图缓存、五视图组件 memo、流式 markdown 块缓冲、mermaid 缓存
- `runFooterMapOf` 明确**不在**冻结范围：open run 的 footer 条目引用随尾条目每帧变化，冻结即改变渲染时机语义
- 每任务收尾门禁：`pnpm --dir gui run typecheck` + 相关测试文件全绿

## Review Focus

- **重连丢帧**：batch=1 客户端重连后 512 帧缓冲补发必须完整到达（合批不丢帧）→ Task 6 步 5 用例
- **混合客户端**：batch=1 与老客户端同时在线，老客户端不受影响 → Task 6 步 5 用例
- **挂起帧时序**：approval/ask/plan-approval 帧无 seq，不进合批窗、立即送达 → Task 6 步 5 用例
- **重播种子（reseed）条目变少**：structureVersion 必须递增，否则派生冻结在旧成员集上 → Task 1 步 1 用例
- **流式中折叠/展开**：hiddenKeys 变更帧与 token 帧交错时行属性不陈旧 → Task 3 步 1 用例

---

### Task 1: chat-reducer structureVersion

**Files:**
- Modify: `gui/src/chat-reducer.ts`（ChatState 接口 ：76-99 区域、applyChatEvent :184、seedChatFromSnapshot :167-179）
- Test: `gui/src/chat-reducer.test.ts`

**Interfaces:**
- Consumes: 既有 `applyChatEvent(s, e)`、`seedChatFromSnapshot(messages, cursors)`
- Produces: `ChatState.structureVersion: number`——单调递增；仅在条目成员集变化（增/删/重播）时 +1，纯内容帧（token/thinking delta、状态翻转）恒定。后续 Task 2/3 以它为 memo key。

- [ ] **Step 1: Write the failing test**（chat-reducer.test.ts 追加）

```ts
it('structureVersion: 纯内容帧不递增,成员帧递增,种子重置为 1', () => {
  let s = seedChatFromSnapshot([], { openRun: -1, openSeg: -1 });
  expect(s.structureVersion).toBe(1);
  s = applyChatEvent(s, { type: 'model-start' } as SessionEvent);   // run 条入列
  const svRun = s.structureVersion;
  expect(svRun).toBe(2);
  for (let i = 0; i < 5; i++) s = applyChatEvent(s, { type: 'token', text: 'x' } as SessionEvent);
  expect(s.structureVersion).toBe(svRun);                            // token burst 不递增
  s = applyChatEvent(s, { type: 'tool-result', /* ...最小合法载荷 */ } as SessionEvent);
  expect(s.structureVersion).toBe(svRun + 1);
});
```

（载荷形状以测试文件内既有用例的 SessionEvent 构造为参照，照抄其辅助函数。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/chat-reducer.test.ts`
Expected: FAIL——`structureVersion` 字段不存在（TS 编译期即报）。

- [ ] **Step 3: Implement**

ChatState 接口加 `structureVersion: number`（注释：成员变更计数,派生冻结 memo key,见 P1 spec §3.3）。`seedChatFromSnapshot` 返回前置 1。`applyChatEvent` 在返回态构造处做 O(1) 成员差分：

```ts
const prevEntries = s.entries;
const structureVersion = s.structureVersion
  + (nextEntries.length !== prevEntries.length || nextEntries[0]?.key !== prevEntries[0]?.key ? 1 : 0);
```

（内核 append-only，计数差分即成员差分；空→空不算变更。编译器会强制所有 ChatState 构造点补字段。）

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run src/chat-reducer.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS + 零类型错误（其余构造点由编译器指出，逐一补默认值）。

- [ ] **Step 5: Commit**

```bash
git add gui/src/chat-reducer.ts gui/src/chat-reducer.test.ts
git commit -m "perf(gui): chat-reducer 增 structureVersion 成员变更计数"
```

### Task 2: 派生计算冻结

**Files:**
- Modify: `gui/src/pages/chat/use-chat-derived.ts:70,75-101,107-113`（三个 useMemo 的依赖数组）
- Modify: `gui/src/pages/chat/use-chat-fold.ts:110`（hiddenKeys 依赖）
- Modify: `gui/src/pages/chat/MessageList.tsx:111-113`（groupEntriesByDay 包 useMemo）
- Test: 既有套件回归（依赖 Task 1 的 `chat.structureVersion`）

**Interfaces:**
- Consumes: `ChatState.structureVersion`（Task 1）
- Produces: `taskNameOf` / `todoBatches` / `turnGoal` / `hiddenKeys` 在纯内容帧引用身份恒定——Task 3 的稳定回调与 render-count 测试依赖此前提。

- [ ] **Step 1: 替换依赖数组**（纯依赖换血,逻辑零改动）

- use-chat-derived.ts:70 `taskNameOf`：`[chat.entries, board]` → `[chat.structureVersion, board]`
- use-chat-derived.ts:101 `todoBatches`：`[chat.entries]` → `[chat.structureVersion]`
- use-chat-derived.ts:113 `turnGoal`：`[chat.entries]` → `[chat.structureVersion]`
- use-chat-fold.ts:110 `hiddenKeys`：`[chat.entries, collapsedRuns]` → `[chat.structureVersion, collapsedRuns]`
- use-chat-derived.ts:117 `batchSig` 的 `JSON.stringify` **保留原样**——todoBatches 冻结后它只在成员变更时重算，G14.174 去重语义零漂移
- MessageList.tsx:113 `groupEntriesByDay(visible)` 包 `useMemo`，依赖 `[structureVersion, visibleCount]`（visibleCount 即既有 `visible.length` 来源——日分组只依赖成员集与窗口大小,尾条目内容变化不影响分组）

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd gui && npx vitest run src/pages/chat/ && npx tsc -p tsconfig.json --noEmit`
Expected: 全绿（本任务是纯优化,既有断言即护栏——若有用例失败,说明误改了逻辑,回查依赖数组）。

- [ ] **Step 3: Commit**

```bash
git add gui/src/pages/chat/use-chat-derived.ts gui/src/pages/chat/use-chat-fold.ts gui/src/pages/chat/MessageList.tsx
git commit -m "perf(gui): 派生计算以 structureVersion 冻结,纯内容帧零重算"
```

### Task 3: 行级 memo 补齐 + 回调稳定化

**Files:**
- Modify: `gui/src/pages/chat/ToolEntry.tsx:141`（ToolEntryView 包 React.memo）
- Modify: `gui/src/pages/chat/ToolGroups.tsx`（ToolSegBlock 包 React.memo + 自定义比较器）
- Modify: `gui/src/pages/chat/MessageList.tsx`（函数 props 经 ref 模式稳定化）
- Test: `gui/src/pages/Chat.test.tsx`（追加 render-count 用例）

**Interfaces:**
- Consumes: Task 2 的派生身份稳定
- Produces: `ToolEntryView`/`ToolSegBlock` 为 memo 组件（导出名不变）;MessageList 传给行组件的全部回调引用恒定。AgentTranscriptTab 等既有消费面无需改动。

- [ ] **Step 1: Write the failing test**（Chat.test.tsx 追加；mock 计数器参照文件内既有 `vi.mock` + `importOriginal` 手法）

```tsx
vi.mock('./chat/ToolEntry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./chat/ToolEntry')>();
  let calls = 0;
  const Counted = memo((props: object) => { calls++; return <mod.ToolEntryView {...props} />; });
  return { ...mod, ToolEntryView: Counted, __calls: () => calls, __reset: () => { calls = 0; } };
});
it('token 突发期间已落位 tool 行零重渲染', async () => {
  // 挂 Chat:种子 2 条已完成 tool 行 + 1 条流式 assistant;__reset()
  // 逐次 act() 派发 5 个 token 事件(强制每事件一次渲染);断言 __calls() 保持 0
});
it('流式中折叠 run 后续 token 帧不击穿行 memo(交错帧)', async () => {
  // 同上场景:act 折叠一个含 tool 行的 run → act 派发 token → 断言 __calls() 仍 0
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: FAIL——`__calls()` > 0（内联闭包每帧击穿 memo）。

- [ ] **Step 3: Implement**

1. ToolEntry.tsx:141 `export function ToolEntryView(...)` → `export const ToolEntryView = memo(function ToolEntryView(...) { ... });`（props 类型原样）。
2. ToolGroups.tsx：ToolSegBlock 包 memo，比较器 `segKeysEqual`——`prev.seg.length === next.seg.length && prev.seg.every((e, i) => e.key === next.seg[i]!.key) && prev.closed === next.closed && prev.renderTool === next.renderTool && prev.renderThinking === next.renderThinking && prev.renderAssistant === next.renderAssistant`（seg 数组每帧新身份,key 序列才是真身份；closed 变化=折叠切换必须重渲）。
3. MessageList.tsx：对 `onOpenFile/onOpenDiff/onOpenAgent/onOpenTask/toggleRun/submitText/taskNameOf/callIdOf` 建 ref 镜像 + `useCallback([])` 稳定包装（ref 模式对齐 App.tsx sessionRef 手法）；`renderTool/renderThinking/renderAssistant` 改 `useCallback`，依赖仅稳定包装与 `conn/sessionId`（props 本身稳定）；renderAssistant 内 `onOpenDiff={(p) => onOpenDiff?.('', p)}` 用稳定包装。逐帧新建的闭包归零。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx src/pages/chat/ && npx tsc -p tsconfig.json --noEmit`
Expected: PASS——render-count 用例绿 + 既有套件全绿（含折叠/展开、流式光标、mermaid settle 用例）。

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/chat/ToolEntry.tsx gui/src/pages/chat/ToolGroups.tsx gui/src/pages/chat/MessageList.tsx gui/src/pages/Chat.test.tsx
git commit -m "perf(gui): ToolEntryView/ToolSegBlock memo 化 + MessageList 回调稳定化"
```

### Task 4: 贴底滚动 rAF 合并

**Files:**
- Modify: `gui/src/pages/chat/use-chat-scroll.ts:26-30`（首个无依赖 effect）
- Test: `gui/src/pages/Chat.test.tsx`（追加用例）

**Interfaces:**
- Consumes: 既有 `chatScrollRef` / `chatStickRef` / `entriesLen`
- Produces: 归底读取 `scrollHeight` 每动画帧至多一次（此前每 render 一次强制 reflow）。

- [ ] **Step 1: Write the failing test**

```tsx
it('贴底归底在 rAF 内执行且同帧多次渲染只调度一次', async () => {
  // stub requestAnimationFrame 记录调度数;挂 Chat 置 stick;
  // 同一 act() 内连派 3 个 token 事件 + 3 次独立重渲 → rAF 调度 ≤ 1 次新增;
  // 手动 flush rAF 回调后 scrollTop 被赋值
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: FAIL——现行 effect 同步读写,无 rAF 调度。

- [ ] **Step 3: Implement**

effect 体内：`rafRef`（hook 级 useRef）已有在途调度则跳过；否则 `rafRef.current = requestAnimationFrame(() => { rafRef.current = null; if (el !== null && chatStickRef.current && el.dataset.groupAnchor !== '1') el.scrollTop = el.scrollHeight; })`；cleanup `cancelAnimationFrame(rafRef.current)`。groupAnchor 钉底循环（use-chat-fold/ToolGroups）不动——它们已是 rAF 帧内操作。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gui && nvitest run src/pages/Chat.test.tsx && npx vitest run src/pages/chat/ && npx tsc -p tsconfig.json --noEmit`
Expected: PASS（含既有滚动恢复/mermaid 补归底用例）。

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/chat/use-chat-scroll.ts gui/src/pages/Chat.test.tsx
git commit -m "perf(gui): 贴底归底收进 rAF,消灭逐帧强制 reflow"
```

### Task 5: highlight.js 按需收敛

**Files:**
- Modify: `gui/src/highlight.ts:1-5`（导入面）
- Test: `gui/src/highlight.test.ts`（追加注册断言）

**Interfaces:**
- Consumes: 无
- Produces: `hljs` 为 `highlight.js/lib/common` + 显式注册 `jsx/tsx/toml`（EXT_LANG 表内语言全集可解析）——`highlightCode`/`highlightByLang` 签名不变。

- [ ] **Step 1: Write the failing test**（highlight.test.ts 追加）

```ts
it('lib/common + 显式注册:EXT_LANG 表内语言全部可解析', () => {
  for (const lang of ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'markdown', 'css', 'xml', 'python', 'rust', 'java', 'bash', 'yaml', 'toml']) {
    expect(hljs.getLanguage(lang)).toBeDefined();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/highlight.test.ts`
Expected: FAIL（改动前全量包本应通过——此用例是改后的防回归钉子；先写先绿,则 Step 3 后必须仍绿。若 Step 2 即绿属预期,直接进 Step 3,以 Step 4 的产物体积记录为验证）。

- [ ] **Step 3: Implement**

highlight.ts 头部改为：

```ts
import hljs from 'highlight.js/lib/common';
import tsx from 'highlight.js/lib/languages/tsx';
import jsx from 'highlight.js/lib/languages/jsx';
import toml from 'highlight.js/lib/languages/toml';
hljs.registerLanguage('tsx', tsx);
hljs.registerLanguage('jsx', jsx);
hljs.registerLanguage('toml', toml);
```

同步更新 ：2-4 的注释（全量包 → common 子集 + 显式补注册,表完整性由测试钉住）。

- [ ] **Step 4: Run tests + 产物体积记录**

Run: `cd gui && npx vitest run src/highlight.test.ts && pnpm run build && ls -l ../dist-gui/assets/index-*.js`
Expected: 测试 PASS；index chunk 较 9.9MB 基线显著下降（hljs 全量约 1MB+,common 约 200KB；Monaco/xterm 仍在,总体降幅在 Task 6-7 于 P2 落地——此处记录数值即可,不做硬断言）。

- [ ] **Step 5: Commit**

```bash
git add gui/src/highlight.ts gui/src/highlight.test.ts
git commit -m "perf(gui): highlight.js 收敛 lib/common + 显式注册 jsx/tsx/toml"
```

### Task 6: daemon 泵合帧（batch=1 门控）

**Files:**
- Modify: `src/serve/daemon-wire.ts`（新增 batch 帧类型）
- Modify: `src/serve/daemon.ts:415-438`（attachWs 读 query）、`daemon.ts:379-383`（broadcastFrame 分路）、`onWsConnection` 与 wsClients 记账、close 清理
- Test: `src/serve/daemon.ws.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `EventFrame`、`broadcastFrame(frame: DaemonFrame)`、`this.wsClients`、`onWsConnection(ws)` 与补发循环
- Produces: `WsBatchFrame = { kind: 'batch'; frames: EventFrame[] }`（登记进 DaemonFrame 并集,src/types.ts 同步）——Task 7 客户端解包消费。30ms 合批窗常量 `BATCH_FLUSH_MS = 30`。

- [ ] **Step 1: Write the failing test**（daemon.ws.test.ts 追加三例）

```ts
it('batch=1 客户端:30ms 窗内连发 3 事件收 1 个 batch 帧(序保持)', async () => { /* ws 连 /events?batch=1;pump 3 事件;首帧 kind==='batch' 且 frames.length===3,seq 递增 */ });
it('老客户端(无 query):行为不变,逐帧到达', async () => { /* 既有用例同构对照 */ });
it('挂起帧(approval)不进合批窗,立即到达;重连补发对 batch 客户端完整成批', async () => { /* approval 帧直收;断线重连后 512 缓冲补发为 batch 帧且无丢失 */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test dist-test/` 或按仓库测试入口跑 daemon.ws
Expected: FAIL——batch 帧类型与分路不存在。

- [ ] **Step 3: Implement**

1. daemon-wire.ts + src/types.ts：`WsBatchFrame` 登记进 `DaemonFrame` 并集（注释：batch=1 客户端合帧形态,事件帧序内数组）。
2. attachWs upgrade 回调：`const batch = urlOf(req).searchParams.get('batch') === '1'`，传入 `onWsConnection(ws, batch)`。
3. `wsClients: Set<WebSocket>` → `Map<WebSocket, { batch: boolean; buf: EventFrame[]; timer: NodeJS.Timeout | null }>`。
4. broadcastFrame：无 batch 客户端走原单序列化快路（零开销）；有则事件帧 push 进各 batch 客户端 buf 并置 30ms timer（已在途则跳过），flush 时 `ws.send(JSON.stringify({ kind: 'batch', frames: buf.splice(0) }))`。挂起/reset 帧绕过 buf 直发。补发循环的帧对 batch 客户端走同一 buf（重连即成批,≤30ms 延迟）。
5. close/teardown 路径清 timer（对齐既有心跳 timer 清理点）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`（全量——daemon.contract.test.ts 必须全绿证明老路径逐字节不变）
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/serve/daemon-wire.ts src/serve/daemon.ts src/types.ts src/serve/daemon.ws.test.ts
git commit -m "perf(serve): 泵出口 batch=1 门控 30ms 合帧,老客户端零影响"
```

### Task 7: 客户端 batch 解包

**Files:**
- Modify: `gui/src/connection-types.ts`（WsFrame 并集增 batch 形态）
- Modify: `gui/src/connection-transport.ts:38-41`（wsUrl 加 query）、`:125-149`（onmessage 分路）
- Test: `gui/src/connection.test.ts`（追加）

**Interfaces:**
- Consumes: Task 6 的 `WsBatchFrame` 线格式
- Produces: transport 对上层回调面零变化（`onEvent` 逐帧回调,序不变）——批量去重/单调 seq 过滤复用既有 `deliver()`。

- [ ] **Step 1: Write the failing test**（connection.test.ts 追加）

```ts
it('batch 帧:逐帧 onEvent 且单调 seq 过滤生效', () => {
  // 注入模拟消息 {kind:'batch', frames:[event(seq=1),event(seq=2),event(seq=1)]}
  // 断言 onEvent 恰 2 次,seq=1,2 各一次
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/connection.test.ts`
Expected: FAIL——batch 帧落入 `frame.kind !== 'event'` 早退。

- [ ] **Step 3: Implement**

1. connection-types.ts：WsFrame 并集加 batch 形态——`{ kind: 'batch'; frames: Array<{ kind: 'event'; sessionId: string; seq: number; e: SessionEvent }> }`（元素类型=本文件既有 event 帧形态,与 Task 6 服务端线格式镜像）。
2. onmessage：事件帧处理体（:146-148）抽局部函数 `handleEventFrame(frame)`；`if (frame.kind === 'batch' && Array.isArray(frame.frames)) { for (const f of frame.frames) if (f.kind === 'event') handleEventFrame(f); return; }`。同步循环内多次 setState 由 React 18 自动批处理合并单次渲染——无需额外微任务缓冲。
3. wsUrl：`${toWsUrl(url)}/events?batch=1`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gui && npx vitest run src/connection.test.ts src/e2e.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS——e2e（真 daemon + 真 GUI 客户端）全绿即端到端合帧闭环验证。

- [ ] **Step 5: Commit**

```bash
git add gui/src/connection-types.ts gui/src/connection-transport.ts gui/src/connection.test.ts
git commit -m "perf(gui): transport 解包 batch 帧,wsUrl 声明 batch=1"
```

### Task 8: App 级后台帧节流（trailing queue）

**Files:**
- Create: `gui/src/trailing-queue.ts` + `gui/src/trailing-queue.test.ts`
- Modify: `gui/src/use-connection-wiring.ts:65-79`（live 板/委派路径）、`:80-99`（live subagent bumpActs 路径）

**Interfaces:**
- Consumes: 既有 `bumpActs` / `setProjection`
- Produces: `createTrailingQueue<T>(apply: (items: T[]) => void, ms: number): { push(item: T): void; flush(): void; dispose(): void }`——100ms 窗内合并、尾随触发。水合/播种回放路径（use-connection-wiring `onSeeded` :441-444、shadow 缓冲 flush）**旁路直投**（权威终态,零节流）。

- [ ] **Step 1: Write the failing test**（trailing-queue.test.ts，vi.useFakeTimers）

```ts
it('100ms 窗内多次 push 合并为一次 apply(尾随)', () => {
  vi.useFakeTimers();
  const seen: number[][] = []; const q = createTrailingQueue<number>((xs) => seen.push([...xs]), 100);
  q.push(1); q.push(2); q.push(3);
  expect(seen).toEqual([]);
  vi.advanceTimersByTime(100);
  expect(seen).toEqual([[1, 2, 3]]);
  q.push(4); vi.advanceTimersByTime(100);
  expect(seen).toEqual([[1, 2, 3], [4]]);
  q.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gui && npx vitest run src/trailing-queue.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: Implement**

trailing-queue.ts：数组缓冲 + 单 timer（在途则跳过）；`flush()` 同步排空（dispose 清 timer 不 apply）。use-connection-wiring 接线：live 路径的 `bumpActs(sessionId, fold)` 改 `actsQueue.push({ sessionId, fold })`（flush 时按序折叠）；板/委派 live 路径 `setProjection` 改 `boardQueue.push(e)`（flush 时 `setProjection((p) => 逐事件 applyBoardEvent/applyDelegation)`）。播种窗缓冲与 onSeeded 整替、shadow 水合重放照旧直投。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gui && npx vitest run src/trailing-queue.test.ts src/App.test.tsx && npx tsc -p tsconfig.json --noEmit`
Expected: PASS（App.test 既有 waitFor 断言容忍 100ms 尾随延迟）。

- [ ] **Step 5: Commit**

```bash
git add gui/src/trailing-queue.ts gui/src/trailing-queue.test.ts gui/src/use-connection-wiring.ts
git commit -m "perf(gui): 后台帧 100ms trailing 节流,活动会话 chat sink 直通不节流"
```

> **范围说明（对 spec §3.7 的显式裁剪）**：spec 的「services 拆稳定切片 + 消费组件 memo」不在本任务落地——节流后 services 重建频率已从 token 帧率降至 100ms 一次，剩余收益要配合 P2 keep-alive 的 tab body memo 才完整，避免 P1 范围膨胀。该项并入 P2 计划。

### Task 9: P1 全量门禁

**Files:** 无新改动（验证 + 收尾）

- [ ] **Step 1: 全量验证**

```bash
pnpm build && pnpm --dir gui run test && pnpm test && pnpm selfcheck
```
Expected: 全绿（GUI 全量含 e2e 真 daemon——合帧端到端 + 渲染计数 + 协议兼容三面齐验）。

- [ ] **Step 2: 产物体积记录**

`ls -l dist-gui/assets/index-*.js`——记录相对 9.9MB 基线数值（写入提交说明,供 P2 对比）。

- [ ] **Step 3: Commit（如有门禁修正）**

```bash
git add -A && git commit -m "chore(gui): P1 全量门禁收尾"
```
