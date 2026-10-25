# GUI 性能优化二期工程设计（分包 + keep-alive）

- 日期：2026-10-26
- 状态：设计待评审（brainstorming 产出；评审通过后经 writing-plans 出实施计划）
- 范围：gui/（registry/App 壳/标签装配面 + 构建配置）
- 前置关系：一期（原规格 P1 快赢 + 2026-10-26 二轮补强：映射缓存/组级 memo/App 帧隔离/content-visibility）已交付（0bb44ca 系）；三期 = 历史链分页（原规格 P3，snapshot cursor 分页/载荷瘦身/重连收敛）另立设计，本设计不含。

## 1. 背景与实测现状

一期后流式渲染链已收敛（daemon 30ms 合批 + 映射缓存 + 组级 memo），但**切屏卡与启动慢**完整保留——原规格 P2 的全部内容。实测（2026-10-26 构建）：

- **主包 9.4MB**（index-*.js，gzip 前）：根因是 `tabs/registry.tsx` 静态 `import` 全部标签体——`TerminalTab → @xterm/xterm+addon-fit`、`DiffTab → diff-panel → @monaco-editor/react`、`Files → monaco-setup → monaco-editor 全量`、`highlight.js/lib/common`（200KB，已收敛）。mermaid/TaskDag/cytoscape 已是懒 chunk（一期前完成）；ts.worker 6.9MB 按需加载不进首屏。
- **切 tab 全卸载重挂**：`sx-tabbody key={activeTab.uid}`——同型标签互切也强制重挂。Monaco DiffEditor 重建 100-300ms；终端断 WS + pty replay 往返；目录树重新逐层 fetchLayer。
- **启动**：主包解析与执行是首屏 TTI 的决定项（9.4MB minified）。

## 2. 目标与验收

| 指标 | 现状 | 目标 |
|------|------|------|
| 主包体积 | 9.4MB | < 1.5MB（Monaco/xterm/hljs 各自独立 chunk 按需加载） |
| 同型标签互切（file→file，diff→diff） | 100-300ms（Monaco 重建） | < 50ms（零重建） |
| 终端标签切回 | WS 重连 + replay 往返 | 零往返（实例保活，屏幕原样） |
| 首次可交互 | 主包全量解析后 | 主包 1.5MB 解析即交互，重 chunk 预热后台拉 |

全量门禁：`pnpm --dir gui run test` + `pnpm test` + typecheck + `pnpm gui:build` 产物体积复核。

## 3. 红线（一期 + 二轮成果不回归）

五行行级 memo、MessageList 组级 memo、chat-reducer 映射缓存、App 级 100ms 帧隔离、content-visibility 离屏跳渲、流式 markdown 块缓冲、mermaid SVG 缓存、终端 dispose 生命周期语义（保活=不 dispose，不是改语义）。`data/` 持久化分层与共享会话档语义不动。

## 4. 方案对比（选型记录）

- **A. 分包 + Freeze keep-alive（选定）**：registry 懒加载标签体 + 手动分包；非活动标签 `display:none + inert` 挂 Freeze gate 冻结 reconcile，LRU 上限。收益覆盖全部验收指标，自研 Freeze 约 20 行零新依赖（React 官方 `<Activity>` 落地前的通行替代，业界同款）。
- **B. 仅分包不保活**：主包目标达成、实现最小，但切 tab 仍全重挂——切屏卡（场景 ②③）原样保留，验收指标 2/3 不达成。否。
- **C. 消息流全虚拟化重写 + 标签保活**：虚拟化解决的是长会话滚动（一期已用 content-visibility + 尾窗覆盖 80%，实测非当前主诉），且与 seg-collapse 高度动画/组级 memo 冲突面大。否——收益比倒挂，留待实测必要时另立。

## 5. 设计

### 5.1 代码分割（registry 懒加载 + manualChunks）

- **registry 拆两层**：同步层保留元数据（`id/title/resolveKey/singleton/group/icon`——TabStrip/TabSearchPop/判重零等待）；`render` 改 `lazy(() => import('../pages/Files'))` 形态的组件工厂。`tabEntry().render` 消费面不变（返回 lazy 组件，调用点包 `<Suspense fallback={<TabSkeleton />}>`）。
- **Suspense 骨架**：`TabSkeleton` = 标签体同构空态（标题行 + 三行 shimmer），与 `sx-tab-empty` 视觉同族。
- **manualChunks**（vite 配置）：`monaco-editor`、`@monaco-editor/react`、`@xterm/*`、`highlight.js` 各自独立 chunk；`mermaid`/`@xyflow`/`cytoscape` 维持现状（已懒）。
- **monaco-setup 异步工厂**：`loader.config({ monaco })` 与 worker 注册移入 chunk 内模块顶层；`diff-panel`/`Files` 首次挂载时才拉。
- **highlight.ts 留主包**（lib/common 已收敛 ≈200KB，Files 页与正文代码块首屏即用——拆出反而首开加一跳）；若批1 构建复核主包仍超 1.5MB，再降级为紧随 chunk（唯一例外口）。
- **Chat/主对话不入懒加载**（首屏主面）；WebTab 轻量（iframe 壳）留主包。

