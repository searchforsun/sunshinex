# 技术债全量普查报告（2026-10-03）

> 本文件是**一次性全仓只读普查的快照报告**：登记发现、给出证据与处置建议，不改代码、不改台账。处理规则见 `docs/TECH-DEBT.md`；下列确认项应在下一轮清理时择要登记进 `docs/TECH-DEBT-LOG.md` 待办债项区（编号续 D18+），偿还后本报告相应条目即过时，以台账为准。
>
> **执行状态**：批A（当轮轻扫）已于 2026-10-03 执行完毕并入台账当日行——S2/S4/S5/S6①②④⑤/S7/S8①②、R2/R4/R5/R6/R7/R12、C1/C4、D1–D10、N8、N11-③、R9 注释与常量化项已清；D18–D26 已注册、D17 证据已刷新。执行勘误与遗留轻项见文末「执行状态与勘误」。

## 方法与覆盖面

- 基线：HEAD `982324b`（dev1，工作树干净；普查期间并行会话将在途 harness 改动落盘为该提交，`.dist-gate/` 已随之清除）。
- 7 路并行只读调研，非测试产品码 133 文件全覆盖：① harness 根层（reactor/subagent/tasks/tools/skills/worktree/prompts）；② context + memory + knowledge；③ security + mcp + loop + graph；④ tui 全部 45 文件（session.ts 2351 行通读）；⑤ model + config + cli + src 根层；⑥ 活文档与工程面逐节对照实况；⑦ 全仓死代码机械扫（TS 编译器 API 构建导出/导入可达图：624 条导出记录、入口闭包 126/133 文件可达）。
- 重磅结论均经人工二次亲证（下文标 ✅ 者）：KB 死接线、workflow/plugins 死文件、loadSettingsChain 双胞胎、MCP env 吞弃、前台 exec 安全缝、selfcheck 漏收口、stopAll/topo/dry-run 死通道、/terminal-setup 清单漂移。
- 重点口径（用户指定）：冗余、多余兼容、超大类、死代码、过期文档、违背扩展性；超出该口径但必须上报的安全/正确性缝隙单列第六节。

## 总览

7 路原始发现 100+ 条，交叉去重后归并为下列 **63 条**：重 4 / 中 27 / 轻 32。分布：死代码与死栈 9、冗余 12、多余兼容 6、超大类 6、扩展性 10、安全与正确性缝隙 10、过期文档与失真注释 10。最大单一主题是**「整条能力只有两端、中间无接线」的死栈**（KB 知识库、workflow DAG、plugins、dry-run）与 **D17 的持续恶化**（session.ts 一天 +188 行）。

---

## 一、死代码与死栈（S 系，9 条）

### S1 ✅【G·重】KB 知识库整栈生产零接线，selfcheck 报喜不报实
- 证据：`src/harness/index.ts:127` 装配处 `builtinTools(this.safety, base, undefined, undefined, …)` 第 3 参 `kb` 硬编码 `undefined`；`new KnowledgeBase` 全仓产品码零构造（仅 2 个测试文件）；`createVectorBackend`/`indexDir` 零生产调用；`store.sqlite-vec.ts:129` 的后端注册靠 import 副作用，而生产无人 import 该模块——注册永不发生。结果是 `kb_search` 工具注册了但生产**恒降级**（`builtin.ts:337` 恒抛 `kb_not_configured`），而 `selfcheck.ts:66-67` 仅凭 env 解析就打印 `kb_search ready (backend=…)`——观测面与装配实况相反。
- 为什么是债：chunk/embed/index/store/store.sqlite-vec 五文件 + conformance 套件的完整「双后端」能力，维护成本全付、生产价值为零；env 配置面（KB_BACKEND/KB_DATA_DIR/EMBEDDING_*）与 MANUAL 模板引导用户配置一条实际接不通的链；sqlite-vec 依赖仍在 package.json 里装运。
- 处置：二选一，禁止现状维持——(a) 装配层补真实接线（resolveKbEnv → embedder + backend → KnowledgeBase 注入），selfcheck 反映真实装配；(b) KB 线冻结则整簇显式退役（移出生产树、依赖与配置面同步收口、selfcheck 文案改「未装配」）。

### S2 ✅【G·中】graph/workflow.ts 死文件及连带死导出
- 证据：`src/graph/workflow.ts`（125 行，validateWorkflow/instantiateWorkflow）全仓唯一 import 方是自身测试；连带死导出 `types.ts:207 WorkflowDef`、`graph/nodes.ts:107 makeCiNode`（唯一产品消费方即本文件）、`graph/agents.ts:6 ROLE_PRESETS`。README/CLAUDE 无 workflow 字样。附带：`workflow.ts:115-116` 的 `as never` 双断言（K 类逃逸）随文件消亡。
- 处置：整文件 + 连带导出删除，测试随迁；若 DAG 工作流仍在路线图，先在 ROADMAP 登记再裁决。

### S3 ✅【G·中】plugins/loader.ts 整模块死代码
- 证据：`src/plugins/loader.ts:13 loadPlugins` 全仓非测试消费者为零；Harness/runtime/CLI 均不扫描 plugins 目录。但 `README.md:28/128` 宣称 `plugins/{id}/plugin.json` 插件机制——「文档已宣称、装配面未接线」的脚手架；`plugins/demo/plugin.json` 的 `entry: "index.js"` 还指向不存在的文件。
- 处置：与 S1 同型裁决——接线或退役；退役时 README/CLAUDE §3/§4 分层叙事同步摘除。

### S4 ✅【G·中】dry-run 特性全链死通道（跨 6 文件）
- 证据：`loop/engine.ts:116,144` 把 `__dryRun` 写进 ctx.state 注释称「透传给节点」，但 loop 四类节点无一读取——透传断头；`graph/engine.ts:135` 引擎层拦截 dry-run 直接产 preview 行，`graph/nodes.ts:113` 节点层 `__dryRun` 分支因此**不可达**；CLI 两个命令均无 `--dry-run` 旗标，生产零调用；同族 `chain.ts:450-452 preview()` 生产测试双零调用（✅亲证），`security/dryrun.ts` 整类只被测试注入占位。
- 处置：整族裁决——接通（CLI 旗标 + 节点消费）或清除（dryrun.ts、chain.preview、两引擎 dryRun 参数、makeCiNode 死分支、`__dryRun` 魔法键）。

