# GUI 性能优化二期+三期工程设计（分包 keep-alive + 历史链自动分段加载）

- 日期：2026-10-26
- 状态：设计已确认（brainstorming 产出，用户裁定合并二期/三期一起实施；参数尾窗 600/TTL 60min）
- 范围：gui/（registry/App 壳/标签装配/attach 播种/prepend 归约/后台加载链/chatMem TTL）+ src/serve/（snapshot 分页参数与载荷瘦身）
- 前置关系：一期（原规格 P1 快赢 + 2026-10-26 二轮补强：映射缓存/组级 memo/App 帧隔离/content-visibility）已交付（0bb44ca 系）。本设计 = 原规格 P2（分包 keep-alive）+ P3（历史链分页，按用户裁定演化为「自动后台分段补全」形态）合并实施。
- 参数裁定（2026-10-26 用户 + 复核修正）：**首屏尾窗 200 / 补全页 600 / 渲染窗 RENDER_WINDOW 600**（600 作渲染跨度与补全页合理；作首屏偏重——200 条 ≈200KB 解析个位数 ms 真秒开，1-2 页补全即填满渲染窗）；chatMem TTL **60 分钟**。
- 兼容裁定（2026-10-26 用户）：**去掉兼容项**——snapshot 缺省即尾窗形态，不留无参全量旧路径；`result.full` 在所有快照响应中剥离，§4.5 观测按需端点与批 1 同步交付。

## 1. 背景与实测现状

一期后流式渲染链已收敛（daemon 30ms 合批 + 映射缓存 + 组级 memo），但两类场景完整保留：

**切屏与启动（二期）**，实测 2026-10-26 构建：

- **主包 9.4MB**：`tabs/registry.tsx` 静态 import 全部标签体——`TerminalTab → @xterm/xterm+addon-fit`、`DiffTab → diff-panel → @monaco-editor/react`、`Files → monaco-setup → monaco-editor 全量`、`highlight.js/lib/common`（≈200KB）。mermaid/TaskDag/cytoscape 已懒 chunk；ts.worker 6.9MB 按需不进首屏。
- **切 tab 全卸载重挂**：`sx-tabbody key={activeTab.uid}`——Monaco 重建 100-300ms；终端断 WS + pty replay 往返；目录树重新逐层 fetchLayer。

**长会话进入（三期）**，用户裁定（2026-10-26）：

- attach 把 journal **全量**重放下发（载荷→解析→seed→映射全链），用户只看尾部若干轮却为全部历史付加载成本——「先上车再补票」：进会话先加载最新 600 条秒开，**进入后自动分段后台补更老的历史直到补全**（无感，不依赖翻页触发）；
- 不活跃会话**60 分钟自动剔除转录缓存**。

## 2. 目标与验收

| 指标 | 现状 | 目标 |
|------|------|------|
| 主包体积 | 9.4MB | < 1.5MB（Monaco/xterm/hljs 各自独立 chunk 按需加载） |
| 同型标签互切 | 100-300ms（Monaco 重建） | < 50ms（零重建） |
| 终端标签切回 | WS 重连 + replay 往返 | 零往返（实例保活屏幕原样） |
| 进会话首屏可用 | 全量下载+解析+seed（随历史线性变慢） | 仅首屏尾窗 200 条，体感恒定 |
| 快照载荷 | 全量（含 result.full 全量观测） | 一律不带 full；首屏 200 条/补全页 600 条 |
| 老历史补全 | 无（一次性全量） | 后台自动逐段直到头部（完成态标记），切走暂停切回续跑 |
| 会话缓存 | LRU-4 无时间界 | LRU-4 + 60min TTL（运行中不剔） |
| 兼容 | — | **已去除**（用户裁定）：缺省即尾窗形态 |

全量门禁：`pnpm test`（daemon 契约）+ `pnpm --dir gui run test` + typecheck + `pnpm gui:build` 产物体积复核。

## 3. 红线（一/二期成果不回归）

五行行级 memo、MessageList 组级 memo、chat-reducer 映射缓存、App 级 100ms 帧隔离、content-visibility 离屏跳渲、流式 markdown 块缓冲、mermaid SVG 缓存、终端 dispose 生命周期语义。`data/` 持久化分层与共享会话档语义不动；journal 落盘形态不动（全量观测随档是模型上下文恢复契约）；**流式尾部不裂**（prepend 老历史不得扰动 openRun/openSeg 游标与尾窗渲染）。

## 4. 三期部分——历史链自动分段加载 + 缓存 TTL

### 4.1 daemon：snapshot 分页参数（传输面增量，向后兼容）

