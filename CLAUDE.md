# CLAUDE.md

本文件是 Sunshinex 项目的 AI 协作规范，供智能体与开发者共同遵守。
它是项目的「工作说明书」，优先于模型默认行为；冲突时以本文件为准。

## 1. 项目概览

- 名称：Sunshinex —— 通用 AI Agent 工程化骨架
- 范式：Harness / Loop / Graph 三层嵌套
- 技术栈：TypeScript（strict）+ Node.js，CommonJS 模块
- 定位：云端推理，本地负责编排、执行、安全与记忆
- 交互面：TUI（对标 Claude Code）与 GUI（对标 Codex 工作台，Electron 壳 + 浏览器双形态）均已交付——构建规范见 §13

## 2. 常用命令

```bash
pnpm install    # 安装依赖（pnpm 版本由 packageManager 钉定；store 固定仓内 .pnpm-store）
pnpm build      # 编译 TS 到 dist/（tsc -p tsconfig.json）
pnpm start      # 运行入口（node dist/cli/index.js）
pnpm cli        # CLI 执行面（内置自动构建，自动装载 settings.json）
pnpm selfcheck  # 编译并运行骨架自检（dist 可启动性；shell/isolation 决议上屏）
pnpm gui:build  # 构建 GUI 前端产物 dist-gui/
```

| 层 | 命令 | 要点 |
|----|------|------|
| 主仓单测 | `pnpm test` | 清空编译 dist/ → `node --test` 全量；测试数据钉仓内 `.data-test`；pty.test 串行收尾（win32 conpty 与并发 daemon pty 即挂死，上游问题）+ `--test-force-exit` 兜 fs.watch 句柄迟滞 |
| GUI 全量 | `pnpm --dir gui run test` | pretest 先 typecheck 并编译主仓；vitest 单测 + e2e（起真 daemon） |
| GUI e2e 单跑 | `pnpm --dir gui run test:e2e` | pretest 先构建 dist-gui；主仓 dist 须先在 |
| 桌面壳 | `pnpm --filter sunshinex-shell run test`；冒烟 `pnpm shell:smoke` | 冒烟 = electron 真启动→加载→有序退，退出码判过 |
| 真实模型 e2e | `node scripts/e2e-real.mjs` | 手动门（花真金 token）：真适配器/流式/工具链/安全链全链唯此能验；需 settings env 已配密钥 |
| 长任务基准集 | `node scripts/eval-run.mjs [--only <id>]` | 手动门：6 固定任务量化完成率与干预次数，脚本验盘为权威判定 |

联调：`pnpm --dir gui run typecheck`；`pnpm --dir gui run dev`（`VITE_SERVE_URL` 指向后端）；`pnpm cli serve` → `http://127.0.0.1:7788/`（host 恒回环；`--port` 覆盖 / `--port=0` 临时；缺省免鉴权，`--token` 启用）。**HTTP posture（登记的接受面，D58 裁定 2026-11-02）**：单用户本机工具，安全第一道=回环绑定；缺省免鉴权档不验 Host/Origin/Content-Type，浏览器侧跨站 simple POST 的理论可达面显式接受；多用户/不可信环境用 `--token` 收紧。daemon 服务 dist-gui 静态产物——改完 GUI 源码须 `pnpm gui:build` 再刷新（dev 热更免重建）。

### 桌面端部署与重装

```bash
node scripts/deploy-gui.mjs verify|deploy|reinstall [--dir ...|--no-build|--pristine]
NODE_OPTIONS=--use-system-ca pnpm shell:dist   # 壳全链：版本同步→主仓 build→gui build→壳 esbuild→NSIS 包
./shell/release/sunshinex-<version>-win-x64-setup.exe /S   # 静默重装（沿用上次安装目录，装毕自启）
```

打包输出**恒 `shell/release` 一个目录**（2026-11-14 用户裁定「应该只放到这一个里面」）：不同版本=目录内不同 setup 文件名并存（deploy-gui 按 mtime 取本机架构最新），同版本=同名覆盖；**禁止每轮 `-c.directories.output=release-freshNN` 换目录**（曾堆 29 份×560MB 残留）。

- 纯 `gui/` 改动 deploy 即可（dist-gui 推装+重启，留 dist-gui.old 回滚点）；改 `shell/` 源码必须 reinstall（改动落 app.asar，renderer 推装覆盖不到）。装后装配校验自动化（核 app.asar 壳束标志+进程路径）。`--pristine` 连用户态历史一并清（`%APPDATA%\sunshinex-shell` 与 `~/.sunshinex/gui/`；会话数据 `~/.sunshinex/projects/` 不动）。
- 壳链铁律：`NODE_OPTIONS=--use-system-ca` 必带（打包下载组件走 Node TLS）；整链必须走根 `shell:dist`（壳包自身 dist 无 esbuild，出旧束）；退出码勿经管道取；装新先杀旧；asar 无压缩可 `grep -a` 直查新束标志。

### 发版

