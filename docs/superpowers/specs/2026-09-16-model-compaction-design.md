# 模型驱动压缩摘要设计

- 日期：2026-09-16
- 状态：设计定稿（用户已批准方案 A + /compact 补链对齐）；实施计划待 writing-plans 产出
- 关联：CLAUDE.md §11（前缀缓存第一要义）；docs/superpowers/specs/2026-09-14-context-fork-design.md（压缩块=唯一合法重写产物、压缩协调链）；window.ts 确定性压缩（现行为）；92ab44a（ctx 水位口径）

## 1. 背景与问题

当前压缩（Reactor 自动压缩 + TUI `/compact`，同一引擎）为**确定性抽取式**：`window.compact()` 按预算选块后，摘要即各块原文头部截断（每块前 2000 字符），无模型参与。问题：

| # | 现状 | 问题 |
|---|------|------|
| P1 | 摘要=原文截头 | 信息密度低，块尾内容直接丢失；与对标形态（Claude Code 模型生成结构化摘要）差距明显 |
| P2 | 丢弃序按类型/位置 | 不识别语义重要性，关键结论可能被丢、冗长过程可能被留 |
| P3 | `/compact` 输入无会话链 | `assemble()` 无参调用，只喂装配面（loader/rules）；对话历史不在压缩对象里 |

**用户裁决**：压缩摘要改由**当前会话模型**生成，内容按六要素结构化（目标/关键约束/进度/验证结果/未完成与下一步/策略依据与原始记录入口）。

## 2. 目标与非目标

**目标**
- 压缩摘要由当前会话模型一次调用生成六要素结构化交接摘要
- 模型失败（抛错/空输出）自动回退现有确定性截断，压缩永不因摘要失败而失败
- `/compact` 补链参与压缩，成功后 trim 链前缀，与自动压缩语义对齐
- 前缀缓存不变量零新增击穿

**非目标**
- 不改选块算法（预算丢弃序、system/instruction 白名单、去重合并原样保留）
- 不改 checksum 语义与 `[Compacted summary checksum=…]` 头部格式
- 不改自动压缩触发阈值、滞回、收敛环与 reread 机制
- 不改 `/new` 语义

## 3. 设计原则（方案 A：协调单点 + 摘要接缝）

1. **模型只接管「怎么讲」，不接管「压什么」**：选块仍由 `window.compact()` 确定性完成（预算内、白名单保护）；模型把选中块的内容浓缩为六要素摘要。确定性资产完整保留为回退路径。
2. **失败回退=今日行为**：模型路径任何失败都收敛为「走现有确定性 join」，压缩结果始终可用，失败面为零新增。
3. **压缩协调单点**：`compact → 摘要 → applyCompaction → trimChainFront` 序列收敛为一个共享协调函数，Reactor 自动压缩与 `/compact` 两入口只传参不拼装（防两处漂移，memory 双写教训）。

### 3.1 关键裁决

| 裁决 | 内容 | 理由 |
|------|------|------|
| D1 方案 A | 模型只生成摘要，不参与选块 | 确定性选块/预算/幂等是已验证资产；C（模型全权）废弃回退底线、测试钉不住 |
| D2 当前会话模型 | 摘要调用走会话当前模型（用户裁决），不做 small 档降档 | 摘要质量优先；压缩点低频，成本可控 |
| D3 checksum 锚定输入 | checksum 仍按选中块（输入）哈希，与摘要体生成方式无关 | 事件身份、幂等门禁、回放检测语义零改动 |
| D4 注入条件 | 装配点仅真实模型（OpenAIAdapter）注入 summarizer；Stub/Scripted 不注入 | selfcheck/无 key 环境自然走确定性路径，行为可预期 |
| D5 /compact 补链 | 组装面加入 chainView 转换条目，成功后 trim 已折叠链行 | 六要素模板的主要素材来自会话链；同时消除与自动压缩的语义分叉 |

## 4. 架构设计

### 4.1 新增接缝模块 `src/harness/context/summarizer.ts`

```text
buildSummaryPrompt(chunks: ContextChunk[]): string
  # 六要素双语模板（i18n pick() 就地成对），附选中块原文与预算约束
summarizeWithModel(complete, chunks, budget): Promise<string | null>
  # 一次 complete(prompt)；抛错 / 空输出 → null
  # 超预算 → 确定性字符截断至预算内（安全网，防模型跑飞）
```

- `complete` 形态为最小函数接缝 `(prompt: string) => Promise<string>`，不把 ModelAdapter 域类型引入 context 层；测试经此接缝 mock 覆盖模型路径。

### 4.2 ContextManager 消化分叉（单点）

- 摘要器不驻留 ContextManager：`applyCompaction` 增调用点参数 `summaryModel`/`summaryTokenBudget`，内部：
  - `isModelSummarizer(summaryModel)` 门禁开启（provider='openai'）且 `summarizeWithModel` 返回非空 → 摘要体 = 模型文本（返回三态 `'model' | 'deterministic' | 'replay'`）
  - 未传、门禁关闭或返回 null → 摘要体 = 现有确定性 join（逐字节今日行为，返回 'deterministic'）
- checksum 计算保持输入锚定（D3）：同输入块的 verdict 三态（first/replay/new）语义不变；replay 幂等跳过时不发起模型调用
- 新增共享协调函数（context/index.ts 导出）：