- `GET /session/:id/snapshot`：缺省返回**最后 200 条**（首屏尾窗）+ `total/oldestSeq/hasMore`；
- `GET /session/:id/snapshot?tail=N`：自定义尾窗；`?before=<seq>&limit=600`：返回 seq < before 的前 limit 条 + `hasMore`（journal 条目 seq 单调且不可变——天然游标）；
- **无兼容旧路径**（用户裁定）：所有响应一律分页形态 + 剥 `result.full`；契约测试钉「缺省尾窗/参数校验/full 恒剥」；
- **载荷瘦身随分页走**：分页响应条目只带 `result.text`（既有 200 字符截断），剥 `result.full`——全量观测按需另拉（§4.5）。kernel 内存面仍持全量（daemon 内不受影响），裁剪只发生在快照序列化出口；
- 前置核对（实施批内第一步）：TUI 恢复路径确认不经 GUI 快照出口；若共用读取面则裁剪收窄到带 `gui=1` 客户端声明。

### 4.2 gui：attach 尾窗播种 + prepend 归约

- attach 只以首屏尾窗 seed（缺省 tail=200）；渲染尾窗 RENDER_WINDOW_DEFAULT 同步 600；快照响应带 `total/oldestSeq/hasMore` 入 ChatState 供加载链消费；
- reducer 增 `prependSeed(state, entries, meta)`：头部插入 + structureVersion 递增；不动尾部与 openRun/openSeg 游标（游标引用尾部 seq，头部插入无扰）；
- mapCache：头部插入走全量重映射路径（页级频率可接受）；尾部流式帧仍走快速路径；
- 渲染尾窗语义：老数据到达**不自动扩可视窗**——滚顶按既有「自动回放」机制扩窗（数据已在内存，扩窗零等待）；背景补全是「备货」不是「上货架」。

### 4.3 后台自动加载链（先上车再补票）

- 触发：尾窗播种落定即启动；`while hasMore`：`before=oldestSeq&limit=600` 串行取页 → `prependSeed` → 下一页；
- **让路规则**：会话切走（非当前 openSessionId）即暂停链；切回续跑（oldestSeq 断点续取，已取页不重取）；会话运行中照常补老（prepend 头部/流式追加尾部互不干扰）；单页之间让出一帧，不与流式渲染争主线程整段；
- **失败与重试**：单页失败指数退避（对齐 adapter 口径），三次仍败置「更早的会话暂时加载失败（点击重试）」顶栏内联提示——可手动重试也可等自动重试；
- **完成态**：`hasMore=false` 置 historyComplete，链终止，提示退场；
- **指示器**：补全期间顶栏内联细条（「正在加载更早的会话…」），无弹层无交互负担；
- 竞态守卫：加载链绑定会话代次（切会话/重播种 gen 失配即弃在途页）。

### 4.4 「显示更早」语义

- 数据未达区域：按钮显「更早的历史正在加载…」（不可点，补全进度自动消失）；
- 数据已达区域：现状扩可视窗行为不变；
- 滚顶自动回放既有机制保留。

### 4.5 全量观测按需拉取

- 工具行展开且 `result.full` 缺席时：`GET /session/:id/entry/:seq/observation` 单条拉取（daemon kernel/journal 直取，内存命中零盘读）；加载态沿用现 diff 面骨架样式；失败回落 `result.text`。

### 4.6 chatMem TTL 剔除

- LRU-4 增时间维：桶记录 lastTouch；**60 分钟**未触碰的桶在触碰检查/周期清理（60s 定时）时剔除；
- 运行中会话（runningIds 含）不剔；
- 剔除后果 = 重进走尾窗快照（权威路径），代价近零；
- 单测钉住：TTL 到期剔、运行中豁免、触碰续期。

## 5. 二期部分——分包 + keep-alive

### 5.1 代码分割（registry 懒加载 + manualChunks）

- **registry 拆两层**：同步层保留元数据（`id/title/resolveKey/singleton/group/icon`——TabStrip/TabSearchPop/判重零等待）；`render` 改 `lazy(() => import(...))` 组件工厂。`tabEntry().render` 消费面调用点包 `<Suspense fallback={<TabSkeleton />}>`；
- **TabSkeleton**：标签体同构空态（标题行 + shimmer），与 `sx-tab-empty` 视觉同族；
- **manualChunks**（vite）：`monaco-editor`、`@monaco-editor/react`、`@xterm/*`、`highlight.js` 各自独立 chunk；mermaid/`@xyflow`/cytoscape 维持现状已懒；
- **monaco-setup 异步工厂**：`loader.config({ monaco })` 与 worker 注册移入 chunk 内模块顶层，`diff-panel`/`Files` 首挂才拉；
- **highlight.ts 留主包**（lib/common ≈200KB，首屏即用）；若批后复核主包仍超 1.5MB，再降级为紧随 chunk（唯一例外口）；
- **Chat/主对话不入懒加载**；WebTab 轻量（iframe 壳）留主包。

