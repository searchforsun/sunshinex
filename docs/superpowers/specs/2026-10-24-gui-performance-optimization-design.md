# GUI 性能优化三期工程设计

- 日期：2026-10-24
- 状态：设计已确认（brainstorming 产出），待实施计划
- 范围：gui/（React 18 + Vite 渲染面）、src/serve/ + src/tui/session-journal.ts（历史加载传输面）

## 1. 背景与目标

用户反馈 GUI 整体偏卡，四个场景全部命中：

1. 流式生成时卡（打字/滚动掉帧）——最常见；
2. 打开长历史会话慢；
3. 切 tab 卡顿（Monaco/终端重挂）;
4. 启动/首屏慢（主包解析久）。

调研结论（三路并行子智能体审查 + 产物实测，证据行号见 §6 各表）：

- **渲染链**：`ToolEntryView` 未 memo + MessageList 每帧传新内联闭包使 memo 全部失效；`chat.entries` 每帧新数组身份导致派生计算（按日分组/runFooter/todoBatches 的 `JSON.stringify`）每帧重跑；自动滚动 effect 无依赖数组逐帧读 `scrollHeight` 强制 reflow；尾窗只增不减、折叠行与工具展开体常挂 DOM。
- **加载链**：snapshot 无分页（`kernel.replay()` 全量返回）；journal 每次打开同步全量解析两遍（attach + shadow-events）；`result.full` 全量观测随 snapshot 传输；WS 流式零合并（1 delta = 1 帧 = 1 setState = 全 Chat 重渲染）；重连重放所有会话 × 512 帧缓冲。
- **切屏/包体链**：主包 9.9MB（Monaco + xterm + 全量 highlight.js 静态进首包，仅 mermaid/TaskDag 懒加载）；tab 切换 `key={uid}` 完全卸载重挂（Monaco 重建 100-300ms、xterm 断开重连 + replay 往返、ReactFlow 从零布局）；App 级每帧 setState 风暴（后台子智能体 shadow 帧让整个 App 以 token 帧率重渲染）。

**目标**：消除上述四个场景的卡顿。**红线**：既有身份保持 WeakMap 视图缓存、五个视图组件 memo、流式 markdown 块缓冲（仅尾部重解析）、mermaid SVG 缓存、终端 dispose 生命周期全部保留不回归；`data/` 持久化分层与共享会话档语义不动（本设计只动传输与渲染面，不动落盘形态）；不触提示词与前缀缓存面。

## 2. 分期总览

三期独立交付、独立可回滚，按收益/风险比排序：

| 期 | 主题 | 改动面 | 消除的场景 |
|----|------|--------|-----------|
| P1 | 快赢：memo 修复 + 派生冻结 + 滚动收敛 + WS 合帧 + App 帧隔离 | gui/ + session pump 传输出口 | 流式掉帧 |
| P2 | 分包 + keep-alive：代码分割 + 切屏保活 + 预热 | gui/（registry/App/tabs） | 切 tab 卡、启动慢 |
| P3 | 历史链分页：snapshot cursor + 载荷瘦身 + 解析缓存 + 重连收敛 | src/serve/ + gui/ 客户端 | 开长会话慢 |

## 3. P1 快赢——流式渲染链

### 3.1 稳定回调身份（memo 生效的前提）

MessageList 传给 ChatEntryView / ToolEntryView / ToolSegBlock 的全部内联闭包（`onOpenDiff={(p) => onOpenDiff?.('', p)}`、`renderTool/renderThinking/renderAssistant` 等）提升为 `useCallback`；依赖中的宿主回调经 ref 稳定（会话切换免闭包陈旧，对齐 App.tsx sessionRef 既有手法）。

### 3.2 memo 补齐

`ToolEntryView`、`ToolSegBlock` 包 `React.memo`。entry 身份由既有 WeakMap 视图缓存保证（未变条目对象身份不变），配合 3.1 后未变行在 token 帧零重渲染。

### 3.3 派生计算冻结（structureVersion）

chat-reducer 增加单调递增 `structureVersion`：**仅在条目增删/播种/清空时递增**；尾条目内容变更（token delta）不递增。以下派生全部以 `structureVersion` 为 memo key：

- `groupEntriesByDay(visible)`（MessageList 内联每帧重跑 → 冻结）；
- `runFooterMapOf`、`collapsedHiddenKeys`、`taskTitleMapOf`/`todoBatches`/`turnGoal`（use-chat-derived / use-chat-fold）；
- `JSON.stringify(todoBatches)` 每帧序列化换成结构化 key（批次计数 + 首尾 entry 身份）。

### 3.4 滚动收敛