总入口 `node scripts/release.mjs --bump patch`（`--dry-run`/`--no-gui`/`--clobber`）：先过全量门禁（主仓全量→selfcheck→GUI 全量→壳单测→shell:smoke），再出 TUI tgz 与 GUI 安装包两线；参数细节见 README「发版（维护者）」，CI 见 §14 与 docs/PLATFORM.md；npm publish 经 `prepublishOnly` 强制 test+selfcheck。

## 3. 目录结构

```text
src/
  index.ts            # package.json main 库导出面（loadSettingsChain/buildModel/buildHarness 再导出，零副作用；可执行入口唯一落 cli/index.ts）
  cli/                # CLI 执行面（commands/：selfcheck / run / pipeline / serve / skills install / kb-index / plugins / agents / providers / mcp / settings；worktree-launch --worktree 装配前解析）
  types.ts            # 全局共享类型（新增共享类型一律在此登记）
  result.ts           # Result 统一结果类型
  runtime.ts          # 运行时装配根（buildHarness 单点 + buildDeps CLI 整形：CLI/TUI/GUI 三面共用）
  paths.ts            # 路径工具单点（isWithin 子树判界，§14）
  textmatch.ts        # 文本匹配原语单点（escapeRegExp/globToRegex）
  slug.ts             # slug 折叠单点（ASCII 小写折叠）
  idstamp.ts          # UTC 紧凑时间戳单点（可排序标识段）
  i18n.ts             # 外观双语 t(en, zh) 调用时求值（§15）
  images.ts           # 图片附件共享面（MAX_IMAGES ≤8/校验/钳制/占位标记；serve+TUI+GUI 单源）
  warning-filter.ts   # node:sqlite ExperimentalWarning 定点过滤（入口首 import；拒全局静音）
  config.ts           # SUNSHINE.md 解析器
  catalog/            # 设置存储结构化单点（io 读写纪律 / providers、agents、teams、plugins、mcp、skills、approvals、permissions 读写面 / watch 目录监听；两级合并读 + 结构化写，CLI/TUI/serve 三面共用）
  config/             # env.ts、settings.ts（settings.json 装载，两级只填缺省）、agent-teams.ts / permissions / providers / termination-config / memory-config / data-dir / plugins / image-history
  tui/                # 交互式终端（ink + React）：session 会话控制器、tui-loop/tail-rewrite 渲染循环、components/、markdown/md-ansi/highlight 呈现、md-theme 双链共享常量单点、session-journal（v3 段级行；INDEX.md 索引 + <id>.transcript.md 可读镜像，jsonl 为逐字节权威）/session-snapshots、ui-state-disk（§13 分层）、clipboard-image（Ctrl+V 贴图）
  harness/
    index.ts          # Harness 门面（生产主链唯一入口=KernelRuntime.runTask→Loop 模板；stableSegment 观测面薄委托）
    perception.ts     # 项目感知（目录/依赖/SUNSHINE.md/Git）
    sunshine-init.ts  # /init 目标构造器（纯函数产出 goal 文本）
    reactor.ts        # 最小闭环引擎（observe→think→act）
    batch-runner.ts   # 批次执行器（签名去重/串并行政策/扇出/批后记账）
    plan-flow.ts      # 计划模式共用纯件单点（PLAN_MODE_NOTE/计划名派生/Steps 解析；宿主接缝在 tui/serve）
    guardrail.ts      # 护栏停判纯函数（超时→预算→步数序；loop/graph 双引擎共用）
    ledger.ts         # per-run 成本账本（selfcheck usage 行数据源）
    skills.ts         # 技能装载与调度（多级根、resolve 回退链、清单注入）
    teams.ts          # 团队目录装载与调度（两级遮蔽、索引注入、resolve 三态、章程卡）
    skills/           # learned.ts（FIFO 沉淀）、learned-extract.ts
    memory/           # store/guards/extractor/consolidate/pipeline（记忆单点+后台管线；log.jsonl 追加只增=OKF log 件；Wiki 层：links/superseded_by、topics/ 主题综述页派生物、MEMORY.md 两段化）
    tools.ts          # 工具注册表（统一执行面 + 安全链）
    tools/builtin.ts  # 内置工具（read/write/edit/grep/glob/exec/webfetch/websearch/kb_search/skill/load_agent_teams/load_subagent/memory_write/ask_question/worktree/todo_write/exit_plan）
    plugin-host.ts    # 插件宿主装配单点（browser-use 连接改写为每进程宿主 HTTP 连接）
    tools/task-stop.ts # task_stop 与 agent_team_task_stop（agentTeams 开时注册）
    tools/task-wait.ts # task_wait 与 agent_team_task_wait（同上）
    tasks.ts          # 统一后台任务账本（exec/spawn ID/生命周期/状态单点）
    mcp/              # MCP 客户端（官方 SDK 接缝，三传输；入口探活+断链重连 ≤2 次）
    subagent.ts       # 子智能体执行单元（spawn 工具面 + fork 执行/回写/预算/并发护栏）
    worktree.ts       # git worktree 单点模块
    prompts/          # 提示词模板单点（shared 稳定段共享行）
    knowledge/        # 本地向量知识库
    security/         # guard/policy/rules/modes/sandbox/chain + landlock（Linux 写围栏）/websearch-endpoint
    context/          # loader/messages（buildMessages 单点）/breakdown/window/summarizer/drift-detector/chain-ledger/compaction/index.ts 门面
  loop/               # engine.ts 闭环引擎、nodes.ts 四类节点+/goal 判据、templates.ts
  graph/              # engine.ts DAG 拓扑、nodes.ts、agents.ts、templates.ts
  model/              # adapter.ts 适配器单点（OpenAIAdapter+Stub/Scripted，原路径再导出）；effort.ts；usage.ts；wire.ts；router.ts；catalog.ts ModelSwitcher（/model 多源数据面；providers 变更经 reload() 原地换芯热生效）；chat-stub.ts
  eval/               # 长任务基准集（eval-run.mjs 数据面）
  taskboard/          # 智能体团队域模型与协调器（model/board/store/translate/teammate/team-registry/inbox/executors）
  delegation/         # 委派投影（spawn/后台/graph 节点统一生命周期，TUI/GUI 同源）
  session/            # 会话内核：kernel.ts（applyEvent 纯 reducer）、entry.ts、seglog.ts（kernelEventRows→journal v3）、runtime.ts（createKernelRuntime，TUI/GUI 共用）
  serve/              # GUI daemon（HTTP+WS、静态资源、PTY 中继、catalog 全量结构化配置面，settings 变更锚根两层重装+模型层热生效；转录 v3 单档唯一写者链路 kernelEventRows）
  storage/            # 本地 JSON 存储底座；archive.ts（归档读写单点）
gui/                 # 浏览器 GUI 前端（React 18 + Vite 工作区包；直接 import 主仓 TS 源保类型同源）
shell/               # Electron 桌面壳工作区包（托盘/全局快捷键/无边框窗控/NSIS 打包；壳与主仓零编译期耦合）
plugins/             # 插件工作区根（内置插件 plugin.json + schema 校验；用户级根 ~/.sunshinex/plugins/；指南 docs/PLUGIN-DEV.md）
.sunshinex/skills/    # 项目级技能目录（{id}/SKILL.md；.agents/.claude/.codex/.cursor 同形兼容根见 §6）
.sunshinex/teams/     # 项目级智能体团队目录（{id}/team.md，正文=章程；两级遮蔽见 §6）
.sunshinex/agents/    # 项目级子智能体目录（{id}/agent.md；全局 ~/.sunshinex/agents/ 垫底→项目级就近遮蔽，旧位 <root>/agents/ 首次装载一次性自动迁入且装载面不认旧位；enabled:false 装配期剔除；畸形文件整次 fail-fast）
SUNSHINE.md          # 项目业务配置
```

