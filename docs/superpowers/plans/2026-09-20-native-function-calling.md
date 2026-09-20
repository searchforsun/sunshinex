# 原生 function calling 迁移实施计划

- 日期：2026-09-20
- 规格：docs/superpowers/specs/2026-09-20-native-function-calling-design.md（提交 081386d）
- 执行方式：会话内联 TDD（goal / 子代理显示 / 计划先例收束形态）；单文件单编辑纪律从严（本仓三次并行写入竞态先例）
- 开工前置：与在飞并发线（steering/interrupt/effort）落点硬重叠，开工时点待用户排期裁决（见 §3）

## 0. 前置事实（2026-09-20 现场核实）

1. `ToolSpec` 仅 `{name, description}`（src/types.ts:7-10），无 parameters——T1 登记面
2. 内建工具 11 个：exec / read / skill / write / grep / glob / webfetch / websearch / kb_search / memory_write / ask_question（ask_question 系并发线 47ee44f 已入库，parameters 声明必须覆盖）；spawn 在 Harness 聚合点注册（builtin 之外），其声明落点以 T1 开工时注册面全量复核为准
3. `RETIRED_KEYS` 已存在（src/config/settings.ts:48-50，现 1 键 dataDir），structuredOutput 入列后 2 键
4. stream-extractor 非测试消费点两处：src/tui/session.ts 与 **src/cli/commands/selfcheck.ts**——规格 §9 删除清单漏 selfcheck（勘误①，以本计划为准）
5. 独立调用落点核实：压缩=src/harness/context/summarizer.ts（buildSummaryPrompt / summarizeWithModel）、记忆提取=src/harness/memory/extractor.ts（settleMemory / writeMemoryFact）、learned 提炼=src/harness/skills/learned.ts（settle 的 `refined?: RefinedSkill`）、判据=**src/loop/nodes.ts**（modelJudge）——规格 §10 写 src/harness/loop 系路径笔误（勘误②，以本计划为准）
6. journal 事件词汇 `{t:'msg'|'chain'|'compact'}` 与消息视图零交集：session-journal.ts 零改动确认（D1 直接收益）
7. 本地未推送：081386d（本线规格）+ 47ee44f（并发线 AskQuestion T2）；工作区并发 WIP 15 改 7 增，adapter.ts mtime 距核实时刻 6 分钟（活跃中）

## 1. 任务总览（8 任务 TDD 循环，串行执行）

| 任务 | 内容 | 主要落点 |
|---|---|---|
| T1 | 共享类型登记 + 工具参数声明化 | types.ts、harness/tools/builtin.ts、tools.ts |
| T2 | adapter 消息/tools 请求体、流式聚合、ScriptedAdapter 改造 | model/adapter.ts（+test） |
| T3 | buildMessages 派生视图单点 + 前缀稳定/fork 钉子 | harness/context/messages.ts（新）、context/index.ts |
| T4 | reactor 动作消费改造 + 信封协议退役 | harness/reactor.ts、action-schema.ts（删） |
| T5 | 独立小调用函数化四件 | loop/nodes.ts、summarizer.ts、extractor.ts、learned.ts |
| T6 | TUI/CLI 事件适配 + stream-extractor 退役 | tui/session.ts、cli/commands/selfcheck.ts、stream-extractor.ts（删） |
| T7 | 配置退役与文档五处 | config/settings.ts、README、TUI-MANUAL、.env.example、CLAUDE.md |
| T8 | 回归矩阵 11 条对账 + 三门禁终验 | 全量 |

## 2. 任务详单（每任务红灯先行 → 实现 → 定向绿 → 提交）

### T1 共享类型与工具参数声明化

- 类型登记（src/types.ts）：`ToolCallSpec {id, name, argsJson}`、`StructuredAction {content, toolCalls}`、`ChatMessage`（system/user/assistant/tool 四角色 + tool_calls + tool_call_id）、`ToolSpec.parameters?: JsonSchema`
- 11 内建工具 + spawn 逐个声明 parameters，口径按 strict 兼容写（additionalProperties:false、全字段 required、可选项 null 联合）；确属自由入参口（skill.params、spawn.prompt、memory_write.content）登记宽松点不佯装严格
- 红灯：逐工具 schema 断言（必填全集、无未声明字段、enum 收敛）+ 类型编译面
- 验收：selfcheck 工具清单 11+spawn 项不变；注册面全量 grep 复核无漏声明工具