### S5【G·中】会话持久化双轨：context 侧整套已死 + selfcheck 假命中率
- 证据：`context/session.ts:10-30 SessionStore.save/load` 生产零调用（仅测试）；`context/index.ts:175 exportSessionState()` 生产零调用；生产会话恢复唯一走 `tui/session-journal.ts` 事件重放。`selfcheck.ts:65` 的 `hitRate()` 因 `load()` 永不被调，hits/misses 恒 0——打印的「缓存命中率 0.0」是假指标。
- 处置：删除 SessionStore 与假命中率行；`exportSessionState` 无 journal 备用规划则降级为测试工具或移除。

### S6【G·中】零调用死出口集合（7 件）
- 证据（均全仓 grep 亲证或机械扫确认）：① `graph/engine.ts:87-89 topo()` ✅——注释自我标注「兼容保留」，零调用；② `chain.ts:451 preview()` ✅（见 S4）；③ `tasks.ts:120 TaskRegistry.stopAll()`——注释承诺「宿主退出收口（规格 D9）」但 CLI/TUI 退出路径均未接线，进程退出时 running 后台任务无终态行、日志永久半截；④ `worktree.ts:119-129 detectIsolation`——仅测试消费，设计初衷（`--worktree` 装配前检测）未接线；⑤ `steering.ts:8/20/37-39 deliveredCount/delivered()`——注释宣称「服务于收口兜底判定」而收口判定实际未读它；⑥ `Harness.enterWorktree/exitWorktree/cleanupWorktrees + visitedWorktrees`（`harness/index.ts:211-260`）——约 50 行会话管理 apparatus 生产零调用，唯一生产路径（worktree 工具 `builtin.ts:522`）直改 `safety.enterWorktree` 绕开记账，且 exit 守卫双实现两套文案（`builtin.ts:526` CodedToolError vs `index.ts:246` 裸 Error）；⑦ `i18n.ts:15 getLanguage`——仅测试探针。
- 处置：逐件裁决接线或删除；③⑥ 涉行为承诺（退出收口、树清理记账），优先补接线测试或修订规格注释后删。

### S7【G·中】死导出与死类型（机械扫确证）
- 证据：完全死导出 4 件——`ChildTranscript.tsx:25 estimateSegLines`、`types.ts:28 StructuredAction`、`types.ts:223 MemoryLevel`、`theme.ts:19 ThemeColor`（全仓含测试零引用）；仅测试消费的值导出 9 件中值得处理的是 `knowledge/store.ts:23/77/82`（随 S1 裁决）与 `App.tsx:38/45 slashCandidates/nextSlashCompletion`——Tab 补全语义已在其 `App.tsx:668` 内联重写，旧纯函数仅测试维持（重复实现）。另有 119 处「零跨文件消费、仅本文件内使用」的导出冗余（92 type/21 value 等，去掉 export 关键字级别，清单见机械扫 out.json）。
- 处置：4 件死导出当轮删；App.tsx 双函数删或回接消内联重复；119 处导出冗余可按目录分批摘 export。

### S8【G·轻】零散死物三簇
- 证据：① `context/window.ts:78-84` 死局部 `dropped`、`:19-21 ContextItemEstimate` 死载荷（两个生产调用方只消费 `.used`）、`:31-38 KIND_WEIGHT` 的 tool/result 权重无生产者（连带 `types.ts:385` 联合类型死分支）；② `ChildPanel.tsx:12 selectedLabel` prop 生产测试双零传——2020-09-28「选中态收敛 BrowseList」改造残肢，其三分支全死；③ `model/adapter.ts:104 LLMConfig.timeoutMs` 死旋钮——全仓构造方均不传、无 env/语义键/flag 对应，600s 是唯一活值。
- 处置：①② 删除；③ 要么接线 `SUNSHINEX_MODEL_TIMEOUT_MS`，要么删字段落命名常量。

---

## 二、冗余：复制粘贴族谱（R 系，12 条）

### R1 ✅【G·重】loadSettingsChain 双胞胎入口
- 证据：`src/index.ts:5-20` 与 `src/cli/index.ts:28-40` 函数体逐行相同（亲证 diff）；`src/index.ts:24-30` 仍执行模块级副作用（装载 settings + 打印骨架占位语），`--selfcheck` 分支打印「selfcheck 已迁移至 CLI」自证残渣；`package.json` 的 `main`/`start` 仍指向 `dist/index.js`。
- 处置：收敛为单一导出（落 config 层或 cli 专属模块）；src/index.ts 改纯库导出面或删除，main/start 改指 cli。

### R2【G·中】CLI 收尾三连复制 3 份
- 证据：`run-pipeline.ts:76-80`（paused 分支）与 `:86-90`（正常分支）逐字相同四行（pipeline.drain → mcpWarnings → mcpClose → exitCode），`run-loop.ts:39-43` 第三份。
- 处置：提 `teardownCliRun(deps, status)` 单点。

### R3【G·中】Kahn 环检测算法两份
- 证据：`graph/engine.ts:50-84 layers()` 与 `graph/workflow.ts:54-85 validateWorkflow` 内联预检逐行同构，错误文案已分叉两套（`cycle members and downstream` vs 无）。随 S2 裁决可能自然消亡；若 workflow 复活则先抽 `detectCycle()` 纯函数单点。

### R4【G·轻】escapeRegExp 三份 + globToRegex 两份
- 证据：`config/permissions.ts:68`、`security/rules.ts:17`、`security/sandbox.ts:173` 三份逐字符等价；`rules.ts:7` 与 `sandbox.ts:147` 两份同义 glob 转换。permissions 的 `pathGlobToRegex` 语义不同（`**` 跨段）分立合理。
- 处置：文本原语收敛进 paths.ts 同级叶子模块；语义差注释化。

### R5【G·轻】slug 折叠算法三份
- 证据：`tasks.ts:25-32 labelSlug(≤16)`、`worktree.ts:105-113 slugifyLabel(≤27)`、`skills/learned.ts:25-34 slugify(≤40)`——同一正则链三份拷贝，learned 注释自认「对标 worktree 同款口径」。
- 处置：收敛 `slugify(text, {max, fallback})` 单点。

### R6【G·轻】frontmatter 解析器四份（两族）
- 证据：harness 族 `skills.ts:7-27`（宽容）与 `subagent.ts:48-61`（严格 fail-fast）词法核心逐字相同——严格度差异是刻意，词法是复制；memory 族 `memory/store.ts:88 parseRecord`（严格）与 `memory/writer.ts:44 parseFrontmatter`（宽松）同格式两套接受面，kv 逐行拆解逐字同构。
- 处置：各族抽共享 `parseFrontmatterKV`，包装层留各自校验/缺省策略；宽松度差异若刻意须注释+对照测试。