## 4. 架构约定

- 分层依赖方向：graph → loop → harness → model / storage
- Graph 节点可嵌入 Loop 子流程，二者都运行在 Harness 底座之上
- 技能与子智能体经「目录约定」加载，第三方工具经 MCP 接入（登记于项目/全局 mcp.json，项目遮蔽全局）；插件 = MCP server 与技能的可开关治理单元（docs/PLUGIN-DEV.md）
- 错误通道分域：工具与安全域返回 `Result`；引擎在节点边界 `catch` 转节点状态与 `reply`——两通道不得跨域混用
- 运行时装配收敛于 `src/runtime.ts`，交互面只做参数解析与呈现

## 5. 编码规范

- TypeScript strict，禁止无理由 any；一文件一职责；IO 集中在 adapter/store；测试与被测模块同目录（`*.test.ts`，统一 `pnpm test`）；新增共享类型登记 `src/types.ts`；改动后跑 `pnpm selfcheck`
- **主链工具面**（装配期一次性登记，selfcheck `tools :` 行同源）：
  - builtin（`tools/builtin.ts`）：`exec` / `read` / `skill` / `load_agent_teams` / `load_subagent` / `write` / `edit` / `grep` / `glob` / `webfetch` / `websearch` / `kb_search` / `todo_write` / `memory_write` / `ask_question` / `worktree` / `exit_plan`（挂起型出牌工具，plan 接缝在场时 TUI/serve 恒注入，`session/runtime.ts` 装配）
  - 另册：`spawn`（subagent.ts 工厂）/ `task_stop` / `task_wait`（仅 exec/spawn 台账；板 id 拒识点名 `agent_team_task_wait/stop`）；用户面列任务走 `/tasks`，不另增模型工具
  - 智能体团队八件套（`agentTeams` 门禁，缺省开；语义键/槽解析单点 `config/agent-teams.ts`）：`create_agent_team` / `create_agent_teammate` / `create_agent_team_task` / `update_agent_team_task` / `get_agent_team_board` / `send_agent_team_message` / `agent_team_task_wait`（仅板任务）/ `agent_team_task_stop`；板态 `pending/running/success/failed/cancelled`；关开关则不注入且 GUI 隐页签；成员面剔板面写件、换注读取件
  - 插件贡献工具以 `mcp__<server>__<tool>` 前缀进模型面，不入内置清单；guard 按 manifest `safety` 三类驱动问线（`act` 任何档强制 ask、`confirm` 通用 ask+会话一次放行、`observe` 直放），未声明走通用 MCP 审批；工具 schema 由 server 经 `tools/list` 下发，harness 不手写
