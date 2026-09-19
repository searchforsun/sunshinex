# CLAUDE.md

本文件是 SunshineX 项目的 AI 协作规范，供智能体与开发者共同遵守。
它是项目的「工作说明书」，优先于模型默认行为；冲突时以本文件为准。

## 1. 项目概览

- 名称：SunshineX —— 通用 AI Agent 工程化骨架
- 范式：Harness / Loop / Graph 三层嵌套
- 技术栈：TypeScript（strict）+ Node.js，CommonJS 模块
- 定位：云端推理，本地负责编排、执行、安全与记忆
- 对标：OpenAI Codex / Claude Code / Hermes
- 交互面对标：TUI 对标 Claude Code（已基于 ink + React 开源栈交付），GUI 对标 Codex 工作台（规划中）——最外层 TUI/GUI 一律优先复用成熟开源组件，不重复造轮子（见 §13）

## 2. 常用命令

```bash
pnpm build      # 编译 TS 到 dist/（tsc -p tsconfig.json）
pnpm start      # 运行入口（node dist/index.js）
pnpm selfcheck  # 编译并运行骨架自检
pnpm test      # 编译 + 全量单测（scripts/run-tests.js 启动，测试数据目录钉仓内 .data-test 防污染用户全局区）
pnpm cli       # CLI 执行面（内置自动构建，自动装载 settings.json）
pnpm install   # 安装依赖
```

> 包管理器统一 pnpm：版本由 `packageManager` 字段钉定（Node 自带 corepack，`corepack enable` 后直接使用 `pnpm`）；项目 `.npmrc` 已将 store 固定在仓内 `.pnpm-store`，沙箱等 HOME 不可写环境开箱即用。

## 3. 目录结构

```text
src/
  index.ts            # npm/pnpm start 入口（装载 settings.json 配置链）
  cli/                # CLI 执行面（selfcheck / run / pipeline）
  types.ts            # 全局共享类型
  result.ts           # Result 统一结果类型
  runtime.ts          # 运行时装配根（buildDeps：CLI/TUI/GUI 三面共用）
  config.ts           # SUNSHINE.md 解析器
  config/env.ts       # 用户配置目录与 KB 环境解析
  config/settings.ts  # settings.json 装载（语义键 + env 块，两级只填缺省）
  harness/
    index.ts          # Harness 门面
    perception.ts     # 项目感知（目录/依赖/SUNSHINE.md/Git）
    reactor.ts        # 最小闭环引擎（observe→think→act）
    ledger.ts         # per-run 成本账本（runs/<id> 条目 + 汇总，selfcheck usage 行数据源）
    skills.ts         # 技能加载与调度（项目级兼容链五根+全局+学习级装载 + resolve 回退链 + 清单冻结段注入 + skill 工具按需加载）
    skills/learned.ts # 记忆→技能沉淀（成功 run 沉淀学习技能至全局数据目录，FIFO 上限）
    skills/learned-extract.ts # learned 语义提炼（lessons-not-logs：四小节语义结构 + description ≤60 语义化；判无教训零落盘、技术失败回退确定性写盘）
    memory/           # 记忆（store 记录/索引单点 + guards 文本闸门单点 + extractor 提取 + consolidate 整理 + pipeline 后台沉淀管线）
    tools.ts          # 工具注册表（统一执行面 + 安全链）
    tools/builtin.ts  # 内置工具（read/write/grep/glob/exec/webfetch/websearch/kb_search/skill/memory_write）
    mcp/              # MCP 客户端（官方 SDK 接缝：stdio/http/sse 传输工厂 + 握手身份校验 + external 登记制）
    subagent.ts       # 子代理执行单元（agents/{id}/agent.md 注册制 + 预设角色 + 内联临时；spawn 工具面 + fork 执行/回写/预算/并发护栏）
    knowledge/        # 本地向量知识库（chunk 分块 / store 后端注册表 / embed Provider / KnowledgeBase 编排）
    security/         # guard/policy/modes/sandbox/dryrun/chain
    context/          # loader（全局 ~/.sunshinex/SUNSHINE.md + 项目 SUNSHINE.md 两层装载）/window/session/compaction/memory-lifecycle
  loop/
    engine.ts         # Loop 闭环引擎（生成→校验→修正）
    nodes.ts          # 四类节点（Agent/Check/Gate/Router）+ /goal 判据
    templates.ts      # 三大模板（重构/测试闭环/代码审查）
  graph/
    engine.ts         # DAG 拓扑执行（含环检测）
    nodes.ts          # 四类节点（loop/agent/gate/ci）
    agents.ts         # 多角色子 Agent
    workflow.ts       # WorkflowDef 装配
    templates.ts      # 五节点软件工程流水线
  model/adapter.ts    # 模型适配 + 三档算力路由
  storage/            # 本地 JSON 存储底座（adapter.ts）
  plugins/loader.ts   # 插件加载（plugins/{id}/plugin.json）
.sunshinex/skills/    # 项目级技能目录（标准形态 {id}/SKILL.md；兼容根 .cursor/.codex/.claude/.agents 同级，见 §6）
agents/               # 用户子代理目录（{id}/agent.md：frontmatter name/description + 正文框定；装配期一次性加载 fail-fast）
plugins/              # 用户插件目录
SUNSHINE.md          # 项目业务配置
```