### R7【G·中】判定集与常量多份并存（memory 域）
- 证据：`MemoryType` 合法集三份（`store.ts:28`、`extractor.ts:135 WRITABLE_MEMORY_TYPES`、`writer.ts:20`）；`INDEX_NAME='MEMORY.md'` 两份（store:58/writer:19）；4096 截断两名（`context/index.ts:418 DRIFT_MAX_CHARS`、`extractor.ts:108`，注释自称「同水位对齐」却无单一来源）；`extractor.ts:77` 内联重写 `consolidate.ts:144 coerceType` 谓词（注释互认同口径）。
- 处置：store.ts 导出单点，两处 import；水位与 coerceType 同步收敛。

### R8【G·轻】「Current instruction: 」任务行前缀 6 处手拼
- 证据：`graph/nodes.ts:42`、`graph/agents.ts:51`、`tui/session.ts:730/1102/1135` + subagent 调用方——模型赖以识别当前指令的协议格式散落多点；fork 种子构造 `graph/nodes.ts:36-44` 与 `subagent.ts:385-392` 同构有漂移缝隙。
- 处置：`buildTaskLine(text)` 常量单点（appendInstructionLine 已是方法单点，前缀仍是散的）。

### R9【G·中】长任务量级缺省与注释多点失真
- 证据：400 步缺省双点（`reactor.ts:135` 与 `graph/agents.ts:53` 同一回退链抄两份）；24h 兜底双点（`graph/templates.ts:9` 与 `loop/templates.ts:149 LONG_TASK_TIMEOUT_MS` 靠抄数字对齐）；32MB 双点（`sandbox.ts:31/48` 同文件两个字面量）；**注释失真实锤**：`loop/templates.ts:152`「缺省交给 Reactor 的 200」（实际 400）、`subagent.ts:151`「与 reactor 并行批上限 8 同量级对齐」（`reactor.ts:119 PARALLEL_TOOLS_LIMIT=16`）、`subagent.ts:486` 工具 description 硬编码「cap 8」、`prompts/shared.ts:43` 提示词行硬编码「up to 16」需手动对齐。
- 处置：termination-config 增 `REACTOR_MAX_STEPS_DEFAULT`/`LONG_TASK_WALL_CLOCK_MS` 常量三处引用；description/提示词行改模板引用常量拼装；失真注释修正。

### R10【G·中】TUI 渲染知识三处同构（双渲染链 + 估算链）
- 证据：主链 `md-ansi.ts renderMd`（markdansi）、回看链 `markdown.ts`+`MarkdownText.tsx`（markdown-it IR）、估算链 `markdown.ts:410 markdownRowCount` 三套并立，共同样式知识靠人肉同步——① 高亮色映射两份（`md-ansi.ts:9 HI_SGR` SGR 码 vs `MarkdownText.tsx:57 HI_COLOR` ink 色名，注释自认「同色系」）；② hr 渲染两份逐字重复；③ 表格超宽降级两处同构；④ 折行预算三套。另：全角归一双模块复制（`md-ansi.ts:83-85 normalizeCjkLine` vs `markdown.ts:142/149 preprocess`，注释自认「承接旧 preprocess」）+ 表格实跑路径三重归一（renderSource→renderGridTable→parseMarkdown 各归一一遍）；CSI 原子扫描器两份逐行相同（`md-ansi.ts:44-56` vs `:150-160`）。
- 处置：短期抽共享常量/归一模块；中期评估回看链统一走 renderMd 后 MarkdownText 仅剩估算职责。

### R11【G·轻】TUI 布局杂项多点
- 证据：`● [VERB] target` 调用行渲染三份三套宽度算法（`ToolRow.tsx:39` 预算 columns-5、`ChildInspector.tsx:226` columns-2-verb-3、`ChildTranscript.tsx:93` 固定 columns-10）；滑窗分页两份（`SlashMenu.tsx:17` vs `BrowseList.tsx:24`）；THINK_TAIL_LINES=6 两处、预览上限 28 三处且下限 4/8 不一致；session 层「>8 切筛选卡」三处、描述截断 60/48/128 散落；输入历史上限 100 两处。
- 处置：调用行抽共享组件；阈值收单一常量模块。

### R12【G·轻】杂项复制粘贴
- 证据：exec 任务 label 提取两份（`builtin.ts:81/99`）；reactor 主动/反应式压缩的 `runCompaction` 第四参对象逐字相同（`reactor.ts:248-253/312-317`）；MEMORY.md 读取两份（`context/index.ts:401-407` vs `memory/store.ts:150-156`）+ memory 目录路径拼接四处；`ModelTier/ReasoningEffort` 双导入源（`adapter.ts:6` 转出口 vs types.ts 正字源，消费面两路）；五兼容技能根清单双份（`skills.ts:35` vs `skills-install.ts:20-27`，顺序语义还不同）；`summarizer.ts:23-25` 对 prompts/summarizer 的中转再导出制造双 import 路径。
- 处置：逐项收敛单点；ModelTier 转出口删除统一从 types 导入。

---

## 三、多余兼容（C 系，6 条）

> 判据：CLAUDE.md §5 核心契约零兼容——无调用方的「兼容保留」即残渣；防未来而保留的形态须显式登记。

### C1 ✅【G·中】`topo()` 自我声明的「兼容保留」
- 证据：`graph/engine.ts:87-89` 注释原文「拓扑扁平序（兼容保留）」，全仓零调用（亲证）。
- 处置：删除。（并入 S6-①）

### C2【G·轻】MessageList `previewCap` 退役口径自相矛盾
- 证据：`MessageList.tsx:174-180` 头注宣称「previewCap 退役：恒高窗口本身即帧高限界（prop 保留签名兼容）」，但紧邻注释与实码（`:202` slice、`:212` `previewCap ?? Math.min(28,…)`、App 两处仍计算传入）表明 prop 实活——两段注释互相矛盾且第一段与代码不符，照注释删 prop 会引入截断回归。
- 处置：先裁定 previewCap 生死，再正名注释。

### C3【G·中】dry-run 引擎层拦截 + 节点层不可达分支（并入 S4）
- 证据：见 S4。保留节点分支的唯一理由是「万一引擎放行」，正是需要预测另一层行为的补丁形态。

