# 技术债清理台账（TECH-DEBT-LOG）

> 本文件记录**历次清理的执行内容**与**未偿债项登记（待办债项区）**，处理规则见 `docs/TECH-DEBT.md`。每次清理收尾时在此追加一行，该行的「清理后 HEAD」即为下一次清理的默认基线。

## 记录格式

| 日期 | 基线 | 清理后 HEAD | 账本 | 范围与结果 |
|---|---|---|---|---|

- **基线**：本次清理所用的起点 commit（首次可为「含本账的提交」）。
- **范围与结果**：动了哪些文件/类别、残留复查结论、验证方式与结论（如 selfcheck + 单测全绿）。

## 台账

| 日期 | 基线 | 清理后 HEAD | 账本 | 范围与结果 |
|---|---|---|---|---|
| 2026-09-08 | 含本账的首次提交 | 同左（改动随该提交入库） | 记录债 | 全仓去厂商化：`.env.example` 示例值、README 两处表述、probe 脚本注释与日志 ×4、测试夹具键名（DEEPSEEK→TEST）；`docs/superpowers/` 历史存档按规则保留。残留 grep 归零；selfcheck exit 0，单测 165/165 通过 |
| 2026-09-08 | 8b11e60 | d457809 | 记录债 E/B + 代码债 G | 全仓技术债审计后按双账本当轮清轻债：CLAUDE.md §3 目录树同步实况（E）、§2 补 pnpm test/cli、§7 忽略清单补 .longtask/（B）；删零引用死文件 storage/store.ts、types.ts 死枚举收敛（LoopResult.retry 零产出移除、ToolCategory.network 降注释预留，engine.test 桩值同步）（G·轻）。验证：build 零错、165/165 全绿。遗留中级别债（登记待后续批次）：装配根 buildDeps 上移出 cli 层、错误模型契约统一（Result vs catch-reply）、感知跳过集与 .gitignore 单源化、解析类纯逻辑直接单测（config/agents/skills/loader）、真实模型 e2e 资产化 |

## 待办债项

> 未偿债项在此逐条登记（编号/账本/状态/描述/证据/偿还动作/登记来源）；偿还后在同轮提交中翻转状态并补「关联提交」。本区与上方清理记录互不掺杂。

| 编号 | 账本 | 状态 | 描述 | 证据 | 偿还动作 | 登记来源 |
|---|---|---|---|---|---|---|
| D1 | 二·J | closed（e299a66） | 装配根 buildDeps 定义于 cli/commands/run-loop.ts，run-pipeline 跨命令 import；新增交互面（TUI/GUI）复用装配将被迫依赖 CLI 层 | run-loop.ts:10、run-pipeline.ts:5/47 | 上移 src/runtime.ts 作唯一 composition root，CLI 层仅参数解析 | 2026-09-08 清理行遗留 |
| D2 | 二·J | closed（0fc4283） | 感知 SCAN_SKIP_DIRS 与 .gitignore 人肉双源，已漂移一次（d8dbcc4 补 .pnpm-store）；.superpowers 仍缺 | perception.ts:14 vs .gitignore | export 唯一源 + 绑定测试锚点防漂移 + 补 .superpowers | d8dbcc4 |
| D3 | 一·B/二·J | closed（f14facf，契约入规；实现收敛按登记原文另批） | 错误模型双轨：Result（tools/chain/sandbox）与 throw→catch→reply（engine/reactor/nodes）并存，跨层语义靠约定维持 | graph/engine.ts:161 等 14 处 catch | 契约入规 CLAUDE.md §4；实现收敛另批 | 2026-09-08 清理行遗留 |
| D4 | 二·补充 | closed（f14facf） | 解析类纯逻辑无直接单测：config.ts / graph/agents.ts / harness/skills.ts / plugins/loader.ts / cli parseArgs | 无配套 *.test.ts 清单 | 补解析器单测五件套 | 2026-09-08 清理行遗留 |
| D5 | 二·补充 | deferred | 真实模型 e2e 未资产化，现靠手工 background + 产物判定，成果只在 git log | f2adf16、f5acd9a、clamp 验收 run3 | scripts/e2e-real 手动门脚本（需真实 key，单独批次，不进门禁） | 2026-09-08 清理行遗留 |
| D6 | 一·C/二·I | open（重要） | model-error 双上屏：Reactor 既 `emit('error')` 又在收尾 `emit('done')` 里带同一错误文案，会话层把错误当终答再推一条 assistant，与「失败只走 error 通道」的声明矛盾 | src/harness/reactor.ts（error/done 两处 emit）、src/tui/session.ts 的 done 分支 | session 的 done 分支对 `stopReason === 'model-error'` 跳过终答推送，并补一条对照用例 | 2026-09-11 长任务护栏支线 · 整支评审 |
| D7 | 二·L | open | 阈值/护栏类用例判别力不足：夹具恒回零用量致 tokenCap 分支不可达；「缺省步数 200」半支把 Reactor 常量固化进断言 | reactor.guardrail.test.ts:70-78、runtime.test.ts:129-150、session.plan.test.ts:149 | 补可达夹具（真实用量适配器）；「移除」类断言改为不耦合常量（notEqual / 命名常量）；补「换回旧实现必红」对照 | 2026-09-11 长任务护栏支线 |
| D8 | 二·J | open | graph 的 paused/failed（gate 挂起、节点失败）不带 stopReason，下游须以「undefined = 非护栏越限」为契约维持，现无类型层表达 | src/graph/engine.ts 收尾路径 | 在 GraphRunResult 上写死该契约（注释或判别联合），或补非空 reason | 2026-09-11 长任务护栏支线 |
| D9 | 二·J | open | `/plan` 规划段并入主链后原 `maxSteps: 6` 上限消失，最坏情形仅由 4h / 1M 兜底 | src/tui/session.ts 规划调用点 | 评估是否收回规划段步数上限（护栏口径统一） | 2026-09-11 长任务护栏支线 |
| D10 | 二·G | open | 规划指令文案在 session.ts / session.plan.test.ts / session.incomplete.test.ts 三处独立拷贝；session.ts 两处重复「算 note + 非空即推」 | 三处字面量 | 提为导出常量；抽 `reportIncomplete(r)` | 2026-09-11 长任务护栏支线 |
| D11 | 二·L | open | `stop-reason.ts` 的 default 吞未来新增枚举值（新增 StopReason 成员时静默无文案） | src/tui/stop-reason.ts | 改显式 case + 兜底文案 | 2026-09-11 长任务护栏支线 |
| D12 | 二·G | open | 轻残渣批：reactor.ts 双 `import '../types'`；两个测试文件各自双 `import '../model/adapter'`；runtime.ts 中 `harness.ledger` 恒真的死分支；graph 测试冗余 `as` cast | src/harness/reactor.ts:1,3、templates.long-task.test.ts:8-9、runtime.ts:47、agents.guardrail.test.ts:48 | 当轮清（随下次轻债批次） | 2026-09-11 长任务护栏支线 |
| D13 | 二·L | open | 未断言字段与无判别贡献断言：`UsageAdapter.calls` 只累加不断言（loop/graph 两处）；runtime.test 用例 8 断言无独立红灯贡献；graph/agents.ts 的 tokenCap 无覆盖 | nodes.guardrail.test.ts、agents.guardrail.test.ts、runtime.test.ts:170-173 | 补断言或删无用字段，或注释说明其冗余属有意 | 2026-09-11 长任务护栏支线 |
| D14 | 一·E | open | `ReactorLimits` / `ReactorOpts` 落在 harness/reactor.ts 而非 src/types.ts（共享类型未统一登记） | src/harness/reactor.ts | 待下游直接消费时移入 types.ts 登记 | 2026-09-11 长任务护栏支线 |
| D15 | 一·B | open | 本文件台账表的两行 2026-09-08 / 2026-09-09 记录误落于「待办债项」区之后，表结构错位 | 本区末两行 | 归位至台账表；本次未动（长行搬运风险高于收益），留待下次清理批次 | 2026-09-11 登记时发现 |

