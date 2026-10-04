# 多 Agent 编排子系统设计规格(TaskBoard / Teammate / Executor 三维正交)

- **日期**:2026-10-04
- **状态**:设计定稿,待评审,未实施
- **来源**:六轮架构讨论收敛(现状分析 → 落地设计与取舍 → 正交性修正 → 持久化与恢复 → 外部执行体 → 上下文缓存)
- **关联**:`docs/ROADMAP.md`(阶段五 5A/5B)、`docs/Tech Architecture/01~04`、`docs/superpowers/specs/` 同级设计规格
- **对照系**:Claude Code Agent Teams(官方文档 + 第三方逆向:共享任务列表 + 文件 mailbox + 扁平 teammate)

---

## 0. 背景与问题陈述

### 0.1 现状(以代码为准)

- **GraphEngine 是静态 DAG**:拓扑构造期一次性灌入(`src/graph/engine.ts:45`),无 addNode/removeNode API,运行期不可增删;Kahn 分层 + 环检测(`engine.ts:79`,错误携带环成员清单);层间串行、同层 `Promise.allSettled` 并发;无回边、无一等条件分支,重试环只存在于 loop 节点内部的 LoopEngine。
- **Graph 层在 TUI 是零呈现**:GraphEngine 不发射 SessionEvent(仅 `hooks.onNodeEnd` 回调),唯一消费方是 CLI `sunshinex pipeline`(`src/cli/commands/run-pipeline.ts:65`)与 selfcheck。
- **TUI 的多 agent 体验建立在 spawn/SubagentRunner 通道上**(ChildPanel / ChildInspector / Ctrl+B / 归档回放),与 GraphEngine 无交集——**两套编排平行未打通**。
- 已知文档漂移:阶段三报告声称的 `graph/workflow.ts`(WorkflowDef)与 `ci` 节点类型在代码中不存在;现存图定义仅 `src/graph/templates.ts` 代码级模板工厂。

### 0.2 对照:Claude Code Agent Teams 的机制与教训

- 机制:lead + 扁平 teammates(各为完整独立 session);协调靠**共享任务列表(三态 + 任务间依赖 + claim,文件锁防竞争)**——即「隐式动态 DAG」,无显式图对象;通信靠文件系统 mailbox(每 agent 一个 inbox JSON)+ 轮询;UI 只做面板行级呈现 + Ctrl+T 任务视图,无图可视化。
- 教训(官方自认):文件 mailbox 单条脏数据曾卡死整个收件箱;任务状态滞后阻塞下游(靠模型自觉标记);`/resume` 不恢复 in-process teammates;token 线性放大且 teammate 请求不共享主会话缓存。

### 0.3 核心判断

对交互式 coding agent 产品,**不适合的是「静态」,不是「DAG」**:DAG 作为依赖调度语义(分层解锁、skip 传播、环检测)依然正确;错误的是拓扑构造权攥在代码里。任务结构在运行期才显形,拓扑构造权必须交给模型(在 harness 护栏内)。

由此定调:**不是给 GraphEngine 加动态改图,而是把编排重心从「节点图」移到「任务列表」;GraphEngine 降级为「预填任务列表的模板宏」,其调度器官移植进任务板。**

---

## 1. 目标与非目标

### 1.1 目标

1. **三维正交**:任务(做什么)/ 角色(是什么)/ 执行体(在哪跑)三个独立维度;现有 spawn 是「任务↔执行体 1:1 焊死」的特例,team 是解耦后的通用形态。
2. **统一事件面**:task/delegation 事件进 `src/types.ts:259` 的 TUI/GUI 公共 SessionEvent 面,进 journal;TUI 与 GUI 是同一事件流的两个投影。
3. **journal 化持久**:任务板、收件箱、执行体状态全部落盘,kill -9 任意时刻可恢复且无需人工修状态。
4. **执行体异构**:内部 fork / 内部长驻 teammate / 外部 CLI agent(claude code 等)可插拔;协调与观察层统一,执行层异构。
5. **缓存稳定的上下文构造**:三类执行体共用三层上下文形状,append-only 纪律,prefix cache 命中率最大化。

### 1.2 非目标