### C4【G·轻】resolveProjectPath 生产面恒 no-op 的双轨
- 证据：`builtin.ts:20-22` + 三处消费；生产链 `chain.ts resolveSafe` 对 PATH_TOOLS 恒带绝对 safePath，`path.isAbsolute(p)` 恒真，函数体死跑；仅测试桩链走活。两轨锚点语义不同（safePath 锚活动根，本函数锚装配根），一旦活转即分叉。
- 处置：删除或注释明确「桩链兜底」并标注锚点差异。

### C5【G·轻】SafetyChain.evaluate 同步评估面生产零调用
- 证据：生产唯一执行入口 `tools.ts:96` 走 `evaluateAsync`；`chain.ts:65-74` evaluate 与 `:78-95` evaluateAsync 各自手写「guard → PATH_TOOLS → resolveSafe」骨架，同步版仅测试消费但活在生产 API 面。
- 处置：evaluate 改为 evaluateAsync 的同步子集复用，删独立骨架。

### C6【G·轻】spawn 入参三层归一（幂等防御，登记豁免即可）
- 证据：registry 边界 `stripNullInputArgs`（tools.ts:94）→ `validateSpawnInput` 内归一即弃（subagent.ts:251）→ `runSubagent/spawnBackground` 再各归一一次（:292/:347）。分层有注释交代，validate→run 同路径内的二次归一是纯冗余。
- 处置：归一结果透传复用，或注释声明「幂等多层防御」消除权威层疑问。

**负结论（非多余兼容）**：skills 五根兼容链（.cursor/.codex/.claude/…）是 CLAUDE.md §6 文档化的装载优先级设计，非模型核心契约兼容，不判债；chat-stub 是登记在册的测试 DSL；SSE 传输分支是 SDK 官方支持的互操作保留。

---

## 四、超大类与超长函数（H 系，6 条）

### H1【H·重】D17 证据刷新：session.ts 2351 行、16 职责块、增速加快
- 证据：2026-09-30 登记 2038 → 10-02 实测 2163 → 今 2351（一天 +188）。全文通读细化为 16 块：纯函数/类型区（L32-295）、运行时装配（L376-441）、状态订阅、输入 FIFO、审批挂起、问询管线、暂停确认、中断、/plan、/goal、任务流统计、**斜杠分发 handleSlash 单方法约 355 行（L1192-1546）** + memory 六方法 + skill 面、会话持久化编排（L807-996）、事件路由状态机 onEvent（L1758-1926）、子代理面板五方法（L1976-2170）、流式 md 通道状态机（8 方法 6 字段）。
- 拆分边界建议（先锚点后动刀，现有 25+ 个 session.*.test.ts 就近锚定）：① 纯函数+类型 → chat-model.ts；② md 通道 → md-stream.ts；③ handleSlash 骨架留 facade，memory/model/session 命令各拆 commands-*.ts；④ 子代理面板 → child-panel.ts；⑤ 审批/问询/中断挂起族 → approval.ts。
- 附带小残渣：L287 注释错挂、L1038-1039 同注释逐字两份。

### H2【H·中】App.tsx 974 行，键盘分发器 394 行单闭包
- 证据：`App.tsx:437-830` useInput 单闭包内含问询卡（筛选/多选/自定义双形态）、审批卡、plan 卡、斜杠菜单、inspect/browse、输入编辑（Home/End/⌦/历史/续行/换行）九层 if 链；组件体 20+ useState/useRef。
- 处置：按模态拆 hook（useQuestionKeys/useApprovalKeys/useBrowseKeys/useInspectKeys/useLineEdit），与 D17 同批次规划。

### H3【H·中】ContextManager 九类职责 24 字段
- 证据：`context/index.ts:37-398`——快照装载、漂移探测（4 基线字段）、链账本、压缩协调（含内嵌 fs 读写与预算循环）、文件 LRU、技能待注入槽、会话导出/恢复/订阅、Compact Instructions 双处同构提取、模块级 runCompaction 归档 IO。
- 处置：拆 DriftDetector / ChainLedger / CompactionCoordinator，ContextManager 收窄为门面；单列计划分步。

### H4【H·中】model/adapter.ts 497 行八类职责
- 证据：effort 档位机制、usage 三提取器、契约类型、StubAdapter、LLMConfig、OpenAIAdapter（构造+HTTP+错误映射+effort 探测状态机+wire 序列化+非流式解析+SSE 流式重组）、ScriptedAdapter 测试 DSL、三档 ModelRouter 同文件。model 目录已拆出 catalog/chat-stub，唯独核心 adapter 是包级单文件。
- 处置：按先例拆 effort.ts / usage.ts / wire.ts / router.ts，纯搬移零行为变更。

### H5【H·中】Reactor.chatRound 单函数约 165 行六类职责
- 证据：`reactor.ts:435-599`——消息装配、tools schema 映射、流式分派、空批纠偏、批次政策、**批次签名去重+串/并行执行扇出**（486-584 自成一体的并行执行器）、链行记账混在同一函数；外层 run() 约 270 行。
- 处置：抽 BatchRunner（签名去重+串/并行+结果回发）；测试锚点已充分。

### H6【J·中】builtinTools 13 个位置参数的装配接缝
- 证据：`builtin.ts:50` 签名 `(safety, root, kb?, webSearch?, archive?, skills?, memory?, memoryWrite?, ask?, writeSnapshot?, activeRoot?, todos?, tasks?)`，唯一生产调用 `index.ts:127` 单行 300+ 字符、连排两个 `undefined` 占位；相邻同类型 seam（kb/webSearch）位置错位编译期不报错。
- 处置：收敛为 `opts` 对象，一次性迁移（生产调用 1 处 + 测试桩）。

---

## 五、违背扩展性（J 系，10 条）

### J1【J·中】工具注册表知识硬编码进 TUI 呈现层
- 证据：`tui/tool-verbs.ts:4-19` 逐工具枚举 VERBS、`:32-43` 逐工具硬编码 schema 字段名（question/command/path/pattern/query/url/name）；`session.ts:177-181` spawnBaseLabel 与 tool-verbs 重复实现。harness 增改工具，TUI 呈现静默降级（全大写+JSON 兜底）无告警——违反「渲染层不感知工具实现」边界。
- 处置：工具面向事件面暴露 displayVerb/targetFields 元数据，TUI 只消费。