## 4. 架构约定

- 分层依赖方向：graph → loop → harness → model / storage / plugins
- Graph 节点可嵌入 Loop 子流程，二者都运行在 Harness 底座之上
- 插件/技能/子代理通过「目录约定」加载，第三方工具经 MCP 接入
- 错误通道分域：工具与安全域返回 `Result`（可预期失败显式化）；引擎（Reactor/Loop/Graph）在节点边界 `catch` 后转为节点状态与 `reply` 字段（不可预期失败集中化），两条通道不得跨域混用
- 运行时装配收敛于 `src/runtime.ts`（buildDeps），交互面（CLI/TUI/GUI）只做参数解析与呈现，新增交互面复用同一装配根

## 5. 编码规范

- TypeScript 开启 strict，禁止无理由使用 any
- 一个文件只承担一个职责，模块边界清晰
- 所有 IO（文件/网络/命令）集中在对应 adapter/store 内
- 写操作前评估影响面；改动后运行 `pnpm selfcheck` 自检
- 新增共享类型需在 `src/types.ts` 登记
- **原始工具面复用、核心能力专属工具**：原始操作面（文件读写/搜索/命令/网络）能靠既有原子工具（`read` / `write` / `grep` / `glob` / `exec` …）与既有参数完成的，一律不新增专属工具；**核心 harness 能力**（记忆沉淀、技能沉淀等平台功能）可为模型定义专属工具——效果优先，给模型便利、精确的操作手脚，不以原始工具拼凑模拟平台语义。工具清单属稳定段（§11），每加一个工具即一次全量前缀断点，新增仍须论证并经用户裁决、数量克制
- 依赖引入原则：零依赖不是硬规则。优先 node: 内置模块；允许引入优秀且必要的第三方依赖。引入标准：解决真实问题、维护活跃、类型完善（或随附 .d.ts）、许可证兼容、依赖面（含传递依赖）可控；引入时登记 `package.json`、在 README/Arch-Plan 标注用途，并跑全量 build/test 验证
- **已登记依赖**：`@modelcontextprotocol/sdk` ^1.30.0 —— MCP 官方客户端（stdio / streamable http / sse 三传输）。用途：阶段四第三方工具接入（懒 spawn → 握手身份校验 → tools/list → tools/call）；边界：依赖收敛于 `src/harness/mcp/client.ts` 接缝内（替换客户端实现不动主链），transport 工厂按 SUNSHINE.md 配置分支三传输；回退预案：自研最小 stdio JSON-RPC 客户端同接口（spec §6-R6）
- **已登记依赖**：ink ^3.2.0 + react ^18.3.1 —— 终端渲染框架（组件化 TUI）。用途：阶段五 5A `sunshinex tui` 交互式会话终端渲染层；边界：仅渲染层（组件/入口），运行时零接触，依赖收敛于 `src/tui/`；回退预案：Renderer 接缝退原生 ANSI 最小面（spec §6-R1，SessionController 纯逻辑不受影响）
- **已登记依赖**：sqlite-vec ^0.1.9 —— sqlite-vec 向量扩展（vec0 虚拟表 KNN）。用途：阶段四 P1 `SUNSHINEX_KB_BACKEND=sqlite-vec` 向量后端；加载路径：node:sqlite（Node 22.14 内置）`loadExtension` + `allowExtension: true`（缺省关闭，安全缺省）；边界：单进程本地库、插入走 hex 字面量（vec0 xUpdate 参数化绑定限制，spike 已证）、依赖收敛于 store 接缝内；回退预案：local-json（`SUNSHINEX_KB_BACKEND` 缺省即回退，禁静默切换）
- **已登记依赖**：markdown-it ^15.0.1 —— Markdown 解析器（CommonMark token 流）。用途：阶段五 5B TUI 正文 Markdown 解析（块级/行内 token 流 → `MdBlock`/`MdInline` IR）；边界：依赖收敛于 `src/tui/markdown.ts` 解析层（含预处理补偿顿号列表、七级标题归 6、未闭合围栏降级段落三处 spec 语义），渲染层 `MarkdownText.tsx` 只消费 IR 不感知库；回退预案：IR 稳定，替换解析实现（含自研轻量解析器）不动 IR 与渲染层
- **已登记依赖**：highlight.js ^11.12.0 —— 语法高亮引擎。用途：阶段五 5B 围栏代码块语法高亮（token 树 scope → `HiKind` 四类着色）；边界：依赖收敛于 `src/tui/highlight.ts`（单行高亮纯函数，产出 `HiSpan[]`，未知语言/异常整行 plain），渲染层 `MarkdownText.tsx` 只消费 `HiSpan`；回退预案：`HiSpan` 接口稳定，替换实现（含轻量正则关键字高亮）不动渲染层
- **规划选型（GUI，未引入）**：Electron ≥ 28（桌面壳）+ Vue 3 + Vite + Naive UI（界面组件库）+ Monaco Editor（代码预览/diff，核心 diff 走 Monaco Diff Editor）+ @antv/g6（工作流可视化）+ xterm.js + node-pty（内嵌终端）+ splitpanes（多面板布局）+ chokidar（文件监听）+ pinia（状态管理）+ electron-vite + electron-builder + electron-updater（构建/打包/自动更新）；diff2html 降级为备选（仅非编辑器区域轻量 diff 展示），dockerode + tree-kill 为可选增强（Compute Use 容器执行/进程管理）——GUI 落地前为候选名单，实际引入时按上方引入标准逐项转正登记（Arch-Plan §2.1.1）