- 不做终端 DAG 可视化(依赖以文字呈现;图形化是 GUI v2 的事,与 ROADMAP 一致);
- 不上 A2A/MTP 等重协议(单机产品,子进程 + JSON 流适配够用;Executor 抽象保留,标准协议将来做一个适配器实现即可);
- 不做文件锁协议(单进程,内存原子操作);
- 不淘汰现有 subagent(fork)模式——它是「上下文连续性优先」场景的正解,与 teammate 是两种能力并存;
- 不做 GUI 详细设计(5B 另立 spec,本 spec 只约束 GUI 的协议层前置);
- 不做分布式/多机(单进程单机形态)。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **Task** | 工作单元:自包含 spec + 状态机 + 依赖;住在 TaskBoard |
| **TaskBoard** | 任务集合 + 调度语义(依赖解锁/环检测/gate/预算)的协调中枢 |
| **Role** | 角色定义:`agents/{id}/agent.md`(提示词/工具面/资源约束)+ 新增 executor 绑定 |
| **Executor** | 执行体实现:internal-fork / internal-team / external-cli |
| **teammate** | 长驻执行体:独立 context + 任务队列,可多任务、可重派承接 |
| **subagent** | 现有 fork 型执行体:主链快照 + 单任务 + 终态一行回写 |
| **lead** | 主链 session,天然的任务板操作者;不设新角色 |
| **Inbox** | 每执行体一个消息收件箱(append-only 队列 + 消费位点) |
| **artifact** | 任务产出(结论/统计),存引用、按需拉取,不进正文 |
| **委派投影(Delegation)** | spawn / graph 节点 / 后台任务 / teammate 统一投影出的域对象,TUI/GUI 的消费单元 |
| **模板宏** | GraphEngine 静态模板的降级定位:展开成带依赖的任务集注入 TaskBoard |

---

## 3. 架构总览

### 3.1 三维正交

```
        任务(Task:做什么)
          │ 依赖/状态/审批
          ▼
  ┌─────────────── TaskBoard(协调中枢)◄─── lead(主链 session,工具操作)
  │                                        │ claim/assign
  │        角色(Role:是什么)              ▼
  │  agents/ 统一注册 ──实例化──► 执行体(Executor:在哪跑)
  │                            internal-fork │ internal-team │ external-cli
  └──────────── 统一 SessionEvent 事件面(神经)─► TUI / GUI / journal(记忆)
```

一句话:**TaskBoard 是心脏,SubagentRunner 是生命周期唯一权威,GraphEngine 降级为模板宏,TUI/GUI 是同一事件流的两个投影。**

### 3.2 与既有分层的关系

依赖方向不变:`编排(TaskBoard/模板宏)→ Runner → harness → model/storage`。teammate 是 SubagentRunner 的长寿命变体,**不新建旁路**(`src/tui/session.ts:353` 记录过 loop→graph 反向依赖被拆除的教训:任何新编排层必须经 Runner 而非旁路拼装)。

---

## 4. 域模型

### 4.1 Task

```ts
interface Task {
  id: TaskId;
  title: string;
  spec: string;                    // 自包含任务描述:teammate/外部执行体不看主链也能干
  status: 'pending' | 'claimed' | 'in-review' | 'done' | 'failed' | 'cancelled';
  dependsOn: TaskId[];             // 动态可加;加边时环检测(器官移植自 Kahn)
  assignee?: AgentName;            // lead 指派;空 = 可被自主 claim
  executorHint?: ExecutorKind;     // 能力匹配:需要主链上下文(fork-only)或自包含(任意)
  artifact?: { conclusionRef; tokens; durationMs };  // 结果存引用不进正文
}
```

**状态机**:`pending → claimed → in-review → done | failed | cancelled`;`blocked` 为派生态(上游 failed 或依赖被改),不自动迁移。

**关键语义(有意收紧自 GraphEngine)**:上游 failed 时下游**不自动 skip**,标 blocked 等 lead 裁决——交互场景中「上游失败下游还要不要跑」经常是人的判断;CI 式自动 skip 语义保留在模板宏模式(见 §12.1)。

### 4.2 Role(agents/ 目录升级)

- 保留现有装配期一次性加载、fail-fast、运行期零增删(`subagent.ts:74-86`)——此决策同时是一致性保证与缓存稳定性保证(§9.3);
- `agent.md` frontmatter 扩展:`executor: internal-fork | internal-team | external-cli`(缺省 internal)、能力标签、外部适配器参数。

### 4.3 Executor 接口