### T2 adapter 请求体与流式聚合（含 ScriptedAdapter 前置改造）

- 请求体：messages 数组 + tools（由注册表 parameters 映射 OpenAI function 形态）+ tool_choice 缺省 auto；response_format 与 SUNSHINEX_STRUCTURED_OUTPUT 穿参整体摘除
- 流式：tool_calls 增量聚合（index 分片 → name/arguments 拼装）、content 增量照旧、finish=stop 收束 content 为 reply；finish=tool_calls 产出 StructuredAction
- ScriptedAdapter（测试基建）：脚本出牌从 JSON 信封文本改为 tool_calls 序列（支持一轮多调用、content 旁白、finish=stop 收束）
- 红灯：请求体形态断言（含 tools 无 response_format）、增量聚合（名/参分片乱序到达）、多调用并行批、旁白并存
- 验收：adapter 套件全绿；**前置：adapter.test.ts 须已脱离并发线 WIP（排期依赖）**

### T3 buildMessages 派生视图单点

- 新增 src/harness/context/messages.ts：`buildMessages(chainView, snapshot, tools 注册面)` 纯函数——system#1 稳定段 / system#2 冻结快照 / user 指令行与 notice 行 / assistant content+tool_calls / role:tool 配对 / 压缩块折叠 / 技能置尾消息
- 链行增「动作行」：`[tool] <name> <args-json>` 单行英文入链（消息配对的真实 args 来源；观察行现行截断口径不动）
- 红灯：链序列→消息序列映射全分支；**相邻步消息序列前缀稳定**（序列化逐字节、首差异点落尾部新追加段）；**fork 首帧=主链末帧**（消息边界严格前缀）；压缩块不双份
- 验收：context 套件 + 既有前缀回归矩阵在消息形态下重建全绿

### T4 reactor 动作消费改造 + 信封协议退役

- StructuredAction 消费：content→phase（▶ 行）、toolCalls 逐调用过安全链（manual 审批语义不变）→执行→观察行回写 + 配对 role:tool 所需的动作行
- exec 单发纪律保留在执行面校验（参数 schema 表达不了跨调用约束）：违规批整体拒绝并回喂（现行语义）
- finish=stop → content 即 reply 收束；无 tool_calls 且 finish≠stop → 纠偏观察回喂（fail-bounded，不当崩溃）
- 删除：action-schema.ts 整文件、reactor.parse 归一层（顶层数组信封/并行归一/单信封容错/input 数组）、resolveStructuredFormat、SUNSHINEX_STRUCTURED_OUTPUT 消费面
- 红灯：并行批多 tool_calls 成对上屏、exec 混入批拒绝回喂、args 非法 JSON 回喂、收束轮 reply、纠偏观察；既有「畸形信封归一」用例随协议退役删除（登记删用例清单）
- 验收：reactor 套件全绿（新口径）

### T5 独立小调用函数化（四件）

- submit_verdict（src/loop/nodes.ts，勘误②落点）：参数 {passed, verdict: met|not-yet|impossible, evidence}；判据三值从文本约定变类型约束；错误分级与 retry≤3 语义不变、禁时变字段不变
- submit_summary（context/summarizer.ts）：summarizeWithModel 改函数形态取六要素参数；失败/超预算回退确定性 join 不变；护栏保持——未注入 summarizer 时输出与现行逐字节一致
- memory_items（memory/extractor.ts settleMemory）：参数 {items:[{type,content,description}]}；五重准入闸门一条不少；provider 门禁（现 provider==='openai'）迁移后语义改判「模型具备 tools 面」，Stub/Scripted 静默跳过语义保持——登记实施期现场裁决点，收口铁律不变（提取失败不失败收口）
- refine_skill（skills/learned.ts）：参数 {usable, description, body}；无 refined/失败回退现状写盘沉淀不变
- 红灯：四函数形态用例 + 各自回退路径不回归
- 验收：判据三值（impossible 终局）、压缩回退逐字节一致、记忆闸门、learned 沉淀四套件绿