## 6. 技能与插件规范

- 技能：`{根}/skills/{id}/SKILL.md`（Agent Skills 标准形态；实现 SKILL.md 优先、skill.md 兜底保三平台装载一致），含 frontmatter（name/description/version）与正文。项目级**兼容链五根升序** `.cursor < .codex < .claude < .agents < .sunshinex`（**只装载标准形态、异构形态零兼容**——`rules/*.mdc`、裸 `AGENTS.md`、`commands/*.md` 一律不装载；右侧遮蔽左侧，`.sunshinex` 原生恒最优先）> 全局用户级 `~/.sunshinex/skills/`（跨项目共享，`SUNSHINEX_USER_SKILLS_DIR` 覆盖）> 学习级 `~/.sunshinex/projects/<工作区>/data/skills/`（LearnedSkillStore 自动沉淀，FIFO 上限）；id 撞名就近遮蔽，resolve 仅 SKILL_NOT_FOUND 逐级回退（SKILL_PARAM_MISSING 就近不回退）
- 技能发现与加载（对标 Claude Code 渐进披露）：name+description 清单由 `formatSkillsIndex` 注入会话冻结段（会话级常量、随快照刷新点重读），模型据清单经 `skill` 工具按 id 加载正文——正文以工具观察尾追进链（装配面前缀零击穿）；`skillRef` 为 loop 内部模板面，仍走置尾一次性注入
- 插件：`plugins/{id}/plugin.json`，声明 id/name/version/entry
- 加载器只做发现与解析，不执行副作用；执行由 Harness 统一调度

## 7. 提交与验证

