# 记忆调度优化与 learned 技能语义提炼设计规格

> 背景：用户三问（auto memory 与 learned skills 的提示词是什么 / 是否对标明星产品 / 调度时机是否需要空闲与周期触发）+ 两轮裁决（①调度方案 A=队列+空闲消化+空闲兜底节拍，钉死「后台提取不得阻塞用户」；②learned 用语义提示词提取而非 goal 写死，钉死「对标 Hermes」；③补 CC 记忆提取时机对标调研）。
> 2026-09-19 第三轮修订：用户裁决「运行中由大模型自动触发为主，后台任务兜底和优化；原子工具规范改『只保留原始工具的规范』，核心 harness 能力可定义专属工具、效果优先」——in-band 自主写入由「登记方向」收编为主通道（`memory_write` 工具 §3.7），后台队列降级为兜底与优化面（D5）。
> 对标实证：Hermes 官方文档 Skills System / Curator / Heartbeat 页 + GitHub 仓库；Claude Code 官方文档 Memory 页（2026-09-19）。

## 1. 调研对标结论

### 1.1 Hermes 技能提取（Skills System 官方文档）

| 维度 | Hermes 实际做法 |
|------|----------------|
| 触发时机 | **in-band、agent 自主**：系统提示词要求 agent 在①走通值得复用的多步流程②踩坑/死路后找到可行路径③被用户纠正做法时，当场调 `skill_manage` 落技能 |
| 素材面 | `/learn` 任意可描述来源：本地文档目录、在线文档、刚走完的对话流程、口述步骤、整本书（大素材 → knowledge-base skill：SKILL.md + references/ 按主题分文件按需加载） |
| 内容标准 | **"lessons, not logs"**：When to Use / Procedure / Pitfalls / Verification 小节；Pitfalls=可泛化规则+一句机制原因；**明确排除事件叙事、PR/issue 号、日期、聊天原文引用**；不复述每轮已装载内容（AGENTS.md/工具 schema）；description ≤60 字符；advisory linter 专查 incident-log-shape 与 references 泛滥 |
| 生命周期 | 使用中自我改进（patch 定向修补优先于全量重写）；Curator 后台维护（usage 统计、陈旧归档、LLM review）；可选 `write_approval`（暂存 pending → /skills approve/reject 人工审） |
| 与记忆分工 | memory=小而持久、常驻上下文的事实；skills=较长流程、按需加载 |
| 空闲先例 | Session Heartbeats（空闲周期性重入会话）+ 记忆 periodic nudges |

### 1.2 Claude Code 记忆提取（Memory 官方文档）

| 维度 | CC 实际做法 | 我们现状 |
|------|------------|----------|
| 触发主体 | **agent 会话中自主写**（MEMORY.md 「reads and writes throughout your session」），非任务收口批量提取 | 收口批量提取（settle 单点） |
| 频度 | 明示「doesn't save something every session」，自判是否值得记 | 每次成功任务固定提取 |
| 素材面 | 全会话上下文 | goal + reply |
| 四类型 | user/feedback/project/reference | ✓ 一致 |
| 跳过项 | 可从代码库推导的 + CLAUDE.md 已写的 | ✓ prompt 条款 + 闸门 e 一致 |
| 索引治理 | 200 行/25KB、超限写成功但报错勒令重写、topic file 按需 read、**near-limit 提醒缩短** | 前三项已对齐；**near-limit 提醒缺失** |

### 1.3 范式对比与更正登记

- **更正 1**：auto-memory 规格 §12「提取材料不含全量观察=对标 Hermes 摘要重放省成本」在**技能面不成立**（Hermes /learn 由活跃 agent 现场取证，素材远宽于指令+答复）；**记忆面**口径维持既批（CC 素材虽为全会话，但 digest 扩展已由用户裁决仅技能面，记忆面扩展登记为方向）。
- **更正 2（范式差异 → 2026-09-19 修订收编）**：CC 与 Hermes 均为 **in-band、agent 自主写**；本项目原为任务收口批量提取。原规格以「不开专属工具」「Write 拒数据目录」两条既定裁决为由将其登记为方向；**本轮按用户新裁决推翻前者**（原子工具规范改写为「原始操作面复用 + 核心 harness 能力专属工具」），in-band 升级为**主通道**（`memory_write` 工具，§3.7），后台队列管线保留降级为**兜底与优化面**。

