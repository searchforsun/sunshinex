# Sunx（路由型编排智能体）设计方案

- 日期：2026-11-14　分支：dev1　状态：**已裁定待实施**（2026-11-14 用户裁定 R1–R13 全部按推荐采纳；同日三问增补裁决见 §17——实例身份三元组、fork 缓存语义、总览页形态）
- 需求来源（2026-11-14 用户）：新增 "Sunx" —— 类业界 super agent 架构；Sunx 是**路由 agent**：负责首发用户任务、转派给子 agent、做状态控制与任务管理、**始终异步**处理任务；GUI 新增 **SUNX 分组**管理每一个 Sunx 实例；Sunx **只有分派任务相关工具和能力**（含 HITL 用户介入）。
- 关联规格：`2026-11-09-bg-task-wake-design.md`（后台任务唤醒，**草案未实施**——本设计的 P0 前置）、`2026-10-04-multi-agent-orchestration-design.md`（TaskBoard/Teammate/Executor 三维正交，已实施为 taskboard/）

---

## 0. 一句话定位

> **Sunx = 一种装配期 profile 化的会话形态（session kind）**：系统提示词换成编排章程、工具面换成「分派-监视-收口-问询」白名单、执行完全依赖既有派发通道（fork 子智能体 / 团队板任务 / 后续外部执行体），并以「后台任务唤醒」（bg-wake）实现事件驱动的异步接续。
> **不是新引擎**——编排层必须经 Runner/TaskBoard 既有器官，不建旁路（多智能体编排规格既定裁定）；GUI 的 SUNX 分组是**视图**，不是新的存储分组。

---

## 1. 需求重述与目标

### 1.1 需求拆解

| 用户原话 | 设计含义 |
|---|---|
| 负责首发用户任务 | Sunx 是任务第一站：接收原始诉求，做澄清/分解，产出**自包含任务简报**派发 |
| 转派给子 agent | 派发通道复用既有：fork 子智能体（spawn background）为主，团队板任务为辅，外部执行体后续 |
| 状态控制和任务管理 | 任务状态唯一权威=TaskBoard 五态机 + TaskRegistry 台账；Sunx 用非阻塞工具监视，用链行记账计划 |
| **始终异步**处理任务 | 分派即返回；不阻塞等待；任务终态由系统**唤醒**接续（bg-wake）；Sunx 空闲时不占资源 |
| GUI 新增 SUNX 分组，管理每一个 sunx | 侧栏新「SUNX」组：列出全部 Sunx 实例、各自任务进度、待裁决聚合；实例详情复用既有页签 |
| 只有分派任务相关工具 + HITL | 工具面白名单派生（`derive({only})`）：无 exec/read/write 等执行件；保留 ask_question 等问询件 |

### 1.2 目标

1. Sunx 会话内：用户一句诉求 → Sunx 分解 → 并行派发多个子任务 → 收轮 → 子任务完成逐个唤醒 Sunx → Sunx 验收/追加派发/汇总交付——全程无需用户盯守。
2. 子任务执行不占 Sunx 上下文（fork 隔离），子任务产物只以压缩结论回链（现状纪律的延续）。
3. GUI 关闭后 Sunx 与子任务照常运行（daemon 常驻会话既有能力）；重开可恢复全部投影。
4. 普通会话零行为变化（不动主链工具面、不动系统提示词、不动 spawn/团队八件套语义）。

### 1.3 非目标（本期不做）

- 不做跨 Sunx 编排（sunx-of-sunx）与多机分布式（单进程单机形态，与编排规格口径一致）。
- 不做 A2A 等重协议（外部执行体走既有 external-cli 适配器形态）。
- 不做会话级共享 KV 缓存（业界也无标准解；沿用「每执行体独立前缀 + 前缀字节冻结」既有纪律）。
- 不替换普通会话的团队协作体验（智能体团队八件套原样保留；Sunx 是编排专职形态，不是普通会话的替代）。
- TUI 不做 SUNX 专属管理面（会话本体三面同源可开，管理面/分组是 GUI 特性）。

---

## 2. 业界调研：拓扑与落地教训

### 2.1 拓扑总览（2024–2026 生产系统收敛为四种）

| 拓扑 | 代表 | 与 Sunx 的关系 |
|---|---|---|
| Orchestrator-Worker | Anthropic 多智能体研究系统、Claude Code、Genspark | **Sunx 采用**：lead 分解派发、worker 独立上下文、只回压缩结论 |
| Supervisor-Node 图编排 | LangGraph supervisor、Magentic-One、CrewAI hierarchical | 借鉴其「状态权威 + 每步重估」：我们的状态权威=TaskBoard，重估=唤醒轮重读板态 |
| Agent Handoff（对等移交） | OpenAI Agents SDK handoff | **不采用**：handoff 把对话控制权整体移交，与「Sunx 始终持有任务管理权」相悖 |
| 并行同题求解 + 聚合 | Grok 4 Heavy（多实例共识，聚合算法未公开） | 不采用（成本模型不适用于工程编排）；Grok **Tasks**（定时/一次性任务+通知面板）是 §7 调度能力的对标 |

诚实声明：**DeepSeek 无任何公开的 agentic 编排架构文档**（公开面只有模型层的 tool calling / hybrid thinking）；Grok Heavy 聚合与 Grok Tasks 调度器内部未公开；Devin/Manus/ChatGPT Agent 内部编排只有产品文档无技术报告。对标以机制而非品牌。

### 2.2 对本设计有直接约束力的六个业界机制