```ts
interface Executor {
  capabilities(): {
    contextSource: 'fork' | 'independent';
    tools: string[];               // 能力声明,调度匹配用
    stopGranularity: 'turn' | 'process';
    budgetModel: 'event-precise' | 'deadline-coarse';
  };
  start(task: TaskSpec, inbox: Inbox): {
    events$: AsyncIterable<SessionEvent>;   // 可选降级:黑盒执行体只发起止
    conclusion$: Promise<Conclusion>;
    stop(): Promise<void>;
  };
}
```

三实现:`internal-fork`(现有 spawn 路径)、`internal-team`(P2,独立 seed + 任务队列)、`external-cli`(P2,首个适配 claude code headless stream-json)。

### 4.4 Inbox 接口

```ts
interface Inbox {
  send(to: AgentName, msg: AgentMessage): Promise<void>;   // append-only 落盘
  poll(agent: AgentName, since: Cursor): AgentMessage[];
}
// 实现:内存(现在,双写磁盘)/ 文件(daemon 阶段)/ IPC(再往后)
// 协议(append-only + 位点 + 至少一次)三实现共用——换实现不换语义
```

### 4.5 委派投影(Delegation)

spawn / graph 节点(模板宏展开后即 Task)/ 后台任务 / teammate,统一投影为一个域对象(谁、状态、进度、父子关系、审批挂起),TUI 面板/Ctrl+B/Ctrl+T 全部消费这个投影——P0 的核心交付。

---

## 5. 调度与执行体生命周期

1. **SubagentRunner 是生命周期唯一权威**(`subagent.ts:189-191` 既有注释):spawn 工具、模板宏、任务板 claim 都是薄入口;teammate 复用其并发护栏、pause 级联、终态回写,fork 组装换独立 seed + 任务队列。
2. **claim 原子性**:单进程内存原子切换,零锁。
3. **并发护栏**:`SUBAGENT_CONCURRENCY_LIMIT = 8`(`subagent.ts:155`)扩展为 team 维度计数;后台 spawn 绕过单并发上限的既有语义保留。
4. **harness 强制状态回写(核心差异化)**:teammate 回合结束时 Runner 自动推进 `claimed → in-review`,不依赖模型自觉标记——直接消除 Claude Code 官方承认的「任务状态滞后阻塞下游」。
5. **pause-cascade 保留既有两裁决**(2026-10-02):父停子随停(信号级联进子 Reactor/任务 abort);停单个子不连带主链。
6. **预算三级贯通扩展为四级**:Graph/模板宏 → loop 节点 → Reactor 的既有链条,加上 **team 级预算帽**(任务板调度点检查,触帽则排队不失控)。
7. **批量快照派发**:任务板派发一波并行任务时取同一时刻主链快照给整层 fork(缓存层理由见 §9.2);派发器必须支持「快照批量派发」。
8. **模型操作任务板的工具面(lead 侧)**:`create_task / set_dependency / assign / review_task / gate_task`;`create_task` 限流,`set_dependency` 环检测 fail-fast。

---

## 6. 交互分层(团队协作三层)

| 层 | 机制 | 交付 |
|---|---|---|
| **L1 结构共享** | 任务板对 teammate 可见(推摘要 + 工具拉详情);reviewer 能对照 developer 的 spec 评审 | **首版必交付** |
| **L2 消息通道** | @mention 定向消息;**回合边界投递**(非实时中断);载荷过 guardrail;子不能代父批(`deriveChildRegistry` 工具面收窄不变量继续守) | P2,架构占位现在留 |
| **L3 工件协调** | 多执行体改同一文件 | 永久回避:worktree 隔离(已有)+ lead 合并;不发明文件锁协议 |

设计原则:**「teammate 互不通信」是排期决策,不是架构决策**——架构图里必须画着 L2。L2 的投递时机选回合边界有双重理由:执行原子性/位点简单(§7.3)+ 缓存前缀不动(§9.3)。

L1 的注入方式:任务板**结构摘要**(标题/依赖紧凑列表)作为回合启动的尾部 user 消息追加;详情用 `get_task`/`get_board` 工具按需拉取,结果作为 tool-result 尾部追加。禁止把全量任务板状态拼进 system 或重写历史头部。

---

## 7. 持久化与崩溃恢复

### 7.1 两级真相源

