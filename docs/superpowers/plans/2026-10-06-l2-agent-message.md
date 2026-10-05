# L2 Agent-Message 批次 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付多 Agent 编排的 L2 消息层:FileInbox 落盘收件箱、send_message 双面工具、teammate 回合边界注入、TUI 即时呈现——编排 spec 自此除 P3-GUI 外全部实现。

**Architecture:** FileInbox 实现 P1 定型的 `Inbox` 接口(append-only jsonl + torn-skip + ts 位点),落 `teams/main/inbox/<agent>.jsonl`;`send_message {to, text}` 单名双面注册(主链面 lead→teammate、teammate 面 teammate→任意),发送 = FileInbox.send + `agent-message` 事件;**投递双轨**:teammate 侧回合边界注入(worker 每轮 execute 前 poll 自己收件箱、按 `msg:<id>` 前缀查链去重后 appendChain note 行——§7.3 四件套的注入幂等),lead 侧事件即时呈现(TUI agent-message 分支 → system 行)。

**Tech Stack:** TypeScript (tsc strict)、node:test、ink、无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§6 L2 层、§7.2 inbox 布局、§7.3 四件套、§9.3 缓存友好注入、§11 agent-message 词汇;P2 落地记录裁定「随 P3 前置」)。

## Global Constraints

- tsc strict 零报错;`pnpm test` 0 败(2 既有 win32 跳过容忍)——全量门禁仅 T5 控制器后台执行(看门狗 600s 协议沿用:逐任务聚焦,单命令 ≤8min)。
- 不破坏 P0-P2 既有行为;受保护测试零改动。
- 事件 payload 结构化禁 ANSI;`agent-message` 载荷口径:`{ messageId: string, from: string, to: string, text: string }`(text 帽 4000,超长发送端拒)。
- 注释中文决策风格;模型面文案英文。
- `agent.jsonl` 损坏行跳过(TeamStore.load 同款韧性);目录惰性建档。

## Rulings(计划级)

1. **guardrail 深度**:send_message 校验 = to ∈ (活 teammates ∪ 'lead')、text 非空 ≤4000;「子不能代父批」由既有工具面收窄结构性保证(payload 仅 text,无审批语义);注入内容深检记 deferred(P3 复核)。
2. **teammate 位点持久化**:cursor 内存态 + 注入前按 `msg:<id>` 链前缀去重(至少一次 + 幂等;重启重放不双显)。
3. **lead 投递轨**:事件即时呈现(chat 面板本就用户回合制,等价于回合边界)+ inbox 落档;CLI/headless 场景 lead inbox 只积累(P3 GUI 消费),记为裁定。
4. **external 执行体无 inbox**(P3+;send_message to 校验不含 external)。

---

### Task 1: FileInbox(src/taskboard/file-inbox.ts)

**Files:**
- Create: `src/taskboard/file-inbox.ts`
- Test: `src/taskboard/file-inbox.test.ts`

