# CLAUDE.md

本文件是 SunshineX 项目的 AI 协作规范，供智能体与开发者共同遵守。
它是项目的「工作说明书」，优先于模型默认行为；冲突时以本文件为准。

## 1. 项目概览

- 名称：SunshineX —— 通用 AI Agent 工程化骨架
- 范式：Harness / Loop / Graph 三层嵌套
- 技术栈：TypeScript（strict）+ Node.js，CommonJS 模块
- 定位：云端推理，本地负责编排、执行、安全与记忆
- 对标：OpenAI Codex / Claude Code / Hermes
- 交互面对标：TUI 已交付（对标 Claude Code）、GUI 规划中（对标 Codex 工作台）——构建规范见 §13

## 2. 常用命令

```bash
pnpm build      # 编译 TS 到 dist/（tsc -p tsconfig.json）
pnpm start      # 运行入口（node dist/index.js）
pnpm selfcheck  # 编译并运行骨架自检
pnpm test      # 编译 + 全量单测（scripts/run-tests.js 启动，测试数据目录钉仓内 .data-test 防污染用户全局区）
pnpm cli       # CLI 执行面（内置自动构建，自动装载 settings.json）
pnpm install   # 安装依赖
```

> 包管理器统一 pnpm：版本由 `packageManager` 字段钉定（corepack 启用后直接使用 `pnpm`）；`.npmrc` 已将 store 固定在仓内 `.pnpm-store`，依赖安装与缓存随仓库走（部署口径见 `docs/PLATFORM.md`）。

## 3. 目录结构

```text
src/
  index.ts            # npm/pnpm start 入口（装载 settings.json 配置链）
  cli/                # CLI 执行面（selfcheck / run / pipeline）
  types.ts            # 全局共享类型（新增共享类型一律在此登记）
  result.ts           # Result 统一结果类型
  runtime.ts          # 运行时装配根（buildDeps：CLI/TUI/GUI 三面共用）
  config.ts           # SUNSHINE.md 解析器
  config/             # env.ts（配置目录与 KB 环境解析）、settings.ts（settings.json 装载，两级只填缺省）
  harness/
    index.ts          # Harness 门面（含 SteeringChannel）
    perception.ts     # 项目感知（目录/依赖/SUNSHINE.md/Git）
    reactor.ts        # 最小闭环引擎（observe→think→act）
    ledger.ts         # per-run 成本账本（selfcheck usage 行数据源）
    skills.ts         # 技能装载与调度（五根兼容链+全局+学习级、resolve 回退链、清单注入）
    skills/           # learned.ts（FIFO 沉淀）、learned-extract.ts（语义提炼 lessons-not-logs）
    memory/           # store/guards/extractor/consolidate/pipeline（记忆单点 + 后台沉淀管线）
    tools.ts          # 工具注册表（统一执行面 + 安全链）
    tools/builtin.ts  # 内置工具（read/write/grep/glob/exec/webfetch/websearch/kb_search/skill/memory_write/ask_question/worktree/todo_write）
    tools/task-stop.ts # task_stop 工具（按 id 停止后台任务；装配期与 spawn 一并注册进主链）
    tools/task-wait.ts # task_wait 工具（阻塞等待后台任务到终态；装配期与 task_stop 一并注册进主链）
    tasks.ts          # 统一后台任务账本（exec/spawn 后台与超时转后台的 ID/生命周期/状态单点）
    mcp/              # MCP 客户端（官方 SDK 接缝，三传输）
    subagent.ts       # 子代理执行单元（spawn 工具面 + fork 执行/回写/预算/并发护栏）
    worktree.ts       # git worktree 单点模块（create/remove/list/isDirty/subagentTreeName）
    knowledge/        # 本地向量知识库（chunk/store/embed/KnowledgeBase）
    security/         # guard/policy/modes/sandbox/dryrun/chain
    context/          # loader（全局+项目 SUNSHINE.md 两层）/window/session/compaction/memory-lifecycle
  loop/               # engine.ts 闭环引擎、nodes.ts 四类节点+/goal 判据、templates.ts 模板
  graph/              # engine.ts DAG 拓扑（含环检测）、nodes.ts、agents.ts、workflow.ts、templates.ts
  model/adapter.ts    # 模型适配 + 三档算力路由
  storage/            # 本地 JSON 存储底座
  plugins/loader.ts   # 插件加载（plugins/{id}/plugin.json）
.sunshinex/skills/    # 项目级技能目录（标准形态 {id}/SKILL.md；兼容根见 §6）
agents/               # 用户子代理目录（{id}/agent.md，装配期一次性加载 fail-fast）
plugins/              # 用户插件目录
SUNSHINE.md          # 项目业务配置
```

