# SunshineX 架构设计与技术选型

> 本文档记录 SunshineX 的目标架构、技术栈与核心能力现状，随实现同步维护。产品愿景与验收口径以 `docs/GOAL.md` 为单一权威；工程协作规范见根目录 `CLAUDE.md`；阶段路线与进度见 `docs/ROADMAP.md`。

## 一、项目定位

SunshineX 是个人开发者本机运行的通用 AI Agent：云端大模型负责推理，本地负责编排、执行、安全与记忆。北极星场景锁定复杂编码长任务（跨文件重构、测试闭环、多步工程）。

- 对标基线：Claude Code（交互形态与工程闭环）、OpenAI Codex（分层算力与工作台）、Hermes（模型无关与持久进化）
- 用户形态：本机安装运行、数据全本地、单人使用
- 交互面：TUI 为第一入口（对标 Claude Code），CLI 承载执行面，GUI（对标 Codex 工作台）规划中、spec 先行
- 分发：GitHub Release 附件直装为主，npm registry 正式发布为辅

## 二、系统架构

### 2.1 分层与装配

分层依赖方向：`graph → loop → harness → model / storage / plugins`。Graph 节点可嵌入 Loop 子流程，二者均运行在 Harness 底座之上。运行时装配收敛于 `src/runtime.ts`（buildDeps），CLI/TUI/GUI 交互面只做参数解析与呈现、共用同一装配根。

### 2.2 上下文模型：单一基座 + fork

前缀缓存是产品第一要义（相邻请求 token 前缀命中率最大化）。一帧上下文自上而下：

```text
[稳定段]      身份/输出约定/工具清单/JSON 协议/工作目录/执行协议行  ← 逐字节冻结
[SUNSHINE.md] 全局 ~/.sunshinex/SUNSHINE.md → 项目 SUNSHINE.md      ← 会话级冻结快照
[技能清单]    name+description 索引（按名排序冻结）                  ← 模型经 skill 工具按需加载正文
[压缩块]      会话链前缀折叠摘要（模型驱动六要素 + 确定性回退）      ← 唯一合法重写产物
[会话链]      任务指令行 + 全量执行轨迹                              ← append-only，只在尾部变
[fork 尾追]   角色行 + 节点任务行 + 私有步骤                          ← 仅 graph 节点 / 子代理
[技能块]      一次性注入置尾（loop 内部面）
```

会话开始装载 → 运行中动态改动一律尾追 → 轮次起点主动探测漂移并尾追差异；快照重写只发生在刷新点（构造 / /init / /new / 压缩成功）。完整不变量见 `CLAUDE.md §11`，设计原文见 `docs/superpowers/specs/2026-09-14-context-fork-design.md`。

### 2.3 Harness 运行时层（src/harness/）

- **项目感知**（perception.ts）：目录/依赖/SUNSHINE.md/Git 扫描
- **Reactor 最小闭环**（reactor.ts）：observe→think→act，缺省 400 步宽预算（`SUNSHINEX_MAX_STEPS` 可调）
- **统一工具面**（tools.ts / tools/）：read、write、grep、glob、exec、webfetch、websearch、kb_search、skill、memory_write、ask_question，统一注册表 + 安全链；工具参数一律 JSON Schema 声明化
- **安全管控**（security/）：权限三态（deny/ask/allow）、SafetyChain、ProcessSandbox 子进程单点（exec shell 由 `resolveShell()` 跨平台解析）、凭据脱敏、dry-run 接缝
- **记忆双轨**（memory/ + skills/）：程序性记忆 LearnedSkillStore（任务收口沉淀可复用技能，FIFO 上限）+ 陈述性记忆 auto memory（MEMORY.md 索引 + 记录文件，提取挂 settle 单点、后台管线空闲消化、/memory 命令族管理）
- **技能体系**（skills.ts）：三级根装载（项目级 `.sunshinex` > 全局级 `~/.sunshinex` > 学习级 `data/skills`），标准形态 `{id}/SKILL.md`，清单冻结注入 + skill 工具按需加载正文
- **子代理**（subagent.ts）：SubagentRunner 单点承载 fork 组装/结论回写/预算换算/并发护栏；spawn 工具 + `agents/{id}/agent.md` 目录注册制；同层并发上限 4
- **会话持久化**（tui/session-journal.ts）：journal 逐事件落盘，崩溃丢失窗口收敛至在飞一个工具步；/resume、CLI `--continue` 恢复、/rewind 代码回退（write 影子快照）、/fork 不可变分档
- **MCP 客户端**（mcp/）：官方 SDK 接缝，stdio/http/sse 三传输，装配期 fail-fast 注册
- **知识库**（knowledge/）：本地向量知识库，local-json 与 sqlite-vec 可插拔双后端

### 2.4 Loop 迭代层（src/loop/）

闭环引擎 + Agent/Check/Gate/Router 四类节点；`/goal` 验收修正环：目标整体为自由文本判据（模型判据，verdict 三值 met / not-yet / impossible）、可恢复错误分级重试 ≤3 次、impossible 即终局、预算耗尽 paused 可重跑续走；模板注册表为内部扩展点。终止参数收编 settings.json（maxSteps / maxLoopIterations / maxGraphNodes），兜底宽预算（400 步 / 200 轮 / 1000 节点步），墙钟时长仅作失控保底。

### 2.5 Graph 编排层（src/graph/）

