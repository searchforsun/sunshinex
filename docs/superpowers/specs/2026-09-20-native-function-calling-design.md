# 原生 function calling 迁移设计（工具调用协议硬切换）

- 日期：2026-09-20
- 状态：设计要点经用户三裁决批准（硬切换 / 工具清单迁移 / 独立调用全迁），本规格为批准口径的完整化；实施未开始
- 探针证据：`/workspace/probe-so.js`（json_schema strict 可行性）、`/workspace/probe-fc.js`（function calling 能力矩阵）；端点 open.bigmodel.cn · glm-5.3-flash，2026-09-20 实测

## 1. 背景与动因

文本信封协议（整段提示词装进单条 user 消息、模型回一个 JSON 对象表达动作）的缺陷史：

| 日期 | 事故 | 当时的补丁位置 |
|---|---|---|
| 2026-09-13 | 并行数组误装单信封（`tools` 被当工具名查注册表） | parse 归一 + 提示词消歧行 |
| 2026-09-13 | `input` 为数组的畸形并行 | parse 归一 |
| 2026-09-14 | 顶层数组信封（`[` 开头判违规、动作被静默吞） | parse 归一 + 提取器 ignore 态 |
| 2026-09-20 | plain 态信封连 content 整段灌进正文（44d54c8） | 提取器挂起候选 |

同一根因反复复发：**动作合法性约束在「提示词约定 + 事后归一」两端，模型侧无强制力**。strict 探针实证 json_schema 强制路线不可行——端点对 `strict:true` 静默不校验（故意不合规的 schema 不报错、required 字段可缺省）；function calling 探针实证端点原生 tool_calls 完整可用。约束的唯一可靠位置在端点侧 → 文本信封协议退役。

function calling 能力矩阵（探针实测）：

| 能力 | 实测 |
|---|---|
| 单调用 | finish=tool_calls，args 合法 JSON，content 空 |
| 并行 | 一轮 2 个 tool_calls（read×2），不同入参 |
| 流式 | delta 携带 tool_calls 增量（工具名+参数分片）与 content |
| 旁白并存 | content（phase 载体）与 tool_calls 同轮共存 |
| 结果回传 | role:'tool' + tool_call_id 回传后正常收束（finish=stop） |

## 2. 用户裁决（三根钉子）

- U1 硬切换：删除文本协议，只留 function calling；不支持 tools 的端点明示报错，不做任何降级档
- U2 工具清单只走 API tools 字段，提示词摘除文本工具清单
- U3 独立小调用（loop 判据 / 压缩摘要 / 记忆提取 / learned 提炼）全部统一迁移

## 3. 架构基座：链为唯一事实源，消息为派生视图

**D1** 会话链（append-only 链行）仍是唯一事实源与持久化单位；消息数组是 `buildMessages(chainView, 冻结段)` 的纯函数派生视图。由此：

- session-journal 词汇零改动（journal 记链行，链行→消息是装配期映射）
- 压缩仍是链折叠（唯一合法重写点），消息视图随折叠后的链重建
- fork 仍是 chainView() 派生 + 尾追；fork 首帧 = 主链末帧的严格前缀（消息边界粒度）
- 「链即记忆」、三段式、动态面盘点等第一要义不变量全部平移，不改写

**D2** 链行保真升级：每步工具调用增记「动作行」（tool 名 + 完整入参 JSON 一行）；观察行维持现行截断口径。理由：消息视图必须能重建 assistant tool_calls 消息与 role:tool 的配对；与 fork 规格「全量执行轨迹」语义一致。代价如实登记：写重任务链增长（入参含全文），由既有压缩机制承载，对标 Claude Code 的全保真 tool_use 历史。

## 4. 消息形态

### 4.1 消息序列映射