## 4. 架构约定

- 分层依赖方向：graph → loop → harness → model / storage / plugins
- Graph 节点可嵌入 Loop 子流程，二者都运行在 Harness 底座之上
- 插件/技能/子代理通过「目录约定」加载，第三方工具经 MCP 接入（服务器登记于项目级 `.sunshinex/mcp.json` 与全局级 `~/.sunshinex/mcp.json`，项目级撞名遮蔽全局）
- 错误通道分域：工具与安全域返回 `Result`（可预期失败显式化）；引擎（Reactor/Loop/Graph）在节点边界 `catch` 后转为节点状态与 `reply` 字段（不可预期失败集中化），两条通道不得跨域混用
- 运行时装配收敛于 `src/runtime.ts`（buildDeps），交互面（CLI/TUI/GUI）只做参数解析与呈现，新增交互面复用同一装配根

## 5. 编码规范

- TypeScript 开启 strict，禁止无理由使用 any
- 一个文件只承担一个职责，模块边界清晰
- 测试与被测模块同目录就近放置：`*.test.ts` 与被测 `*.ts` 同目录，测试统一走 `pnpm test`（`scripts/run-tests.js` 启动、测试数据目录钉仓内 `.data-test`）
- 所有 IO（文件/网络/命令）集中在对应 adapter/store 内
- 写操作前评估影响面；改动后运行 `pnpm selfcheck` 自检
- 新增共享类型需在 `src/types.ts` 登记
- **主链工具面（装配期一次性登记，selfcheck `tools :` 行同源）**：
  - builtin（`tools/builtin.ts`）：`exec` / `read` / `skill` / `write` / `grep` / `glob` / `webfetch` / `websearch` / `kb_search` / `todo_write` / `memory_write` / `ask_question` / `worktree`
  - 另册：`spawn`（`subagent.ts` 工厂，子代理派生）/ `task_stop`（`tools/task-stop.ts`，按 id 停止后台 exec/超时转后台/后台子代理）/ `task_wait`（`tools/task-wait.ts`，阻塞等待后台任务到终态并内联回执 exec 日志尾部/子代理结论）；用户面列任务走 `/tasks` 斜杠命令，不另增模型工具
- **原始工具面复用、核心能力专属工具**：原始操作面（文件读写/搜索/命令/网络）能靠既有原子工具（`read` / `write` / `grep` / `glob` / `exec` …）与既有参数完成的，一律不新增专属工具；**核心 harness 能力**（记忆沉淀、技能沉淀、子代理派生、后台任务停止等平台功能）可为模型定义专属工具——效果优先，给模型便利、精确的操作手脚，不以原始工具拼凑模拟平台语义。工具清单属稳定段（§11），每加一个工具即一次全量前缀断点，新增仍须论证并经用户裁决、数量克制。**工具参数声明化**：每个工具必须以 JSON Schema 声明 `parameters`（function calling strict 兼容口径——`additionalProperties` 显式闭合、可选项以 null 联合进 `required`；自由入参属例外，须显式登记 `additionalProperties: true` 宽松点），新工具不带 schema 不得入清单
- 依赖引入原则：零依赖不是硬规则。优先 node: 内置模块；允许引入优秀且必要的第三方依赖。引入标准：解决真实问题、维护活跃、类型完善（或随附 .d.ts）、许可证兼容、依赖面（含传递依赖）可控；引入时登记 `package.json`、在 README/Arch-Plan 标注用途，并跑全量 build/test 验证
- **核心契约零兼容**：模型核心契约（原生 function calling 等 API 层强制的能力）不支持即换模型/换端点，禁止在提示词层做兼容适配——靠提示词约束模型输出分布的兼容是开集，补丁修不完。允许保留的容错仅限两类：①wire 层差异（输入形态闭集 + 每种形态有确定归一规则 + 未知形态可判定并安全回退，如流式 tool_calls 分片重组、finish_reason 归一）；②运行时自愈与可选增强降级（上下文超限反应式压缩、reasoning_effort 探测降级——缺了只损增强不损核心契约）。新增任何兼容/兜底须先过此判据：需要预测「模型下一步会输出什么」的补丁一律不做
- **依赖台账**：已引入依赖的用途/收敛边界/回退预案按下表登记（候选调研与评审记录见 `docs/Arch-Plan.md` §三 技术栈选型），引入时仍按上方原则更新本表与 `package.json`：