### J2【J·轻】`provider === 'openai'` 作能力探针
- 证据：`context/summarizer.ts:7`——summarizer/extractor/consolidate/pipeline 四处统一门禁以供应商字符串近似「真实模型」判定；新增真实 provider 时无模型摘要/零记忆提取/零整理，功能静默消失。
- 处置：改显式能力位（capabilities.chat 或桩基类无 chat 面即天然区分）。

### J3【J·中】sqlite-vec 注册工厂违反 store 接缝契约
- 证据：`knowledge/store.sqlite-vec.ts:129` 工厂签名承诺 `(storage) => VectorStore` 却忽略 storage 参数——数据目录用 `process.cwd()` 解析（root≠cwd 场景落错目录）、harness 层 import 期直读 env（与 `embed.ts:10` 自述纪律矛盾）、import 即注册的副作用在生产无人触发（见 S1）。
- 处置：随 S1 裁决一并重设计（显式注册调用 + 装配层传参）。

### J4 ✅【J·中】MCP `env` 配置静默吞弃
- 证据：`types.ts:330` 声明 `env?: Record<string,string>`，`config.ts:88` 解析保留，但 `mcp/client.ts:78` `new StdioClientTransport({command, args})` 不传 env（http/sse 分支同弃）——用户给 MCP 服务器进程配的环境变量（典型 API key）解析后静默消失，零警告零生效（亲证）。
- 处置：stdio 补 `env: {...process.env, ...cfg.env}`；或配置面显式声明不支持并装配告警。

### J5【J·轻】config↔model 双向互指 + config→harness 穿透
- 证据：`providers.ts:12` import model/adapter（EFFORT_ORDER/parseEffort）而 `adapter.ts:4` 反向 import config/termination-config——同目录一处刻意防反向依赖（termination-config.ts:46 注释）、一处直接穿透；`permissions.ts:9` import harness/security/rules。
- 处置：effort 原语下沉叶子模块（可与 H4 拆分合并解决）；rules 固化「永远零依赖」契约注释。

### J6【J·轻】渲染层直读环境与双宽度源
- 证据：`App.tsx:968` 直读 `SUNSHINEX_CONTEXT_WINDOW`（规范解析点在 termination-config.ts:37）；`session.ts:2199-2201 mdWidth()` 直读 `process.stdout.columns ?? 80` 而渲染层经 useStdout 传 columns——测试环境两源即分叉（ansi 按 80 产、组件按 100 布局）。
- 处置：经 TuiState.modelWindow / 装配层注入宽度源。

### J7【J·中】worktree 会话的「活动根」adoption 不完整
- 证据：glob executor `builtin.ts:275` 锚装配期闭包 `root`（chain 的 PATH_TOOLS 不含 Glob、无 safePath 注入）——worktree 会话中模型 glob 到主区文件清单而 read/grep/exec 锚树，正是 `builtin.ts:17-19` 注释自述要防的「glob 看得到、read 读不到」锚点分裂变体；`reactor.ts:429 workDirLine` 恒报主根，与 worktree 工具回执「session working root is now this worktree」自相矛盾。
- 处置：glob 改经 `activeRoot?.() ?? root`；workDirLine 的 root 改活动根提供者求值（fork 的 rootProvider 先例在 `subagent.ts:176`）。

### J8【J·中】KB 双后端 conformance 未锁 meta 契约，两后端已实际分叉
- 证据：契约 `upsert(id, vec, meta)`，调用方传 `{text, file}`；local-json 全量持久化，sqlite-vec 的 kb_meta 表只有 `(rowid, id, text)`——`file` 字段静默丢失（`store.sqlite-vec.ts:36/62-71`）；conformance 套件未断言 meta 完整往返。
- 处置：conformance 补 meta 往返断言；sqlite-vec 补 meta JSON 列或契约显式收窄为 `{text}`。

### J9【J·轻】死旋钮与无校验旗标
- 证据：`LLMConfig.timeoutMs` 见 S8-③；`--model` 旗标有实现（runtime.ts:9-12）但 usageText 不列、assertValidFlagValues 不校验——`--model=typo` 静默按 openai 装配，违背该函数自己立的 fail-fast 纪律；`run` 的 `--worktree` 同病（接线了但 usage 只标 TUI）。
- 处置：旗标进 usage + 白名单校验。

### J10【J·中】IO 散落在 store/adapter 之外（context/memory 三处）
- 证据：`context/index.ts:445-449` 归档直接 mkdir/writeFileSync、`:139-148` 重读直接 readFileSync；`memory/consolidate.ts:67-75/113-122` 对 `store.dir()` 做 .bak 快照/清空/拷回的裸 fs 手术——MemoryStore 布局一旦演进即静默失效，且均不可桩不可替换。
- 处置：MemoryStore 增 backup()/restore() 原语；归档/重读经 StorageAdapter 或独立 ArchiveStore。

---

## 六、安全与正确性缝隙（N 系，10 条，超出指定口径必须上报）

### N1 ✅【J·中】隔离子代理前台 exec 的 landlock 写围栏锚在主根
- 证据：`builtin.ts:96` 前台执行 `await safety.run(cmd, …)` 用**闭包捕获的装配链**（其 `landlockWritableRoots` 的 base=主根），而顶部判界与后台分支（`:80-82`）正确走 `gateView`（fork 克隆链）；`chain.ts:264` 注释自述「registry 注入的 gate 即链实例，fork 克隆自动携带」——但前台 run 没走 gate 实例，克隆没携带上（双 agent 独立发现 + 亲证）。Linux+landlock 在场时隔离子代理对主工作区保持可写，架空隔离承诺；Windows 下 wrap 为 null 无行为差异故长期未察。
- 处置：前台分支改走 gateView（补 run 转发），landlock 单测锚「隔离子链前台 exec 可写根不含主根」。

### N2【G/J·中】worktree 工具绕过 Harness 会话记账单点（与 S6-⑥ 同根）
- 证据与处置见 S6-⑥：工具直改 safety.enterWorktree，visitedWorktrees 永不收录，cleanupWorktrees 即便被调也清不到工具建的树。

### N3【J·中】manual 档只读白名单可被重定向绕过
- 证据：`modes.ts:10-12` READONLY_WHITELIST 含 echo/cd；`guard.ts:211-215` 只取首 token basename 判定；manual 模式命中白名单免审批直接放行——`echo pwned > ~/.bashrc` 命中 echo 直放，且 `~/.sunshinex` 在 landlock 可写根内（chain.ts:272），内核围栏也不拦。
- 处置：白名单命中前嗅探重定向操作符（`>`/`>>`/`tee`）降为 ask，或剔除 echo 类可写命令；安全域单独立项评审。