- **原始工具面复用**：原始操作能靠既有原子工具+既有参数完成的一律不新增专属工具；核心 harness 能力（记忆/技能/子智能体/任务停止）可为模型定义专属工具。工具清单属稳定段（§11）——每加一个工具即一次全量前缀断点，新增须论证并经用户裁决
- **工具参数声明化**：每工具必须 JSON Schema 声明 `parameters`（function calling strict 口径——`additionalProperties` 显式闭合、可选项 null 联合进 `required`；自由入参属例外须显式登记宽松点），无 schema 不得入清单
- **依赖引入**：优先 node: 内置；引入第三方须解决真实问题、维护活跃、类型完善、许可证与依赖面可控；登记 `package.json` + README/Arch-Plan 标注，跑全量 build/test。已引入依赖的收敛边界与回退预案见下表：

| 依赖 | 用途与收敛边界 | 回退预案 |
|------|----------------|----------|
| @modelcontextprotocol/sdk | MCP 客户端三传输，收敛于 `harness/mcp/client.ts` 接缝 | 自研最小 stdio JSON-RPC 客户端同接口 |
| ink + react | TUI 组件化渲染层（仅组件/入口），收敛于 `src/tui/` | 退原生 ANSI 最小面 |
| sqlite-vec | KB 向量后端（`SUNSHINEX_KB_BACKEND=sqlite-vec`），收敛于 store 接缝 | local-json 缺省回退，禁静默切换 |
| markdown-it | Markdown→IR，唯一消费=markdansi 表格网格回路 | IR 稳定，换解析实现不动渲染层 |
| markdansi | Markdown→ANSI 渲染，收敛于 `tui/md-ansi.ts` 单点出口 | renderMd 接缝稳定，替换不动渲染分流 |
| cli-table3 | 表格框线渲染，收敛于 `tui/markdown.ts` | 降级原文行 |
| highlight.js | 围栏代码块高亮，收敛于 `tui/highlight.ts` | `HiSpan` 接口稳定，替换不动渲染层 |
| mermaid（GUI） | 会话流围栏图渲染，收敛于 `gui/src/Mermaid.tsx` | 回落原文 |
| @deepseek-ai/node-addon-landlock-run | exec 内核级写围栏（Linux-only），收敛于 `security/landlock.ts`；缺失/不支持静默降级不阻断 | `SUNSHINEX_SANDBOX=off` 回 JS 检查 |
| ws | daemon WS 服务面，收敛于 `serve/daemon.ts` | 退 HTTP 快照轮询（路径已在） |
| node-pty | 终端标签 PTY 宿主，收敛于 `serve/pty.ts`（原生模块） | 终端降级不可用提示 |
| @xyflow/react + @dagrejs/dagre | 团队编排图，收敛于 `gui/src/tabs/TaskDag.tsx` | 降级任务列表；布局接缝 `layoutTaskDag` 纯函数 |
| @playwright/mcp | browser-use 插件的浏览器 MCP server（钉版，插件目录开发依赖非主仓依赖；esbuild 内联双单文件束） | 插件不启用即零依赖面 |

GUI 规划选型唯一登记于 §13 组件选型表，不在此重复。

- **核心契约零兼容**：模型核心契约不支持即换模型/端点，禁止提示词层兼容适配。允许的容错仅两类：①wire 层差异（闭集形态+确定归一+未知可判定回退）；②运行时自愈与增强降级（反应式压缩、effort 探测降级）。判据：需要预测「模型下一步输出什么」的补丁一律不做

## 6. 技能规范

- 标准形态 `{根}/skills/{id}/SKILL.md`（SKILL.md 优先、skill.md 兜底），frontmatter name/description/version+正文。**装载面仅限标准形态**——`rules/*.mdc`、裸 `AGENTS.md`、`commands/*.md` 均不装载（防回归钉锁定）
- 装载优先级（右遮左，id 撞名就近遮蔽；resolve 仅 SKILL_NOT_FOUND 逐级回退、SKILL_PARAM_MISSING 就近不回退）：

```text
.sunshinex > .agents > .claude > .codex > .cursor（项目级五根，只认 {root}/<根>/skills/{id}/SKILL.md）
  > ~/.sunshinex/skills/（全局，SUNSHINEX_USER_SKILLS_DIR 覆盖）
  > ~/.sunshinex/projects/<工作区>/data/skills/（学习级，自动沉淀，FIFO 上限）
  > plugins/<id>/skills/（插件链尾，启用且平台可用才并入）
```