| 依赖 | 用途与收敛边界 | 回退预案 |
|------|----------------|----------|
| @modelcontextprotocol/sdk | MCP 官方客户端（stdio/http/sse 三传输），收敛于 `src/harness/mcp/client.ts` 接缝（替换实现不动主链） | 自研最小 stdio JSON-RPC 客户端同接口 |
| ink + react | TUI 组件化渲染层（仅组件/入口，运行时零接触），收敛于 `src/tui/` | Renderer 接缝退原生 ANSI 最小面 |
| sqlite-vec | KB 向量后端（`SUNSHINEX_KB_BACKEND=sqlite-vec`），收敛于 store 接缝 | local-json（缺省即回退，禁静默切换） |
| markdown-it | 正文 Markdown 解析为 IR，收敛于 `src/tui/markdown.ts` 解析层 | IR 稳定，替换解析实现（含自研）不动渲染层 |
| highlight.js | 围栏代码块语法高亮，收敛于 `src/tui/highlight.ts` | `HiSpan` 接口稳定，替换实现不动渲染层 |
| @deepseek-ai/node-addon-landlock-run | exec 内核级写围栏（Landlock self-restrict-then-exec launcher，Linux-only），收敛于 `src/harness/security/landlock.ts` 接缝；包缺失/内核不支持静默降级不阻断 | SUNSHINEX_SANDBOX=off 回 JS 层检查 + 容器部署口径 |

GUI 规划选型（未引入）唯一登记于 §13 组件选型登记表，不在此重复；转正时逐项按依赖引入原则评审并更新该表。

## 6. 技能与插件规范

- 技能标准形态：`{根}/skills/{id}/SKILL.md`（SKILL.md 优先、skill.md 兜底保三平台装载一致），含 frontmatter（name/description/version）与正文。**装载面仅限标准形态**——`rules/*.mdc`、裸 `AGENTS.md`、`commands/*.md` 均在装载面之外（防回归钉子用例锁定）。
- 装载优先级（右侧遮蔽左侧，id 撞名就近遮蔽；resolve 仅 SKILL_NOT_FOUND 逐级回退、SKILL_PARAM_MISSING 就近不回退）：

```text
.cursor < .codex < .claude < .agents < .sunshinex（项目级，原生恒最优先）
  > ~/.sunshinex/skills/（全局用户级，SUNSHINEX_USER_SKILLS_DIR 覆盖）
  > ~/.sunshinex/projects/<工作区>/data/skills/（学习级，LearnedSkillStore 自动沉淀，FIFO 上限）
```

- 技能发现与加载（对标 Claude Code 渐进披露）：name+description 清单由 `formatSkillsIndex` 注入会话冻结段（会话级常量、随快照刷新点重读），模型据清单经 `skill` 工具按 id 加载正文——正文以工具观察尾追进链（装配面前缀零击穿）；`skillRef` 为 loop 内部模板面，仍走置尾一次性注入。
- 插件：`plugins/{id}/plugin.json`，声明 id/name/version/entry。加载器只做发现与解析，不执行副作用；执行由 Harness 统一调度。

## 7. 提交与验证

