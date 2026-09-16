# /goal 对齐 Claude Code 形态（条件自由化 · 三值裁决 · 错误分级）设计规格

- 日期：2026-09-16
- 状态：方案 B（核心对齐）经会话内裁决批准（范围问卷通道超时按 fork/子代理两计划先例收束），待实施
- 关联：`2026-09-15-tui-goal-loop-entry-design.md`（/goal v1 薄入口与主链纪律）、`2026-09-14-context-fork-design.md`（会话链模型）

## 1. 背景与目标

Claude Code `/goal [condition|clear]` 官方语义（code.claude.com/docs/en/goal，已核实）：设置完成条件后 Claude **跨轮持续工作直到条件满足**；每轮结束由**独立小快模型**（缺省 Haiku）读「条件 + 迄今对话」出三值裁决——Not yet met（reason 作下一轮指引）/ Met（清除，记 achieved）/ **Impossible**（判定结构性不可满足，清除，记 failed）；错误分级——auth 失败/余额耗尽/模型不可用 → 清除 goal，过载/断连 → 自动重试 3 次后暂停，限流 → 暂停可自动续；resume 时还原活跃 goal 并重置计量基线；无硬时间上限，靠条件内自我设界。

本项目 `/goal`（94eb89d 已落地）现状差距四项：

1. **条件自由化缺失**：goal 无内嵌「验收标准：id=描述」段时 `parseCriteria` 返回 null → checkNode 立即 fail「无验收标准（解析失败不静默通过）」→ 空转回修烧满 100 轮安全网（`src/loop/nodes.ts` checkNode 兜底分支）——当前不写结构化验收标准的 goal 基本不可用；
2. **无 Impossible 出口**：modelJudge 二值 `{"passed":boolean}`，结构性不可满足的目标只能烧安全网；
3. **错误不分级**：判据调用抛错一律吞成 `passed:false`（与「条件未满足」不可区分，`nodes.ts` modelJudge catch 通道）；引擎一律 failed 终态，无 CC 的「不可恢复清除 / 可恢复重试暂停」；
4. **跨天恢复**：依赖 TUI 会话持久化基建（核实：无 persist/restore 模块、`/new` 即清链、唯一恢复先例是 graph pipeline 的 gate resume）——**拆独立特性线**，本规格只保证 goal 状态为纯可序列化数据、为将来恢复预留。

目标：对齐 CC 的前三项核心语义（方案 B）；跨天恢复按 C 档拆线说明（§11）。

## 2. 方案与关键裁决

方案对比（会话内已呈现）：A 最小闭环（条件自由化+三裁决）/ **B 核心对齐（A+错误分级，已批准）** / C 完整对齐（B+goal 持久化跨天恢复，依赖 TUI 会话持久化基建，拆独立特性线）。

| # | 裁决 | 内容 |
|----|------|------|
| D1 | 评估器复用 check 节点 | 不引入 CC 的 Stop-hook 外置评估器形态——goal 无内嵌验收标准段时，checkNode 将整个 goal 包装为**单一隐式判据**（`id=condition`，desc=goal 原文）走 modelJudge；「每轮自由工作→轮末独立小模型评估→reason 作下轮指引」语义同构（deficits 链行即指引通道） |
| D2 | 判据协议三值化 | modelJudge prompt 与解析增 `impossible:boolean`；`CriterionResult` 增**可选** `verdict?: 'met'\|'not-yet'\|'impossible'`，缺省按 passed 推导——旧模型输出（无 impossible 字段）零破坏；规则谓词保持二值不产生 verdict |
| D3 | 既有形态行为不变 | 内嵌「验收标准：id=…」多判据逐项判定、全部 met 才 done、not-yet 写 deficits 回修——回归零变化；任一判据 impossible → 整体终局 |
| D4 | CLI run 同步受益 | 改动全在 loop 层（模板工厂上移红利）：CLI `--goal="自由文本"` 同样获得条件自由化与三裁决 |
| D5 | 零新拼装面/零新终态 | impossible 与不可恢复错误走既有 failed+error 通道（`LoopRunResult.error` 携带理由）；可恢复重试耗尽走既有 paused 态（现仅预算超支，扩一个进入路径）；`LoopRunResult` 零新字段 |
| D6 | agent 侧边界登记 | 工作模型（agent 节点）错误语义维持现状（failed 宁停不误）；本规格只对齐**判据评估器**的错误分级 |