1. **上下文隔离是 orchestrator 成立的前提**（Anthropic）：worker 各自独立窗口、只回压缩结论；大产物写文件系统、传引用不传正文。→ 现状 spawn 简报协议「自包含 prompt、结论一行回链」已内置此纪律，Sunx 沿用并强化（简报必须含验收标准）。
2. **后台执行 + 完成唤醒是异步化的标准路径**（Claude Code 后台 subagent 完成通知、Codex Cloud 并行任务、Grok Tasks）：Anthropic 自认当前同步阻塞是首要瓶颈。→ bg-wake 草案（2026-11-09）与业界路径一致，是 Sunx 的 P0 前置。
3. **KV-cache 是一等工程指标**（Manus：输入输出比 100:1、append-only、Mask-don't-Remove——不动态增删工具改用屏蔽）：→ Sunx 工具面在**装配期**按 kind 一次性定型（不运行期增删），唤醒注入只尾追——与本项目「前缀缓存第一要义」纪律完全同构，这是本项目相对业界框架的既有优势。
4. **HITL 审批必须可异步、可序列化**（OpenAI SDK：needs_approval 暂停 + RunState.to_json 跨进程恢复；LangGraph interrupt/Command(resume)）：→ 现状挂起表（pid 票据 + WS 帧 + HTTP 回执 + 快照重建卡）已是同构能力；缺口是 daemon 重启即蒸发（内存态）——§11 给增量方案。
5. **每步重估 + 停滞检测**（Magentic-One 双账本：Task Ledger facts/plan + Progress Ledger stall counter）：→ Sunx 每个唤醒轮自然重读板态（板快照工具 + 唤醒回执），连续无进展防打转由「连续唤醒上限」（bg-wake 草案 10 轮）+ 唤醒轮提词承担；不引入独立 Progress Ledger 账本（避免第二状态面）。
6. **token 经济须预付管理**（Anthropic：multi-agent ≈ chat 15×；单变量解释 80% 性效方差）：→ 派发上限沿用（fork 并发帽 8、teammate 帽 8、板未终态限流 64）+ dispatch 契约带可选 tier（强 Sunx 弱 worker 或反之）+ bg-wake 合批窗口抑制唤醒风暴。

### 2.3 业界自认的失败模式（设计规避清单）