## 2. 裁决

| # | 裁决 |
|---|------|
| D1 | 调度方案 A（已批）：收口**零等待入队** → 单 worker 串行消费；TUI 空闲 kick + 空闲兜底节拍（仅队列非空才消费）；CLI 退出前 drain |
| D2 | 后台化**不得阻塞用户**（钉死）：收口路径零 await 模型调用；用户提交下一任务不等后台 |
| D3 | learned **语义提炼**对标 Hermes（钉死）：素材=goal + reply + 步骤摘要 digest；digest 仅技能面（已裁），记忆提取材料维持 goal+reply |
| D4 | **失败/中止任务也入队**：由提炼器自判有无可复用教训，无则不落盘（宁少勿滥，Hermes 触发时机③「被纠正」的覆盖路径） |
| D5 | **（2026-09-19 修订：升级为主通道）运行中模型自主触发**——`memory_write` 专属工具随双通道落地（新规范：原始操作面复用既有原子工具、核心 harness 能力可为模型定义专属工具，效果优先）；后台队列管线降级为**兜底与优化面**（收口入队 → 空闲消化，双写由三级归一去重收敛） |
| D6 | curator-lite：空闲 drain 时维护 learned 库（相似合并、description 语义化改写）；usage 统计与 write_approval 登记 YAGNI |
| D7 | 记忆面吸收 CC 三点：宁少勿滥保守条款（提取 prompt）；near-limit 提醒档；素材面/跳过项维持既批口径 |

## 3. 设计

### 3.1 MemoryPipeline（新增 `src/harness/memory/pipeline.ts`）

- `enqueue(item: { goal; reply; outcome: 'done'|'failed'|'stopped'; digest })` **零等待返回**；内部单 worker FIFO 串行消费（防并发模型调用），drain 期间再入队只排队不并发
- **无真实模型**（isModelSummarizer 门禁同款）→ 跳过队列语义：直接走今日确定性 learned 写盘、记忆提取跳过——测试行为与现状一致，测试面改动最小
- 有模型：worker 对每个任务依次执行 ① learned-extraction（D3）② settleMemory（提取+阈值整理，含 failed 任务的 feedback 面）；两者异常全吞（旁路纪律不变）
- `notify(line)` 回调：说明行由装配层接 `context.appendChain`（模型面链行）+ session 事件（用户面）双通道；**时序登记：notice 从收口瞬间后移至后台完成时**（仍为链尾追加，前缀纪律不破）
- 开关语义不变：autoMemory off → 记忆提取子链跳过；learned 受 learnedSkillLimit 管辖

### 3.2 步骤摘要 digest（reactor 收口构造）

- 形态：每步 `[tool] target → result 首行`；单步截 120 字符，digest 总截 1500 字符、最多 20 步（取尾，最近的更有价值）
- 随 settle 载荷传入：`ReactorDeps.settle` / `settleMemory` 载荷扩 `digest?: string` 字段（reactor 收口处由 steps 现成构造；failed/stopped 同样构造）

### 3.3 learned-extraction（新增 `src/harness/skills/learned-extract.ts`）

- prompt（固定标记 `'learned-extraction'`，测试桩区分——对齐 handoff/memory-extraction 先例）：输入 goal/reply/digest；输出严格 JSON `{"skill":{"name":"kebab-slug","description":"≤60 chars what it does","body":"…"},"worth":true}` 或 `{"skill":null}`
- 内容纪律（lessons, not logs）：body 含 When to Use / Procedure / Pitfalls / Verification 语义小节；Pitfalls=可泛化规则+一句机制原因；**禁止事件叙事、PR/issue 号、日期、聊天原文引用**；不复述 SUNSHINE.md 与每轮已装载内容；description ≤60 字符（进技能清单参与语义匹配，替代 goal 截 30 字）
- 闸门：注入/不可见 Unicode 扫描（复用 memory 闸门正则，抽公共单点 `src/harness/memory/guards.ts`）；description/body 截断沿用 60/2000
- **语义二分**：`worth:false`（模型判无可复用教训）→ **不落盘**（宁少勿滥）；**技术失败**（异常/畸形 JSON）→ **回退确定性写盘**（goal 原样，保「沉淀永不因技术故障丢失」既语义）
- `LearnedSkillStore.settle` 增可选 `refined?: { name; description; body }` 参数，缺省行为逐字节不变（向后兼容）