### N4【J·中】landlock 缺口降级零观测
- 证据：`landlock.ts:2-6` 注释自述「对标 MCP 装配失败警告降级语义」，但 MCP 降级有警告单上屏+链内 notice（loop/engine.ts:125-129），landlock 返回 null 后无任何运行期提示——Linux 用户缺包/内核不支持时 exec 围栏静默失效，仅 selfcheck 可见。
- 处置：探测失败（非 Linux 除外）首次发生打进程级 warning 或链内 notice，与 MCP 同通道。

### N5【J·中】GraphEngine.resume 不重置时钟，挂起等待时间计入超时
- 证据：`engine.ts:93` startedAt 只在 ctx 首建时设定；gate paused 等人工期间墙钟照走，resume 后 `:147-152` deadline 立判——挂起超预算即 resume 秒失败，调大 timeoutMs 还需自行心算补偿。[设计意图待核实：未见 spec 条款裁决挂起时间口径]
- 处置：resume 重锚 startedAt 或累计 paused 时长扣除；或文档写明口径。

### N6 ✅【J·中】selfcheck 漏 MCP 收口，配置 stdio 服务器时可能挂死
- 证据：`selfcheck.ts:41 await h.mcpReady()` 装配了 stdio 子进程，但全文无 `mcpClose`（grep 亲证零命中）；对照 run-loop.ts:42-43 在册注释「关闭 stdio 子进程，防悬挂事件循环」——selfcheck 绕过 buildDeps 手工拼装且不收口，prepublishOnly 钩子在配了 stdio MCP 的机器上可能永不退出。[挂起行为为机理推断，标待运行验证]
- 处置：结尾补 `await h.mcpClose()`（最小修）；中期复用 buildDeps 或抽诊断装配函数。

### N7 ✅（随 S1）kb_search 假就绪 + meta 丢失见 S1/J8。

### N8【G·中】grep 出口未过 archive 预算管线
- 证据：`builtin.ts:51-52` 注释「注册了 archive 的工具出口过 fit」，exec/read/skill/glob/webfetch/worktree 全过 `fitOut`，唯 grep 三出口（:236/:253/:258-259）裸 `execOut`——超 2000 字符（reactor.describe 截断）部分无落盘不可恢复；kb_search(:339)/websearch(:319) 同类未过（有界兜底，轻）。
- 处置：grep 三出口包 fitOut + 「超限输出可 read 恢复」钉子。

### N9【J·轻】GraphEngine 实例二次 run() 静默忽略 goal
- 证据：`engine.ts:91-98` ctx 已存在时 run(newGoal) 的 goal 被丢弃沿用旧值，无警告——埋给复用者的语义陷阱。
- 处置：goal 不同即抛错，或把续跑能力从 run 签名拿掉只留 resume。

### N10【I·轻】extractLearnedSkill 裸吞一切异常且三态合流
- 证据：`skills/learned-extract.ts:39-51` 无 chat 能力/模型没出牌/任何抛错统一 `catch return null`、零注释；下游 `memory/pipeline.ts:129-133` 把 null 解释为「技术失败→回退原始 dump 落盘」——「明确无可提炼」与网络抖动不可区分。附带 :55-67 stringify→再 parse 的双重解析绕行。
- 处置：区分返回形态（skill:null / unavailable），pipeline 只对技术失败回退；catch 补理由注释。

### N11【杂·轻】三件小项
- ① loop 引擎终态文案 i18n 混杂：`engine.ts:204` 走 t() 而 :123/:133/:215 英文单语，同为上屏 error 双语不可预测（graph 侧合格）。
- ② MCP 握手 version `'0.1.0'`（client.ts:92）与 package 0.3.1 漂移。
- ③ 链行 action 词汇 note/notice 分裂无类型约束（`types.ts:414` 开放字符串；note 8 处 notice 5 处，消费面处理完全一致）——定 `ChainAction` 联合类型收窄。

---

## 七、过期文档与失真注释（D 系，10 条）

### D1 ✅【E/B·中】`/terminal-setup` 三源漂移：SLASH_COMMANDS 与 MANUAL 总表双双缺席
- 证据：session.ts 有实现（:1235）与 /help 行（:279），但 `slash-commands.ts`（自称「唯一源…防双清单漂移」）23 项无它，MANUAL 第四节命令总表亦无——命令面板与 Tab 补全不可见，用户只能盲打；`session.test.ts:243-251` 只做正向断言放行了漂移。特性 64a5d37（10-02）落地后两轮文档面均未跟上。
- 处置：入 SLASH_COMMANDS + 描述表 + MANUAL 行；测试补反向断言（/help 每个 `/` 命令 ∈ SLASH_COMMANDS）。中期 slashHelp 从单源派生。

### D2【B·中】MANUAL 快捷键表缺 Shift+Enter / Alt+Enter 换行
- 证据：`use-input.ts:16-18` 已实现（含 kitty CSI-u），KeyHints 矩阵已提示，MANUAL:248 与快捷键表均无。
- 处置：补表行（含「需终端键位绑定，用 /terminal-setup 自动配置」提示）。

### D3【B/F·中】Arch-Plan.md 三处失真
- 证据：:59 旧口径「/model」「/model effort」（实况 /model-tier、/model-effort，/model 已是模型切换）；:63「命令面统一化重设计已定稿待实施」已被实现推翻（ROADMAP 同条目已翻 [x] 补落地号，Arch-Plan 漏改）；:70 依赖列举与 §5 台账互不一致（多列 string-width/cli-table3，漏列 markdansi/landlock-run）。
- 处置：正向修正或收为「以 §5 为准」指针。

### D4【E·中】cli-table3 缺依赖台账登记
- 证据：`package.json:25` 在册、`tui/markdown.ts:1` 在用（表格框线渲染），CLAUDE §5 台账与 §13 组件表均无——两轮「依赖同步」复查均漏。
- 处置：§5 或 §13 补登记（用途+收敛边界）。

### D5【B·轻】PLATFORM.md 两处
- 证据：:17「模板见 MANUAL 第三节」实为第二节（2026-09-30 修过 TECH-DEBT 规则 A 同款错，此处违「上新删旧」）；:10 平台矩阵 CLI 行漏 skills install。
- 处置：改节名、补命令。