- 提交前必须通过 `pnpm build`（tsc 严格模式零报错）
- 涉及加载/解析逻辑时，补充示例物料并确保 `--selfcheck` 输出正确
- `.pnpm-store/`、`.npm-cache/`、`.data/`、`.longtask/`、`node_modules/`、`dist/` 不入库
- 运行时数据（账本/记忆/学习技能/KB）统一落盘 `~/.sunshinex/projects/<工作区>/data`（`SUNSHINEX_PROJECTS_DIR` 可把 projects 根指到任意盘），工作区保持干净。`SUNSHINEX_DATA_DIR`（整目录直指、**不按工作区隔离**）是开发与测试专用重定向口（测试钉数据目录、CI 隔离运行时数据），留在环境变量面，不进 settings.json 语义键表

## 8. 边界与约束

（无）

## 9. 信息对齐与执行准则

执行任务前先对齐信息，不机械照字面生成结果：

- 信息充分：直接执行，不重复追问。
- 缺失会显著改变结果的关键信息：最多提 3 个关键问题；不影响推进时明确假设、先做探索版再收敛。
- 主动指出用户方案的更优替代与取舍，不盲从原方案。
- 共同未知：转为可验证假设，用最小实验验证（控制单一变量，明确成功/失败信号）。

## 10. 代码与文档修改纪律

- 禁止补丁式修改：追溯根因重构，禁用临时 if/开关变量/复制粘贴兜底；同一 bug 反复 2–3 轮仍复发，即质疑架构与提示词，而非靠代码过滤兜底。
- 代码自解释：命名清晰表意；注释只写业务规则与决策背景（为什么），不复述代码逻辑。
- 无残渣：清理死代码、未用 import/字段、注释掉的代码；上新删旧，不留悬空引用。
- **删除即无痕**：删除一个概念，即把概念、代码与处理逻辑一并清出全部引用面（文档正文、代码、注释、配置与处理分支）；正文零存在史——不复述「已删除 / 已退役 / 已废止 / 不再支持」，删除的完整证据只保留在提交历史与规格存档。
- **正向表述**：规则主体以正向限定承载（现行是什么、做什么、以什么为准），反向限定词仅作边界的短促标注，不以「不要做什么」的罗列替代正面定义。
- 部署一致性：本地与服务器代码一致，交付前校验；改动后按本项目约定验证（`pnpm build` + `pnpm selfcheck`）。

## 11. 前缀缓存：产品第一要义（Prompt Caching）

推理成本与响应时延是 agent 产品的核心竞争指标，前缀缓存（供应商侧自动 prefix cache，自开头逐字节匹配）是最有效的杠杆——不管产品什么形态（CLI/TUI/GUI、直执行/plan/工作流），能力建设都必须建立在「相邻请求 token 前缀命中率最大化」之上。对标基线：Claude Code——系统提示词与工具清单整场冻结、对话只尾部追加、历史仅在压缩点重写。

**上下文模型：单一基座 + fork**（2026-09-14 定稿，详见 `docs/superpowers/specs/2026-09-14-context-fork-design.md`）：

```text
[稳定段]     身份/输出约定/工具清单/JSON 协议/工作目录/执行协议行  ← 全层共享，逐字节冻结
[SUNSHINE.md]  全局 ~/.sunshinex/SUNSHINE.md → 项目 SUNSHINE.md  ← 会话级常量（两层冻结快照）
[技能清单]   name+description 索引（同刷新点冻结、按名排序）       ← 会话级常量，模型据此按需加载
[压缩块]     会话链前缀折叠摘要                                   ← 唯一合法重写产物
[会话链]     任务指令行+全量执行轨迹+结论/节点结论/补丁行           ← 主链 append-only，只在尾部变
[fork 尾追]  角色行+节点任务行+私有步骤                            ← 仅 graph 节点/子 agent
[技能块]     一次性注入置尾（loop skillRef 内部面）                ← 出现/消失击穿面≈0
```

主任务、plan 步骤、loop 修正轮都是主链追加；graph 节点与子 agent 是主链 fork（私有步骤不回主链，只回写结论/补丁行）。任何相邻帧、跨任务帧、主链↔fork 首帧的差异只允许出现在尾部。

核心不变量（违反即回归；任何新能力先回答「落在提示词哪个位置、击穿多长前缀」）：