| 层 | 内容 | 真相源 |
|---|---|---|
| 执行历史 | 主链 + 各执行体 transcript | SessionJournal(现有;teammate = 长寿命 fork scope,每回合边界 commit) |
| 协调状态 | 任务板 + 收件箱 | **team 目录(新)**,event sourcing |

协调状态不挂在 session journal 下:team 生命周期长于会话(新 session 可按 team-id attach 回同一 team),挂 session 下会话死则 team 成孤儿。

### 7.2 team 目录布局

```
<resolveDataDir()>/teams/{team-id}/        # 跟随统一定位面(src/config/data-dir.ts),不进工作区
  events.jsonl        # 协调事件流(真相源):task-created / claim / status 变更 / message-sent ...
  board.json          # 任务板物化快照(缓存,可从 events.jsonl 重放重建)
  inbox/{agent}.jsonl # 每执行体一个收件箱,append-only,行不完整跳过该行
```

event sourcing + snapshot:每次任务变更 append 一条事件(原子写)后更新快照;崩溃在两步之间 → 重放事件流重建快照。快照的意义只是避免启动全量重放。

### 7.3 mailbox 恢复四件套

**持久 append-only 队列 + 消费位点 + 至少一次投递 + 注入幂等。**

三个中断时机各有确定答案:

1. **发送中崩**:append-only jsonl 单行一次 write+flush;行不完整跳过(从根上回避 Claude Code 整文件 JSON 一条脏数据卡死收件箱的教训);
2. **在箱无人收**(投递后、消费前崩):收件箱在磁盘;执行体死了消息留着,重拉时消费(对应 Claude Code「给已停 teammate 发消息原地拉活」语义,本设计统一到恢复流程);
3. **消费中崩**:**位点不单独记,跟 journal 走**——「消息 X 注入了某执行体的回合」本身就是一条 journal 事件,注入与回合执行在同一个 append 边界;崩溃在中间 → journal 无注入记录 → 恢复重放收件箱会再注入一次。

至少一次 + 幂等而非精确一次:消息注入的是上下文不是副作用,重复注入的最坏结果是模型看到两遍(dedupe ID 供渲染层去重);精确一次需要事务级复杂度,单机产品过度设计。

### 7.4 执行体恢复:回合边界 checkpoint

- 回合边界是天然 checkpoint(每完成一轮「模型调用 + 工具执行」历史落 journal);
- **回合边界崩溃 → 续跑**(从上个回合边界 history 拉起,重跑被截断回合);
- **回合中间崩溃 → 该回合作废重跑**——与消息投递的「至少一次」语义统一:回合是恢复的最小单位,回合内不留半成品状态(副作用靠工具幂等性兜底,与主链 resume 面对同一问题);
- **claimed 任务的处置**:恢复时凡 journal 里无「回合完成」记录的 claimed 任务,先回 `pending`,由 lead(或执行体重拉后重新 claim)决定是否接续——保守回池 + 允许重接,不自动续跑(断点处世界可能已变)。

### 7.5 恢复流程总览

```
崩溃恢复:
  1. 重放 teams/{id}/events.jsonl → 任务板
  2. 每执行体:重放其 journal fork scope → 消息消费位点 + 回合边界
  3. 收件箱从位点之后重放 → 未消费消息注入下一回合边界
  4. 执行体按任务板状态重新拉起;无完成记录的 claimed 任务回 pending
```

一句话:**任务从事件流恢复,消息从位点恢复,执行体从回合边界恢复——全部是 journal/append-only 重放,没有任何需要修复的中间态。**

### 7.6 验收(硬性)

任务板/收件箱/执行体三层,**kill -9 任意时刻**,重启后任务列表完整、消息不丢、claimed 任务安全回池,全程无需人工修状态。用一个崩溃注入测试(随机时刻 kill + 恢复断言)守门。

---

## 8. 外部执行体接入

### 8.1 最小契约

| 契约 | 必须 | 说明 |
|---|---|---|
| 接活(收任务 spec + 上下文切片) | 是 | stdin / prompt 参数 |
| 交活(结论 + done/failed) | 是 | 结构化输出 |
| 可见性(进度事件流) | 否 | 无 → 降级黑盒(UI 显示「运行中(外部)→ 结论」) |
| 控制(停止信号) | 否 | SIGTERM |

