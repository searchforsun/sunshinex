# 上下文 fork 模型治理设计

- 日期：2026-09-14
- 状态：设计定稿（用户逐节确认）；实施计划待 writing-plans 产出
- 关联：CLAUDE.md §11（前缀缓存第一要义）；plan_cache_continuous_fix（5f85ac8 / f4cd5e2）；prefix_cache_audit（唯一击穿点：技能首帧注入前部）；92ab44a（ctx 水位 exact 口径）

## 1. 背景与问题清单

| # | 现状 | 问题 |
|---|------|------|
| P1 | 主任务跨任务上下文从零（steps 不跨任务，靠记忆段 episodic 摘要承接） | 任务边界重算；且记忆段居提示词中段，任何追加使其后全部内容位移重算（与 70ec1a9 修掉的 memory 每步双写同型病） |
| P2 | plan 步骤 seed 链结构性裁剪（f4cd5e2：前序只留结论行，全量工具观察不进后续 prompt） | 用户裁决废除：「不应该丢弃中间工具步骤，要对标 Claude Code 处理」 |
| P3 | graph 角色节点把 goal+角色框定+上游产出拼进 goal 槽（每节点全新 prompt）；loop 节点不带 seed；loop deficit 轮丢历史 | 稳定段之后全部前缀节点间不共享；修正轮重复建模 |
| P4 | 技能首帧注入位于上下文段头部且消费即清（prefix_cache_audit 唯一明确击穿点） | 技能出现/消失各击穿其后全部前缀，等效两次全量击穿 |
| P5 | goal 槽承载真实任务文本且每任务变化（位于提示词中部） | 任务边界中部击穿点 |

## 2. 设计原则（从第一要义推导）

1. **单一基座 + fork**：主链（稳定段+会话链）是唯一上下文基座；任何执行单元都是「基座 + 尾部追加」，不存在第二种上下文构造方式。
2. **只增不改**：会话内上下文只增加不更改；历史上下文有问题就追加补丁行说明过期，不就地改写；压缩是唯一合法的整体重写点。
3. **尾部差异公理**：任意相邻帧、跨任务帧、主链↔fork 首帧之间，差异只可能出现在提示词尾部——这是所有装配面改动的验收公理。

## 3. 上下文分层模型（全层唯一段序）

```text
[稳定段]     身份 / 输出约定 / 工具清单 / JSON 协议 / 工作目录 / 执行协议行   ← 全层共享，逐字节冻结
[SUNSHINE.md]                                                              ← 会话级常量，装载一次
[压缩块]     会话链前缀的折叠摘要                                            ← 唯一合法重写产物
[会话链]     任务指令行 + 主任务全量执行轨迹 + 结论行 / 节点结论行 / 补丁行     ← 主链 append-only，只在尾部变
[fork 尾追]  角色行 + 节点任务行 + 私有步骤                                   ← 仅 graph 节点 / 子 agent
[技能块]     一次性注入置尾                                                  ← 出现/消失击穿面≈0
```

与 Claude Code 的对应：会话链 ≈ messages 流（全量对话只增）；fork ≈ Task 子代理（私有上下文、返回报告）；压缩 ≈ auto-compact（唯一重写点）。

### 3.1 关键裁决（用户逐条定调）

| 裁决 | 内容 | 理由 |
|------|------|------|
| 记忆段退出提示词 | working/episodic 逐帧注入职责取消；settle/compaction 事件行是对话事实，改走会话链尾追；跨会话沉淀仍走文件（学习技能/KB） | 中段追加使其后全部内容每帧位移重算；链即记忆，全量对话已承载一切 |
| goal 槽取消 | 恒定执行协议行折进稳定段协议区；assemble 无 goal 入参位；真实任务文本只以「当前指令行」存在于链尾；`Task.goal` 降级为纯观测字段（ledger/settle 留痕），不进提示词 | 恒定内容没理由占独立槽位；每任务变化的 goal 是中部击穿源 |
| fork 收窄 | fork 仅指「需要隔离私有步骤」的单元：graph 节点（与未来子 agent），节点内部不论是 agent 还是 loop 模板全部私有于该 fork；TUI 主任务的 loop 修正轮、plan 步骤都是主链追加 | 主链对话的组成部分（含全量工具观察）不应被隔离；只有子代理工作需要私有化 |

## 4. 会话链语义

- **归属**：ContextManager 单点持有（session ledger），跨 run / 跨任务 / 跨交互面共享；graph/loop 经 deps.context 读取同一基座。
- **内容**（均为链上行）：任务指令行（当前指令：…）、主任务全量执行轨迹（含全部工具观察，不裁剪）、任务结论行、graph 节点结论行、失败/中止补丁行。
- **只增不改**：过期修正以补丁行追加；条目行号在追加时定死，裁剪后允许跳号、不重排。
- **API**：`chainView()`（当前链只读视图，自压缩水位起）、`appendChain(entries)`、`trimChainFront(n)`（压缩协调）、`resetSession()`（/new：清链+压缩块+待注入技能块；记忆存储与账本保留）。