- **提示词单一来源**：任务执行轮提示词只由 `Reactor.buildPrompt()` 产出；loop/graph 角色框定与任务文本复用该主链（判据仲裁等独立一次性调用除外，其内部拼装同样禁时变字段）；各层禁止绕开主链自行拼提示词。
- **前置段字节冻结**：压缩块之前的所有内容逐字节稳定——禁时间戳/随机值/时变字段（git 状态、计数器等）；工具清单按名排序；工作目录等环境事实为会话级常量；观察与事件一律尾部追加，禁止写回任何前置段——链即记忆。
- **只增不改**：会话链 append-only，过期信息以补丁行追加修正、不就地改写；压缩是唯一合法重写点（预算驱动、带滞回节流）；任务边界不重置上下文——新任务/新步骤以「当前指令行」尾追进链。
- **消息形态不变量**：模型上下文以消息视图为源（`buildMessages` 派生单点，链/快照/压缩块/技能块 → ChatMessage 序列）；tools 清单为请求级字段（`tools`），不进提示词文本、前缀零占用；system 双消息（稳定段 + 会话冻结段）逐字节冻结语义同前置段
- **重算事件少且收敛**：压缩是唯一的整体重写；模型档位是用户级会话参数（`--tier` / TUI `/model` / `SUNSHINEX_TIER`），整场恒定、不进提示词、模型无自调通道、系统不自动换档；思考强度（`--effort` / TUI `/model effort` / `SUNSHINEX_REASONING_EFFORT`）同属用户级请求参数——请求级字段不进提示词、端点不支持时按七档阶梯降级、全不支持省略参数用模型默认，前缀缓存零影响。
- **动态改动一律尾追——第一要义的完整形态（2026-09-18 定稿）**：第一要义不是「前缀冻结、一成不变」，而是**以尾追承载一切动态**：会话开始装载（SUNSHINE.md 两层 / 技能清单 / 记忆索引进冻结快照）→ 运行中任何变更只尾追说明行（含模型经 `write` 改写 SUNSHINE.md 的路径）→ 轮次边界与跨天 resume 启动时主动探测，读盘比对 SUNSHINE.md、技能 id 集、记忆索引与刷新点基线，差异一律尾追说明行进链——恢复后下一帧与存档时前缀严格连续，差异只允许出现在尾部。快照重写只发生在既有刷新点（构造 / `/init` / `/new` / 压缩成功），其余任何时刻不改写前缀、不提前重建快照；新内容一律以「后到者优先」由尾部承载。
  - **注入面盘点**：SUNSHINE.md 两层独立基线、同语义（全局 `~/.sunshinex/SUNSHINE.md` 由 `SUNSHINEX_GLOBAL_SUNSHINE` 覆盖，对标 `~/.claude/CLAUDE.md`；全局层缺失为合法确定态、消失同样尾追告知；全局文件在模型可写边界外，仅用户手工维护）；技能清单新增/变更尾追一行增量告知，正文经 `skill` 工具实时读盘置尾注入；记忆索引新写/整理尾追一行增量告知，索引快照不动、记录文件用 `read` 直接读（恒 live）；外部编辑、他处变更与已读文件变动一律尾追提示行。
  - **过期与冲突（对标 CC 补丁行语义）**：运行中出现的新确认项、新状态与链中已有条目过期或冲突时，不删不改旧条目，只尾追一条「过期/冲突说明行」声明以最新为准；读者按「后到者优先」取尾行，历史行保留作审计轨迹。禁止用「改写旧行」表达状态变化。
  - 反面即回归：把新内容插回前置段、就地改写历史行、为「让改动生效」提前重建快照——任一条都会击穿其后全部前缀。

验证与回归（改动强制项，细则以上方不变量为准）：

- 提示词组装面改动必须附带「相邻步前缀稳定」回归用例（断言首个差异点落在尾部新增段）；跨层改动附带「主链↔fork 首帧严格前缀连续」用例；动态面（SUNSHINE.md / 技能清单 / 记忆）会中变更附带「相邻帧前缀逐字节不变、新内容只以尾追行出现」用例。跑 `pnpm build` + 全量测试 + `pnpm selfcheck`。
- 「动态面盘点审计」：新增任何进上下文的装配面/提示词产出面时，全仓审计时间戳/随机值/计数器等动态源零泄漏（`new Date` / `Math.random` / `toISOString` 仅允许存在于旁路遥测与耗时统计）；确认无第四类动态面时同步更新本节清单，发现即按尾追语义收编。
- 端点侧前缀缓存能力以探针口径观测：两轮前缀连续请求，第二轮 `cached_tokens` 明显大于 0 即命中生效；端点侧缺口归端点侧，不计入产品回归目标。