> 注：本区之后的**两行**属上方**台账表**（2026-09-08 / 2026-09-09 记录），历史误落于此，待归位（见 D15）。
| 2026-09-08 | c656a05 | f14facf（台账行随紧随提交入库） | 记录债 B + 代码债 J·中/补充 | 三批次偿还 D1-D4：装配根上移 src/runtime.ts（e299a66）；SCAN_SKIP_DIRS 单源化+绑定测试锚点+补 .superpowers 漂移（0fc4283）；错误通道分域契约与装配根条款入规 CLAUDE.md §4、过期占位句移除（f14facf）；解析器单测 config/skills/plugins/agents 四件套 +9 用例、loader 非法 JSON 降级（f14facf）。过程与治理：批次3 首入库带 4 红测（链式命令未设门禁），根因为测试侧断言语义与夹具路径错误（实现无罪），修正后 amend 并确立 fail 0 硬门禁；54 个 root 属主源文件删除重建归位 sandbox（内容零变更），修复沙箱 EACCES 写入受限。验证：build 零错、175/175 全绿。待办债项区 D1-D4 翻 closed，D5 维持 deferred |
| 2026-09-09 | d457809 | 4f09461（台账行随紧随提交入库） | 记录债 | 增量判定 d457809..HEAD（阶段四知识库/MCP/技能沉淀/成本账本批次，81 文件）后当轮清账本一 5 项：`.env.example` 补 KB_BACKEND/KB_DATA_DIR/EMBEDDING_* 注释示例并标注 OPENAI_* 逐键回退语义（A）；CLAUDE.md §5 MCP SDK 边界句更新为 stdio/streamable http/sse 三传输（B/F）；§3 目录树补 ledger.ts 与 skills/learned.ts（E）；README 架构树同步实况（补 runtime.ts/mcp/knowledge/ledger/learned、删悬空 memory.ts、builtin 清单补 webfetch/kb_search）（B/E）；ROADMAP 进度行去厂商化「DeepSeek 兼容」→「OpenAI 协议兼容供应商」（F）。账本二增量复查无新增实债（G–K 全类无；chunk.ts 导出常量属配置面声明、mock-mcp 双脚本协议帧重复属测试物料独立运行设计，均留证不动刀）；遗留 D5 维持 deferred。残留 grep 复查：活文档「未启用」/悬空 memory.ts/厂商键名均归零。验证：build 零错、selfcheck OK（含 learned/usage 行）、299/299 全绿 |