**Interfaces:**
- Consumes: `Inbox`/`AgentMessage`(src/taskboard/inbox.ts,P1 定型:`send(to, msg: Omit<AgentMessage,'id'|'to'|'ts'>): Promise<AgentMessage>`、`poll(agent, since): AgentMessage[]`)
- Produces(T2/T3 依赖): `class FileInbox implements Inbox { constructor(inboxDir: string); send(to, msg): Promise<AgentMessage>; poll(agent, since): AgentMessage[] }` —— 落盘 `<inboxDir>/<agent>.jsonl`(惰性 mkdir、单行 appendFileSync、id `m<seq>` 进程内单调 + ts `max(clock+1, Date.now())` 严格单调(MemoryInbox 同款);poll = 逐行重放过滤(to 匹配 + ts 严格大于 + 损坏行跳过);**id 唯一性跨重启**:seq 初始化 = 重放现有最大 id 序号(防重启撞 id)

- [ ] **Step 1: 失败测试**:send/poll 往返(to 隔离/位点严格大于);尾行截断跳过(写半行 + 完好行,load 语义);跨重启 id 不撞(新实例 send 的 id > 旧最大);ts 严格单调。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(MemoryInbox 语义 + fs 化;send 先 ensureDir;poll try/catch ENOENT 回空)
- [ ] **Step 4: 跑测** `pnpm build && node --test dist/taskboard/file-inbox.test.js dist/taskboard/inbox.test.js`
- [ ] **Step 5: 提交** `feat(taskboard): FileInbox——inbox/<agent>.jsonl append-only 落盘(torn-skip/跨重启 id 不撞/ts 严格单调),实现 P1 Inbox 契约(§7.2/§7.3)`

### Task 2: send_message 双面工具 + agent-message 事件 + TUI 呈现

**Files:**
- Create: `src/taskboard/message-tools.ts`
- Modify: `src/harness/index.ts`(构造 FileInbox 于 `<dataDir>/teams/main/inbox`;主链面注册 send_message)
- Modify: `src/taskboard/teammate-tools.ts`(teammate 派生面注册 send_message)
- Modify: `src/tui/session.ts`(onEvent 增 agent-message 分支 → pushMsg `[from → to] text` system 行)
- Test: `src/taskboard/message-tools.test.ts`、`src/tui/session.message.test.tsx`

**Interfaces:**
- Consumes: FileInbox(T1)、RegisteredTool 形态、TaskBoard.summaryLines 无关
- Produces(T3/T4 依赖):
  - `makeSendMessageTool(deps: { inbox: FileInbox; onEvent?: (e: SessionEvent) => void; knownRecipients: () => string[]; from: () => string }): RegisteredTool`——name `send_message`,parameters `{to: ['string','null'], text: ['string','null']}` required 全,category `'task'`,英文 description;executor:校验 to ∈ knownRecipients() ∪ {'lead'}、text 非空 ≤4000(违者 CodedToolError INVALID_ARG)→ `await inbox.send(to, { from: from(), text })` → emit `agent-message {messageId, from, to, text}` → 回执 `message <id> delivered to <to>`
  - knownRecipients 由注入点供:主链面 `() => this.team.aliveNames()`;teammate 面 `() => [...'lead', ...this.team.aliveNames()]`(经 registryFactory 闭包——teammate-tools 需 team 引用,deriveTeammateRegistry 签名扩 `(base, board, team?: { aliveNames(): string[] })`)
  - `Harness` 新增 `readonly inbox: FileInbox`

- [ ] **Step 1: 失败测试**:工具三态(合法投递→FileInbox 落盘+事件载荷精确;未知 to 拒;超长拒);TUI:onEventForTest 喂 agent-message → 消息区 system 行含 `[w1 → lead] hi`;teammate 面注册后 `get_board/get_task/send_message` 三件在场、五件套不在场。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(三处注册/装配)
- [ ] **Step 4: 跑测 + 回归** `node --test dist/taskboard/message-tools.test.js dist/tui/session.message.test.js dist/harness/teammate-spawn.test.js dist/harness/tools/taskboard-tools.test.js`
- [ ] **Step 5: 提交** `feat(taskboard): send_message 双面工具——主链面 lead→teammate、teammate 面任意定向;FileInbox 装配;agent-message 事件;TUI 即时呈现(lead 投递轨=事件+落档,Ruling 3)`

### Task 3: teammate 回合边界注入

**Files:**
- Modify: `src/taskboard/teammate.ts`(TeammateDeps 增 `inbox?: Inbox`;worker 每轮 execute 前 `drainInbox()`)
- Modify: `src/harness/index.ts`(teammate 构造注入 inbox)
- Test: `src/taskboard/teammate.test.ts` 扩

**Interfaces:**
- Consumes: Inbox(T1/T2)、Teammate own context(P2)
- Produces: `Teammate` 私有 `drainInbox(): number`——`poll(name, lastTs)` 逐条:按 `msg:<id>` 前缀扫 own chain(`chainView()` 线性扫,P1 链长量级可受)去重后 `appendChain([{ action: 'note', observation: \`msg:<id> [message from <from>] <text>\` }])`;更新 lastTs;返回注入条数。调用点:worker 循环每轮 execute() **之前**(含 runTask 指派路径与 claim 路径统一入口)。

- [ ] **Step 1: 失败测试**:teammate 空闲期 inbox.send 两条 → kick → 首个任务的 own chain(测试经注入 fake inbox 或真 FileInbox)含两行 `msg:mN [message from lead] …`;重复 poll(kick 两次)不双注入;teammate 未配 inbox(缺省)零行为变化。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(Ruling 2:cursor 内存 + 链前缀去重;消息行在 task 行之前 append——回合边界语义)
- [ ] **Step 4: 跑测 + 回归** `node --test dist/taskboard/teammate.test.js dist/taskboard/board.test.js`
- [ ] **Step 5: 提交** `feat(taskboard): teammate 回合边界投递——worker 每轮前 drainInbox(msg-id 链去重,至少一次+幂等 §7.3);消息行前缀不动(§9.3 缓存友好)`

### Task 4: e2e 双向消息

**Files:**
- Test: `src/harness/message.e2e.test.ts`(零产品码)

- [ ] **Step 1: 测试**:真 Harness + 真 FileInbox(tmp)——①lead→teammate:spawn w1(mode team)→ 主链经真工具面 `send_message {to:'w1', text:'prioritize tests'}` → create 任务 → w1 消化 → 断言 w1 的执行(经事件流/或任务结论)可见消息行(检查 delegation 转录事件流含 `msg:m` 行,或断言 inbox 文件已消费位点推进+链去重——取事件流断言更直接);②teammate→lead:计数 fake model 的 teammate 面发 `send_message {to:'lead'}`(脚本化:teammate 的首任务 spec 指示其调用 send_message——fake model 需支持工具循环,改用**真 ScriptedAdapter 给 teammate?teammate 共享 harness model**——简化裁定:teammate 面的工具执行不经 fake model 驱动,改为**直测工具**:deriveTeammateRegistry 取出 send_message 工具以 from='w1' 执行 → 断言 lead inbox 文件 + agent-message 事件 + TUI 行(session.message 测试已覆盖,此处断言事件与文件)。清理 stopAll。
- [ ] **Step 2: 跑测** `pnpm build && node --test dist/harness/message.e2e.test.js dist/taskboard/teammate.test.js`
- [ ] **Step 3: 提交** `test(harness): L2 e2e——lead→teammate 回合边界注入可见;teammate→lead 落档+事件(§6 L2 双轨)`

### Task 5: 全量回归 + spec 回写(控制器执行)

- [ ] `pnpm test` 后台跑(0 败/2 既有跳过);`pnpm selfcheck`
- [ ] spec §13 P2 落地记录后追加 L2 批次记录(提交可溯 + 四项 Ruling);提交 `docs(spec): L2 agent-message 执行回写——编排子系统除 P3-GUI 外全量实现`