首个适配目标:**claude code headless**(`claude -p --output-format stream-json`,支持系统提示词注入、`--allowedTools`、权限模式、usage 事件)。适配器 = spawn 子进程 → stream-json 翻译成 SessionEvent → 结论取 result → 停止 = SIGTERM。**事件翻译是精髓**:外部执行体的进度经适配器进入统一事件面后,TUI/GUI/journal/崩溃恢复对内外执行体完全无感——**协调与观察层统一,执行层异构**。

### 8.2 控制语义降级清单(显式接受)

| 语义 | 内部执行体 | 外部 CLI 执行体 |
|---|---|---|
| pause-cascade | 回合内信号级联 | 只能 SIGTERM,粒度 = 进程,无原地续跑 |
| 预算计量 | 事件级 token 精确累计 | 粗粒度:对方 usage 事件(有则翻译,无则 deadline 兜底) |
| 工具面收窄 | `deriveChildRegistry` 程序化 | 翻译成对方 flags(`--allowedTools`),各方方言 |
| guardrail/approval | 全链管辖 | 管不到对方内部;**任务 gate、产物审批、文件写权限留在本侧** |

信任纪律:外部执行体产出的东西,关键节点用内部执行体复核(外部写码、内部 review),做成任务的信任标注。

### 8.3 能力匹配与可替换性

任务标注「需要主链上下文」(fork-only)或「自包含」(任意执行体);fork 型 subagent 不进可重派池——**只要带主链上下文的执行体混进可重派任务池,外部执行体就永远接不了那些任务**;spec 自包含是可替换性的前提(此前为 token 经济性做的决策在此兑换为通用性)。

对称性(低成本加分):sunshinex 自身输出 stream-json 风格 headless 接口(已有 headless asker 桩与 daemon 接缝),可反过来被其他编排器使用。

---

## 9. 上下文构造与缓存稳定性

### 9.1 三条铁律 + 三层形状

铁律:① append-only,永不重写(任何位置一字节变动,从该点起全部重算);② 稳定度分层递增,越易变越靠后;③ 易变元数据(时间戳/token 计数/状态行)进 journal/事件面,**不进 prompt**。

```
[L0 固定层]  system = role/agent.md + 工具面(排序冻结)
[L1 半固定层] fork: 主链快照@对齐点 | teammate: 任务板结构摘要 | 外部: spec 模板头
[L2 易变层]  task spec / inbox 消息 / 拉取结果 —— 一律尾部追加
```

三类执行体差异只在 L1 装什么;L0/L2 纪律相同,缓存布局逻辑在 Executor 适配器做一套、三实现共用。

### 9.2 动态 fork

现有 seedHistory 组装顺序(快照 → role 行 → memory 行 → task 行,`subagent.ts:390-396`)恰好稳定度递增,已是前缀友好形状。补三条:

1. **快照不裁剪、不重排**:主链 append-only 时,后 spawn 的 fork 链式命中先 spawn 的缓存前缀加增量;取舍为「链式命中 > 单次裁剪省的 token」;真要省,裁剪点按消息条数分档对齐,同档互相命中;
2. **同层并行 fork 统一快照点**(§5.7 批量派发):整层首次请求前缀一致,一份缓存全员命中;逐个快照各异的派发是缓存最差形态;
3. **压缩时机 = 空闲或层边界**:压缩重写历史 → 前缀断裂;规则:**有待决 fork 派发或层执行中不压缩**;压缩点记进 journal,rewind/恢复时知道缓存从哪断。

### 9.3 预定义 teammate

- **agent.md 装配期冻结** → L0 全生命周期字节稳定,每回合全量命中;
- 任务板**推摘要 + 拉详情**(§6 L1 注入方式),禁止重写历史头部;
- **inbox 回合边界投递是缓存友好的另一面**:消息 append 为新 user 消息,前缀纹丝不动;
- **结论回写 lead 走既有「终态一行」**(`subagent.ts:441` 的 `[label] firstLine(reply)`),全文进 artifact、lead 按需工具拉取——主链保持 append-only 增长,机制现成。

### 9.4 外部执行体

- 缓存主权在对方;本侧只控 **spec 模板稳定**:同一 role 多次调用,模板头(agent.md/角色说明)字节固定,任务变量全在尾部——模板稳定性直接决定对方缓存命中率;
- 外部执行体的翻译事件只进 TUI/journal,不构成任何模型请求,对本侧主链缓存零影响;
- 成本模型明示:外部执行体不共享本侧任何缓存,每次调用独立上下文。