- 发现与加载（渐进披露）：name+description 清单由 `formatSkillsIndex` 注入会话冻结段，模型经 `skill` 工具按 id 加载正文（观察尾追进链）。用户入口 = `/skill-id` 软引用与 `/skill` 选择卡；命令面仅内置命令
- 技能启停：settings 语义键 `disabledSkills`（槽 `SUNSHINEX_DISABLED_SKILLS`，逗号分隔技能目录绝对路径）按 id 停用装载，停用条目不进清单注入（GUI 技能面板开关落点）
- 智能体团队：`.sunshinex/teams/{id}/team.md`（frontmatter name/description/members/lead/enabled，正文=章程），成员按 id 引用 agents 注册表；两级落位=项目级遮蔽全局 `~/.sunshinex/teams/`（catalog `teamsDir` 单点，写面收口 catalog）；清单进冻结快照，`#team-id` 软引用经 `load_agent_teams` 加载章程，实例化走八件套（受 `agentTeams` 门禁）；`$agent-id` 软引用经 `load_subagent` 出卡、spawn 委派

## 7. 提交与验证

- 提交前必须过 `pnpm build`（tsc strict 零报错）；涉加载/解析逻辑补示例物料并 selfcheck
- 运行时数据统一落盘 `~/.sunshinex/projects/<工作区>/data`（`SUNSHINEX_PROJECTS_DIR` 重定向；工作区保持干净）。`SUNSHINEX_DATA_DIR`（整目录直指、不按工作区隔离）为开发与测试专用重定向口，留在 env 面不进 settings 语义键表
- **SUNSHINEX_* 环境槽是语义键的运行时载体**（`SEMANTIC_KEYS` 为全仓唯一权威；装载链按「显式 env > 语义键落槽」写槽）：运行面读槽属契约消费，槽是装载链输出端而非第二配置面

## 8. 边界与约束

（无）

## 9. 信息对齐与执行准则

- 信息充分：直接执行，不重复追问
- 缺失关键信息：最多提 3 个关键问题；不影响推进时明确假设、先做探索版再收敛
- 主动指出更优替代与取舍，不盲从原方案；共同未知转最小实验验证（控制单一变量、明确成功/失败信号）

## 10. 代码与文档修改纪律

- 禁止补丁式修改：追溯根因重构，禁临时 if/开关变量/复制粘贴兜底；同一 bug 反复 2–3 轮即质疑架构与提示词
- 代码自解释；注释只写业务规则与决策背景，不复述逻辑
- 无残渣：清死代码、未用 import/字段、注释掉的代码；上新删旧不留悬空引用
- **删除即无痕**：删一个概念即清出全部引用面（文档/代码/注释/配置/分支），正文零存在史——完整证据只留提交历史与规格存档
- **正向表述**：规则以「现行是什么、做什么」承载，反向限定仅作边界短标注
- **命令是底层实现，GUI 只是渲染层**：命令执行与状态变更全在 daemon/命令通道层，GUI 不发旁路、不拦截、不替代语义，仅在命令成功后同步渲染态。回执 i18n 归属见 §15

## 11. 前缀缓存：产品第一要义（Prompt Caching）

推理成本与时延是核心竞争指标，前缀缓存是最有效杠杆——能力建设必须建立在「相邻请求 token 前缀命中率最大化」之上。对标 Claude Code：系统提示词与工具清单整场冻结、对话只尾部追加、历史仅在压缩点重写。

**上下文模型：单一基座 + fork**（详见 `docs/superpowers/specs/2026-09-14-context-fork-design.md`）：

```text
[稳定段]     身份/输出约定/工具政策等共享行/工作目录（stableSegmentOf 单点）      ← 全层共享，逐字节冻结
[SUNSHINE.md]  全局 → 项目两层冻结快照                                        ← 会话级常量
[技能清单]   name+description 索引（同刷新点冻结、按名排序）                   ← 会话级常量，按需加载
[压缩块]     会话链前缀折叠摘要                                              ← 唯一合法重写产物
[会话链]     任务指令行+全量执行轨迹+结论行                                   ← append-only，只在尾部变
[fork 尾追]  角色行+节点任务行+私有步骤                                        ← 仅 graph 节点/子智能体
```

主任务、plan 步骤、loop 修正轮是主链追加；graph 节点与子智能体是主链 fork（私有步骤不回主链，只回写结论/补丁行）。任何相邻帧差异只允许出现在尾部。

**核心不变量**（违反即回归；任何新能力先回答「落在提示词哪个位置、击穿多长前缀」）：