## 5. fork 语义（graph 节点 / 子 agent）

- **组合**：`fork = chainView() 快照 + [角色行 + 节点任务行]`。前置依赖不单独拼行——上游节点结论行已在链上，fork 时天然可见；并发同层各 fork 命中同一基线前缀。
- **缺省 fork**：`reactor.run` 缺省 seed = `context.chainView()`——fork 是结构性缺省，不依赖调用方纪律。
- **私有性**：fork 私有步骤（全量工具观察）不回主链；节点终态回写一行结论（reply 摘要）——子代理返回制；失败/中止回写补丁行。
- **fork 内压缩**：只折叠私有段，不触主链基座（并发 fork 不互写）。

## 6. 压缩与预算

- 压缩消费到 seed 前缀时，`compactedUpTo` 同步 `trimChainFront(min(watermark, seedLen))`——压缩块与会话链永不双份。
- 主链自身超预算：同一 `window.compact` 机制在任意 run 的装配面触发折叠；折叠后的基线即新基线。
- ctx 水位（92ab44a 口径延续）：exact:true 权威覆盖；fork 起点回落「稳定段+主链」属真实语义回落，允许。

## 7. 各层落点

| 层 | 改动 |
|---|---|
| context/index.ts | chain 存储 + 第 4 节四个 API；assemble 段序改造（去 goal 位、记忆段移除、压缩块前置、pendingSkill 移尾） |
| reactor.ts | 缺省 seed=chainView()；主链 run 结束把全量步骤+结论行 appendChain；compactedUpTo 回传 RunResult；settle/ledger 用 task.label |
| loop/engine+nodes | 修正轮主链追加：每轮 run 后链自然续接，下一轮 seed=chainView()；skillRef 尾注入自动落尾 |
| graph/agents+nodes | role agent / loop node 改 fork 组合 + 结论回写；gate/ci 零模型调用不 fork |
| tui/session.ts | runTaskFlow/plan 走链：指令行 appendChain → runTask；plan 步骤全量步骤接续（废除「只留结论行」裁剪）；/new 调 resetSession() |
| 边界登记 | /init 与 /plan 规划轮的内部 verbose 提示词不进链（防污染对话流）；CLI 单发 run = 空链 fork（行为不变）；pipeline 节点同规则 |

## 8. 错误与边界

- fork 失败：回写补丁行；下游节点 skipped 语义不变。
- resume/断点续跑：从当前链重新 fork，已通过节点的结论行已在链上。
- i18n：链行文案 t() 运行期求值（--language 决定），会话内恒定。
- SUNSHINE.md 会话中编辑：用户显式动作，属合法边界（罕见事件，登记即可）。
- 会话链增长：由压缩兜底（唯一重写点）；链行轻量（指令/结论/补丁行），主任务轨迹随压缩折叠。

## 9. 回归矩阵（提示词组装面改动强制验证项）

1. 跨任务严格前缀连续（T1→T2 首帧逐字节前缀）。
2. fork 首帧 = 主链末帧严格前缀 + 尾追断言。
3. 同层并发 fork 共享基线断言。
4. fork 内相邻步连续（既有用例迁移）。
5. 压缩后基线重置 + 链/压缩块不双份断言。
6. 技能出现/消失零击穿（移尾后）。
7. 全量 `pnpm build` + 全量测试 + `pnpm selfcheck`；真实端点探针口径（第二轮 cached_tokens > 0）不计入产品回归目标。

## 10. 否决备选（登记理由）

| 备选 | 否决理由 |
|------|----------|
| 会话层各自持链（TUI/graph/CLI 各管一份） | 三份链逻辑靠纪律对齐，跨面漂移风险高——链必须收敛在 ContextManager 单点 |
| messages 数组形态重构（照搬 Claude Code 消息结构） | 前缀收益与 fork 模型相同，但需推翻单 user 消息 + JSON 协议的整个 reactor/adapter 面；协议形态不是本轮瓶塞 |
| 记忆段保留并改为尾部注入 | 与会话链职责完全重复，双源承载同一事实必然漂移——链即记忆 |

## 11. 与既有决策的关系

- plan_cache_continuous_fix（5f85ac8 / f4cd5e2）：「恒定 goal + 指令行尾追」演化为主链通用形态；「前序只保留各步结论、全量工具观察不进后续 prompt」被本设计废除（用户裁决）；相关回归用例（前序只留结论行）按新语义改写。
- prefix_cache_audit：唯一击穿点（技能首帧注入前部）由本设计移尾修复；「goal 每任务必变属预期重算点」观察项被 fork 模型消除（任务边界不再重算）。
- 92ab44a ctx 水位：exact:true 权威口径延续。

## 12. 验收

- 全量测试 + selfcheck 绿；回归矩阵 1–6 每条有用例钉死。
- 文档同步面：TUI-MANUAL（ctx/plan 语义）、README（如涉及）。