### D6【E·轻】CLAUDE §3 目录树缺列新文件
- 证据：`model/catalog.ts`（ModelSwitcher）、`context/breakdown.ts`（/context 数据面）、`tui/md-ansi.ts`（§5 台账明言的「单点出口」）、`harness/guardrail.ts`、`sunshine-init.ts` 均未列（所列文件零悬空）。
- 处置：目录树同步实况。

### D7【B/E·轻】交叉引用失真两处
- 证据：README.md:39 引用 MANUAL 节名「permissions 权限规则与信任目录」（实际节名为 6.1/6.2）；CLAUDE.md:236「同步复核 README 平台支持矩阵」——矩阵已迁 PLATFORM.md。
- 处置：正名。

### D8【B·轻】MANUAL 两处小漏
- 证据：第四节缺 `/add-dir` 行（SLASH_COMMANDS 在列）；:246 状态栏描述漏 effort 段（StatusBar 实况有且丢弃优先序最先）。
- 处置：补行。

### D9【C·轻】builtin.ts 头注 8/13 失真 + tui 四处失真注释
- 证据：`builtin.ts:49` 头注首句列 8 个工具（实际 13，CLAUDE 均为 13 口径）；tui 侧：`ToolRow.tsx:14-16` 头注仍描述已撤除的 spawnExpanded 机制、`session.ts:745` 用已退役 streamer 术语「finish 收口」（10-02 清理轮 9 处漏网）、`:1772`「片段即时入档」与现行块缓冲口径不符、session.ts:287 注释错挂 + :1038-1039 重复（随 H1 附带残渣）。
- 处置：逐条正名。

### D10【工程卫生·轻】
- 证据：根目录 `sunshinex-agent-0.3.0.tgz`（旧版残留，与 0.3.1 并存；均被 .gitignore 覆盖不入库，纯本地卫生）；`plugins/demo/plugin.json` entry 指向不存在文件（随 S3 裁决）。
- 处置：本地清理 0.3.0.tgz；demo 物料补齐或随 S3 退役。

---

## 八、已查无债（负结论，支撑全量声明）

1. **工具注册表未被绕过**：全仓唯一 `tool.executor(` 直调点在 registry.execute 内部，reactor/graph 均经注册表；工具面白名单与 CLAUDE §5 完全吻合，spawn/task_stop/task_wait 均正规注册。
2. **纪律逃逸干净**：产品码 `as any` 恰 2 处且均在 ink-output-guard 豁免清单内；@ts-ignore/@ts-expect-error/eslint-disable/@ts-nocheck 全仓零；TODO/FIXME/HACK 化石零；注释掉的代码块零；恒真恒假分支零；.skip/.only 遗留零。
3. **console 纪律成立**：产品码 58 处 console.* 全部落在 CLI/入口输出面，harness/graph/loop/model/config/tui 核心库内零打印。
4. **吞错 catch 基本有据**：全仓 38 处仅 3 处无注释（websearch.ts:88、session-journal.ts:190/208，语义可推断，建议补一行 why）。
5. **已退役机制四项无行为残留**：文本信封协议、.env 渠道、markdansi streamer、memory 段进提示词——产品码 grep 零命中（现存提及均为「退役说明」性头注，失真 4 处已列 D9）。
6. **平台分支纪律合格**：非测试码 process.platform/win32 仅在 sandbox.ts；路径判界全走 isWithin；maskText 单点无双轨。
7. **guard/rules/policy/modes 分工清晰**；chain.ts 453 行不构成 H 债（单一安全域、spec 逐条背书、方法粒度良好，仅可变状态膨胀提示）。
8. **loop/graph 判据与记账已收敛**：guardrailStop/describeGuardrailHit 两引擎共用；token 记账引擎级统一。
9. **data-dir 无双胞胎**：harness/data-dir.ts 实现文件已不存在，单一权威在 config/data-dir.ts，15 个消费点全部指向它（harness/data-dir.test.ts 是 Harness 级装配契约测试，落位正当）。
10. **厂商特判零泄漏**：model/ 全目录 grep 厂商名仅 1 处注释；reasoning_content/effort 降级均为协议级归一。
11. **chat-stub 定位准确**：仅测试消费，与登记口径一致。
12. **配置面无死键无漂移**：34 个语义键逐一有消费点；MANUAL 模板与解析器逐项吻合（含 providers 两级 contextWindow/reasoningEffort）；版本号全对齐 0.3.1；M 存在史词活文档正文归零。
13. **skills 五根链非债**（文档化设计）；**session-journal/snapshots 无双写**；**ModelSwitcher/effort 降级/流式回落契约合格**；**SSE 传输互操作保留合理**。
14. **resolveShell 无缓存**（每次 exec 全量探测，landlock 有缓存的不对称）已识别为轻债，随 N 系排期（security 调研 F13，未单列编号——并入 R9 处置批次顺手收敛）。
15. **scripts/ 五脚本无死脚本**；CI 矩阵/gitattributes/editorconfig 三方一致；ROADMAP/HARNESS-BACKLOG 状态抽查无假态；specs 引用无悬空。

---

## 九、处置建议（分批）

| 批次 | 内容 | 项 |
|---|---|---|
| 批A·当轮轻扫（纯删/纯记录，build+全量测试即可交付） | 死代码与文档 | S2/S4(裁决后清)/S5/S6(①②④⑤⑦)/S7/S8-①②/R2/R4/R5/R6/R7/R12/C1/C4/C5、D1–D10 全部、N8、N11-③、R9 失真注释修正 |
| 批B·行为修正小步（先锚点后动刀，逐项立项） | 正确性与接缝 | N1（前台 exec 缝）/N3（重定向绕过）/N4（landlock 观测）/N5（resume 时钟）/N6（selfcheck 收口）/J4（MCP env）/J2/J3/J7/N9/N10/J8/J9/R3/R8/R9(常量化)/R10(共享常量)/R11/H6/C2/C6/J5/J6/J10 |
| 批C·重构立项（plan→execute→review，明确验收） | 结构性 | H1（D17 拆分，边界建议已备）/H2（App 键分发拆 hook，与 D17 同批）/H3（ContextManager 拆）/H4（adapter 拆）/H5（BatchRunner）/S1（KB 整栈裁决：接线或退役——**最优先**，观测面失真）/S3（plugins 裁决）/J1（工具元数据下泄 TUI）/R1（入口收敛）/R10 中期（渲染链统一） |