### 5.2 keep-alive（切屏保活）

- **挂载形态反转**：`sx-tabbody` 从「只挂活动标签」改为「挂全部 open 标签」：活动标签正常渲染；非活动标签外层 `display:none + inert`（不可聚焦/不响应指针），内层挂 **Freeze gate**。
- **Freeze gate（自研 ~20 行）**：`const Freeze = ({ frozen, children }) => frozen ? <Suspense fallback={null}><FreezeFrame>{children}</FreezeFrame></Suspense> : children`——利用「Suspense 已展示过 fallback 后的更新被搁置」语义冻结子树 reconcile：隐藏标签不参与渲染（后台 setState 不触发其 DOM 更新），但组件树与状态完整保留。
- **分类型策略**：keep-alive = `terminal / file / diff / taskboard / directory / agent / bgtasks / memory / web`（terminal 收益最大：WS 常连零 replay；web 是 iframe 壳，保活代价低顺手保）；`sidechat` 重挂（旁路 Chat 有独立 sink 生命周期，保持现状隔离语义）。
- **LRU 上限 4 个重标签**（terminal/file/diff/taskboard/directory 计重）：超限卸载最久未用的——卸载即现行关标签语义（pty kill、状态丢弃），无悬挂引用。卸载路径有测试。
- **pty 生命周期**：隐藏标签的 PtySocket 继续收帧（WS 帧路由在 App 级，不经标签体）——xterm 实例保活写屏，`display:none` 不影响其内部缓冲；切回零 replay。Freeze 冻结 reconcile 不会吞 PtySocket 的 useEffect 数据流（冻结的是渲染提交，不是事件回调）。
- **与切屏动画/滚动存档兼容**：切回时 `sx-tabbody` 复用保留的滚动位（各标签体自持）；`key` 从卸载条件改为保留条件（uid 不再触发重挂）。

### 5.3 预热

- 首屏 `requestIdleCallback`（降级 setTimeout 2s）预取 monaco/xterm chunk（`import()` 触发下载不执行重初始化）——首次打开终端/文件不再是「下载+解析+初始化」三重最慢。
- TabStrip「+」菜单 hover 项与侧栏文件树行 hover：预载对应 tab chunk。

### 5.4 微优化（原规格 §4.4 平移）

- Files 文件内容模块级 LRU（按路径+mtime 键，切回免重拉）；
- DirectoryTab 展开集提升为模块级（按会话键）；
- TaskBoardTab `agentOf` 内联箭头 useCallback（消灭 dagde 每 render 重布局）。

## 6. 分期交付

| 批 | 内容 | 独立可回滚 |
|----|------|-----------|
| 批1 | manualChunks + registry 拆层 + Suspense 骨架 + monaco 异步工厂（§5.1） | 是——纯分包，keep-alive 未上前行为等价 |
| 批2 | Freeze keep-alive + LRU + 分类型策略（§5.2） | 是 |
| 批3 | 预热 + 微优化（§5.3/§5.4） | 是 |

## 7. 风险与对策

- **Freeze 语义依赖 Suspense 内部行为**：React 18 稳定语义（已有商用库 react-freeze 同实现）；升级 React 19 后可直接换 `<Activity mode="hidden">`（API 兼容替换，封装隔离在 Freeze 单点）。
- **隐藏标签 setState 积压**：冻结期间标签体自身的 setState 被搁置（不丢，恢复时一次提交）——长隐藏期高频态（终端屏缓冲在 xterm 实例内不在 React 态）不受影响；`WebTab` iframe 不经 React 态。恢复风暴面 = 纯 UI 态，可控。
- **内存上限**：LRU 4 重标签 + 现状 chatMem 4 会话转录缓存，内存增幅有界；超限路径卸载兜底。
- **体积回退风险**：批1 完成后立即复核主包体积（构建产物断言可后续加 CI 检查，本期人工复核）。

## 8. 业界口径对照

路由级代码分割 + 悬停预取（Next.js/Vite 生态标准做法）；列表虚拟化（一期已用 content-visibility 覆盖主诉）；keep-alive 采用「Suspense 冻结 + display:none」——React 官方 `<Activity>`（原 Offscreen）尚未发布前的通行替代（react-freeze/React Navigation 同实现）；worker 化 markdown 解析评估后不纳入本期（尾块已限流,收益不足）。

## 9. 明确不做（本二期）

- 历史链分页/快照瘦身/重连收敛（三期，原规格 P3）；
- 消息流全虚拟化重写；
- 主对话渲染链进一步改动（一期 + 二轮已收敛，红线保护）。