### 3.4 记忆提取面增强（`memory/extractor.ts` 小改）

- 保守条款（CC 实证）：prompt 加 `Be conservative — it is fine to extract nothing; only include facts clearly useful in a future conversation.`
- near-limit 提醒档：`add` 后索引行数 ≥ 上限 90% 时，在返回说明附「索引接近上限，建议精简或 /memory gc」提醒（现仅超限报错）
- 素材面维持 goal+reply；digest 扩展登记方向

### 3.5 空闲消化与兜底节拍（后台兜底与优化面）

- **TUI（session.ts）**：回 idle（任务收束、队列清空、无挂起审批）时 fire-and-forget `pipeline.kick()`；`setInterval(MEMORY_IDLE_KICK_MS)` 仅 `status==='idle' && pipeline.pending()>0` 时 drain——无待办零调用零配额
- **CLI（run / run-pipeline）**：命令收尾 `await pipeline.drain()`（用户本就在等命令结束，不构成新增阻塞）
- 队列属 harness 装配层（CLI/TUI 共用），跨会话存活；`/new` 不清队列（登记语义）
- **兜底定位**（D5 修订）：模型运行中自主写入为主通道后，收口入队覆盖「模型未写/写入被拒」的任务——漏记兜底由提炼器/提取器「宁少勿滥」自判零落盘；双写由 store 三级归一去重收敛，后台整理兜底系统性质量（curator-lite §D6）

### 3.6 配置（`config/memory-config.ts`）

- `MEMORY_IDLE_KICK_MS` 缺省 5 分钟；`MEMORY_STEP_DIGEST_MAX_STEPS=20` / `MEMORY_STEP_DIGEST_ITEM_CHARS=120` / `MEMORY_STEP_DIGEST_TOTAL_CHARS=1500`

### 3.7 `memory_write` 专属工具（运行中自主写入主通道，D5）

- **入参**：`{ type: 'user'|'feedback'|'project'|'reference'; content: string; description?: string }`——单次一条事实（原子性一条记忆一个事实），type 四类型同提取 prompt 既有枚举
- **执行链**：安全链登记 `memory_write → Write`；落盘走 `MemoryStore.add`（既有的五重准入闸门自然生效：scope=persistent、临时词黑名单、注入/不可见 Unicode 扫描、三级归一去重、SUNSHINE.md 去重）——**不绕过任何质量闸门**，模型自主写与批量提取同一条准入链
- **去重冲突**：重复写返回已存在 slug（幂等，链行观察「已存在」）；**改写/修正**：模型再写一条新事实并注明 supersedes，由既有「新观察覆盖旧结论」的整理语义在 gc 时合并——不提供 delete（管控面归 /memory rm）
- **注入面**：工具清单属稳定段（按名排序进 B 类），前缀缓存一次断点已由既批双通道预算覆盖，零新增击穿；工具 description 英文单语（§15），写清何时该用（用户偏好/纠正/踩坑路径等跨会话值得记的事实时）
- **回执**：成功观察行含 slug（可追溯）；失败走 Result 错误通道（TOOL_INVALID_ARG 等），永不炸任务

### 3.8 curator-lite（空闲维护 learned 库，D6）