## 12. 长任务设计取向

本项目对标 Claude Code / Codex 等明星 agent 产品的**长任务能力**：任务由完成判定（验收标准、修正环收敛）驱动，而非由保守的步数/超时中断驱动。对标基线：明星产品代理轮次无人工步数上限、命令可后台长跑、以完成与预算为界——本项目缺省值按同量级取值，上限仅为安全网。

- **缺省放宽原则**：超时、轮次、步数、预算的缺省值按「真实长任务」量级取值——模型调用超时 600s（深度推理 + 长生成）、命令执行超时 1800s（install/build/test 套件）、命令输出缓冲 32MB、Reactor 400 步（对标「无步数上限、完成驱动」，`SUNSHINEX_MAX_STEPS` 可调）、修正环 200 轮 / 1M tokens / 12 小时（`SUNSHINEX_MAX_LOOP_ITERATIONS` 可调轮数）、全链路 1000 节点步 / 2M tokens / 24 小时（`SUNSHINEX_MAX_GRAPH_NODES` 可调节点数）；墙钟时长为失控保底、不进 settings 常规配置面。宁可放宽缺省，不靠保守中断制造假失败。
- **放宽不等于无界**：预算记账、错误局部化、fail-bounded 语义全部保留——上限是安全网而非期望路径；长任务的正确形态是「宽预算 + 验收收敛」，而非「频繁触界中断」。
- **新增参数时**：缺省值须按长任务场景论证并对齐上述量级；测试与探针可用显式小值构造边界用例，但不得因测试便利反推缩水产品缺省值；**各层缺省须同量级一致——单层缩水即整链瓶颈**（入口/模板层的显式覆盖值视同产品缺省，须同等论证）。
- 已知长任务敏感点：模型慢响应（adapter timeoutMs）、长命令执行（sandbox exec 超时与 maxBuffer）、复杂多文件任务（Reactor maxSteps、Loop 修正环轮数、Graph 全链路终止参数）、批内长阻塞等待（task_wait 阻塞到终态或超时，缺省 1800s，占据一个工具执行槽——批内其他调用照常完成，整批回合时延以最慢等待为准）、各 CLI 命令与模板内嵌节点的显式覆盖值。调整任一处须同步评估其余层级的一致性。

## 13. 交互面构建规范（TUI / GUI）

最外层交互面（TUI/GUI）是对产品的第一印象，质量基线对标明星产品：TUI 对标 Claude Code、GUI 对标 Codex 工作台。好用易用优先于实现优雅；**开源优先**：新增任何交互能力前先调研维护活跃的开源组件，有则直接采用、无足量合格开源件才自研且须在接缝处隔离实现（可替换），选型引入标准沿用 §5 依赖引入原则。

**组件选型登记**（唯一登记处；引入依赖时同步 §5 依赖台账）：