DAG 拓扑引擎（环检测携带环路径）+ loop/agent/gate/ci 四类节点 + 五节点软件工程流水线模板；角色代理经 makeRoleAgent 薄入口复用 SubagentRunner；节点私有 fork、终态一行结论/补丁行回写主链；gate 人工审批、错误局部化、预算跨层贯通。

### 2.6 模型适配层（src/model/）

OpenAI 协议兼容适配器（内置 fetch 直连、流式/非流式双路），核心契约走模型原生 function calling；三档算力路由（small/medium/large）为用户级会话参数（`--tier`、/model），请求级字段不进提示词；reasoning_effort 七档思考强度（`--effort`、/model effort）按端点能力阶梯降级探测；per-run 成本账本（ledger.ts）承载 usage 与缓存命中口径。

### 2.7 交互面

- **CLI**（src/cli/）：selfcheck / run / pipeline 子命令 + 全局 flags（`--mode`、`--language`、`--tier`、`--effort`、`--continue`、`--worktree`、`--workdir`）；命令面统一化重设计已定稿待实施（`specs/2026-09-21-cli-tui-interaction-redesign.md`）
- **TUI**（src/tui/，已交付）：会话 REPL、Static 化历史 + 动态帧流式渲染、Markdown 全框线表格（对标 Claude Code）、plan/goal/子代理面板、审批卡与统一选择器、斜杠命令族、状态栏（cache/ctx/turns/steps/tier/effort）、运行中中断与 steering 穿插提示词、worktree 隔离入口
- **GUI**（规划）：Electron 桌面壳 + Vue3 组件体系，组件选型唯一登记于 `CLAUDE.md §13`

## 三、技术栈

- 底座：Node.js ≥ 22.9、TypeScript（strict）、pnpm（packageManager 钉版）、node:test（测试零框架依赖）
- 已引入依赖（用途/收敛边界/回退预案）唯一登记于 `CLAUDE.md §5` 依赖台账：ink + react、markdown-it、highlight.js、string-width、cli-table3、sqlite-vec、@modelcontextprotocol/sdk
- GUI 规划选型唯一登记于 `CLAUDE.md §13` 组件选型登记表（Electron ≥ 30、Vue 3 + Naive UI、Monaco Editor、@antv/g6、xterm.js + node-pty、pinia、splitpanes、chokidar、electron-vite 工程化等）
- 存储：本地 JSON 底座（src/storage/）；运行时数据（账本/记忆/学习技能/KB/会话日志/worktree）统一落 `~/.sunshinex/projects/<工作区>/data`
- 配置：settings.json 两级装载（全局 `~/.sunshinex/settings.json` + 项目级 `.sunshinex/settings.json`），语义键 + env 透传块，JSONC 容忍；全局约定层 `~/.sunshinex/SUNSHINE.md` 对标 `~/.claude/CLAUDE.md`
- 平台：Windows / macOS / Linux 三平台可部署，LF 由 `.gitattributes` + `.editorconfig` 机器强制，CI 矩阵 ubuntu+windows × Node 22/24；机制细节见 `docs/PLATFORM.md`

## 四、依赖引入与候选池

引入原则与评审标准见 `CLAUDE.md §5`（解决真实问题、维护活跃、类型完善、许可证兼容、依赖面可控）。候选选型池（引入前逐项评审）：项目感知增强 tree-sitter / depcheck；执行后端 dockerode（已登记 GUI 可选增强）/ ssh2；存储 better-sqlite3 / keyv；向量匹配 chromadb。

## 五、关键设计规格索引

历史规格与实施计划全量存档于 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`，代表性设计：

| 主题 | 规格 |
|------|------|
| 统一运行时主链 | 2026-09-04-harness-unified-spine-design.md |
| 上下文单一基座 + fork | 2026-09-14-context-fork-design.md |
| 子代理 | 2026-09-14-subagent-design.md |
| /goal 对齐 Claude Code | 2026-09-16-goal-claude-code-alignment-design.md |
| 模型驱动压缩 | 2026-09-16-model-compaction-design.md |
| auto memory / 记忆管线 | 2026-09-18-auto-memory-design.md、2026-09-19-memory-pipeline-learned-extraction-design.md |
| 全局配置 settings.json | 2026-09-19-global-settings-json-design.md |
| 提示词语言规范 | 2026-09-18-prompt-english-only-design.md |
| Worktree 隔离 | 2026-09-20-worktree-isolation-design.md |
| 交互重设计（CLI 判界 / 斜杠选择题化 / 文档拆分） | 2026-09-21-cli-tui-interaction-redesign.md |

会话持久化 + resume、rewind/fork 回溯、事件级落盘、思考强度 effort、终止参数 settings 化、模型侧原生 function calling 迁移等线的设计原文同见 `specs/` 对应日期文档。

## 六、核心风险与对策

| 风险 | 对策 |
|------|------|
| Loop 失控（无限循环 / token 超支） | 步数/轮次/节点宽预算 + token 预算 + 墙钟失控保底；超支 paused 不伪造完成 |
| 端点能力差异（function calling / effort / 缓存） | 核心契约零兼容（不支持即换端点）；effort 阶梯降级；前缀缓存以探针口径观测、缺口归端点侧 |
| 跨文件重构依赖漏改 | 模型判据 + 测试闭环 + /goal 修正环定向回修 |
| 误操作与越界写 | safePath / isWithin 路径判界单点 + 权限三态审批 + write 影子快照支撑 /rewind 回退 |
| 平台差异（shell / 路径 / 文件锁） | ProcessSandbox 与 resolveShell 单点收敛 + CI 双平台矩阵 + 平台差异登记（`docs/PLATFORM.md`） |
