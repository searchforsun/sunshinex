# Plan 6:挂起表下沉内核(spec §4)+ TuiRuntime 正名迁移(§10-5)

> 前置:P1-P5 已落地(`aa58bf8`/`a3f5591`/`2445aa4`/`6f8b230`/`3470703`)。本 plan 收 §10 定版清单
> 内两项:第 4 项(审批/提问挂起表下沉内核)与第 5 项(TuiRuntime 正名迁移)。第 1/2/3/6 项已随
> P1-P4 落地;第 7/8 项 spec 自标 future/二期不在本期。

## 0. 现状勘察(2026-10-18 代码实测)

**挂起面(G4/G5/G7 现状)**:

- 表在 daemon-wire 层资产:`GuiDaemon.pending: Map<pid, PendingEntry>`(daemon.ts:155),entry 携
  `sessionId`;pid=daemon 级单调 `p<n>`;
- 注册:daemon.createSession 向 SessionRuntime 注 `asker`/`onAskUser` 两闭包(daemon.ts:230-245)
  ——闭包内查 `session.isAborted()`(G14.10 ghost 硬化)与 `isManual()`,注册进 daemon 表+广播帧;
  会话层不知道挂起态存在;
- 消费:`handleSnapshot` 从 daemon 表按 sessionId 过滤合并(session-handlers.ts:337);回执端点
  `POST /approval/:pid`、`/ask/:pid/reply` 直查 `io.pending`(435/457);WS 连接建立全表重发
  (daemon.ts:406);interrupt/reset/delete → `denyPendingFor(sessionId)` deny/dismissed 回填
  (daemon.ts:303);close → `denyAllPending()` 全表回填;
- TUI 面早已会话级(SessionController.pendingApproval/pendingQuestion,in-process),不动。

**问题**:挂起是会话事件,状态却在 wire 层——会话对象不自持挂起,reset/teardown 的会话收口要
绕 daemon 外部表;`PendingEntry` 携 sessionId 属 wire 形态漏进状态模型;ghost 硬化靠 daemon 闭包
反向查会话(方向颠倒)。

**TuiRuntime 现状**:`src/tui/runtime.ts` 定义 `TuiRuntime`/`TuiRuntimeOpts`/`createRuntime`
——TUI 与 daemon 共用的装配单点(buildHarness + Loop runTask/runLoop 入口),名字却叫 TUI;
`src/runtime.test.ts:86` 形态钉按 `src/tui/runtime.ts` 路径断言;消费方 tui/session.ts、
tui/chat-model.ts(SessionOpts extends TuiRuntimeOpts)、serve/session.ts、kb-wiring.test.ts。

## 1. 设计定版

### 1.1 挂起表下沉(SessionRuntime 持表,daemon 保留寻址+广播)

- `SessionRuntime` 持 `pending: Map<pid, entry>`;entry=`{kind:'approval'|'ask'; req; resolve}`
  (sessionId 出模型——同会话内寻址自明);`PendingEntry` 类型迁 session.ts;
- 注册面回正方向:assemble() 无条件注入两接缝——`onApproval: (req) => this.suspendApproval(req)`、
  `onAskUser: (req) => this.suspendAsk(req)`;ghost 硬化(isAborted)与 manual 判定(isManual)在
  session 方法内,`SessionRuntimeOpts.asker/onAskUser` 删除,daemon.createSession 的 ghost 闭包
  反查技巧整体退役;
- 广播:复用 `opts.broadcast`,签名放宽 `(frame: DaemonFrame) => void`(事件帧+挂起帧同路);
  pid 铸造经新 opts `mintPid: () => string`(daemon 级单调 `p<n>` 不变——回执寻址键跨会话唯一);
- 会话 API:`suspendApproval/suspendAsk`(守卫+注册+广播)/`pendingSnapshot()`(快照合并面,
  `{pid,kind,req}` 行)/`pendingFrames()`(WS 重连重发面)/`resolvePendingApproval(pid,decision)`、
  `resolvePendingPendingAsk(pid,answer)`(kind 判别+删表+resolve+notice pump 入转录——daemon
  noticePending 语义随迁)/`denyPending()`(interrupt/reset/delete 回填);