| 层位 | 开源件 | 状态 | 用途与收敛边界 |
|------|--------|------|----------------|
| TUI 渲染 | ink + React | 已引入 | 组件化终端渲染，收敛于 `src/tui/`（仅渲染层，运行时零接触） |
| TUI Markdown | markdown-it | 已引入 | 正文 Markdown 解析为 IR，收敛于 `src/tui/markdown.ts` |
| TUI 高亮 | highlight.js | 已引入 | 代码块语法高亮，收敛于 `src/tui/highlight.ts` |
| TUI 宽度 | string-width | 已引入 | 中英混排/全角字符宽度测量 |
| GUI 桌面壳 | Electron | 规划选型 | 桌面容器，未来收敛于 `src/gui/` |
| GUI 组件库 | Vue 3 + Vite + Naive UI | 规划选型 | 界面组件（对话、看板、表单、文件树） |
| GUI 状态管理 | pinia | 规划选型 | Vue 3 官方状态库，收敛于 `src/gui/` 渲染层 |
| GUI 编辑器 | Monaco Editor（含 Diff Editor） | 规划选型 | 代码预览/diff 编辑，核心 diff 走 Diff Editor |
| GUI diff | diff2html | 降级备选 | 仅非编辑器区域轻量 diff 展示，按需引入 |
| GUI 可视化 | @antv/g6 | 规划选型 | 工作流 DAG 可视化看板（MVP 节点样式先行） |
| GUI 终端 | xterm.js + node-pty | 规划选型 | 内嵌终端；node-pty 为原生模块，三端分别编译打包（§14 纪律） |
| GUI 布局 | splitpanes | 规划选型 | 多面板拖拽分割 |
| GUI 文件监听 | chokidar | 规划选型 | 文件树实时变更监听 |
| GUI 内嵌浏览器 | WebContentsView | 规划选型 | Electron ≥ 30 原生 API |
| GUI 工程化 | electron-vite + electron-builder + electron-updater | 规划选型 | 构建/打包/自动更新，原生模块三端 CI 打包 |
| GUI 可选增强 | dockerode + tree-kill | 可选增强 | Compute Use 容器执行/进程管理，按需引入 |

- **架构边界**：交互面只做参数解析与呈现，共用 `src/runtime.ts` 装配根，只消费 SessionEvents 事件面与 asker 审批契约；渲染层不感知模型/工具实现，IR 与契约稳定时允许整体替换开源件。
- **体验基线**：交互细节向对标产品看齐——快捷键符合终端惯例、输出有渲染降级（窄终端/无色彩环境不花屏）、状态与错误信息用户可读；体验取舍拿不准时以「明星产品怎么做」为参照。
- **引入流程**：新依赖登记 `package.json`，在 README/Arch-Plan 标注用途，`pnpm build` + `pnpm test` 全量验证后方可交付；规划选型转正时同步更新本表状态。

## 14. 平台兼容性目标

以「一份代码、三平台可部署」为目标：Windows / macOS / Linux（Node.js ≥ 22.9）均可完成安装、构建、自检与 CLI 基础使用；工具命令执行面以 POSIX sh 为基线，Windows 经 Git Bash 原生支持（`resolveShell()` 自动探测；无 Git Bash 时回落 PowerShell，末位 `ComSpec` 兜底）。

- **版本下限**：Node.js ≥ 22.9（以 `package.json` 的 `engines` 为准；脚本统一 `node --test` 与 `node:` 内置模块），实测基线 22 LTS 与 24.x。
- **工程约束（编码时强制）**：路径一律 `path.join` / `path.resolve` / `path.relative`，禁止手拼分隔符；**路径子树包含判定一律走 `isWithin`（`src/paths.ts`，叶子模块避免模块环）**，路径判界统一单点；子进程执行收敛在 `ProcessSandbox` 单点，平台分支只允许出现在该文件（脚本层 `.cmd` 分派见 `docs/PLATFORM.md`）；pnpm scripts 保持零 shell 语法依赖（仅 `&&`）；glob 匹配与产物统一 `/` 分隔——`listFiles` 对 `path.relative` 结果先归一化再匹配（Windows 反斜杠转 `/`，POSIX 为 no-op）。
- **契约的机器强制（声明即须可执行）**：三平台可部署与 LF 文本两条契约配置机器闸门，声明与事实对齐——① CI 矩阵 `.github/workflows/ci.yml`（ubuntu + windows × Node 22/24，`fail-fast: false`；流水线内注明未覆盖项：探针不入库仅开发机手动执行、macOS 同源按性价比省略）；② `.gitattributes` + `.editorconfig` 双管入库/检出与编辑器落盘字节（Git for Windows 缺省 `core.autocrlf=true`，缺此二件 Windows 侧一次提交即可引入整文件 CRLF 重写）；③ 脚本层子进程启动形态统一 `spawn(ComSpec, ['/c', cmd, ...args])`，不用 `shell: true` 与 `args` 并用（Node ≥ 22.15 弃用，DEP0190）。细节见 `docs/PLATFORM.md`。
- **平台差异登记**：`exec` shell 由 `resolveShell()` 按序解析——`SUNSHINEX_SHELL` 显式覆盖（POSIX 兼容、配 `-c` 调用）→ Windows 探测 Git Bash → PowerShell（pwsh 各候选整体先于 powershell.exe，`-NoProfile -Command`，对齐 Claude Code native Windows 口径）→ 末位 `ComSpec` → POSIX `/bin/sh`；决议产物带来源标签（`override`/`git-bash`/`powershell`/`comspec`/`posix`），`selfcheck` 的 `shell :` 行显式上屏。候选序、WSL 启动器排除等机制细节见 `docs/PLATFORM.md`。仓库文本为 LF（由机器强制承载）。
- **Landlock exec 写围栏（2026-09-24）**：Linux-only（launcher 功能探测内核 landlock ABI），macOS/Windows 为 host 口径（manual 档审批流兜底）；隔离口径三态 `landlock | container | host`，经 `SUNSHINEX_ISOLATION` 显式声明或缺省 auto 探测，selfcheck `isolation :` 行上屏；`SUNSHINEX_SANDBOX=off` 一键关；容器部署时边界层由 Skills Docker 承担
- **平台相关改动纪律**：新增任何平台相关行为（路径、进程、信号、权限）须在本节登记差异与结论，并同步复核 README 平台支持矩阵与部署指引。
- **测试命令形态对 shell 中立**：断言前提一律以脚本文件（`node script.js`）或跨 shell 命令承载；shell 语义用例集中在 `security/sandbox.test.ts`（平台分支唯一落点），其余测试只断言工具链行为。