- 提交前必须通过 `pnpm build`（tsc 严格模式零报错）
- 涉及加载/解析逻辑时，补充示例物料并确保 `--selfcheck` 输出正确
- `.pnpm-store/`、`.npm-cache/`、`.data/`、`.longtask/`、`node_modules/`、`dist/` 不入库
- 运行时数据（账本/记忆/学习技能/KB）统一落盘 `~/.sunshinex/projects/<工作区>/data`（`SUNSHINEX_PROJECTS_DIR` 可把 projects 根指到任意盘；HOME 不可写回退项目内 `.data`），工作区保持干净。`SUNSHINEX_DATA_DIR`（整目录直指、**不按工作区隔离**）只作测试与多实例口留在环境变量面，不进 settings.json 语义键表

## 8. 边界与约束

- 仅使用 sandbox__* 工具操作文件与命令
- 禁止写 /skills，只写 /workspace
- 禁止越狱路径（/tmp、.. 逃逸等）
- 默认无外网；需要外连时由管理员开启会话级网络

## 9. 信息对齐与执行准则

执行任务前先对齐信息，不机械照字面生成结果：

- 信息充分：直接执行，不重复追问。
- 缺失会显著改变结果的关键信息：最多提 3 个关键问题；不影响推进时明确假设、先做探索版再收敛。
- 主动指出用户方案的更优替代与取舍，不盲从原方案。
- 共同未知：转为可验证假设，用最小实验验证（控制单一变量，明确成功/失败信号）。

## 10. 代码修改纪律

- 禁止补丁式修改：追溯根因重构，禁用临时 if/开关变量/复制粘贴兜底；同一 bug 反复 2–3 轮仍复发，即质疑架构与提示词，而非靠代码过滤兜底。
- 代码自解释：命名清晰表意；注释只写业务规则与决策背景（为什么），不复述代码逻辑。
- 无残渣：清理死代码、未用 import/字段、注释掉的代码；上新删旧，不留悬空引用。
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
- **前置段字节冻结**：压缩块之前的所有内容逐字节稳定——禁时间戳/随机值/时变字段（git 状态、计数器等）；工具清单按名排序；工作目录等环境事实为会话级常量；观察与事件一律尾部追加，禁止写回任何前置段（历史教训：memory 每步双写曾把命中率压到 41.1%；记忆段已整体退出提示词——链即记忆）。
- **只增不改**：会话链 append-only，过期信息以补丁行追加修正、不就地改写；压缩是唯一合法重写点（预算驱动、带滞回节流）；任务边界不重置上下文——新任务/新步骤以「当前指令行」尾追进链。
- **重算事件少且收敛**：压缩是唯一的整体重写；模型档位是用户级会话参数（`--tier` / TUI `/model` / `SUNSHINEX_TIER`），整场恒定、不进提示词、模型无自调通道、系统不自动换档。
- **动态改动一律尾追——第一要义的完整形态（2026-09-18 定稿）**：第一要义不是「前缀冻结、一成不变」，而是**以尾追承载一切动态**：会话开始装载（SUNSHINE.md / 技能清单 / 记忆索引进冻结快照）→ 运行中任何变更只尾追说明行 → 轮次边界与跨天 resume 启动时主动探测差异、尾追进链。快照重写只发生在既有刷新点（构造 / `/init` / `/new` / 压缩成功），其余任何时刻不改写前缀、不提前重建快照；新内容一律以「后到者优先」由尾部承载。
  - **SUNSHINE.md（两层）**：全局 `~/.sunshinex/SUNSHINE.md`（`SUNSHINEX_GLOBAL_SUNSHINE` 覆盖，对标 `~/.claude/CLAUDE.md`，跨工作区个人标准）与项目级各自独立基线、同语义；轮次起点分别读盘与快照比对，不一致即尾追变更说明（属性=最新磁盘内容，覆盖快照旧版直到下次刷新点；全局层缺失为合法确定态、消失同样尾追告知）；运行中模型经 `write` 改写项目根 SUNSHINE.md，同样尾追说明（全局文件在模型可写边界外，仅用户手工维护）。
  - **技能清单**：会话内新增/变更技能尾追一行增量告知；正文经 `skill` 工具按 id 实时读盘、置尾注入。
  - **记忆索引**：会话内新写/整理的记忆尾追一行增量告知；索引快照不动，记录文件用 `read` 直接读（工具响应恒为 live）。
  - **过期与冲突（对标 CC 补丁行语义）**：运行中出现的新确认项、新状态与链中已有条目过期或冲突时，不删不改旧条目，只尾追一条「过期/冲突说明行」声明以最新为准；读者按「后到者优先」取尾行，历史行保留作审计轨迹。禁止用「改写旧行」表达状态变化。
  - **轮次边界主动探测**：每个任务轮起点（含跨天 `--continue` / `/resume` 恢复后的首轮）读盘比对 SUNSHINE.md、技能 id 集、记忆索引与刷新点基线，差异一律尾追说明行进链——恢复后下一帧与存档时前缀严格连续，差异只允许出现在尾部。
  - **通用面**：外部编辑、他处变更与已读文件变动，一律以尾追提示行表达，禁止回改历史行。
  - 反面即回归：把新内容插回前置段、就地改写历史行、为「让改动生效」提前重建快照——任一条都会击穿其后全部前缀。