- **消息视图单一来源**：模型上下文只由 `buildMessages`（`context/messages.ts`）派生；稳定段单点 `stableSegmentOf`（`prompts/shared.ts`）；loop/graph 角色框定与任务文本复用主链（判据仲裁等独立一次性调用模板收 `prompts/`，内部同样禁时变字段）；各层禁止自行拼提示词
- **前置段字节冻结**：禁时间戳/随机值/时变字段；工具清单按名排序；环境事实为会话级常量；观察与事件一律尾部追加，禁写回前置段——链即记忆
- **只增不改**：会话链 append-only，过期以补丁行追加修正；压缩是唯一合法重写点（预算驱动、滞回节流）；任务边界不重置上下文
- **消息形态不变量**：tools 清单为请求级字段不进提示词文本；system 双消息（稳定段+会话冻结段）逐字节冻结
- **用户级会话参数**：tier/模型选择/思考强度整场恒定或显式切换（经 `ModelSwitcher` 外壳换内芯、持有者引用不变）、不进提示词、模型无自调通道、系统不自动换档；effort 按七档阶梯降级、全不支持省略参数——前缀缓存零影响
- **动态改动一律尾追**：会话开始装载（SUNSHINE.md 两层/技能清单/记忆索引进冻结快照）→ 运行中任何变更只尾追说明行 → 轮次边界与跨天 resume 主动探测读盘比对，差异一律尾追。快照重写只发生在既有刷新点（构造/`/init`/`/new`/压缩成功），其余任何时刻不重建
  - 注入面：SUNSHINE.md 两层独立基线（全局层 `SUNSHINEX_GLOBAL_SUNSHINE` 覆盖，缺失为合法态、消失同样尾追告知；全局文件在模型可写边界外）；技能清单变更尾追一行增量告知，正文经 `skill` 实时读盘置尾；记忆索引变更尾追全文块+supersession+slug 失联警告（索引快照不动，记录文件经 `read` 恒 live）
  - 过期与冲突：新确认与链中旧条目冲突时不删不改，只尾追「过期/冲突说明行」声明以最新为准；读者按「后到者优先」取尾行，历史行留作审计
  - 反面即回归：新内容插回前置段、就地改写历史行、为生效提前重建快照——任一条击穿其后全部前缀

**验证与回归**（改动强制项）：

- 提示词组装面改动附「相邻步前缀稳定」用例（首个差异点落尾部）；跨层改动附「主链↔fork 首帧严格前缀连续」用例；动态面会中变更附「相邻帧逐字节不变、新内容只以尾追行出现」用例。跑 `pnpm build` + 全量 + selfcheck
- 新增进上下文的装配面/提示词产出面时，全仓审计动态源零泄漏（`new Date`/`Math.random`/`toISOString` 仅限旁路遥测与耗时统计）；确认无第四类动态面时同步更新本节清单
- 端点侧缓存能力以探针口径观测（第二轮 `cached_tokens` > 0 即命中）；端点侧缺口归端点侧

## 12. 长任务设计取向

任务由完成判定驱动，非保守步数/超时中断驱动。**缺省放宽原则**：超时/轮次/步数/预算缺省按「真实长任务」量级取值——模型调用 600s、命令 1800s、输出缓冲 32MB、Reactor 400 步（`SUNSHINEX_MAX_STEPS`）、修正环 200 轮/12h（`SUNSHINEX_MAX_LOOP_ITERATIONS`）、全链 1000 节点步/2M tokens/24h（`SUNSHINEX_MAX_GRAPH_NODES`）；主链与子智能体 token 硬顶缺省**不设**（`SUNSHINEX_MAX_TOKENS`/`SUNSHINEX_SUBAGENT_TOKEN_CAP` 显式注入才生效；子智能体硬顶不继承父级）；墙钟为失控保底不进 settings 常规面。宁可放宽缺省，不靠保守中断制造假失败。

**放宽不等于无界**：预算记账、错误局部化、fail-bounded 全保留——上限是安全网非期望路径。

**新增参数**：缺省按长任务场景论证；测试可用显式小值构造边界，不得因测试便利反推缩水产品缺省；**各层缺省同量级一致——单层缩水即整链瓶颈**（入口/模板层显式覆盖值视同产品缺省同等论证）。调整任一处须同步评估其余层级（task_wait 阻塞到终态缺省 1800s 占工具执行槽等敏感点）。

## 13. 交互面构建规范（TUI / GUI）

质量基线对标明星产品：TUI 对标 Claude Code、GUI 对标 Codex 工作台。好用易用优先于实现优雅；**开源优先**：新增交互能力先调研活跃开源组件，有则直接采用、无合格件才自研且在接缝处隔离（可替换），选型标准沿用 §5。

**组件选型登记**（唯一登记处；引入时同步 §5 依赖台账）：