- **定位**：优化面（非兜底面）——learned 库长期累积会出现近似重复条目与描述漂移，空闲时做一次轻量整理，提升技能清单（name+description 索引）的语义匹配质量。**只维护学习级目录**（`<dataDir>/skills/`，机器写入产物）；项目级 `.sunshinex/skills/` 与全局级 `~/.sunshinex/skills/` 是手写资产，curator 零触碰。
- **触发门槛**（配额纪律）：仅当 ① `learnedSkills` 开启 ② 学习级条目数 ≥ `MEMORY_CURATE_MIN_ENTRIES`（缺省 8）③ 相对上次整理有净增（标记文件 `<dataDir>/skills-curated.json` 记 `{"count":N}`，当前条目数 > N）时，触发一次 curation 模型调用；否则零调用。判无动作/技术失败同样推进标记（防重复空跑），落盘失败不推进（下次重试）。
- **素材面**：条目清单按 mtime 升序，每条的 `slug + name + description + body` 前 `MEMORY_CURATE_ITEM_CHARS`（缺省 400）字符、整表上限 `MEMORY_CURATE_TOTAL_CHARS`（缺省 4000）。
- **产出**（严格 JSON，固定标记 `learned-curation`）：`{"merge":[{"keep":"slug","drop":["slug",…],"name":"…","description":"…","body":"…"}],"rewrites":[{"slug":"…","description":"…"}]}` 或 `{"worth":false}`（判无需整理）。
- **闸门**（复用 `memory/guards.ts` 单点）：注入/不可见 Unicode 命中 → 丢弃该动作；description 截 60、body 截 2000（沿用 learned 口径）；**只减不增**——整理后条目数不得超过输入条目数，超产计划整体拒绝。
- **落盘与回滚**：整理前快照学习级目录为 `<dataDir>/skills-bak-<timestamp>/`；任一动作失败即回滚（删残留、还原快照）并返回失败；成功后删快照。
- **审计链行**：整理有实际动作时 notify 一行 `[skills] curated: merged N, rewritten M`（英文单语、链尾追加）；无动作零行。
- **成本登记**：每次触达 ≤1 次模型调用，节流靠净增门槛 + 标记文件，跨会话不重复空跑。

## 4. 落点表

| 文件 | 动作 |
|------|------|
| `src/harness/memory/pipeline.ts` | 新增：MemoryPipeline（队列/worker/kick/drain/notify） |
| `src/harness/tools/builtin.ts` | 修改：注册 `memory_write` 工具（可选参 MemoryStore 接缝，对齐 skill 工具第 6 参先例） |
| `src/harness/security/chain.ts`、`guard.ts` | 修改：登记 `memory_write → Write` 映射与 manual 审批分类 |
| `src/harness/memory/guards.ts` | 新增：scanMemoryText 等闸门正则从 extractor 抽公共单点（learned 复用） |
| `src/harness/skills/learned-extract.ts` | 新增：learned-extraction prompt + 宽容解析 |
| `src/harness/skills/learned.ts` | 修改：settle 增可选 refined 参数 |
| `src/harness/memory/extractor.ts` | 修改：保守条款 + near-limit 提醒 + 闸门正则改引 guards |
| `src/harness/reactor.ts` | 修改：收口构造 digest；settle/settleMemory 载荷扩字段（签名兼容：新增可选字段） |
| `src/harness/index.ts` | 修改：装配 MemoryPipeline，settle/settleMemory 改接 enqueue |
| `src/tui/session.ts` | 修改：idle kick + 兜底定时 + notify 双通道接线 |
| `src/cli/commands/run.ts`、`run-pipeline.ts` | 修改：收尾 await drain |
| `src/config/memory-config.ts` | 修改：新增 4 个配置项 |
| `src/harness/prompt-language.test.ts` | 修改：SCOPES 扩新文件 |

## 5. 错误处理与旁路纪律

- pipeline 内任何异常全吞并降级（模型失败/落盘失败/notify 抛错），任务收口与命令退出**永不**因记忆/提炼失败而失败
- consolidate 的 .bak 快照回滚语义不变；learned 撞名避让/mtime 淘汰不变
- 后台模型调用不进主链、不进前缀缓存统计（既有旁路口径）

## 6. 验收矩阵