验证与回归（改动强制项）：

- 提示词组装面改动必须附带「相邻步前缀稳定」回归用例（断言相邻步公共前缀 / 首个差异点落在尾部新增段）；跨层改动附带「主链↔fork 首帧严格前缀连续」用例。跑 `pnpm build` + 全量测试 + `pnpm selfcheck`。
- 「动态改动尾追」用例：SUNSHINE.md / 技能清单 / 记忆在会话中途变更时，断言相邻帧前缀逐字节不变、新内容只以尾追行出现（含模型会中经 `write` 改写 SUNSHINE.md 的路径）。
- 「动态面盘点审计」：新增任何进上下文的装配面/提示词产出面时，全仓审计时间戳/随机值/计数器等动态源零泄漏（`new Date` / `Math.random` / `toISOString` 仅允许存在于旁路遥测与耗时统计，不得进入 `buildPrompt` / `assemble` / 链行拼装）；确认无第四类动态面时同步更新本节子项清单，发现即按尾追语义收编。
- 端点侧行为本产品不可控，真实端点观测以探针口径为准：向真实端点发两轮前缀连续请求，第二轮 cached_tokens 明显大于 0 即命中生效；两轮均 0 即端点未启用前缀缓存（残余缺口归端点侧，不计入产品回归目标）。

## 12. 长任务设计取向

本项目对标 Claude Code / Codex 等明星 agent 产品的**长任务能力**：任务由完成判定（验收标准、修正环收敛）驱动，而非由保守的步数/超时中断驱动。对标基线：明星产品代理轮次无人工步数上限、命令可后台长跑、以完成与预算为界——本项目缺省值按同量级取值，上限仅为安全网。

- **缺省放宽原则**：超时、轮次、步数、预算的缺省值按「真实长任务」量级取值——模型调用超时 600s（深度推理 + 长生成）、命令执行超时 1800s（install/build/test 套件）、命令输出缓冲 32MB、Reactor 200 步（对标「无步数上限、完成驱动」）、修正环 100 轮 / 1M tokens / 2 小时、全链路 500 节点步 / 2M tokens / 4 小时。宁可放宽缺省，不靠保守中断制造假失败。
- **放宽不等于无界**：预算记账、错误局部化、fail-bounded 语义全部保留——上限是安全网而非期望路径；长任务的正确形态是「宽预算 + 验收收敛」，而非「频繁触界中断」。
- **新增参数时**：缺省值须按长任务场景论证并对齐上述量级；测试与探针可用显式小值构造边界用例，但不得因测试便利反推缩水产品缺省值；**各层缺省须同量级一致——单层缩水即整链瓶颈**（入口/模板层的显式覆盖值视同产品缺省，须同等论证）。
- 已知长任务敏感点：模型慢响应（adapter timeoutMs）、长命令执行（sandbox exec 超时与 maxBuffer）、复杂多文件任务（Reactor maxSteps、Loop 修正环轮数、Graph 全链路终止参数）、各 CLI 命令与模板内嵌节点的显式覆盖值。调整任一处须同步评估其余层级的一致性。