## 3. 判据协议三值化（`src/loop/nodes.ts` modelJudge）

- 判据 prompt 协议行改为：`仅回复一个 JSON 对象：{"passed":boolean,"impossible":boolean,"evidence":string}`（impossible=true 表示该判据**结构性不可满足**）；pick 双语（模型侧文案）；
- 解析映射：`impossible === true` → verdict=`'impossible'`；否则按 passed 推导 `met`/`not-yet`；evidence 透传；
- `CriterionResult` 增可选 `verdict` 字段（`src/types.ts` 登记）；`judgeOne` 规则谓词路径不产生 verdict（二值语义不变）；
- 前缀缓存：判据 prompt 属**独立一次性调用**（fork 规格 §11 先例，不进 reactor 主链），协议行变更零击穿。

## 4. 条件自由化（checkNode 兜底路径重定义）

- 判据来源三优先级调整为：显式输入清单 > goal 内嵌「验收标准：」段 > **goal 整体作为单一隐式条件**（`criteria = [{ id: 'condition', desc: <goal 原文> }]`）——**替换**现行「立即 fail 无验收标准」分支；
- 隐式判据走 modelJudge（ruleCheckers 无 `condition` 键，天然模型通路）；verdict=not-yet 时 evidence 经既有 deficits 通道写链行（`- condition: <goal>`），作为下一轮 agent 的回修指引——CC「reason 作为下一轮指引」同构；
- 用法提示放宽（`src/tui/session.ts` /goal usage、`src/cli/commands/run-loop.ts` usage）：目标即条件——建议「一句可度量的终态描述 + 对话里可自证」；内嵌多判据写法保留为高级用法。

## 5. 判据错误分级（对齐 CC 评估器错误语义）

核心原则：**判据「调用失败」与「判定为未通过」严格区分**——现行 modelJudge 把一切抛错吞成 `passed:false` 的形态废除。

- modelJudge 内部返回判别联合（模块私有类型，不外露）：
  - `{ kind: 'judged'; result: CriterionResult }` —— 判定成功（含 impossible）；
  - `{ kind: 'blocked'; severity: 'fatal' | 'recoverable'; message: string }` —— 调用失败；
- 错误分类（按错误消息特征匹配，fatal 模式优先、未命中再测 recoverable）：fatal = `/401|402|403|unauthorized|forbidden|quota|insufficient|billing|invalid api key|model not found/i`；recoverable = `/timeout|etimedout|econn|overloaded|rate limit|429|5\d\d/i`；两者皆未中 → recoverable（保守默认：宁暂停不误清除，含未知类别）；
- 重试策略：recoverable 重试 ≤3 次（同步立即重试、无退避——判据为轻量单发调用，退避登记为可演进点）；fatal 不重试；
- checkNode 聚合优先级（判定循环内遇 impossible 短路，不再判余下判据）：
  1. 任一判据 verdict=impossible → `terminal: { status: 'failed', error: '目标判定不可满足：<evidence>' }`；
  2. 任一判据 blocked fatal → `terminal: { status: 'failed', error: '判据评估不可用（认证/配额/模型）：<message>' }`；
  3. 任一判据 blocked recoverable（重试耗尽）→ `terminal: { status: 'paused', error: '判据评估暂不可用（已重试 3 次）：<message>' }`；
  4. 全部 met → done；其余 not-yet → 既有 deficits 回修路径；
- 输出不可解析维持 fail-bounded 判不通过（不算调用失败，现行为不变）。

## 6. 引擎 terminal 通道（`src/loop/engine.ts` 单点挂接）

- `NodeOutput` 增可选 `terminal?: { status: 'failed' | 'paused'; error: string }`（`src/types.ts` 登记）；
- engine 主循环在 done 判定之后插一个分支：`if (out.terminal) return this.finish(ctx, out.terminal.status, { error: out.terminal.error });`
- terminal 载荷与 `out.status` 解耦——engine 只读 `out.terminal`（checkNode 侧 terminal 输出一律携带 `status: 'fail'`，不参与 done 判定与路由）；
- 终态映射零新概念：failed/paused + error 携带理由（D5）；iterations 语义不变（节点执行步计数）；guardrail 安全网照常兜底（重试不绕过预算/超时/轮数检查）。

## 7. 回执与文档同步