| 层位 | 开源件 | 状态 | 收敛边界 |
|------|--------|------|----------|
| TUI 渲染 | ink + React | 已引入 | `src/tui/`（仅渲染层，运行时零接触） |
| TUI Markdown | markdown-it | 已引入 | `tui/markdown.ts` |
| TUI Markdown 流式 | markdansi | 已引入 | `tui/md-ansi.ts` 单点出口 |
| TUI 高亮 | highlight.js | 已引入 | `tui/highlight.ts` |
| TUI 宽度 | string-width | 已引入 | 中英混排宽度测量 |
| GUI 框架 | React 18 + Vite | 已引入 | `gui/` 工作区包 |
| GUI 状态管理 | React hooks/useReducer | 已引入 | Chat reducer + App 级 hook，无外部状态库 |
| GUI Markdown | react-markdown + remark-gfm | 已引入 | 会话流正文渲染 |
| GUI 编辑器 | Monaco（@monaco-editor/react） | 已引入 | `gui/src/monaco-setup.ts` + `diff-panel.tsx` |
| GUI 图渲染 | mermaid | 已引入 | `gui/src/Mermaid.tsx`（懒加载/失败回落） |
| GUI 图标 | lucide-react + @iconify/react | 已引入 | 界面图标与文件树图标 |
| GUI 终端 | @xterm/xterm + addon-fit + node-pty | 已引入 | gui 渲染、daemon 分配 PTY |
| GUI 团队编排 | @xyflow/react + @dagrejs/dagre | 已引入 | `gui/src/tabs/TaskDag.tsx` |
| GUI 桌面壳 | Electron | 已引入 | `shell/` 工作区包 |
| GUI 壳工程化 | esbuild + electron-builder | 已引入 | 壳束构建与 NSIS 打包 |
| GUI 文件监听 | chokidar | 规划选型 | 现行 30s 轮询+会话切换刷新 |
| GUI 内嵌浏览器 | Electron `<webview>` | 已引入 | Web 标签真实页面；页签常驻池按座位+会话复合键常挂（poolKey 单点）、登录态按会话持久分区 `persist:sx-<浏览器键>`；收敛于 `gui/src/tabs/WebTab.tsx`+`WebTabPool.tsx`+壳 webview 纪律 |
| GUI 可选增强 | dockerode + tree-kill | 可选增强 | 容器化执行按需引入 |

- **架构边界**：交互面只做参数解析与呈现，共用 `src/runtime.ts` 装配根，只消费 SessionEvents 与 asker 契约；IR 与契约稳定时允许整体替换开源件
- **持久化分层（TUI/GUI 双面口径，2026-10-19 裁定）**：两会面共有的数据一律同一底层实现、同一落盘位置、共享模块单点读写；禁止各面自建私有副本或平行写面。三档落位：
  - 会话级共享：`data/sessions/<会话id>.jsonl(+.meta.json)` 一会话一档（转录/段档/影子行/等待队列全在档内）；同目录 `<id>.transcript.md` 镜像与派生 `INDEX.md`；团队板/inbox 落 `data/teams/<journalId>/`
  - 工作区级共享：`data/` 其余子目录（记忆/学习技能/KB/workspace.json），跨会话共用
  - 面私有 UI 态：与 `data/` 平级的 `gui/`、`tui/` 子目录——按会话键的档键=journal id（跨重启稳定身份），工作区级偏好落 `gui/ui-state.json`，应用级指针档落 `userConfigDir()/gui/ui-state.json`。`data/` 整树保持纯会话共享域。判断口径：换面打开同一会话，数据仍在=共享面，消失=面私有面
- **体验基线**：快捷键符合终端惯例、输出有渲染降级、状态与错误用户可读；拿不准以「明星产品怎么做」为参照
- **引入流程**：按 §5 登记与验证；规划选型转正同步更新本表

### GUI 风格铁律

1. **圆角一致**：`--radius-sm/md/lg/xl/2xl` 全量 22px（=`--radius-composer`），面状容器与控件面一律同弧度；`--radius-xs`（5px）仅行内 code/chip/徽标；线形元素与 SVG rx 按面另行落值。新增面状组件一律 `var(--radius-composer)`，取值一律走 `--radius-*`；带边框容器以 `overflow:hidden` 裁齐内表格
2. **悬浮提示统一自定义**：hover 提示一律 `data-tip`（CSS 属性驱动），贴右缘加 `tip-right`；**禁原生 `title` 提示**（`title` 仅允许无障碍名）；测试/e2e 定位走 `[data-tip=…]`
3. **展开/收合一律平滑过渡**：可折叠区域必须高度过渡动画（grid `0fr→1fr`，`--dur-relaxed`），**禁瞬切**；贴底场景动画期逐帧钉底（G14.64）；新增可折叠面复用 `.sx-collapse`/`.seg-collapse` 模式
4. **悬浮提示克制**：可见文字已说明的元素不加提示；只用于图标钮、截断文本、状态解释
5. **全局超椭圆圆角禁止回归正圆——全局与单件同禁**（2026-11-03 裁定，2026-11-09 重申）：`corner-shape: superellipse(1.5)` 全局级联是既定视觉语言；任何理由不得撤全局规则或单件换正圆（已有两次全局回退与一次单件回退在案）。唯一豁免=圆形语义件（状态点/转圈环/滑块拇指，app.css G14.207 豁免组）。毛刺修复登记手段：①阴影收敛——远晕/inset 高光不随形，浮层统一 `--elev-prominent` 贴合近距投影；②撤高亮描边环与 1px 实线边框（同为不随形毛刺源）；③小尺寸件羽化边（底色移 `::before` 继承弧度 + `blur(0.45px)`，`.sx-composer .send` 现行）；④局部面豁免仅限用户明示单一目标；⑤浮层定位整数化——视觉测量写入浮层样式处一律 `Math.round`，与 §ui-zoom「视觉/zoom 归一」叠加
6. **跳转定位不加闪光**（2026-11-08 裁定，2026-11-09 重申）：跨页签/行级定位一律瞬跳（`scrollIntoView({block:'center'})`），**禁 flash/描边高亮/平滑滑动**；残留「flash 定位」表述以本条为准
7. **图标钮尺寸与亮度下限**（2026-11-09 裁定）：GUI 图标一律 ≥14px（`--icon-min`），只随界面放缩不随字号；唯一豁免=状态点内装饰符号。亮度 ≥`--fg-icon`，禁 `--fg-secondary/tertiary` 直作图标钮色（hover 提亮到 `--fg`）；自检走 `gui/src/icon-min.test.ts`
7b. **图标钮 hover 命中盒 24px**（2026-11-10 裁定）：一切图标钮 hover 背景盒 24px×24px（`.sx-iconbtn` 基准形），18px 历史面一律放大；盒内图标仍 14px 禁再收窄
8. **界面字号下限 14px**（2026-11-09 裁定）：一切界面文字最小 `calc(14px * var(--fz))`；**唯一例外=代码内容面**走 `--f-code`（缺省 12px）。字号上调后容器随之放大，已有省略的容器尺寸不动