## 15. 语言规范：外观双语、提示词恒英文

两条线各自独立、不得混用：**外观**走 i18n 双语，**提示词**恒英文单语。

- **外观（双语，可配置）**：仅指用户直接看到的界面呈现——TUI chrome 文案、审批卡、系统消息、命令帮助、CLI 用法与自检输出。语言由 `--language=en|zh` 配置（缺省 `en`），经 `src/i18n.ts` 的 `setLanguage()` 在任何输出与装配之前一次性设定、会话内恒定；一律用 `t(en, zh)` 调用时求值，禁止模块级常量冻结。
- **提示词（恒英文单语，不可配置）**：凡进入模型上下文的一切文案——系统提示词、工具名与工具描述、观察与错误文案、压缩摘要提示词、子代理角色框定、生成类任务 goal（如 `/init`）、判据与链行——**一律英文单语**，不随 `--language` 切换、不写成双语对。理由：提示词是产品行为契约而非外观，单语形态可机械校验。
- **消费方定归属，判据是「有无写链」**：只看这个串有没有被写进链或观察（`appendChain` / `observation` / `steps`）——写链的 → 进模型上下文 → 英文单语；写死字面量且零写链、只上屏 → 属外观 → `t()` 双语。同一文件两种形态可并存（`graph/nodes.ts` loop 结论行英文、同文件 gate 回执 `t()`），不得按目录一刀切。
- **模型产出不译**：写链行里我们自写的前缀与兜底文案用英文；链行承载的模型产出正文（如 `${id}: ${r.reply}` 的 `r.reply`）照原样保留。
- **机械校验**：判据为「**非 `t()` 包裹的中文字面量零出现**」于提示词与链的产出面（`buildPrompt`、工具 description、观察与链行写入点、生成类 goal）；`t()` 包裹的中文允许存在于任何层（含 `graph/` / `loop/` 的写死回执），审计按「是否被 `t()` 包裹」区分，不按目录一刀切。豁免：项目专名（`SUNSHINE.md`）与功能性非 ASCII（分句标点、框线/字形符）。
- **产出语言（模型自判，不配置、不写死）**：产品产出物——生成的文档（如 `/init` 写出的 `SUNSHINE.md`）、答复正文的叙述语言、代码注释与提交说明——由模型按**当前项目**的既有文档风格自行判断：中文项目写中文、英文项目写英文。产品侧不设配置项、开关或参数，提示词中也不写死语言约束。
- **机器消费区**：精确标题与字面按既有约定照写，不随外观语言漂移（如 `## Compact Instructions` / `## 压缩指令`）。