- session `runGoalFlow` 终态回执已透传 `r.error`——impossible/判据不可用的 failed-with-reason 自动呈现，零新渲染；paused 回执语境补一句「重跑 /goal 续走」（同会话链上续接即恢复，无需恢复基建）；
- TUI-MANUAL `/goal` 条目更新：自然语言条件为缺省形态、impossible 语义、错误分级与 paused 重跑指引；
- README 三面入口段 `/goal` 句补「自然语言目标」；CLI `run` usage 行同步放宽（「验收标准：」段从必需降为高级用法）。

## 8. 错误边界

- 未知类别错误 → recoverable（保守暂停，不误清除目标）；
- 判据重试期间 guardrail（超时/预算/轮数）照常生效，重试不绕过安全网；
- agent 工作模型失败维持现状 failed（D6 边界，覆盖面登记）；
- fork 作用域（graph 角色/子代理内的 loop）同享三裁决与错误分级（loop 层单点红利）；
- 既有断言「无验收标准（解析失败不静默通过）」路径的测试随新语义更新（fail 空转路径不复存在）。

## 9. 验收矩阵

1. 自由文本 goal（无内嵌段）：agent→check（隐式条件 met）→done，无「无验收标准」空转；
2. 内嵌「验收标准：」多判据行为回归不变（全 met done / not-yet deficits 链行回修）；
3. verdict=impossible → 引擎终止 failed，error 含「不可满足」+evidence，iterations 远小于安全网上限；
4. 判据调用不可恢复错误（fatal 特征）→ failed + 明确 reason，不重试；
5. 判据调用可恢复错误 → 重试 ≤3 次后 paused（复用既有暂停态）；
6. 判据输出不可解析维持判不通过（fail-bounded 回归不变）；
7. 规则谓词判据行为不变（二值、不产生 verdict）；
8. CLI `run --goal="自由文本"` 同语义；全量回归 + selfcheck 绿，既有前缀稳定用例不破（判据 prompt 独立调用，主链零新增拼装面）。

## 10. 落点表

| 文件 | 动作 |
|------|------|
| `src/types.ts` | `CriterionResult.verdict?`、`NodeOutput.terminal?` 登记 |
| `src/loop/nodes.ts` | modelJudge（协议/解析/分类/重试/JudgeOutcome）、judgeOne 透传、checkNode（兜底重定义 + 聚合 + terminal） |
| `src/loop/engine.ts` | terminal 通道挂点（一处） |
| `src/tui/session.ts` | /goal usage 文案（条件自由化引导）；paused 终态回执补「重跑 /goal 续走」提示句 |
| `src/cli/commands/run-loop.ts` | run usage 文案放宽 |
| `TUI-MANUAL.md` / `README.md` | /goal 行为描述同步 |
| 测试 | loop 判据协议/兜底/分级用例（engine.test 或 nodes 面）、session.goal.test 自由文本用例、run-loop.test 回归 |

## 11. YAGNI 与否决备选

- **不做**：Stop-hook 外置评估器（check 节点同构覆盖）；`/loop` 定时循环（定时任务属另一需求域）；后台 check-in 指数退避（依赖尚不存在的 background 任务面）；条件 4000 字符硬校验（链行承载无此约束需求）；`/goal clear` 跨轮清除语义（单运行制无活跃 goal 状态）；重试退避（同步立即重试，登记可演进）；
- **拆线**：goal 状态持久化 + TUI 会话恢复（跨天语义）→ 独立特性线「TUI 会话持久化与恢复」；本规格的 goal 状态（条件/终态/理由）天然为纯数据，将来恢复线直接消费；
- **否决备选**：A 档（错误分级缺失，无人值守时判据调用失败仍会误判为「未通过」继续烧）；C 档并入本规格（TUI 持久化基建使规格膨胀 2-3 倍）。

## 12. 自审

- 类型面：仅两个可选字段登记（`CriterionResult.verdict`、`NodeOutput.terminal`），`LoopRunResult` 零新字段；
- 范围：不含跨天持久化（§11 拆线）、不含 agent 侧错误分级（D6）、不含规则谓词三值化（D2）；
- 一致性：判据三优先级（§4）、聚合优先级（§5）、引擎挂点（§6）三处口径互洽；「无验收标准即 fail」旧语义在 §4/§8/§9 三处同步废弃；
- 前缀缓存：判据 prompt 独立一次性调用（§3），主链零新增拼装面，既有前缀稳定回归不受影响。