## 13. 交互面构建规范（TUI / GUI）

最外层交互面（TUI/GUI）是对产品的第一印象，质量基线对标明星产品：TUI 对标 Claude Code、GUI 对标 Codex 工作台。好用易用优先于实现优雅；能复用成熟开源组件就复用，不重复造轮子——自研仅限开源件覆盖不到的胶水层与接缝。

- **开源优先原则**：新增任何交互能力前，先调研是否有维护活跃的开源组件；有则直接采用，无足量合格开源件时才自研，且须在接缝处隔离实现（可替换）。选型引入标准沿用 §5 依赖引入原则。
- **组件选型登记**：

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
| GUI 内嵌浏览器 | WebContentsView | 规划选型 | Electron ≥ 30 原生 API（BrowserView 已弃用，不采用） |
| GUI 工程化 | electron-vite + electron-builder + electron-updater | 规划选型 | 构建/打包/自动更新，原生模块三端 CI 打包 |
| GUI 可选增强 | dockerode + tree-kill | 可选增强 | Compute Use 容器执行/进程管理，按需引入 |

- **架构边界**：交互面只做参数解析与呈现，共用 `src/runtime.ts` 装配根，只消费 SessionEvents 事件面与 asker 审批契约；渲染层不感知模型/工具实现，IR 与契约稳定时允许整体替换开源件。
- **体验基线**：交互细节向对标产品看齐——快捷键符合终端惯例、输出有渲染降级（窄终端/无色彩环境不花屏）、状态与错误信息用户可读；体验取舍拿不准时以「明星产品怎么做」为参照。
- **引入流程**：新依赖登记 `package.json`，在 README/Arch-Plan 标注用途，`pnpm build` + `pnpm test` 全量验证后方可交付；规划选型转正时同步更新本表状态。

## 14. 平台兼容性目标

以「一份代码、三平台可部署」为目标：Windows / macOS / Linux（Node.js ≥ 22.9）均可完成安装、构建、自检与 CLI 基础使用；工具命令执行面以 POSIX sh 为基线，Windows 经 Git Bash 原生支持（`resolveShell()` 自动探测；无 Git Bash 时回落 PowerShell，末位 `ComSpec` 兜底）。