use-chat-scroll 的无依赖 effect 改为：贴底判定与 `scrollTop` 写入收进 rAF 回调，且仅在「内容帧脏标记」置位时执行（事件层置脏）。消灭逐帧强制 reflow。折叠展开期的 rAF 钉底循环（use-chat-fold / ToolGroups）复用同一脏标记入口。

### 3.5 highlight.js 按需

`import hljs from 'highlight.js'` → `highlight.js/lib/common`（~40 常用语言，主包 -80% 高亮体积）。语言覆盖面以项目文档/代码常用集为准，缺失语言回落纯文本。

### 3.6 WS 合帧（协议增量，向后兼容）

- 服务端：session pump 出口加 30ms 合并窗——同会话连续帧（token/tool/step 等）合并为一个 `batch` 帧（`{ type: 'batch', events: [...] }`）；
- **仅对 WS 握手 query 声明 `batch=1` 的客户端启用**，老客户端行为不变；
- 客户端：connection-transport 解包 batch 逐条 deliver，但同一 tick 内合并为单次 `setState`（React 18 自动批处理接管，微任务缓冲 + tick flush）。

### 3.7 App 级帧隔离

- 后台帧（子智能体 shadow → `bumpActs`、板/委派事件 → `setProjection`）经 100ms trailing 节流；
- **活动会话 chat sink 直通不节流**（保流式手感）；
- services 对象拆稳定切片 + 相关消费组件 memo，后台流不再牵动 TabStrip/侧栏/活动 tab 全量 reconcile。

### 3.8 P1 验收

- profiler 下 token 突发期间除尾行外可见行零重渲染（渲染计数测试断言，Chat.test.tsx 增补）；
- 派生计算在纯内容帧不重算（structureVersion 不变的断言）；
- 全量门禁：`pnpm --dir gui run test` + `pnpm test`（协议改动）+ typecheck。

## 4. P2 分包 + keep-alive——切屏与启动

### 4.1 代码分割