- daemon 剩余职责:pid 铸造、broadcastFrame 传输、回执路由(pid 无会话前缀,迭代各会话表寻址)、
  close 全表回填(迭代 sessions.denyPending)、WS 重连重发(迭代 pendingFrames);wire 帧
  (ApprovalFrame/AskFrame)与 `pendingFrameOf` 留 daemon-wire;
- **wire 不变**:帧形态/端点/快照 pending 段全不动——GUI/TUI 渲染面零改动。

### 1.2 TuiRuntime 正名迁移(§10-5)

- `src/tui/runtime.ts` → `src/session/runtime.ts`(git mv);`TuiRuntime`→`KernelRuntime`、
  `TuiRuntimeOpts`→`KernelRuntimeOpts`、`createRuntime`→`createKernelRuntime`——装配单点随内核
  落位、名实相副(TUI 与 daemon 共用,不姓 TUI);
- 消费方跟改:tui/session.ts、tui/chat-model.ts(SessionOpts extends)、serve/session.ts、
  kb-wiring.test.ts;`src/runtime.test.ts` 形态钉路径改 `src/session/runtime.ts`(断言内容不变
  ——零直接构造/零 kb 自解析/经 buildHarness);`src/tui/runtime.test.ts` 同迁;
- serve 的 `SessionRuntime` 类名不动(serve 会话=内核+wire 装配体,与 KernelRuntime 不同层)。

## 2. 实施序(依赖单向)

1. **KernelRuntime 迁名**(机械步先行,后续 diff 干净):git mv+重命名+消费方/形态钉跟改;全量
   tsc+针对性测试。
2. **挂起下沉**:session.ts 持表+五 API+assemble 注入;daemon.ts 卸表(mintPid/broadcast 放宽/
   deny 与重发与回执路由改迭代会话);daemon-wire PendingEntry 迁出;session-handlers 快照/回执
   改会话 API;SessionHandlerIo 面收窄。
3. **测试**:session.test ⑥(接缝透传)改为挂起行为断言(帧+pendingSnapshot);daemon.pending
   套件回归(HTTP 面应零改动通过);ghost ⑧ 回归;新增 deny/重发/回执 404 的会话级断言。

## 3. 验收(2026-10-18 实测回填)

- [x] manual 会话 write 越信任域 → approval 帧广播+session 持表(快照 pending 段/WS 重发同源);
      回执 → resolve+notice 入转录;重复回执 false→404(session.test ⑥ 重写断言)
- [x] ask_question 任意档挂起(G14.93,dontAsk 对照组);dontAsk approval 零帧零表项(guard 前置);
      interrupt/reset/delete → deny/dismissed 回填+清表(denyPendingFor 薄委托);ghost 窗
      (isAborted)零注册零广播(daemon.pending ⑧ 回归过)
- [x] close 全表回填(迭代 sessions.denyPending);pid 全局单调跨会话不撞(daemon mintPid 保留);
      wire 帧/端点/快照形态零变化(daemon.pending 套件 HTTP 面原样通过)
- [x] KernelRuntime 落位 src/session/(runtime.ts+runtime.test.ts git mv);形态钉路径更新;
      全仓 TuiRuntime/tui/runtime 代码引用清零(注释正名标注除外)
- [x] 全量:daemon 1865 用例 1863 pass / 0 fail(2 skip 既有);GUI 335/335(重跑确认,前次单
      fail 为既有并发 flake——P6 零 GUI 改动);tsc 双端 0 error

### 实测修正(相对 §1 设计)

- 回执路由收窄:SessionHandlerIo 以 `resolveApproval/resolveAsk` 两回调替代直查表——pid 无会话
  前缀,daemon 迭代各会话表寻址;
- dontAsk 会话 ask_question 行为与产线 daemon 对齐(G14.93 任意档挂起)——旧测试对照组因接缝
  未注入而「未注册」,下沉后 assemble 无条件注入,对照组断言改为「挂起+dismissed 收口」;
- SnapshotPendingRow 随表迁 session.ts(session-handlers 只 import),防 io 面回挂表引用。