### T6 TUI/CLI 事件适配 + stream-extractor 退役

- session.ts：token/reasoning/tool 事件来源改流式聚合与 StructuredAction；▶ phase 行=assistant content；⏺ 调用行与 ⎿ 观察行成对发射语义保留；children/审批卡/消息组件零改动
- cli/commands/selfcheck.ts：摘 stream-extractor 消费（勘误①落点），selfcheck 输出口径不变
- 删除 src/tui/stream-extractor.ts 及其测试文件（不留空壳）；reply-flusher 正文直连保留（安全点切块/节流/Markdown 预览不动）
- 红灯：session 事件序列（phase→调用→观察→收束 reply）、/plan 重复上屏回归、/init 用例迁移
- 验收：TUI 全套（session.*、App.*、transcript、StatusBar、LiveArea）绿

### T7 配置退役与文档五处

- config/settings.ts：structuredOutput 入 RETIRED_KEYS（键表按现存实数 -1、定向提示含替代口径「function calling 恒开、端点须支持 tools」）；红灯：残留键启动不失败 + RETIRED_KEYS 定向提示
- README / TUI-MANUAL / .env.example：结构化输出三档口径删除、部署口径补「要求端点支持 function calling」并引用探针矩阵（open.bigmodel.cn·glm-5.3-flash 2026-09-20 实测五项全过）
- CLAUDE.md：§11 补消息形态不变量（消息=派生视图、system 双消息冻结语义、tools 请求级零提示词占用）；§5 工具规范补 parameters 声明要求（新工具须带 schema、自由入参登记宽松点）
- 验收：纯文档免构建门禁；settings 定向绿

### T8 回归矩阵 11 条对账 + 三门禁终验

- 规格 §11 逐条对账（1–11），失败项回修后复跑
- 三门禁：tsc strict 0 报错、全量 fail 0（ScriptedAdapter 全量改造后跑平现行测试面）、selfcheck OK（工具清单 11+spawn 项、parameters 全声明）
- 前缀缓存对账：probe-usage-frames 消息形态升级登记为后续项（本轮只跑仓内回归矩阵，不发真实端点请求）

## 3. 排期前置（冲突面，硬约束）

- 并发线（steering/interrupt/effort/AskQuestion）在飞：T2 落点 adapter.ts 与其 effort WIP 硬重叠，T4 reactor.ts、T6 session.ts/entry.ts 同为并发 WIP 文件——开工时点须待并发线收口提交，或用户明示接管（接管=本线为唯一写者、并发 WIP 冻结快照至 /workspace/fork-wip 模式先例）
- T1 落点 types.ts 当前亦在并发 WIP（M）内，同受排期约束
- 任务开工前逐文件 mtime 复核（本会话实测 adapter.ts 距核实时刻 6 分钟被写）；单文件单编辑纪律全程从严（本仓三次并行写入竞态先例）

## 4. 验收矩阵 → 任务映射

| # | 规格 §11 验收项 | 落点任务 |
|---|---|---|
| 1 | 相邻步消息序列前缀稳定 | T3 |
| 2 | fork 首帧=主链末帧 | T3 |
| 3 | 压缩后链/压缩块不双份 | T3 |
| 4 | 并行批成对、exec 混入拒绝回喂 | T4 |
| 5 | 判据三值经 submit_verdict | T5 |
| 6 | 压缩回退确定性 join 逐字节一致 | T5 |
| 7 | 记忆五重闸门不回归 | T5 |
| 8 | args 非法回喂不崩 | T4 |
| 9 | 端点拒绝 tools → model-error 明示 | T2 |
| 10 | settings 残留键定向提示 | T7 |
| 11 | 全量跑平 fail 0 | T8 |