**台账登记建议**（下一轮清理时执行，编号续 D18+）：D18=KB 整栈裁决（S1+J3+J8+selfcheck 假就绪，重）；D19=前台 exec 安全缝+worktree 活动根 adoption（N1+J7+S6-⑥+N2，中，同根立项）；D20=selfcheck 装配与收口（N6，中）；D21=MCP env 吞弃（J4，中）；D22=manual 档重定向绕过（N3，中，安全域评审）；D17 证据列刷新 2351 行。其余轻项按批A 当轮清、不留待办。

---

## 执行状态与勘误（2026-10-03 批A 收尾时点）

**已清**（明细见台账 2026-10-03 行）：S2、S4（含 C3）、S5、S6①②④⑤、S7（App 双函数/ChildPanel/ChildTranscript/theme/types 四件 + 级联 Spinner.selected、App 的 SLASH_COMMANDS 再导出）、S8①②、R2、R4（escapeRegExp 三处收敛；见勘误①）、R5、R6、R7、R12（ModelTier 转出口除外）、C1、C4（裁决：保留桩链兜底+why 注释）、D1–D10 全部、N8、N11-③、R9（注释修正 + 提示词常量化，见勘误②）。新增两个根层叶子：`src/textmatch.ts`、`src/slug.ts`。

**勘误**：
1. R4 部分误判——`sandbox.ts:147` 的 glob 转换与 `rules.ts:7` 语义**不同**（`*`/`?` 不跨 `/`、`**/` 跨段、自带锚定，服务 listFiles 匹配面），非重复；批A 只收敛 escapeRegExp×3 与 rules 侧简单 glob，sandbox 本地实现保留分立并注释。
2. R9 处置偏差——`PARALLEL_TOOLS_LIMIT` 常量设想落 reactor.ts 由 shared.ts 引用，实测反向引用成 CJS 环（shared 在 reactor 导入期求值）；终态常量落 `prompts/shared.ts` 叶模块、reactor 反向消费，单一来源与字节等价目标不变。

**遗留轻项**（未立项，后续清理轮顺手清）：119 处零跨文件消费的导出冗余（机械扫清单，按目录分批摘 export）；C5 evaluate/evaluateAsync 双骨架（安全域，需先补行为锚点）；C6 spawn 三层归一幂等注释；ModelTier/ReasoningEffort 双导入源（adapter.ts:6 转出口，跨域改动）；3 处无注释 catch（websearch.ts:88、session-journal.ts:190/208）；i18n.ts:15 getLanguage 测试探针导出。

**验证口径**：tsc strict 零报错；全量 1499 例 1497 过/0 败/2 既有 win32 跳过；selfcheck exit 0。

## 批B执行状态（2026-10-03 第二批·正确性与安全缝）

**已偿还并翻 closed 入归档**：D18（KB 全栈接线，裁决=接线分支——五处在册承诺使接线成为让承诺为真的一侧，退役属破坏性需用户明示；含 J3 工厂契约、J8 meta 契约、selfcheck 真实化、TUI 面接入；索引构建入口缺口新立 D28）、D19（前台 exec 改 gateView.run + glob/workDirLine 活动根 + Harness worktree 三接缝裁决删除）、D20（selfcheck 补 mcpClose）、D21（MCP env 透传）、D22（manual 档重定向嗅探降 ask）。批B顺手清：websearch.ts 无注释 catch。

**批B执行中新登记**：D27=TUI/CLI 装配双轨（createRuntime 绕过 buildDeps，kb 未接为首个可见症状；已用 resolveKnowledgeBase 共享单点最小止血）；D28=kb 索引构建无生产入口（含 KbHit.file 未下泄，产品裁决）。

**验证口径（批B后）**：tsc strict 零报错；全量 1519 例 1517 过/0 败/2 既有 win32 跳过；selfcheck exit 0 且 kb 行为真实装配态。

## 批C执行状态（2026-10-03 第三批·裁决件 + 结构批起步）

**用户裁决落地**：D23=plugins 整体退役（代码+文档叙事收口，`sunshine-init.ts` 通用扩展点枚举核实保留）；D28=kb 索引双入口（CLI `kb-index` 子命令 + TUI `/kb-index`，索引函数单点+活性实例登记+KbHit.file 下泄）；结构批=本会话小步推进。

**已偿还翻 closed**：D23、D24（stopAll 退出收口：CliRunDeps 透传+teardown 链+TUI 'exit' 钩子，双钉判别力实证）、D28。**D25/H6 完成**（builtinTools 13 位置参收敛 opts 对象，20 处调用点迁移，行为零变化）。

**D25 余项推进序**：chatRound BatchRunner（H5）→ adapter 拆件（H4）→ ContextManager 拆（H3）→ session.ts/App.tsx 拆分（D17/H2，与 D27 装配双轨收敛同批）。

**验证口径（批C后）**：tsc strict 零报错；全量 1533 例 1531 过/0 败/2 既有 win32 跳过；selfcheck exit 0。

## 批D/E/F执行状态（2026-10-03 结构批收官 + D26 轻件组）

**已偿还翻 closed**：D25 全批（批D：H5 BatchRunner/H4 adapter 四件/H3 ContextManager 三件，e8d94c9；H6 批C）；**D17**（批E：session.ts 2389→1306 五步拆分七件、薄委托保公开 API，25+ 测试文件零改动；B5 扫描面同步八件）；**H2**（App.tsx 954→591 五 hook、模态判定序十一层显式契约，App 系 119/119 零改动）；**D27**（批E：runtime buildHarness 单点、生产面 new Harness 仅剩两处、kb 两路同源钉+装配单点形态钉）。**D26 轻件已随批F偿还**（704a1e6）：R1 双胞胎入口收敛+src/index.ts 纯库面、J2 capabilities.chat 能力位门禁（provider 字符串探针退役）、J6 双源收敛、J9 --model 校验+timeout 旋钮 env 接线、C5 decideWithGuard 单点（两入口 raw 口径差异刻意保留）、ModelTier 转出口/C6 注释/两 catch why。

**D26 余项**（open）：J1 工具元数据下泄 TUI（涉事件面契约设计）、J10 IO 收敛三处、R10 中期渲染链统一（涉视觉回归，先锚点）+ 尾巴（catalog timeout 旋钮、run --worktree usage、119 导出冗余、getLanguage）。

**验证口径（批F后）**：tsc 零错；全量 1554 例 1552 过/0 败/2 既有跳过；selfcheck exit 0；node dist/index.js 库面零副作用。
