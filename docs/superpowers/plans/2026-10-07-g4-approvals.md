# G4 审批问询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 GUI 审批问询闭环:daemon 挂起表 + WS approval/ask/reset 帧 + HTTP 回执端点 + manual 模式接线;GUI 卡片与回执;并落地 G3.5 终审交接清单(新会话 journal 持久化+chain 派生转录、会话 delete、reset 通知、SnapshotMessage 对齐、Home 竞态守卫)。

**Architecture:** 挂起表为 daemon 级单表(`Map<pendingId, PendingEntry>`),entry 携 sessionId;asker/onAskUser 接缝在 SessionRuntime 装配时注入(manual 模式会话才有);帧 `{kind:'approval'|'ask', sessionId, req}` 无 seq(挂起面,既有裁定),**连接建立/重连时重发全部未决挂起**(spec §4.2 既定);回执 `POST /approval/:pid {decision}` / `POST /ask/:pid/reply {answer}`。中断语义沿 TUI 先例:挂起审批按 deny 回填。交接清单:新会话 createSession 即挂新 journal(链持久),attach 播种增 chain 派生转录(msg 缺席时兜底);`POST /session/:id/delete`;reset 发 `{kind:'reset', sessionId}` 帧;GUI 随帧清投影。

**Tech Stack:** TypeScript strict(主仓+gui)、React 18、vitest、既有 ws。

**Spec:** `docs/superpowers/specs/2026-10-06-gui-v1-design.md`(§4.1 端点、§4.2 帧、§12 G4;G3.5 终审交接清单)。

## Global Constraints

- 主仓 tsc strict 零报错、`pnpm test` 0 败(全量门禁仅 T4 控制器后台);gui typecheck+test 绿;看门狗 600s 协议(逐任务聚焦,单命令 ≤8min)。
- approval/ask 帧无 seq(挂起面);event/reset 帧带 sessionId(event 帧已有 seq 不变)。
- 事件 payload 结构化禁 ANSI;req 序列化只取纯数据字段。
- 注释中文决策风格;受保护测试零改动(session.test 族语义不变)。
- ApprovalDecision/AskUserAnswer 类型以 `src/types.ts` 现场为准(实现者核对后按实际字面引用,不臆造)。

## Rulings(计划级)

1. **挂起表 daemon 级**(非每会话):pendingId 全局唯一(req.id 形态 `ap-N`/ask 的 id 形态现场核);entry `{kind:'approval'|'ask', sessionId, req, resolve}`;回执后广播一条**事件帧** `notice`(「审批已裁决/问询已答复」——转录可见,粗归档面),不发明新事件型。
2. **manual 模式会话级**:`createSession(root, opts?: {mode?: 'dontAsk'|'manual'})`——manual 时 SessionRuntime 装配注入 onApproval/onAskUser 两接缝(挂起表闭包);缺省 dontAsk(G3.5 行为零变化);serve CLI `--manual` flag 预选时传。
3. **中断=deny 回填**(TUI approval.ts 先例):interrupt 端点处理时,该会话全部未决 approval 以 deny 回填、ask 以 dismissed 回填;daemon close(teardown)同构清表。
4. **重连重发未决**:WS 连接建立(补发事件缓冲后)追加发送当前全部未决挂起帧(无 seq,GUI 以 pendingId 去重——同帧可能到达两次,幂等)。
5. **chain 派生转录**(交接 a):attach 播种顺序 = msg 行条目优先,**其后追加 chain 行派生条目**(msg 覆盖同内容的去重?**简化裁定:msg 条目在前、chain 派生在后,不去重**——attach TUI journal 时 msg 已含显示面,chain 派生条目会重复?**再裁定:仅当 msg 行计数为 0(daemon 会话 journal)才做 chain 派生**——TUI journal msg 在场则跳过,零重复);chain→条目映射:instruction/task 行→user、reply→assistant、tool-call+tool-result 按 step 配对→tool、note/notice→notice。新会话 createSession 即 `attachJournal(新 SessionJournal)`——首 run 起链持久。
6. **delete 端点**:`POST /session/:id/delete`——running 409;teardown 该会话(有界)后移出注册表;active 指针若指向它则清空;**journal 文件不删**(数据保留,Home 仍可再 attach)。GUI Home 会话行加 Delete。
7. **reset 帧**:`{kind:'reset', sessionId}`(无 seq)——GUI Chat 收到即清本地投影并重播种(sessionSnapshot);connection 层透传新回调 `onResetSession(sessionId)`(与连接级 onReset 区分:连接级清基线 Map,会话级只清单会话投影)。