1. **收口零等待**：慢速桩模型（200ms）下 done 收口同步路径耗时不含模型调用
2. 无模型回退：enqueue 后确定性写盘（description=goal 截断），零模型调用——与今日行为逐字节一致
3. worker 串行：连入 3 任务模型调用按序、无并发
4. learned 提炼成功：description≤60、body 含四小节、name 派生 slug 落盘
5. `worth:false` → 零落盘；6. 技术失败（畸形 JSON）→ goal 原样回退写盘
7. failed 任务：digest 含失败步骤入队；判无→零落盘、判有→落盘
8. 空闲 kick 生效；兜底定时仅 pending>0 触发（空队列零调用）
9. CLI run 收尾 drain 被调用
10. notice 双通道后移时序：后台完成时链行+事件各恰好一条
11. 提取保守条款在场钉子；12. near-limit 提醒断言；13. digest 截断上限断言
14. 前缀回归：后台 notice 链行尾追、相邻帧前缀稳定用例保持绿
15. **`memory_write` 工具**：写入落盘过五重闸门（含重复幂等返回已存在 slug）；注入样本被拒；运行中手动写入即触发索引漂移尾追（现有探测链复用）；off 语义：autoMemory off 时报「记忆未启用」不落盘
16. 工具清单含 `memory_write` 且按名排序（selfcheck 观测面零新增装配面断言）
17. **curator 门槛**（§3.8）：条目数低于阈值或与上次整理标记相比无净增 → 零模型调用；净增且达标 → 恰一次调用；判无动作/技术失败同样推进标记，二次不重跑
18. **curator 闸门与回滚**：注入动作丢弃、description 截 60、只减不增（超产整体拒绝）、未知 slug 丢弃；中途失败学习级目录回滚且无 `skills-bak-*` 残留；项目级 `.sunshinex/skills/` 与全局级技能零触碰；有实际动作时审计链行 `[skills] curated: merged N, rewritten M` 恰好一条

## 7. 风险与登记取舍

- 每成功任务后台 **+2 次模型调用**（提炼+提取，阈值达标再 +整理）——配额登记；后台不阻塞主链但消耗账号额度
- 工具清单 **+1 项**（`memory_write`）= 一次全量前缀断点——新规范下按「核心 harness 能力」论证且数量克制，断点预算已含在既批双通道批次内
- `/memory add` 手动写与后台 worker 并发：store.add 原子写兜底（登记可接受）；模型运行中 `memory_write` 与收口入队双写同理收敛
- digest 使提炼 prompt 变长（≤1500 字符封顶）——成本上界固定
- notice 后移意味着「记忆已保存」提示延迟数秒——用户面以事件即时呈现「后台整理中」语义可选（YAGNI：本轮不做中间态提示）

## 8. 不做的（YAGNI / 冲突登记）

- ~~in-band 自主写（CC/Hermes 范式）~~ → **已按 2026-09-19 用户裁决收编为主通道**（D5、§3.7）；原「不开专属工具」规范同步改写（CLAUDE.md §5）
- **`skill_write` 专属工具不随本批**：learned 提炼质量瓶颈在「内容标准与素材面」（已由 D3/§3.3 解决），运行中技能自主写入属下一批次（专属工具面可扩展位，登记方向）；本批技能沉淀仍走「后台提炼+兜底」通道
- 绝对周期定时器（无待办也唤醒）——违背配额纪律，仅保留「空闲+非空队列」兜底节拍
- learned usage 统计、write_approval 暂存审阅、轮级后台 review fork（Hermes 自承可烧可观 token）、digest 扩记忆提取面

## 9. 与 auto-memory 规格的关系

本规格为增量规格；`docs/superpowers/specs/2026-09-18-auto-memory-design.md` §4（提取）/§5（整理）的调度时机与材料面以本规格为准（收口批量提取 → 双通道：运行中 `memory_write` 自主写入为主 + 队列空闲消化兜底；素材面按 D3 分域），更正登记见 §1.3；auto-memory 规格中「写入走原子 read/write 不开专属工具」的表述由本规格 D5 取代（Write 对数据目录的拒绝不变，专属工具经安全链登记直达 store）。