### 9.5 工程检查表(进 PR 检查项)

1. **工具面字节稳定**:`deriveChildRegistry` 收窄结果确定性排序(禁无序集合直出)——同一执行体多回合间工具定义差一字节,L0 缓存全失;
2. **rewind 是显式缓存例外**:rewind 本来就重算;rewind 后重新派发走批量快照点机制重新对齐;
3. **cache 断点放置**(cache_control 语义):L0 一断点、L1 一断点、活跃对话尾部一断点,与三层形状对齐;
4. **TTL 取舍**:主链等 teammate 超过缓存 TTL 后前缀重算,**默认接受,不做心跳保活**——心跳保缓存但持续烧钱,仅「主链前缀极长且 lead 回合极频繁」组合下值得,做成配置项;
5. **元数据走事件面不走 prompt**:任务状态/usage/耗时留在 SessionEvent/journal(铁律 ③ 的执行面,写进事件 schema 约定)。

---

## 10. TUI 交互设计(含 GUI 投影约束)

### 10.1 产品形态

**一个 lead 指挥面 + 一个资源面**:用户永远只跟 lead 说话(自然语言,主链零改动);team 对用户是可观察、可插手的资源。

| 层 | 用户做什么 | TUI 载体 | 现有基础 |
|---|---|---|---|
| 指挥 | 对 lead 下目标/裁决 | 输入框 | 主链,零改动 |
| 观察 | 看谁在干什么、干到哪 | 面板行 → Enter 全屏转录;Ctrl+T 任务板 | ChildPanel / ChildInspector / Ctrl+B |
| 干预 | 越级:对 teammate 发消息、停掉、转派任务 | 转录页内发消息、`x` 停止、任务板转派 | stopChild 语义已有 |

### 10.2 正交性的 UI 投影:两视角互跳

- 面板 = 执行体视角(这个人在干什么任务);Ctrl+T 任务板 = 任务视角(这个任务被谁接着);
- 两边 Enter 都落到同一段转录——任务/执行体不正交,这两个视图不可能同时成立;
- 任务行支持**转派**(teammate 卡死 → 任务回池 → lead 重派/自接)——正交化直接兑换的能力。

### 10.3 Ctrl+T 任务视图