```text
runCompaction(ctx, items, { summaryTokenBudget, rereadTokenBudget, chainFoldedCount?, summaryModel? })
  → compact 选块 → applyCompaction（含摘要分叉）→ via≠replay 且 chainFoldedCount>0 时 trimChainFront
  → 返回 { chunks, via: 'model' | 'deterministic' | 'replay' }（via=replay 时不折链；回落水位由调用方各自重装配计算）
```

### 4.3 两入口接线（只传参）

| 入口 | 改动 |
|------|------|
| `src/harness/reactor.ts` | 自动压缩收敛环内改调 `runCompaction`（滞回/水位/收敛环预算不动）；压缩事件行等链尾追语义不变 |
| `src/tui/session.ts` | `/compact` 改调 `runCompaction`：items = assemble(history=chainView 转换条目)；chainFoldedCount=本次喂入链行数；成功后回执含水位回落 |

### 4.4 模型通道决策点（实现对齐）

不新增 buildSummarizer 装配面：`isModelSummarizer()`（summarizer.ts 单点）以 provider 门禁实现同一决策语义（D4）——仅 'openai' 通道启用模型摘要，Stub/Scripted/测试桩自然走确定性路径；模型经既有 `deps.model`（reactor 侧为 run 内已路由 adapter，精确「当前会话模型」，D2）与 `harness.model`（/compact 侧）字段流动，装配零改动。

## 5. 六要素摘要模板

模型侧 prompt（`pick()` 双语），输出控制在该次 summaryTokenBudget 内：

```text
将以下工程会话压缩为交接摘要。六节结构，只留事实与结论，不留过程性原文：
1. Goal        当前要完成什么（防止新窗口跑偏）
2. Constraints 用户要求、边界条件、不能碰的红线
3. Progress    已推进到哪一步、已产出什么
4. Verified    已确认的结论、可信的数据与验证结果
5. Open        未完成：卡在哪、还差什么、下一步查什么做什么
6. Rationale   为什么选这条路、哪些方案已失败不要重复、原始记录入口（文件/位置引用）
```

模型输出整体替换确定性 join 的摘要体，压缩块头部 `[Compacted summary checksum=…]` 与 reread 条目机制不变。

## 6. 前缀缓存不变量

- 压缩点仍是唯一合法重写点；摘要落定后压缩块逐字节冻结，其前缀从新压缩块起重新连续
- 摘要调用属独立一次性 prompt（对标 loop 判据先例），不进主链、不碰稳定段
- 模板语言为启动期常量（会话内恒定），不构成运行期时变字段
- 链 trim 后压缩块与链不双份（fork Task 7 回归用例继续钉）；新增「模型路径压缩后相邻步前缀稳定」用例

## 7. 改动面落点

| 文件 | 改动 |
|------|------|
| `src/harness/context/summarizer.ts` | 新增：buildSummaryPrompt + summarizeWithModel + 预算截断安全网 |
| `src/harness/context/window.ts` | 不动（选块与确定性摘要保留为回退） |
| `src/harness/context/index.ts` | +applyCompaction 摘要分叉（调用点参数）；导出 runCompaction 协调单点与 chainToHistoryItems |
| `src/harness/reactor.ts` | 压缩块改调 runCompaction（await） |
| `src/tui/session.ts` | /compact 改调 runCompaction（链参与 + trim + 回执） |
| `src/runtime.ts` | 不动（模型经既有 deps.model / harness.model 字段流动，零装配改动） |
| `src/i18n.ts` | 零改动（模板 pick() 就地成对） |
| 测试 | summarizer 单测 / index 回退与幂等 / reactor 端到端 / session /compact 用例 / 前缀回归 |

## 8. 错误边界

- summarizer 抛错、返回空、超预算截断后为空 → 一律 null → 回退确定性 join，压缩照常成功，不产生 run 级失败
- verdict=replay（幂等重放）→ 不发起模型调用，直接跳过
- 模型超时/不可用 → 走 adapter 既有错误通道，被 summarizeWithModel 捕获归 null

## 9. 验收矩阵

| # | 断言 |
|---|------|
| A1 | 模型成功：摘要体=模型六节文本；checksum 仍锚定选中块；头部/reread 格式不变 |
| A2 | complete 抛错 → 回退确定性 join，压缩成功 |
| A3 | 空输出 → 回退 |
| A4 | 超预算输出 → 截断至预算内后入块 |
| A5 | 未注入 summarizer → 输出与今日逐字节一致（回归护栏） |
| A6 | reactor 端到端（mock summarizer）：压缩后链前缀折叠、压缩块与链不双份、相邻步前缀稳定 |
| A7 | /compact：链参与后六要素有料；成功后 trim、水位回落；replay 幂等不重复注入；且不再发起模型调用 |
| A8 | zh/en 双语模板输出正确 |
| A9 | `tsc` 严格零报错 + 全量测试 + selfcheck 绿 |

## 10. 否决备选登记

| 备选 | 否决理由 |
|------|----------|
| 方案 C：模型全权压缩（选块+摘要都交模型） | 废弃确定性回退底线；WHAT 不确定导致测试无法钉住；全量上下文进 prompt 成本更高 |
| small 档独立调用生成摘要 | 用户裁决明确走当前会话模型；摘要质量优先 |
| 摘要走主链调用复用 | 压缩点在 run 中部，独立一次性调用才能保证主链 append-only 与前缀稳定 |