### 5.2 keep-alive（切屏保活）

- **挂载形态反转**：`sx-tabbody` 从「只挂活动标签」改为「挂全部 open 标签」：活动标签正常渲染；非活动外层 `display:none + inert`，内层挂 **Freeze gate**；
- **Freeze gate（自研 ~20 行）**：利用「Suspense 已展示过 fallback 后的更新被搁置」语义冻结子树 reconcile——隐藏标签不参与渲染（后台 setState 不触发其 DOM 更新），组件树与状态完整保留；React 官方 `<Activity>` 落地后可单点替换（封装隔离）；
- **分类型策略**：keep-alive = `terminal/file/diff/taskboard/directory/agent/bgtasks/memory/web`；`sidechat` 重挂（旁路 Chat 独立 sink 生命周期保持现状隔离）；
- **LRU 上限 4 个重标签**（terminal/file/diff/taskboard/directory 计重）：超限卸载最久未用——卸载即现行关标签语义（pty kill、状态丢弃），无悬挂引用；卸载路径有测试；
- **pty 生命周期**：隐藏标签 PtySocket 继续收帧（WS 帧路由在 App 级不经标签体）——xterm 保活写屏，`display:none` 不影响内部缓冲；Freeze 冻结渲染提交不吞事件回调；切回零 replay。

### 5.3 预热

- 首屏 `requestIdleCallback`（降级 setTimeout 2s）预取 monaco/xterm chunk（`import()` 触发下载不重初始化）；
- TabStrip「+」菜单 hover 项与侧栏文件树行 hover 预载对应 tab chunk。

### 5.4 微优化

- Files 文件内容模块级 LRU（路径+mtime 键，切回免重拉）；
- DirectoryTab 展开集提升模块级（按会话键）；
- TaskBoardTab `agentOf` 内联箭头 useCallback（消灭 dagre 每 render 重布局）。

## 6. 交付批次（合并排期，批间独立可回滚）

| 批 | 内容 |
|----|------|
| 批1 | daemon 分页参数 + 载荷瘦身 + 契约测试（§4.1/§4.5） |
| 批2 | gui 尾窗播种 + prependSeed + 后台加载链 + 指示器/失败面 + chatMem TTL（§4.2-§4.4/§4.6） |
| 批3 | manualChunks + registry 拆层 + Suspense 骨架 + monaco 异步工厂（§5.1）——纯分包，keep-alive 未上前行为等价 |
| 批4 | Freeze keep-alive + LRU + 分类型策略（§5.2） |
| 批5 | 预热 + 微优化（§5.3/§5.4）+ 主包体积复核 |

## 7. 风险与对策

- **prepend 与流式竞态**：prepend 只动头部（seq < 尾窗最旧），流式只动尾部；页界按 seq 游标闭合，新事件 seq 恒大于已取页，无重叠；chat-reducer 串行归约无并发写。
- **Freeze 语义依赖 Suspense 内部行为**：React 18 稳定语义（react-freeze 同实现）；升级 React 19 后换 `<Activity mode="hidden">`（封装隔离在 Freeze 单点）。
- **隐藏标签 setState 积压**：冻结期间标签体 setState 被搁置不丢（恢复一次提交）；终端屏缓冲在 xterm 实例内不在 React 态；WebTab iframe 不经 React 态——恢复风暴面 = 纯 UI 态可控。
- **内存上界**：keep-alive LRU 4 重标签 + chatMem 4 会话（60min TTL）+ kernel CAP 2000 环形——各面有界；三期改变的是**加载时序与载荷**，不是稳态内存。
- **页风暴**：串行取页 + 页间让帧 + 切走即暂停，无并发页请求。
- **体积回退风险**：批3 完成即复核主包体积（后续可加 CI 断言）。

## 8. 业界口径对照

反向时间序分页 + 不可变 seq 游标（Slack/Discord/timeline 同构）；「尾窗秒开 + 后台补全」= critical-path-first；缓存 TTL = 常规内存卫生；路由级代码分割 + 悬停预取（Next.js/Vite 生态标准）；keep-alive = Suspense 冻结（react-freeze/React Navigation 同实现，`<Activity>` 前身）；worker 化 markdown 解析评估后不纳入（尾块已限流收益不足）。

## 9. 明确不做

- journal 落盘形态改动（全量观测随档是恢复契约）；
- TUI 恢复路径改动（仅核对不共用，裁剪不出 GUI 出口）；
- 渲染侧全虚拟化重写（content-visibility + 尾窗已覆盖）；
- 主对话渲染链进一步改动（一期 + 二轮已收敛，红线保护）。