三列(任务/状态/owner),依赖以文字呈现(「等 #3 #5」),gate 挂起显示为**行内审批行**(复用现有 approval 管线与 `AskUserSeam`);**不做终端 DAG 图**。外部黑盒执行体降级显示「运行中(外部)→ 结论」。

### 10.4 GUI 投影约束(硬边界)

1. 交互原语定义在事件/状态层,TUI 快捷键只是绑定:每个交互都能描述为「作用于哪个域对象 + 发射/订阅哪个事件」,不提终端概念——Ctrl+T 在 GUI 是侧栏看板,Enter 是点击详情;
2. 终端格式不渗进状态:新增委派/任务状态是结构化数据,渲染(ANSI/DOM)永远是订阅侧派生物(现有 ChatItem 带 ansi 预渲染、归档序列化文本行是历史债,GUI 从事件/journal 重新派生);
3. 控制语义做成协议而非按键:pause-cascade、gate resume、stop 的语义在事件面有一等表达,GUI 不重造生命周期逻辑。

GUI 侧映射:任务列表 → 看板;dependsOn → DAG 图自动推导(teammate/执行体 → 侧栏)——即 ROADMAP 5B「任务委派式看板(GUI v2)」。

---

## 11. 事件面扩展

`SessionEventType`(`src/types.ts:259`,TUI/GUI 公共事件面)新增:

```
task-created | task-status-changed | task-unlocked | task-blocked
delegation-started | delegation-ended     # 载荷带 taskId、teamLabel、executorKind
gate-waiting | gate-resolved              # 或复用既有 approval-* 事件
agent-message                              # P2,L2 层
```

约束:payload 结构化(禁 ANSI/预渲染字符串,吸取 §10.4-2 的债);全部进 journal;委派投影(P0)与 TUI 现有 `payload.subagent` 打标分流兼容——`src/tui/session.ts:1051-1057` 的 onEvent 单点扩展一路分支,不动主链路径。P0 口径:delegation-* 为会话瞬态不落 journal(归档回看面仍是消息区 SPAWN 行),journal 化随 P1 teams 目录 event sourcing 落地;teamLabel/executorKind 为 P1+ 词汇,P0 载荷未携带。

---

## 12. 与现有体系的关系

### 12.1 GraphEngine 降级为模板宏

- `src/graph/templates.ts` 静态模板展开成**带依赖的任务集**注入 TaskBoard,后续走统一调度;`pipeline` CLI 与 selfcheck **零迁移**;
- 一份调度核心、两种入口(模板预填 / 模型动态建),消灭「两套平行编排」断层;
- **器官移植清单**(不是丢弃):Kahn 环检测(`engine.ts:79`)→ `set_dependency` 加边检查;gate 三态 + `resume(approvals)`(`engine.ts:186-196`)→ 任务审批暂停/恢复;三级预算贯通 → team 帽(§5.6)。

### 12.2 subagent(fork 型)保留,不合并

- 上下文连续性优先场景(并行探查)的正解;终态一行回写 + 归档回放机制现成;
- **不进可重派任务池**(§8.3):fork 带主链上下文,进池即破坏任务可替换性。

### 12.3 LoopEngine 不动;依赖方向不变

graph → loop → harness 单向依赖保持;模板宏展开发生在 graph/编排侧,LoopEngine 仍是 loop 节点(任务)的执行底座。

### 12.4 文档纪律

阶段三报告的 workflow.ts/ci 漂移是前车之鉴:本 spec 引用的代码行号以 2026-10-04 dev1 分支为准,实施时如行号漂移以语义锚点(函数/注释)为准;spec 与代码的同步责任归实施 plan 的执行回写。

---

## 13. 阶段路线(P0-P3)

> 与 ROADMAP 映射:P0-P2 是阶段五 5A 的编排深化特性线;P3 即 5B GUI 事件面消费的协议前置。每阶段独立交付,无大爆炸重写;**实施 plan 按阶段分册,一阶段一 plan**。

### P0 可见性(先行,不改任何执行语义)

- 事件面扩展(§11)+ 统一委派投影(§4.5);ChildPanel/Ctrl+B 改为消费投影;
- GraphEngine 在既有 `hooks.onNodeEnd`/`deps.onEvent` 透传点发射 delegation 事件(消除「Graph 层不发 SessionEvent」的断层,模板宏化前的过渡接线);
- **验收**:GraphEngine 节点进度事件经 `deps.onEvent` 可订阅(单测断言事件序);TUI 内 spawn/后台任务呈现统一走委派投影、现有行为回归不破(既有 session.subagent-* 测试全绿);一个最小 GUI 原型订阅事件流能列出任务/委派。

> **落地记录**:P0 已交付(`329210f`/`41a41f9`/`f0a3d12`/`c5773be` 四笔,git log `feat(delegation)`/`feat(graph)`/`feat(harness)`/`feat(tui)`)——事件面词汇就位、GraphEngine/Runner 双端发射、TuiState.delegations 投影 + 并集选择器过渡接线;「ChildPanel/Ctrl+B 改为消费投影」以并集口径落地(合成事件测试路径保绿),投影单源收敛随 P1 TaskBoard。

### P1 TaskBoard 核心

- 域模型 + team 目录 event sourcing(§7.2)+ lead 工具五件套 + harness 强制状态回写(§5.4)+ 依赖环检测;Executor/Inbox 接口定型(实现只有内存/内部);teammate 先用现有 subagent fork 模式顶替(每任务一 spawn);
- **验收(硬)**:§7.6 的 kill -9 崩溃注入测试通过;lead 建任务+依赖按解锁顺序执行;resume 后任务列表完整可续跑。

### P2 teammate 长驻 + 外部执行体

- internal-team 执行体(独立 context + 任务队列 + 自主 claim)+ external-cli 适配器(claude code stream-json)+ Ctrl+T 任务视图 + agent-message(L2,可选最后加);
- **验收**:3 个 teammate 消化 6+ 任务,预算帽触发时优雅排队;外部执行体经事件翻译在面板/任务板上与内部无感同现。

### P3 = 5B GUI 事件面消费

- GUI 订阅统一事件面:任务列表 → 看板,dependsOn → DAG 图自动推导,teammate → 侧栏;无任何需要「翻译」的 TUI 概念。

---

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| token 线性放大(多执行体) | team 预算帽 + artifact 引用(结论全文不进 lead 上下文)+ L1 推摘要拉详情 |
| 模型滥建任务/建依赖环 | `create_task` 限流 + `set_dependency` Kahn 环检测 fail-fast |
| 外部进程不确定性污染核心 | 外部执行体 P2 才引入,P1 验收(崩溃恢复)不混入外部变量 |
| 缓存断链(压缩时机不当) | §9.2-3 压缩纪律进 PR 检查表;压缩点记 journal |
| 状态滞后阻塞下游 | harness 强制回写(§5.4),不依赖模型自觉 |
| spec/代码漂移 | §12.4 文档纪律;行号漂移以语义锚点为准 |
| 任务板事件风暴拖慢 TUI | 沿用 80ms 节流 notify 机制;任务事件聚合后投渲染 |

---

## 15. 决策记录(六轮讨论取舍汇总)

| # | 决策 | 放弃的替代 | 依据 |
|---|---|---|---|
| D1 | 动态拓扑载体 = 任务列表 + 依赖,非可变图对象 | 运行期 addNode/改图 | 改图牵动分层/resume/skip 全复杂度;任务变更是纯增量事件,可审计可回放;与 Claude Code 实践互证 |
| D2 | L2 消息 P2 交付、架构占位现在留 | 首版即全员互聊 / 永不互通 | 互不通信的 team ≈ 批量 subagent(差异化消失);但全互联 = token 爆炸 + 协调混乱;分层交付 |
| D3 | harness 强制状态回写 | 模型自觉标记 | preempt Claude Code「状态滞后」官方坑;单进程可 hook 生命周期的结构优势 |
| D4 | GraphEngine 降级模板宏,器官移植 | 保留独立执行路径 / 直接删除 | 一份调度核心两种入口;pipeline/selfcheck 零迁移;消灭平行编排断层 |
| D5 | 上游 failed 标 blocked 等 lead 裁决 | 自动 skip 传播 | 交互场景需人裁决;CI 语义留在模板宏模式 |
| D6 | TUI 不做 DAG 图,做 Ctrl+T 任务视图 | 终端画 DAG | 终端网格画图是负资产;GUI 从 dependsOn 自动推导(ROADMAP v2 本就后置) |
| D7 | 单进程内存协调,不走文件 mailbox | 复刻 Claude Code 文件收件箱 | 文件 mailbox 是多进程被迫;落盘仅为持久(event sourcing),协调走内存 |
| D8 | 至少一次 + 注入幂等,非精确一次 | exactly-once 投递 | 注入的是上下文非副作用;精确一次需事务级复杂度,过度设计 |
| D9 | 回合边界投递消息,非实时中断 | mid-turn 注入 | 原子性/位点简单 + 缓存前缀稳定,双理由同向 |
| D10 | 任务/执行体正交,任务可重派可恢复 | 维持 1:1 焊死 | 重派、resume、派发策略可插三个能力的前提;UI 两视角互跳的来源 |
| D11 | fork 型 subagent 保留且不进可重派池 | 统一为 teammate | 上下文连续性场景正解;进池即破坏外部执行体可替换性 |
| D12 | 外部执行体经事件翻译进统一事件面 | 为外部单独做 UI/通道 | 协调观察统一、执行异构;TUI/GUI/journal 对内外无感 |
| D13 | 不上 A2A/MTP | 标准协议优先 | 单机产品,子进程 + JSON 流够用;Executor 抽象保留换实现不换语义 |
| D14 | 三层上下文形状 + append-only 纪律 | 各执行体各自拼 prompt | 缓存命中最大化;一套布局逻辑三实现共用;多轮决策(回合边界/agent.md 冻结/spec 自包含)在此收敛 |
| D15 | 快照不裁剪、同层批量快照点、压缩避活跃期 | 逐 spawn 快照 + 活跃期压缩 | 链式缓存命中 > 单次裁剪节省;压缩断链代价集中到空闲期 |
| D16 | TTL 默认不心跳保活 | 定时空 ping 保缓存 | 心跳烧钱;仅长前缀高频回合组合值得,做配置项 |

**既有用户裁决(继承,不重开)**:pause-cascade 父停子随停(2026-10-02);停单子不连带主链(2026-10-02)。