- registry 全部 tab body `lazy(() => import(...))` + Suspense 骨架 fallback；
- `manualChunks`：monaco-editor、@xterm/*、highlight.js 各自独立 chunk；
- Files/diff-panel 经动态 `import()` 取 monaco（monaco-setup 改异步工厂）；
- 目标：主包 < 1.5MB（现状 9.9MB）。

### 4.2 keep-alive（切屏保活）

- `sx-tabbody` 渲染全部 open tab；非活动 tab `display:none` + `inert` + **Freeze gate 冻结 reconcile**（Suspense 语义，~20 行自研，零新依赖）——隐藏 tab 不参与渲染但仍收事件，状态零丢失；
- LRU 上限 4 个重 tab（file/terminal/diff/taskboard/directory 计重），超限卸载最久未用；
- **分类型策略**：terminal/file/diff/taskboard/directory keep-alive（终端收益最大：WS 常连、无 replay 往返）；web/iframe 维持重挂（页面资源常驻代价高）。

### 4.3 预热

- hover「+」菜单项 / 侧栏文件树项：`import()` 预载对应 tab chunk；
- 首屏 `requestIdleCallback` 预取 monaco/xterm chunk——首次打开不再是最慢一次。

### 4.4 微优化

- Files 文件内容模块级 LRU 缓存（切回免重拉）；
- DirectoryTab 展开缓存从组件 useState 提到模块级（按会话键）；
- TaskBoardTab `agentOf` 内联箭头 `useCallback`（消灭 dagre 每 render 重布局）。

### 4.5 P2 验收

- 主包 < 1.5MB；同型 tab 互切 < 50ms（Monaco 零重建）；终端切回无 replay 往返；
- keep-alive LRU 卸载路径有测试（卸载后重开按现状重拉，无悬挂引用）；
- 全量门禁同 P1。

## 5. P3 历史链分页——后端传输面

### 5.1 snapshot cursor 分页

- `GET /session/:id/snapshot?tail=N`：返回最后 N 条 + `total` + `oldestSeq`；
- `GET /session/:id/snapshot?before=<seq>&limit=N`：按 seq 向上翻页（seq 有序且不可变，天然 cursor）；
- 缺省（无参数）行为 = 现状全量，老客户端零影响；
- 客户端：attach 只 seed 尾窗（N=300，对齐 D48 RENDER_WINDOW）；「显示更早」/滚顶触发 before 翻页 fetch；reducer 增 `prependSeed` action；RENDER_WINDOW 保留作渲染侧护栏，D48 的「只增不减」被分页取代——页面按需拉取即用户驱动增长。

### 5.2 result.full 出传输面

- snapshot 的 tool entry 只带 `result.text`（200 字符截断已在）；展开 tool 行按需 `GET /session/:id/entry/:seq/observation`；
- **journal 落盘形态不动**——全量观测随档是模型上下文恢复契约；
- ⚠ 实施前置核对：TUI 是否同样从 journal/snapshot 读 `full`；若共用读取面，则裁剪仅落在 GUI 快照出口（serve 层），TUI 恢复路径不动。

### 5.3 journal 解析缓存与写路径

- `parseJournalFile` 结果按 `(绝对路径, mtime, size)` 模块级缓存——attach 与 shadow-events 共享一次解析（现状解析两遍）；
- `appendFileSync` 改写队列异步化；attach/读档路径先 sync flush 再读，保读己之写。

### 5.4 重连重放收敛

- WS 重连只重放**活动会话**的 512 帧缓冲；其余会话在 attach 时走 snapshot 播种（既有面），不再全量广播后客户端丢弃。

### 5.5 P3 验收

- 10k 行会话 attach 网络载荷 < 500KB（不含按需 full）；
- 「显示更早」为网络翻页（断网时行内重试入口，对齐既有失败形态）；
- 重连期间无他会话帧到达客户端（测试断言）；
- 协议兼容：无分页参数/无 batch 声明的老路径行为逐字节不变（daemon.contract.test.ts 增补）；
- 全量门禁同 P1。

## 6. 调研证据索引

### 6.1 渲染链（gui/src）

| 问题 | 位置 |
|------|------|
| ToolEntryView 未 memo | pages/chat/ToolEntry.tsx:141 |
| 每帧新内联闭包 bust memo | pages/chat/MessageList.tsx:131-147（含 ：146 onOpenDiff） |
| entries 每帧新数组 | chat-reducer.ts:108-154 |
| 派生每帧重跑 | use-chat-fold.ts:110、use-chat-derived.ts:70-137（JSON.stringify :117） |
| 滚动逐帧 reflow | use-chat-scroll.ts:26-30（钉底循环 use-chat-fold.ts:125-133、ToolGroups.tsx:129-138） |
| 尾窗只增不减 | MessageList.tsx:12-14（RENDER_WINDOW_DEFAULT=300）、:75-86 |
| 折叠行/展开体常挂 DOM | use-chat-fold.ts:95、ToolEntry.tsx:140、EntryViews.tsx:132-134 |
| hljs 全量包 | highlight.ts:3-5 |
| 打开会话 300 条同步挂载 | MessageList.tsx:75-79、EntryViews.tsx:421 |

### 6.2 加载链（src/serve + src/tui）

| 问题 | 位置 |
|------|------|
| attach 全量同步解析 | daemon.ts:296-307；session-journal.ts:245-260（readFileSync） |
| snapshot 全量无分页 | session.ts:1124-1126、session-handlers.ts:387 |
| shadow-events 二次全量解析 | session.ts:547-568、daemon.ts:650 |
| result.full 全量随档 | batch-runner.ts:93,122 |
| WS 零合并（1 delta=1 setState） | session.ts:575-608、daemon.ts:379-383、connection-transport.ts:64-68、use-session-events.ts:256 |
| 重连全会话 × 512 帧重放 | daemon.ts:448-465、session.ts:106 |
| appendFileSync 同步写 | session-journal.ts:128 |

### 6.3 切屏/包体链

| 问题 | 位置 |
|------|------|
| 主包 9.9MB（Monaco/xterm/hljs 静态进首包） | monaco-setup.ts:3、TerminalTab.tsx:3-4、registry.tsx:14-22；dist-gui/assets 实测 index-*.js=9.9MB |
| tab 切换完全卸载重挂 | App.tsx:817-840（key={uid} :820） |
| App 级每帧 setState 风暴 | use-connection-wiring.ts:80-99、use-agent-projections.ts:44-52、App.tsx:435+ |
| dagre 每 render 重布局 | TaskBoardTab.tsx:154 → TaskDag.tsx:181 |
| 目录展开缓存随卸载丢失 | DirectoryTab.tsx:56-60 |
| Monaco 每挂载重建 | Files.tsx:100-111 |

已确认良好（不回归）：chat-reducer.ts:103 WeakMap 身份保持；EntryViews 五组件 memo；流式 markdown 块缓冲（EntryViews.tsx:394-417）；Mermaid SVG 缓存+防抖+超时回落（Mermaid.tsx）；终端 dispose（TerminalTab.tsx:190-196）。

## 7. 测试与回滚策略

- 三期独立 PR，逐期全量门禁：`pnpm build` + `pnpm --dir gui run test`（含 e2e）+ `pnpm test` + `pnpm selfcheck`；
- P1 渲染计数测试（token 突发 spy）、structureVersion 语义单测；
- P2 chunk 清单人工核对 + keep-alive LRU 单测 + 冻结期事件不丢单测；
- P3 daemon.contract.test.ts 兼容断言（无参老路径逐字节不变）+ 分页/按需 observation 集成测试；
- 全程不触提示词面（§11 前缀缓存不变量零影响）。