| 现行装配段/链行 | 消息落点 | 冻结语义 |
|---|---|---|
| 稳定段（身份/Markdown 约定/phase 约定/工具选择政策/工作目录） | system#1 | 逐字节冻结，永不改写 |
| 会话冻结快照（SUNSHINE.md 条目/技能清单/记忆索引） | system#2 | 沿用快照既有刷新点（构造、/new、reloadContext、压缩成功，以现行实现为准），其余恒定 |
| 工具清单文本 | **API tools 字段** | 请求级字段，零提示词占用；装配期冻结（MCP 纪律不变） |
| 指令行（任务/plan 步/goal） | user | 尾追 |
| 回复正文（reply） | assistant content | 尾追 |
| 工具调用 | assistant tool_calls（content=phase） | 尾追 |
| 工具观察 | role:'tool'（tool_call_id 一一对应） | 尾追 |
| notice/漂移/过期冲突说明行 | user（元信息行） | 尾追 |
| 技能块（skillRef 置尾） | user（[skill] 元信息消息） | 置尾语义不变 |
| 压缩块 | 单条 user（[Compacted summary checksum=…]），折叠其后旧消息 | 唯一合法重写 |

两条 system 分立：稳定段与快照刷新语义不同，分立使快照重写不触碰 system#1（前置段字节冻结在消息粒度成立）。端点对多条 system 消息的兼容性列实施期验证项，异常则合并为一条并在代码注释登记。

### 4.2 phase 与 reply 的新来源

- phase：tool_calls 同轮 assistant content（探针实证并存；content 为空时该轮无 ▶ 行，与现行 phase 可选语义一致）
- reply：收束轮（finish=stop）content
- `{"done":true,...}` / `{"phase":...}` 信封字段整体消失

### 4.3 动作消费

**D3** adapter 直接产出结构化动作 `{content, toolCalls[]}`（流式聚合 tool_calls 增量），reactor 的文本 parse 归一层整层退役。

**D4** 并行 = 一轮多 tool_calls；exec 单发纪律保留在执行面校验（参数 schema 无法表达跨调用约束），违规批整体拒绝并 role:tool 回喂（现行语义）。无 tool_calls 且 finish≠stop → 回喂纠偏观察（fail-bounded）。

## 5. 独立小调用函数化（U3）

| 调用 | 提交函数 | 参数 | 回退语义（不变） |
|---|---|---|---|
| loop 判据 | submit_verdict | {passed, verdict: met\|not-yet\|impossible, evidence} | 不可解析仍走既有错误分级 |
| 压缩摘要 | submit_summary | 六要素 {goal, constraints, progress, verified, open, rationale} | 失败/超预算回退确定性 join |
| 记忆提取 | memory_items | {items: [{type, content, description}]} | provider 门禁、失败静默跳过不失败收口 |
| learned 提炼 | refine_skill | {usable, description, body} | 无模型/失败回退现状写盘沉淀 |

独立调用 prompt 不进主链的不变量保留；判据禁时变字段不变。结构化参数直接消灭「判据输出不可解析」类缺陷面（判据三值协议从文本约定变为类型约束）。

## 6. 工具 parameters 声明化（U1/U2 的承重面）

- ToolSpec 增 `parameters`（JSON Schema），`src/types.ts` 登记；内建工具逐个声明（read/write/exec/grep/glob/webfetch/websearch/kb_search/skill/spawn/memory_write 等），口径按 strict 兼容写（additionalProperties:false、全字段 required、可选项用 null 联合表达）——当前端点不校验 strict，但换支持 strict 的端点直接受益，且参数声明对调用准确率有独立价值（探针 read 入参完全正确）
- MCP 工具 inputSchema 直映射 parameters（协议原生契合）
- 确属自由入参的口子（skill.params、spawn.prompt 等）登记为宽松点（additionalProperties:true），不为佯装严格而扭曲表达

## 7. 错误语义

- 端点不支持 tools（HTTP 4xx）→ 既有 model-error 通道明示，无降级（U1）
- args 非法 JSON / 必填缺失 / tool_call_id 缺失或重复 → role:tool 报错回喂，fail-bounded，不当崩溃
- finish=length 等截断 → 既有 stop-reason 语义保留
- 安全链拒绝 / 工具执行异常 → role:tool 回喂失败原因（模型可见，与现行拒绝观察等价）

## 8. 前缀缓存影响（第一要义对账）

- tools 为请求级字段：零提示词占用；工具清单变更是否击穿端点前缀缓存未知——登记实施期验证项（probe-usage-frames 升级消息形态）
- system#1 恒冻结、system#2 快照刷新点、消息只尾追——三段式不变量逐条平移，无新增动态面
- 强制回归：相邻步消息序列前缀稳定用例在消息形态下重建（序列化逐字节对比、首个差异点落尾部新追加段）；fork 首帧 = 主链末帧（消息边界）用例重建

## 9. 删除清单