- **版本下限**：Node.js ≥ 22.9（以 `package.json` 的 `engines` 为准；脚本统一 `node --test` 与 `node:` 内置模块），实测基线 22 LTS 与 24.x。
- **工程约束（编码时强制）**：路径一律 `path.join` / `path.resolve` / `path.relative`，禁止手拼分隔符；**路径子树包含判定一律走 `isWithin`（`src/paths.ts`，叶子模块避免模块环）**，禁止各自手写 `startsWith(root + path.sep)`——曾三处各持一份拷贝并已付代价：只归一一侧时前缀恒失配、静默全拒（`memory/paths.ts` 头部存有 2026-09-18 裁决记录）；子进程执行收敛在 `ProcessSandbox` 单点，平台分支只允许出现在该文件（脚本层另有 `scripts/release.mjs` 的 `.cmd` 分派，见下）；pnpm scripts 保持零 shell 语法依赖（仅 `&&`）；glob 匹配与产物统一 `/` 分隔——`listFiles` 对 `path.relative` 结果先归一化再匹配（Windows 反斜杠进入正则前转为 `/`，POSIX 为 no-op）。
- **契约的机器强制（声明即须可执行）**：三平台可部署与 LF 文本两条契约原仅存于文档，现各配机器闸门，声明与事实由此对齐——① `.github/workflows/ci.yml` 跑 `ubuntu-latest + windows-latest × Node 22/24` 矩阵（`pnpm install --frozen-lockfile` → `pnpm test` → `pnpm selfcheck`，`fail-fast: false` 让「哪个平台挂了」可见）；流水线内如实注明未覆盖项：探针 `scripts/*probe*.js` 依赖外部 API 且按 `.gitignore` 不入库、仅在开发机手动执行，macOS 语义与 Linux 同源而 runner 成本约为十倍故省略。② `.gitattributes`（`* text=auto eol=lf`，二进制与 `.snap` 显式排除）与 `.editorconfig` 双管：前者管入库/检出字节，后者管编辑器落盘字节——Git for Windows 缺省 `core.autocrlf=true`，无此二件则 Windows 侧一次提交即可引入整文件 CRLF 重写。③ 脚本层子进程启动形态统一取 Node 官方文档给出的显式式样：`.cmd`/`.bat` 经 `spawn(ComSpec, ['/c', cmd, ...args])` 启动，**不用** `shell: true` 与 `args` 并用（自 Node 22.15 起弃用，DEP0190——args 会被重拼并再转义一遍）。
- **已知差异（如实登记，不虚构兼容）**：`exec` shell 由 `resolveShell()` 按序解析——`SUNSHINEX_SHELL` 覆盖（契约：须 POSIX 兼容，配 `-c` 调用；指向 cmd.exe 等非 POSIX shell 属未定义行为）→ Windows 探测 Git Bash（候选序：安装环境变量 `ProgramFiles`/`ProgramW6432`/`ProgramFiles(x86)`/`LOCALAPPDATA\Programs` 下的 `Git` 根 → PATH 上 `git.exe` 所在目录及其祖先根反推 → PATH 上直接暴露的 `bash.exe`；每根取 `<root>\bin\bash.exe` 与 `<root>\usr\bin\bash.exe` 两种布局）→ 无 Git Bash 时探测 PowerShell（候选序：PATH 逐目录 → `<ProgramFiles>\PowerShell\7` 与 `%LOCALAPPDATA%\Microsoft\WindowsApps` → Windows PowerShell 的 PATH 目录与 in-box `%SystemRoot%\System32\WindowsPowerShell\v1.0`；**pwsh 各候选整体先于 powershell.exe**，配 `-NoProfile -Command`——对齐 Claude Code 官方 native Windows 口径「无 Git for Windows 时以 PowerShell 作 shell 工具」，而非退回 cmd.exe）→ 皆无则 `ComSpec`（`/c`，仅兜底不崩，sh 语义命令不保证可用）→ POSIX `/bin/sh`；发现逻辑为可注入纯函数（`windowsBashCandidates` / `findWindowsBash` / `windowsPowerShellCandidates` / `findWindowsPowerShell`），决议序本体为 `resolveShellFor(platform, env, exists)`，跨平台可回归（POSIX 上亦断言 Windows 序）。决议产物带来源标签（`override`/`git-bash`/`powershell`/`comspec`/`posix`），`sunshinex selfcheck` 的 `shell :` 行显式上屏——Git Bash 未命中曾属「静默改变引号与命令集」的隐式差异，观测面由此可循。历史教训：只硬编码 `Program Files\Git` 两路径，非缺省安装（如 D 盘、便携版）静默回落 cmd.exe——引号语义与命令集随之改变（`node -e "…"` 被当字符串字面量求值、退出码恒 0，`ls`/`cat` 不可用），且无任何报错可循；包管理器统一 pnpm（`packageManager` 钉版）；`.npmrc` 已将 store 固定在仓内 `.pnpm-store`，沙箱等 HOME 不可写环境开箱即用；仓库文本为 LF（现由 `.gitattributes` + `.editorconfig` 机器强制，见上「契约的机器强制」），Node/tsc 对 CRLF 不敏感。
- **已知差异 · Windows 超时与进程树（如实登记，本轮不消除）**：`ProcessSandbox.exec` 的超时回收依赖 Node 的 `timeout` + `killSignal`（缺省 `SIGTERM`），而该信号的语义三平台不同——POSIX 上 `SIGTERM` 发给直接子进程（即被启动的 shell），若 shell 未 exec 替换自身，其下孙进程可能存活；Windows 上无信号概念，实为 `TerminateProcess` 强杀，且**不**级联到子进程树（`detached` 语义亦与 POSIX 进程组不同）。故超时后可能有孤儿进程残留，最坏情形是一个仍在奔跑的模型子调用。结论：**接受并登记，不加代码**——① 主链唯一子进程调用即 `exec`，其命令面多为短命进程（自检/测试/脚本文件），残留窗口小且不累积；② 彻底收口需 Windows 侧 `taskkill /T /F` 或 Job Object、POSIX 侧进程组（`detached` + `process.kill(-pid)`），属跨平台进程管理独立议题，牵动 `ProcessSandbox` 单点语义与三平台回收时序，须单独立项论证，不以顺手补丁处置。
- **平台相关改动纪律**：新增任何平台相关行为（路径、进程、信号、权限）须在本节登记差异与结论，并同步复核 README 平台支持矩阵与部署指引。
- **测试不得编入宿主 shell 方言**：被测命令形态须对 shell 中立——内联 `node -e "…"` 与 `ls`/`cat` 等 POSIX 命令集在 Windows 无 Git Bash 时语义不同（前者命令串被当字面量、断言恒真而失去判别力），故一律以脚本文件承载（`node script.js`）或改用跨 shell 命令；shell 语义用例集中在 `security/sandbox.test.ts`（平台分支唯一落点），其余测试只断言工具链行为。