---

### Task 1: daemon 挂起表 + approval/ask/reset 帧 + 回执端点 + manual 接线

**Files:**
- Modify: `src/serve/daemon.ts`(挂起表/帧/端点/createSession opts/close 清表)、`src/serve/session.ts`(mode opts + 接缝注入点暴露)
- Modify: `src/cli/commands/serve.ts`(--manual)
- Test: `src/serve/daemon.pending.test.ts`(新)、`daemon.ws.test.ts`(扩帧)、`session.test.ts`(mode 透传)

**Interfaces:**
- Consumes: `createRuntime` opts(onApproval/onAskUser/mode)、SecurityGuard.setAsker 既有链、ApprovalRequest/ApprovalDecision/AskUserRequest/AskUserAnswer(types.ts 现场核字面)
- Produces(T2/T3 依赖):
  - `GuiDaemon.createSession(root: string, opts?: { mode?: 'dontAsk' | 'manual' }): Result<{sessionId}>`(manual 时 session 装配注 asker=挂起表闭包:approval → `new Promise(res => pending.set(req.id, {kind:'approval', sessionId, req, resolve: res}))` + 广播帧;resolve 即回执值;ask 同构 dismissed 桩退役)
  - 挂起表:`private pending = new Map<string, PendingEntry>()`;`broadcastPending(conn)`(重连重发)
  - `POST /approval/:pid {decision: ApprovalDecision}` → resolve + notice 事件帧 + 200;未知 pid 404;**重复回执**(已 resolve)404
  - `POST /ask/:pid/reply {answer: AskUserAnswer}` → 同构
  - interrupt 端点 + teardown:该会话未决 approval→deny、ask→dismissed(裁定 3)
  - reset 端点追加发 `{kind:'reset', sessionId}`
  - WS 帧:`{kind:'approval'|'ask', sessionId, req}`(req 纯数据字段直序列化——含 id/kind/subject/reason 或 question/options/multiple/allowCustom,现场核)