| 失败模式（出处） | Sunx 规避手段 |
|---|---|
| 简单任务过度分解、开几十个 subagent（Anthropic） | 章程提词显式给分解上限指引 + fork 并发帽 8 硬闸 |
| 模糊委派导致重复劳动（Anthropic） | dispatch 简报契约强制「goal/事实/路径/约束/**验收**」自包含字段（现状 spawn prompt 描述已此口径，Sunx 章程再强调） |
| 子任务产物「传话失真」game of telephone（Anthropic） | 结论行截断 300 字符回链 + 全文落任务日志（现状）+ 大产物要求子任务写文件、Sunx 凭验收行转派他人（不转发正文） |
| 检查点只保数据不保执行（Diagrid 对 LangGraph 的批评；Temporal 的补位论证） | 不引入执行级重放；重启语义显式裁定为「打开态自愈 cancelled + Sunx 恢复唤醒轮重估」（§11），与「宁可显式重建、不假装续跑」一致 |
| 唤醒风暴 / 无限自循环（Claude Code 后台 agent 经验） | bg-wake 合批窗口（1.5s）+ 连续唤醒上限（10 轮）+ interrupted 不唤醒（草案既有） |
| 审批状态不可序列化导致人不在场时停摆（OpenAI/LangGraph HITL 痛点） | 挂起票据已可异步回答；Sunx 增加无人值守降级策略（§8.3） |

---

## 3. 现状盘点（代码实证）

### 3.1 直接复用面

| 能力 | 落点 | 对 Sunx 的意义 |
|---|---|---|
| fork 子智能体（同步/后台两段式） | `src/harness/subagent.ts`（spawnBackground :414、并发帽 8 :259） | P1 主派发通道：`background=true` 立即回 taskId、结论落任务日志 |
| 后台任务账本（exec/subagent、持久化、孤儿标、收养） | `src/harness/tasks.ts`（ledger-<journalId>.jsonl、liveTasks 进程级共享） | Sunx 的执行层台账；唤醒源在此分流（bg-wake §3.1） |
| 任务板五态机（依赖/环检测/指派/自愈） | `src/taskboard/model.ts`（LEGAL :42、recoverOnLoad :165） | 状态权威；P2 板任务通道；重启自愈语义沿用 |
| 长驻执行体（单飞 worker/claim/指派队列/inbox） | `src/taskboard/teammate.ts` | P2 板通道的执行体；「无活成员留 pending」语义适配 Sunx |
| 外部 CLI 执行体 | `src/taskboard/executors/external-cli.ts` | P3 目标通道 |
| 委派统一投影（四种 kind 统一生命周期） | `src/delegation/projection.ts` | GUI 任务时间线零新增 |
| 唤醒机制设计（合批/优先级/防循环/回执同构/显示裁定） | `2026-11-09-bg-task-wake-design.md`（**草案**） | **P0 = 按草案落地**；Sunx 的「始终异步」完全建立在其上 |
| 挂起表（approval/ask/plan-approval、pid 票据、WS 帧、快照重建卡、HTTP 回执） | `src/serve/session.ts:559-695` | Sunx 的 HITL 回路零新增；daemon 重启持久化为 P2 增量 |
| steer 队列（运行中插话、空闲续跑 G14.89） | `src/serve/session.ts:1193-1201` | 用户给 Sunx 的追加指令通道，零新增 |
| journal v3（凡界面可见皆落库、shadow 行水合） | `src/session/seglog.ts:28-56` | Sunx 无需新行词汇：任务/委派/子智能体行全部既有 |
| 会话常驻 + 收编恢复 + 双键对账先例 | `src/serve/session-lifecycle.ts:129-266`、`gui/src/use-side-chats.ts` | GUI 关了任务照跑；SUNX 分组跨重启寻址学 sidechat 模式 |
| 工具面白名单派生 | `ToolRegistry.derive({only})`（`subagent.ts:346` 同机制） | Sunx 面的单一实现点；防后续新增工具泄漏进 Sunx 面 |

### 3.2 缺口清单（Sunx 须补齐的全部净新增）

1. **唤醒未落地**——bg-wake 只有设计草案（docs 提交 41d955c6），无任何实现代码。这是唯一「无它则 Sunx 不成立」的缺口。
2. **调度原语不存在**——全仓无 cron/timer 业务层（Explore 已穷举：现有定时器全部是基础设施）。P2 新增 daemon 级 timer registry。
3. **HITL 仅主链**——fork/teammate 面剔除 ask_question（`subagent.ts:338-366`、`harness/index.ts:420`）。子任务中途问人 P2/P3 处理（§8.2）。
4. **挂起是内存态**——daemon 重启未决 ask/approval 蒸发。P2 持久化增量（§11）。
5. **无自定义侧栏分组**——现状组=工作区/置顶/归档/RECENTS。SUNX 分组以 `meta.kind==='sunx'` 过滤视图实现（§10）。
6. **Sunx 章程与工具面**——装配期按 session kind 分叉的 profile 机制（§6）。

---

## 4. 总体架构

### 4.1 关键裁定：Sunx 是 profile 化会话，不是新编排器

备选与取舍：

| 选项 | 评价 |
|---|---|
| **A. session kind='sunx' 的 profile 会话（采用）** | 复用 SessionRuntime 全套器官：单 run 锁（天然串行化唤醒轮）、journal、挂起表、影子投影、收编恢复、ModelSwitcher。增量只有「装配面按 kind 分叉」+ 唤醒 + GUI 视图。与「交互面只做参数解析与呈现」「任何新编排层必须经 Runner 而非旁路拼装」两条既有纪律一致 |
| B. daemon 内独立编排器进程/线程 | 需要第二套状态/事件/持久化/挂起机制 = 旁路拼装，违反不建平行写面纪律；否决 |
| C. 普通 lead 会话 + 提示词引导（无 profile） | 无工具面约束（用户明确要求「只有分派工具」）、无 kind 标识（GUI 分组无从谈起）；不满足需求 |

### 4.2 架构图

```text
用户（GUI 欢迎页/SUNX 分组）
   │ submit（普通提交路径，202）
   ▼
Sunx 会话（SessionRuntime，kind='sunx'：章程提示词 + 分派工具白名单面）
   │ 链行：计划（todo_write）→ dispatch_task×N（立即回执）→ 收轮（turn end）
   │                                        │
   │                              ┌─────────┴──────────┐
   │                     fork 后台子智能体          （P2）团队板任务
   │                     （SubagentRunner.spawnBackground）
   │                                        │ 各自独立 Reactor 执行
   │                              TaskRegistry / TaskBoard（状态唯一权威）
   │                                        │ 终态 onChange
   │                                        ▼
   │                    WakeController（bg-wake：合批 1.5s / receipted 复检 / 连续上限）
   │                                        │ 空闲 & steer 空
   │                                        ▼
   └──────────── 唤醒轮 submitWake（notice 尾追 <task-notification> 回执）→ Sunx 重估：验收/追加派发/汇总交付
```

### 4.3 「始终异步」的精确语义（不变量）

1. **分派即返回**：Sunx 面上不存在同步执行形态——dispatch 工具恒两段式；同步 spawn 不进 Sunx 面。
2. **不阻塞等待**：阻塞形态 task_wait 不进 Sunx 面（监视走非阻塞窥视 + 唤醒回执）；「后续步骤依赖结果」的正解是收轮等唤醒，不是原地等。
3. **空闲即不占**：无在飞任务且无可推进入时，Sunx 保持 idle（run 锁释放），不空转轮询——唤醒由状态驱动（「唤醒是状态驱动的系统事件」既定不变量，Sunx 是其第一个重度消费者而非例外）。
4. **用户消息恒优先**：steer 队列用户轮先于唤醒轮（bg-wake §3.2 既有裁定）。

---

## 5. 域模型与状态控制

### 5.1 状态权威：不建第二账本

| 状态 | 权威 | Sunx 的读写面 |
|---|---|---|
| 派发任务执行状态（fork） | TaskRegistry（exec/subagent 台账） | 非阻塞窥视工具（task_wait 变体 0s 窥视档，`task-wait.ts` 既有）+ 唤醒回执（含结论） |
| 派发任务执行状态（板） | TaskBoard 五态 + 依赖 + artifact | 板快照工具（get_agent_team_board 既有）+ 唤醒回执（boardDispatch 行已纳入唤醒） |
| Sunx 自身计划/分解 | **链行即账本**（todo_write 批次 + 链行尾追） | 与 Magentic-One「计划账本」同构但落在链上——append-only、压缩点才重写，前缀纪律天然成立；GUI 侧 todo 批次权威投影（`SessionTodoBatch`）已可直接复用为「Sunx 计划卡」 |

明确否定项：不新增 `SunxTaskStore` 之类的第三份任务存储。理由：执行状态已有两份权威（台账/板），计划状态已有链——再建一份必然漂移（禁止补丁式修改/不建平行写面纪律）。

### 5.2 Sunx 生命周期（wake 驱动的轮次循环，无新状态机）

Sunx 不引入独立的状态字段——它的「状态」就是会话 status（idle/running）+ 链上计划 + 板/台账任务态。轮次循环：

```text
[首轮]  用户 submit → 分解（todo_write 计划批次）→ dispatch_task×N → 输出说明 → 收轮
[唤醒轮] <task-notification> 尾追 → 重估：全部子任务终态且计划完成？
            ├─ 未完成：追加派发 / 标记阻塞（todo 状态推进）/ 收轮继续等
            ├─ 需要用户裁决：ask_question（挂起，回执后同 run 续跑）
            └─ 完成：汇总交付（终轮正文）；如需落档产物，验收行引用子任务日志/文件路径
```

防打转：连续唤醒上限（草案 10 轮）触顶后剩余唤醒丢弃 + notice「auto-wake limit reached」——此时 Sunx 的下一个用户消息/插话是唯一再启动源。**章程提词**须告知模型此上限并引导「无新信息时收轮而非空转」。

---

## 6. 工具面（Sunx profile）

### 6.1 派生机制：白名单（`derive({only})`），不是排除法

排除法派生（现状 fork 子面的形态）有个隐患：**主链未来新增任何工具都会自动漏进 Sunx 面**。Sunx 面采用 `derive({ only: [...] })` 白名单——新增工具默认不进 Sunx 面，「只有分派任务相关工具」由构造保证而非清单维护保证。装配单点在 `SessionRuntime.assemble()`（kind==='sunx' 分支），与 TUI 同源。

### 6.2 工具清单

**P1（Sunx 原型）**：

| 工具 | 来源 | Sunx 语义 |
|---|---|---|
| `dispatch_task` | **新（P1 唯一新工具）** | 唯一派发动词：自包含简报 + agent_id/label/tier/isolation → fork 后台执行（spawnBackground 通道），立即回 taskId+日志路径；回执追加 WAKE_HINT（bg-wake §4.2 挂载闸同款） |
| `task_status` | task_wait 变体注册（`makeTaskWaitTool` kinds/超时收窄先例） | 非阻塞窥视（0s 窥视档既有）：按 id 或「全部在飞」返回状态+日志尾；**阻塞形态不进 Sunx 面** |
| `task_stop` | 既有 | 取消派发任务 |
| `get_agent_team_board` | 既有 | 板态快照（P2 板通道的监视面；P1 若无团队亦无害） |
| `ask_question` | 既有 | HITL：选项卡问询，任意档挂真实回答（G14.93 既有裁定） |
| `todo_write` | 既有 | 计划账本（分解批次，GUI 计划卡复用） |
| `skill` | 既有 | 编排 SOP 技能加载（只读知识件，可选，待裁定 R8） |

**P2（管理面增强）**：`schedule_wakeup`（定时唤醒自己）、`schedule_task`（到点自动派发）、`send_agent_team_message`（板通道协调）、`create_agent_team/create_agent_teammate`（能力自举——若采纳「Sunx 自建团队」裁定 R6）、`update_agent_team_task`（板任务推进）。

**恒不进 Sunx 面**：exec / read / write / edit / grep / glob / webfetch / websearch / worktree / memory_write / exit_plan / 同步 spawn / 阻塞 task_wait / load_subagent / load_agent_teams（清单由白名单构造保证）。

### 6.3 `dispatch_task` 契约（草案）

```text
parameters:
  spec:       string  — 自包含简报：goal / key facts / paths / constraints / ACCEPTANCE（子任务看不到本会话）
  agent_id:   string|null — 注册制角色（agents/{id}）或预设四角色；null=内联临时
  label:      string|null — 卡片短题（台账 label/委派卡/唤醒行显示段同源）
  tier:       enum|null   — 执行档位覆盖（缺省继承会话档；「强 Sunx 弱 worker」可配）
  isolation:  enum|null   — 'worktree' 语义沿 spawn 既有（P3 会话型通道时扩展）
（P2 增）target: enum 'fork'|'team'|'schedule' — 缺省 'fork'；'team'=板任务（依赖/重派/外部执行体）
（P2 增）depends_on: string[] — 板通道依赖 id（fork 通道不支持，传了报 INVALID_ARG）
```

回执形态对齐 spawnBackground 既有：`task <id> started (output: <path>)` + WAKE_HINT 一句（bg-wake §4.2 同一常量，挂载闸：宿主装了唤醒且主链归属）。委派事件沿用 `delegation-started/ended`（kind='background-task' 携 taskId）——GUI 任务时间线零新增。

### 6.4 新工具论证（对齐 §5「每加一个工具即一次全量前缀断点」纪律）

- `dispatch_task` 只进 **sunx kind 的面**，普通会话主链工具面零变化——前缀断点只发生在 Sunx 会话自身（其面装配期一次定型，后续冻结，Manus「Mask-don't-Remove」同构）。
- 为什么不复用 `spawn(background=true)`：spawn 的 schema 与描述是通用语义（含同步形态、并行扇出指引），Sunx 需要的是「恒后台、恒异步」的窄契约；且「两动词两契约」是项目既定先例（spawn vs create_agent_teammate）。窄工具还能把 WAKE_HINT 直接写进描述，而不依赖运行期回执追加。
- 为什么不复用 `create_agent_team_task` 做 P1 派发：板任务语义绑团队名册（无活成员留 pending），fork 通道无此前置；P1 用 fork 起步零装配成本。P2 target='team' 时该动词的板语义整体收编进 dispatch_task 的 team 分支（R6 裁定后定稿）。

---

## 7. 唤醒与调度

### 7.1 P0：落地 bg-wake（前置依赖，独立于 Sunx 交付价值）

按 `2026-11-09-bg-task-wake-design.md` 实施：WakeController（session 层）+ harness 终态分流（onChange 既有回调内）+ 两端轮收束胶水 + run 行一行前缀显示。**草案 §10 的五个待裁定项须先裁决**（interrupted 后待唤醒去留 / 连续上限 10 / 合批 1.5s / 失败任务唤醒 / live notice 步型核对）。bg-wake 落地后普通会话立即受益（后台 exec/spawn 完成自动接续），Sunx 只是第一个重度消费者——这保证 P0 的独立价值与回归面清晰。

### 7.2 P2：调度原语（对标 Grok Tasks / Devin Automations 的最小内化）

**依赖裁定（2026-11-14 用户问询后确认）：调度是唤醒管线的第二触发源，全部基础设施（唤醒 notice 契约 / submitWake 胶水 / run 行前缀显示 / 防循环上限）都是 P0 bg-wake 的交付物——不可先于 bg-wake 实施**（否则管线按 timer 触发器先落一版，终态触发接入时 notice 契约与显示配对返工）；Sunx P1 为纯事件驱动闭环，零调度依赖。

- `schedule_wakeup({ delay_seconds | at_iso, note })`：Sunx 给自己定闹钟。到点 = 一条唤醒轮（notice 形态：`<schedule-wake>` + note），走 WakeController 同一管线（合批/上限/显示前缀沿用，前缀文案「定时唤醒」）。
- `schedule_task({ spec, ..., at | delay })`：定时派发——到点自动执行 dispatch 语义（进 WakeController 待唤醒登记，终态照常唤醒）。
- 持久化：调度行落 journal（新 shadow 行 `wake-schedule`，语义与 board/delegation 行同级——凡界面可见皆落库）；attach 时重布防（daemon 级 timer registry 装载重放）。错过时段（daemon 停机跨越）策略待裁定 R7：默认「补发一次唤醒 + 注明延迟时长」。
- 循环/周期（cron-like）：P3 视需求，MVP 只做一次性。

---

## 8. HITL

### 8.1 Sunx 自身问询（P1，零新机制）

`ask_question` 复用挂起表全链路（suspendAsk → AskFrame → GUI 卡 → /ask/:pid/reply → notice 行）。Sunx 是主链会话——任意权限档挂真实回答的既有裁定直接适用。run 被问询挂起期间：子任务照常在飞（它们是独立 Reactor），完成唤醒在控制器登记为 pending，回答后本轮收束、唤醒轮自然起——**HITL 不破坏异步性**，只是推迟 Sunx 的下一拍。

### 8.2 子任务 HITL（P2/P3）

现状：fork/teammate 面剔除 ask_question 是既定裁定（「fork 执行不中途发问，结论回写即应答」）。演进路径（与「执行体=会话」P3 联动）：

- **P2（轻量上抛）**：子任务无问询能力不变。Sunx 章程要求简报里预置「默认决策」（acceptance 之外附 defaults 字段指引），子任务遇歧义按默认走并在结论里声明——业界「模糊委派」教训的对症手段。
- **P3（会话型执行体）**：dispatch target='session' 派生真子会话（fork 血缘机制既有：journal header forkedFrom），子会话挂起卡经既有 per-session pending 帧直达 GUI（卡带来源 Sunx 与任务 id 的上下文标注），同时上抛一条 blocked 委派事件让 Sunx 知晓。是否允许子会话直接问用户 vs 一律上抛 Sunx 代问，届时裁定。

### 8.3 无人值守降级策略

业界痛点（审批不可序列化→人在不在场决定生死）在本项目的形态：ask 无超时=run 可无限挂起。策略（P1）：

- 默认**永不过期** + GUI 醒目徽标（SUNX 组聚合「待裁决 N」+ `awaiting` 侧栏标注既有）——问询都是「影响任务线走向」的决策（章程提词约束问询频率），过期自动放行反而制造假确认。
- 备选（P2，R8 裁定）：pending 可选 TTL，超时自动 dismissed + 唤醒轮告知「用户未应答，按默认决策推进」——与 8.2 的 defaults 机制配套。
- daemon 重启丢失挂起的现状缺口：P2 持久化（§11）。

---

## 9. 执行体通道演进

| 期 | 通道 | 语义 | 约束 |
|---|---|---|---|
| P1 | fork 后台子智能体 | 轻量、零前置、同进程、转录进子智能体页签；简报隔离 | 并发帽 8；owner 收割语义沿用（fork 域 `fork:<label>`） |
| P2 | 团队板任务 | 长任务、依赖图、可重派、可 external-cli；唤醒已纳入（boardDispatch） | 需团队名册在场；「无活成员留 pending」+ Sunx 能力自举（R6） |
| P2 | schedule_task | 定时派发（§7.2） | 一次性 |
| P3 | 独立子会话（target='session'） | 真 HITL、断线可续、完整 journal、GUI 可见子树 | fork 血缘机制复用；上下文传递=简报文本+结论文本；子会话权限档独立装配 |
| P3 | 外部 CLI（target='cli'） | external-cli 执行体直连（stream-json 适配既有） | 并发帽 2（MAX_EXTERNAL_CONCURRENT 既有） |

---

## 10. GUI：SUNX 分组

### 10.1 信息架构：分组是视图，不是存储

- **实例标识**：会话旁车 meta 加 `kind?: 'sunx'`（`<id>.meta.json` 现有 root/title/archived/forkedFrom 同级字段，出生写落定），连同实例身份三元组 `kind + name + charterRev`；`/sessions` 列表行透出 `kind`。身份三元组的分层落位与修改语义见 §17.1。
- **侧栏 SUNX 组**：新分组区块，聚合展示全部 `kind==='sunx'` 会话（按工作区再分组或平铺，R10 裁定）。每实例行：标题 + 状态点（running/idle）+ 任务徽标（在飞 n / 待裁决 n，数据=委派投影 + pending 计数，既有字段组装）。
- **新建入口**：侧栏 SUNX 组「+」按钮与欢迎页模式选择（「直接对话」/「交给 Sunx 编排」两态，R11 裁定欢迎页形态）。
- 跨重启寻址学 sidechat 双键对账先例（运行时 id × journalId）：SUNX 组行持久身份=journalId。

### 10.2 实例详情：页签复用为主，新增一个聚合页

| 视图 | 载体 | 增量 |
|---|---|---|
| Sunx 转录（计划/唤醒/交付全过程） | SessionTab 既有 | 唤醒行一行前缀（bg-wake §6 两端已裁定） |
| 任务列表 + 依赖 DAG | agents 页签（TaskBoardTab + TaskDag）既有 + 委派投影 | fork 通道任务在后台任务页签（bg-task 行既有）；P2 板任务进 agents 页签 |
| 子智能体转录 | agent 页签（AgentTranscriptTab，shadow 水合既有） | 零新增 |
| **SUNX 总览页（新页签类型 `sunx`，单例）** | 新注册条目（registry 追加一条+图标+盘档白名单即得全套） | 全部 Sunx 实例卡片：状态/任务进度/最近活动/待裁决聚合；点击进实例 |
| 待裁决卡 | Chat 卡区既有（per-session）+ SUNX 组徽标聚合 | 卡片带「来自 Sunx <名> · 任务 <label>」上下文标注（P2） |

### 10.3 交互裁定沿用

跳转定位瞬跳无闪光（§13.1 规则 6）、悬浮提示 data-tip、图标钮 24px 命中盒/14px 下限、圆角体系——全部既有铁律直接适用，本设计零豁免。

---

## 11. 持久化与恢复

| 资产 | 机制 | 缺口与增量 |
|---|---|---|
| Sunx 会话链/转录/计划批次 | journal v3 + todo 批次权威投影（既有） | 无 |
| fork 任务台账 | ledger-<journalId>.jsonl（既有，pid 孤儿标 stopped） | 无；重启后打开态任务不自动续跑（recoverOnLoad 自愈 cancelled 既有语义） |
| 板/团队 | TeamStore 收养 + reconcile（既有） | 无 |
| 委派/子智能体投影 | shadow 行水合（既有） | 无 |
| 唤醒登记 | 内存（receipted 不落档既有裁定） | 无需持久——重启后运行中任务已孤儿标，本就不唤醒 |
| **调度项** | 无 | P2：journal `wake-schedule` 行 + attach 重布防（§7.2） |
| **挂起票据** | 内存（现状，重启蒸发） | P2：pending 行落 journal（`pending-open/resolve` 影子行），attach 重挂 + GUI 卡重建；executors 已死的票据标 expired 由用户重投 |
| **恢复唤醒** | 无 | P2（R9 裁定）：attach 完成后对 `kind==='sunx'` 会话注入一条恢复 notice 唤醒轮（「重启后 N 个派发任务被打断；重读板态，决定重派/放弃」），实现「重启自愈后 Sunx 自主重建」 |

---

## 12. 分期落地

| 期 | 内容 | 交付判据 |
|---|---|---|
| **P0** | 落地 bg-wake（草案 §10 五项先裁定）；普通会话与 Sunx 共同受益 | 草案 §9 验收全绿；两端唤醒轮端到端用例 |
| **P1** | Sunx 会话原型：kind 装配分叉（章程提示词 + 白名单面）+ `dispatch_task` + 非阻塞 `task_status` 变体 + ask/todo 复用；GUI 可建可聊（无专属分组） | 场景走查 §13 全部主链场景通过；普通会话回归零变化（主链工具清单逐字节不变用例） |
| **P2** | GUI SUNX 分组（meta.kind + 侧栏组 + sunx 总览页 + 徽标聚合）；调度原语（schedule_wakeup/task + 持久化重布防）；板任务通道（target='team' + 能力自举 R6）；挂起持久化；恢复唤醒（R9） | 断网/关窗/重启三类生存用例；调度到点用例 |
| **P3** | 独立子会话执行体（target='session'，HITL 直达+上抛）；外部 CLI 通道；子任务结论注入扫描（业界教训，P3 可选）；多 Sunx 协同评估 | 届时另立规格 |

每期强制：`pnpm build` + 全量 + selfcheck；提示词/装配面改动附前缀稳定用例（§11 纪律）；工具面改动附「主链清单逐字节不变」对照。

---

## 13. 场景走查（验收剧本）

| 场景 | 期望 |
|---|---|
| 用户给 Sunx 一句「重构 A 模块并补测试，跑通全量」 | 首轮：todo 计划批次（分解 3 步）→ 2~3 个 dispatch_task（实现/测试并行，简报自包含含验收）→ 收轮；子任务完成各唤醒一轮；末轮汇总交付，计划批次全勾 |
| 子任务失败 | 唤醒回执含失败信息（bg-wake 裁定「失败也唤醒」）→ Sunx 读日志尾（task_status）→ 重派带修正简报 / ask_user 裁决 |
| 子任务运行中用户插话「先别做 B 了」 | steer 队列用户轮优先 → Sunx task_stop B + todo 推进 → 收轮；A 完成照常唤醒 |
| 子任务问出歧义 | P1：子任务按简报 defaults 决策+结论声明；P3：上抛卡直达 GUI + Sunx blocked 通知 |
| Sunx 需要用户裁决（方案二选一） | ask 卡挂起 → 子任务照跑 → 用户答后同轮续跑 → 收束后待处理唤醒自然起（HITL 不破坏异步） |
| 用户关掉 GUI / 断网 | daemon 常驻：Sunx 与子任务照跑；重开收编恢复全部投影，唤醒轮照常 |
| daemon 重启 | 打开态任务自愈 cancelled（既有）→ R9 恢复唤醒轮：Sunx 重读板态，重派或向用户报告 |
| 定时任务「每天 9 点跑全量回归并汇报」 | P2：schedule_task 到点派发 → 完成唤醒 → Sunx 汇总；SUNX 组徽标全程可见 |
| 连续唤醒触顶 10 轮 | 唤醒丢弃 + notice；用户消息是唯一再启动源（章程已告知模型） |

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| token 放大（业界 15×） | 简报短、结论截断回链、产物传引用；tier 可配；并发帽沿用；用量统计开关（既有）可关显 |
| 唤醒风暴 | 合批窗口 + 连续上限 + interrupted 不唤醒（P0 既有裁定） |
| Sunx「空转编排」（不派发自己硬干，但无执行工具） | 白名单面上模型物理上不能自己动手；章程给「分派优先」指引；极端空转由步数/预算护栏兜底（放宽缺省纪律不变） |
| 双派发动词漂移（dispatch vs spawn vs 板任务） | P1 只有 dispatch 一个动词；P2 team 分支收编板语义并更新规格；普通会话的 spawn/八件套不动 |
| GUI 复杂度 | 总览页单例；组行复用 SessionRow 组装；页签增量=注册表一条 |

---

## 15. 待裁定清单（~~实施前逐项裁决~~ → 2026-11-14 用户裁定：**R1–R13 全部按推荐采纳**）

| # | 事项 | 裁定（2026-11-14，按推荐采纳） |
|---|---|---|
| R1 | bg-wake 草案 §10 五项（interrupted 后待唤醒去留 / 连续上限 10 / 合批 1.5s / 失败唤醒 / live notice 步型） | 按草案默认值全部采纳 |
| R2 | Sunx 章程提示词正文（恒英文；分解上限指引/defaults 指引/收轮纪律） | P1 实施时出稿，用户过目后冻结 |
| R3 | `dispatch_task` 是否如 §6.3 收编 isolation/tier 参数 | 收编（复用 spawn 既有语义，零新概念） |
| R4 | `task_status` 是否允许有限阻塞档（如 ≤60s）供「马上就好」场景 | 否——恒非阻塞，守「始终异步」不变量纯净性 |
| R5 | `skill`/`kb_search` 是否进 Sunx 面（只读知识件，利于路由质量） | 进 skill，缓 kb_search |
| R6 | P2 板通道：Sunx 是否自建团队+成员（能力自举） vs 只用既有团队 | 自举：首个 team dispatch 时自动建团队+按 agent_id 实例化成员（用户可改） |
| R7 | schedule 调度错过时段策略 | 补发一次 + 注明延迟 |
| R8 | pending TTL 超时自动 dismissed | 暂不做；先观察 ask 卡实际挂起时长 |
| R9 | daemon 重启后 Sunx 恢复唤醒轮（自动重估） vs 静默待用户 | 自动恢复唤醒（Sunx 的自治定位） |
| R10 | SUNX 组按工作区分组 vs 全局平铺 | 按工作区分组（与侧栏既有心智一致） |
| R11 | 欢迎页「交给 Sunx」形态 | 欢迎页加模式选择，SUNX 组内也有「+」直达 |
| R12 | Sunx 会话权限档缺省 | acceptEdits（子任务默认护栏档；Sunx 自身无执行工具，档位只影响派发出去的子面） |
| R13 | P1 是否顺带实现 `schedule_wakeup` 最小版 | 否——P1 保持零调度，聚焦唤醒闭环 |

---

## 16. 与既有规格的关系

- `2026-11-09-bg-task-wake-design.md`：本设计的 P0，全部裁定沿用不重复；Sunx 不修改其任何裁定。
- `2026-10-04-multi-agent-orchestration-design.md`：三维正交（任务/角色/执行体）不动；Sunx 是「编排专职会话」这第三种 lead 形态的实例化——TaskBoard 仍是心脏，Runner 仍是生命周期唯一权威。
- 普通 TUI/GUI 会话、智能体团队八件套、spawn 语义：本设计零改动。

---

## 17. 实例身份、fork 缓存与总览页（2026-11-14 三问增补，已裁定）

### 17.1 实例身份三元组：姓名 + 工作目录 + 品格（采纳；分层落位 + 修改语义）

创建表单 = **姓名**（必填）+ **工作目录**（必选，绑定不可改）+ **品格章程**（文本域，缺省模板，可留空=仅系统总章程）。四个上下文面的落位与修改语义：

| 面 | 提示词落位 | 修改语义 |
|---|---|---|
| 系统总章程（编排者职责/工具面纪律/收轮纪律/唤醒语义/上限告知） | 稳定段共享块（prompts/ 单点，kind='sunx' 分支），全部 Sunx 实例**字节一致** → 跨实例前缀共享最大化 | 装配期定版，随版本演进（与全部提示词同一纪律） |
| 实例品格（charter，用户自撰物料**原样直存**——目录注册制先例，任意语言） | 会话级冻结层（SUNSHINE.md 同区装配，出生一次定版） | **改品格 = 尾追替代行**（v2 标记 + 「以本行为准」；后到者优先既有纪律）——前置段零改动、零前缀击穿；meta 记 charterRev。旧版留在冻结层继续吃缓存，读者按尾行取新版 |
| 姓名 | 身份行（会话级冻结层，出生定版一次）+ meta.name | **改名 = 纯显示同步**：GUI 侧栏/任务卡署名/问询卡署名全部取 meta.name（宿主侧组装，非模型输出），模型面保持出生名——零前缀影响。模型自述名字属边缘场景；如确需同步，尾追一行告知（备选，缺省不做） |
| 工作目录 | 稳定段工作目录行（既有共享行；同工作区各会话字节一致） | **不支持更改**——创建时绑定，生命周期恒定。依据：rehomeRoot 是 attach 元数据纠偏的窄路径（出生壳零实质事件时整体换铸），运行中换根 = 全链换铸 + 数据目录迁移 + 前缀全断；换目录的正解 = 新建实例 |

要点：**显示层与提示词层严格分离**是「改名零缓存代价」的关键——一切署名面在宿主侧组装，模型上下文里的姓名只是出生身份行，永不重写；品格更新走尾追，这正是「运行中任何变更只尾追」纪律的直接适用。

（P2 可选：`.sunshinex/sunx/{id}/sunx.md` 人格模板目录——frontmatter name/description + 正文章程，创建表单从模板挑选，与 teams/agents 目录约定同构。）

### 17.2 分派通道的 fork 语义与前缀缓存（裁定：fork 主链快照为默认形态）

两通道都是既有机制原样复用，零新装配：

| 通道 | 子执行体看到的上下文 | 缓存机制 |
|---|---|---|
| fork 通道（P1 默认，spawnBackground 既有） | 冻结前缀（稳定段+总章程+SUNSHINE.md+技能清单，与 Sunx **逐字节相同**）+ 主链快照切片（分派时刻冻结：用户原始诉求/计划行/既有派发与结论行）+ 角色行 + 简报行 + 私有步骤 | 子首帧 = Sunx 最近一次请求的前缀（front + 链切片逐字节连续）+ **纯尾追** → 供应商侧最长前缀命中；子后续调用在其自有世系继续命中。「主链↔fork 首帧严格前缀连续」是既有测试纪律（CLAUDE.md §11） |
| 板通道（P2，teammate 既有） | 自有独立 ContextManager（角色框定 + 历次任务行），**不见 Sunx 链与章程，只见自包含 spec** | 干净面与全部 teammate 共享 front（同根字节一致）→ 跨成员前缀共享 |

回应「Sunx 特殊提示词是否阻碍 fork 复用缓存」：**恰恰相反**——总章程与品格都在冻结前缀里，fork 首帧原样携带它们，命中率因此更高而非更低；特殊提示词是共享前缀的一部分，不是障碍。工具清单差异（子面 ≠ Sunx 面）是请求级字段差异、不进提示词文本（消息形态不变量），属既有 spawn 通道早已接受的边界，非 Sunx 新增成本。

已知噪声面与对策（按序）：chain 形态下子执行体可见 Sunx 链上的兄弟任务简报与唤醒回执——板通道当年为此设了 bare 先例（防「自等」）。①章程角色框定 + 简报自包含纪律（简报是任务唯一权威，链行只是背景）；②P2 若实测串扰，`dispatch_task` 增 `context:'clean'`（映射既有 bare 通道 + 品格块子面剔除的装配变体，跨实例干净面共享缓存）——一行翻转的退路，P1 不预置。

### 17.3 SUNX 总览页（裁定：按此形态实施）

侧栏 SUNX 组头加**看板钮**（图标钮 24px 命中盒 / data-tip 既有铁律）→ 主区打开**单例 `sunx` 页签**：

- 顶部全局聚合条：运行中实例 n / 在飞任务 n / 待裁决 n（跨实例汇总）。
- 卡片网格（按工作区分节，R10）：每实例一卡 = 姓名 + 状态点 + 任务进度（在飞/完成计数）+ 最近活动一行 + 待裁决徽标；点卡片 → 该实例转录页签（既有 openTab 寻址）。
- 「新建 Sunx」入口卡（= 创建表单，§17.1 三元组）。
- 侧栏**不收起**——总览是普通页签语义：与实例页签并存、可切换、随会话持久化/恢复（盘档白名单一条既有机制即得全套）。
- P2 增强：卡内嵌 mini DAG（TaskDag 复用）；P3：跨实例时间线。

数据面零新增：卡片字段全部来自既有面（/sessions 列表 kind 过滤 + 快照委派投影 + pending 计数）。