## 14. 平台兼容性目标

「一份代码、三平台可部署」：Windows / macOS / Linux（Node ≥ 22.9）；命令执行以 POSIX sh 为基线，Windows 经 Git Bash 原生支持。机制细节见 docs/PLATFORM.md，本节只留编码强制的工程约束。

- 版本下限 Node ≥ 22.9（engines 为准），实测基线 22 LTS 与 24.x
- 路径一律 `path.join/resolve/relative` 禁手拼分隔符；子树包含判定一律走 `isWithin`（`src/paths.ts`）；命令执行收敛 `ProcessSandbox` 单点，平台分支只允许在该文件（登记例外：skills-install 浅克隆 / worktree.execGit / serve/session-changes 的参数数组 git 直调，与 `serve/pty.ts` PTY 接缝）；pnpm scripts 零 shell 语法依赖（仅 `&&`）；glob 匹配与产物统一 `/` 分隔
- 机器强制：CI 矩阵 ubuntu+windows × Node 22/24（fail-fast: false）；`.gitattributes`+`.editorconfig` 双管 LF 契约；子进程统一 `spawn(ComSpec, ['/c', cmd, ...])`，不用 `shell: true` 与 `args` 并用（DEP0190）
- Landlock exec 写围栏 Linux-only（内核 ABI 探测），macOS/Windows 为 host 口径（ask 兜底）；隔离三态 `landlock | container | host`，auto 探测、selfcheck 上屏；`SUNSHINEX_SANDBOX=off` 一键关
- 新增平台相关行为须在本节登记差异与结论，并同步复核 docs/PLATFORM.md
- 测试命令对 shell 中立：断言前提以脚本文件或跨 shell 命令承载；shell 语义用例集中 `security/sandbox.test.ts`

## 15. 语言规范：外观双语、提示词恒英文

两条线各自独立、不得混用。

- **外观（双语，可配置）**：用户直接看到的界面呈现——TUI chrome、审批卡、系统消息、命令帮助、CLI 用法与自检输出。`--language=en|zh`（缺省 en）经 `setLanguage()` 装配前一次性设定、会话内恒定；一律 `t(en, zh)` 调用时求值，禁模块级常量冻结
- **提示词（恒英文单语，不可配置）**：凡进模型上下文的一切文案（系统提示词、工具名与描述、观察与错误、压缩摘要提示词、角色框定、生成类 goal、判据与链行）一律英文单语。理由：提示词是行为契约而非外观，单语可机械校验
- **归属判据**：只看串有无写链（`appendChain`/`observation`/`steps`）——写链→英文单语；写死且零写链、只上屏→`t()` 双语。同文件两形态可并存，不按目录一刀切
- **模型产出不译**：链行承载的模型产出正文照原样保留；我们自写的前缀与兜底文案用英文
- **机械校验**：「非 `t()` 包裹的中文字面量零出现」于提示词与链产出面；审计按是否被 `t()` 包裹区分。豁免：项目专名与功能性非 ASCII（分句标点、框线字形）
- **产出语言（模型自判）**：生成文档/答复正文/代码注释/提交说明由模型按当前项目既有文档风格自判，产品侧不设配置项
- **机器消费区**：精确标题与字面按既有约定照写（如 `## Compact Instructions` / `## 压缩指令`）
- **daemon 回执产出**（2026-11-04 裁定）：serve 层命令回执与 notice/pump 提示恒英文单语字面量，不走 `t()`；例外=不可控动态照原样透传。渲染权在前端：GUI 用 `t()` + 固定头模式表（`gui/src/i18n-notice.ts`），TUI 在展示层 `t()`。模式表与 daemon 文案**人工同源、两处同添**（`i18n-notice.test.ts` 为防脱节锚）