- [ ] **Step 1: 失败测试**——pending.test:manual 会话 + ScriptedAdapter 触发 write 工具(manual guard preToolUseAsync 挂起)→ WS 收 approval 帧(sessionId/req 字段)→ POST /approval/:pid {decision} → run 继续(done 事件)→ notice 帧在场;ask 同构(ask_question 工具触发?**用 onAskUser 接缝直接测**:manual session 装配后测试侧手动调接缝?接缝在 runtime 内部——经 /goal 走 ask_question 工具路径太深,**裁定**:ask 路径经 createRuntime opts.onAskUser 注入的接缝,测试用 HangingAdapter+手工触发不可达时,降级为端点级测试(预置挂起条目经内部 API?不可——测试经真实链路:manual + 模型卡发 ask_question envelope → 工具执行走 onAskUser → 帧)。interrupt-deny:挂起中 POST interrupt → approval 以 deny 回填(run 继续/工具被拒观察行)。重连重发:挂起中断连重连 → 帧再至。404 双路。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **[ ] Step 4: 跑测** `pnpm build && node --test dist/serve/daemon.pending.test.js dist/serve/daemon.test.js dist/serve/daemon.ws.test.js dist/serve/session.test.js`
- [ ] **Step 5: 提交** `feat(serve): 审批问询挂起面——daemon 级挂起表(manual 会话接缝注入)+WS approval/ask 帧(重连重发)+HTTP 回执端点+interrupt/teardown deny 回填+reset 通知帧+createSession mode opts/--manual`

### Task 2: 新会话 journal 持久化 + chain 派生转录 + delete 端点

**Files:**
- Modify: `src/serve/daemon.ts`(createSession 挂新 journal;delete 端点;teardownAll 处决——**删除死代码**或消费:裁定删除,G3.5 终审)、`src/serve/session.ts`(chain 派生播种逻辑挂 attach)
- Test: `src/serve/daemon.workspace.test.ts`(扩)、`session.test.ts`(扩)

**Interfaces:**
- Consumes: SessionJournal 族(新建实例形态现场核 tui/session-journal 导出)、reduceJournal chain 行结构
- Produces(T3 依赖):
  - createSession:`new SessionJournal(resolveDataDir(root))` 新档 + attachJournal 挂载(首 run 起链持久)——**新档 id**:SessionJournal 构造签名现场核(TUI newSessionId 先例)
  - chain 派生:`chainStepsToEntries(steps: StepRecord[]): TranscriptEntry[]`(映射见 Ruling 5;**仅当 msg 行计数===0 时追加**)挂进 attach 播种路径
  - `POST /session/:id/delete`:running 409;有界 teardown → 移出表;active 指向则清;journal 文件保留;GUI Home 消费(T3)
- [ ] **Step 1: 失败测试**——workspace 扩:①新会话 submit 一轮 → journal 文件出现(chain 行);Home 侧 /sessions?root= 列出该会话;attach 重开 → snapshot messages 非空(chain 派生:user instruction+assistant reply 在场)。②TUI journal(msg 在场)attach → 无重复(msg 优先,chain 派生跳过)。③delete:idle 会话删→列表消失/再 :id 404;running 409;journal 文件仍在。
- [ ] **Step 2/3/4** 聚焦:daemon.workspace + session + daemon.pending + contract
- [ ] **Step 5: 提交** `feat(serve): 会话持久化与回收——createSession 即挂新 journal(链持久);chain 派生转录播种(msg 缺席兜底,daemon 会话重开转录在场);POST delete(有界回收/journal 保留);teardownAll 死代码处决`

### Task 3: GUI 卡片 + 回执 + reset/delete 消费 + 交接小项

**Files:**
- Modify: `gui/src/connection.ts`(onApproval/onAsk/onResetSession 回调+replyApproval/replyAsk/deleteSession 方法+SnapshotMessage 五 kind 对齐)、`gui/src/pages/Chat.tsx`(卡片层+reset 清投影)、`gui/src/pages/Home.tsx`(Delete 按钮+toggle slug 守卫)、`gui/src/App.tsx`(回调装配)
- Test: `gui/src/connection.test.ts`/`App.test.tsx`/`home.test.tsx`(扩)

**Interfaces:**
- Consumes: T1/T2 端点与帧
- Produces:
  - Connection opts 增:`onApproval?(sessionId, req)`、`onAsk?(sessionId, req)`、`onResetSession?(sessionId)`;方法 `replyApproval(pid, decision)`、`replyAsk(pid, answer)`、`deleteSession(id)`;帧路由三kind(approval/ask/reset→回调;pendingId 去重:同 pid 帧重复到达只回调一次)
  - Chat:挂起卡片区(ApprovalCard:subject/reason/kind 标+approve/deny/always 按钮——ApprovalDecision 字面现场核;AskCard:options 单/多选+allowCustom 输入+dismissed);卡按 sessionId 过滤(sessionRef);onResetSession(本会话)→清投影+重播种(复用既有 reseed)
  - Home:会话行 Delete 按钮(confirm 后 deleteSession+刷新列表);toggleRow slug 守卫(过期应答丢弃)
  - SnapshotMessage kind 五值对齐

- [ ] **Step 1: 失败测试**(connection 桩:帧路由三 kind/pid 去重/方法 URL;Chat:卡片渲染/回执调用/过滤;App:resetSession 装配;Home:delete 流/toggle 守卫)
- [ ] **Step 2/3/4** `pnpm --filter sunshinex-gui typecheck && pnpm --filter sunshinex-gui test`
- [ ] **Step 5: 提交** `feat(gui): 审批问询卡片——approval(approve/deny/always)与 ask(选项/自定义/dismissed)回执经 HTTP;reset 帧清投影重播种;Home delete;pid 去重;SnapshotMessage 五 kind 对齐+toggle 竞态守卫`

### Task 4: e2e + 门禁 + spec 回写(控制器)

- [ ] gui e2e 扩:**manual 审批闭环**(spec §12 G4 验收)——manual 会话(newSession mode)+ 模型卡发 write envelope(manual 挂起)→ 卡片出现 → replyApproval(allow)→ run done;delete 流。`pnpm --filter sunshinex-gui run test:e2e`
- [ ] 主仓 `pnpm test` 后台;`pnpm selfcheck`;spec §12 G4 回写;提交 `docs(spec): G4 执行回写`