## 15. 语言规范：外观双语、提示词恒英文

两条线各自独立、不得混用：**外观**走 i18n 双语，**提示词**恒英文单语。

- **外观（双语，可配置）**：仅指用户直接看到的界面呈现——TUI chrome 文案、审批卡、系统消息、命令帮助、CLI 用法与自检输出。语言由 `--language=en|zh` 配置（缺省 `en`），经 `src/i18n.ts` 的 `setLanguage()` 在任何输出与装配之前一次性设定、会话内恒定；一律用 `t(en, zh)` 调用时求值，禁止模块级常量冻结（历史缺陷：`STATUS_LABEL` / `SLASH_HELP` 曾在加载期冻死语言）。
- **提示词（恒英文单语，不可配置）**：凡进入模型上下文的一切文案——系统提示词、工具名与工具描述、观察与错误文案、压缩摘要提示词、子代理角色框定、生成类任务 goal（如 `/init`）、判据与链行——**一律英文单语**，不随 `--language` 切换、不写成双语对。理由：提示词是产品行为契约而非外观，双语并行必然长期语义漂移（同一意图两套语料各自演化、行为不一致），单语是唯一可机械校验的形态。模型侧双语别名 `pick()` 随本规范废止。
- **消费方定归属，判据是「有无写链」**：分界线不看文件、不看模块、不看目录，只看**这个串有没有被写进链或观察**（`appendChain` / `observation` / `steps`）。写链的 → 进模型上下文 → 英文单语；**写死的字面量且零写链、只上屏 → 属外观 → `t()` 双语**。同一文件内两种形态可并存：`graph/nodes.ts` 的 loop 结论行走英文，同文件的 gate 三态回执走 `t()`；`graph/engine.ts` 与 `loop/engine.ts` 零 `appendChain`，其回执（审批通过/拒绝/等待、CI 通过/失败、`[dry-run]` 预览、引擎汇总、节点 fail 说明）只有上屏一条去向，是死的用户显示，保双语——不得因它们住在 `harness/` / `graph/` 目录就判为英文。
- **模型产出不译**：写链行里由我们自写的前缀与兜底文案用英文；链行承载的模型产出正文（如 `${id}: ${r.reply}` 的 `r.reply`）照原样保留，不做语言改写。
- **机械校验**：判据为「**非 `t()` 包裹的中文字面量零出现**」于提示词与链的产出面（`buildPrompt`、工具 description、观察与链行写入点、生成类 goal）；`t()` 包裹的中文允许存在于任何层（含 `graph/` / `loop/` 的写死回执），审计按「是否被 `t()` 包裹」区分，不按目录一刀切。豁免：项目专名（`SUNSHINE.md`）与功能性非 ASCII（分句标点、框线/字形符）。
- **产出语言（模型自判，不配置、不写死）**：产品产出物——生成的文档（如 `/init` 写出的 `SUNSHINE.md`）、答复正文的叙述语言、代码注释与提交说明——由模型按**当前项目**的既有文档风格自行判断：中文项目写中文、英文项目写英文。产品侧不设配置项、开关或参数，提示词中也不写死语言约束。
- **机器消费区**：精确标题与字面按既有约定照写，不随外观语言漂移（如 `## Compact Instructions` / `## 压缩指令`）。