- `src/harness/action-schema.ts` 整文件
- reactor.parse 全部归一层（顶层数组信封 / 并行归一 / 单信封容错 / input 数组）
- buildPrompt 的 JSON 协议段与文本工具清单段
- `src/tui/stream-extractor.ts` 整文件（正文直连 reply-flusher；安全点切块/节流/Markdown 预览不动）——44d54c8 缺陷类失去载体
- SUNSHINEX_STRUCTURED_OUTPUT env 槽；settings `structuredOutput` 语义键入 RETIRED_KEYS 定向提示（含替代口径：function calling 恒开；键表按现存实数 -1）
- README / TUI-MANUAL / .env.example 结构化输出口径；CLAUDE.md §11 补消息形态不变量口径、§5 工具规范补 parameters 声明要求

## 10. 落点表

| 落点 | 性质 |
|---|---|
| src/types.ts | ToolSpec.parameters 登记（共享类型入 types） |
| src/harness/tools.ts + tools/builtin.ts | 逐工具 parameters 声明 |
| src/model/adapter.ts | 请求体 messages+tools；流式 tool_calls 增量聚合；response_format 摘除 |
| src/harness/context/（新增 messages.ts；index.ts 装配改造） | buildMessages 纯函数单点 |
| src/harness/reactor.ts | 动作消费/动作行入链/观察回写；parse 退役 |
| src/harness/loop、context/summarizer.ts、memory/extractor.ts、skills/learned.ts | 独立调用函数化 |
| src/tui/stream-extractor.ts | 删除 |
| src/tui/session.ts | 事件消费适配（step/tool 事件载荷来源变化，UI 组件零改动） |
| src/config/settings.ts | structuredOutput 退役入 RETIRED_KEYS |
| src/tui/session-journal.ts | 零改动（D1 直接收益，登记防误改） |
| src/model/adapter.ts 内 ScriptedAdapter | 测试基建改造为 tool_calls 出牌（实施计划 Task 1 前置） |

## 11. 回归矩阵（验收）

1. 相邻步消息序列前缀稳定（序列化逐字节对比、首个差异点落尾部新追加段）
2. fork 首帧 = 主链末帧（消息边界严格前缀）
3. 压缩后链/压缩块不双份（消息视图随折叠链重建）
4. 并行批：多 tool_calls 成对执行上屏；exec 混入被拒并回喂
5. 判据三值经 submit_verdict 落地（impossible 终局语义不回归）
6. summarizer 函数形态 + 失败回退确定性 join 与现行输出逐字节一致（未注入时护栏保持）
7. 记忆提取函数形态 + 五重准入闸门不回归
8. args 非法/必填缺失 → role:tool 报错回喂且 run 不崩
9. 端点拒绝 tools → model-error 明示（仓库内无降级路径可走）
10. settings 残留 structuredOutput 值 → RETIRED_KEYS 定向提示、启动不失败
11. 全量基线迁移后 fail 0（ScriptedAdapter 全量改造后跑平现行测试面）

## 12. 登记不做（YAGNI）

- tool_choice / parallel_tool_calls 请求参数不透传
- 多模态 content parts 不做
- 不做任何文本协议降级档、不做双协议并存
- stream-extractor 不留空壳
- 会话 journal 词汇不扩（链仍是持久化事实源）

## 13. 前置依赖与冲突面

- 与在飞 steering 线落点重叠（reactor.ts / adapter.ts / session.ts / entry.ts / App.tsx）：实施排期须待其收口或经用户明确接管；实施期单文件单编辑纪律从严（本仓已有三次并行写入竞态先例）
- ScriptedAdapter 全量改造是测试基建前置，作为实施计划 Task 1
- 用户端点为硬前置、已探针证实（2026-09-20）；换端点即失能属 U1 明示接受项，README 部署口径须写明「要求端点支持 function calling」

## 14. 自答

- 为什么不留降级档：双协议并存 = parse/测试/文档三面复杂度翻倍，且降级档正是本设计要消灭的缺陷载体；用户明示裁决
- 为什么链不换成消息持久化：journal/压缩/fork 三线语义全在链上，换持久化层 = 三线重写；派生视图以零迁移达成同形态收益
- 为什么动作行全量入链而观察保持截断：消息配对需要真实 args；观察截断是现行已验证的预算口径，两者正交
