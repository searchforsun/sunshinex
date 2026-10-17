# Plan 5:steer 等待队列内核化(spec §12)

> 前置:P1-P4 已落地(`aa58bf8`/`a3f5591`/`2445aa4`/`6f8b230`)——SessionKernel 是全仓唯一转录投影,
> v2 单档 `seg/seg-update/run-open/truncate/runmeta` 行为既有写面。本 plan 收最后一项:队列状态
> 出 harness 内存 FIFO、入内核——持久化(v2 steer 行)+ 变更广播(`queue` 事件)+ TUI 管理面板 +
> GUI 编辑钮。无兼容层:SteeringChannel 整体退役。

## 0. 现状勘察(2026-10-18 代码实测)

| 面 | 现状 | 问题 |
|---|---|---|
| 状态 | `src/harness/steering.ts` SteeringChannel 纯内存 FIFO(`SteerEntry{text,front}`),harness 字段直挂 | daemon 重启/会话重开即丢;setMode 换 runtime 也丢 |
| 消费 | reactor 步边界 `steer:()=>this.steering.drain()`(仅 front 条注入);轮收束 finally `takePending` 首条续跑(harness index:340/serve session:437);TUI submit 运行中入队(session.ts:283)、interrupt 丢弃(approval.ts:117) | — |
| daemon 端点 | steer/cancel/move/front 四个(session-handlers.ts:83-255),快照 `queued:{seq,text}[]` | 缺 edit;变更无事件 |
| GUI | `use-queue.ts` 快照轮询回显(reseed+done 双刷),chips 拖拽/插入/立即/放回输入框/删除 | 无内联编辑;依赖轮询非事件 |
| TUI | 仅入队回显「已排队」+ 计数,无管理面 | 队列不可见不可管 |

## 1. 设计定版

### 1.1 状态单点:SessionKernel 持队(转录内核同体,不进纯 reducer)

- `KernelState`(applyEvent 纯面)**不含**队列——队列非转录;`SessionKernel` 类持
  `steerItems: SteerItem[]`(`{seq,text,front}`,seq=位置下标,每次变更重排)。
- 内核方法(变更即发 `{t:'steer',items:SteerItem[]}` KernelEvent,经既有 onKernelEvent 单槽外抛):
  `steerEnqueue(text)`(trim 空白忽略)/`steerEditAt(seq,text)`/`steerMove(from,to)`(夹边界)/
  `steerMoveToFront(seq)`(置首+front=true)/`steerRemoveAt(seq)`/`steerDrain()`(步边界:取走全部
  front 条,重排)/`steerTakePending()`(取走全部——轮收束补跑/中断丢弃/撤回取回共用)/
  `steerPendingItems()`(只读快照不发事件)/`steerRestore(items)`(装载回种,不发事件防双写)。
- `src/harness/steering.ts` **删除**;harness 字段 `steering` → `steerSource:()=>string[]`(缺省空,
  会话层装配时挂 `()=>kernel.steerDrain()`);reactor 闭包改读该口。runtime.ts:72 同步。
- 行为裁定:**setMode 换 runtime 不再丢队列**(内核不随 runtime 换——比旧行为合理);reset 仍清
  (kernel 整体换新=/new 语义);interrupt 丢弃语义不变(TUI Ctrl+C 队列清空+提示)。

### 1.2 持久化:v2 steer 行(整列重写,末行为准)

- `JournalEvent` 增 `| {t:'steer'; items:Array<{seq:number;text:string;front:boolean}>}`;
- `kernelEventRows` 增映射:`{t:'steer'}` → steer 行(daemon/TUI 写者同形,零改动双落);
- `reduceSteerRows(rows): SteerItem[]`(v2log.ts 新出):扫全行取**末条** steer 行,字段净化
  (text 非串弃/front 严判 true/seq 夹 ≥0);daemon attach 与 TUI restoreFromSession 各自回种。

### 1.3 事件:`queue` 广播(GUI 实时回显,退役轮询)

- `SessionEventType` 增 `'queue'`,payload `{items:SteerItem[]}`;
- daemon `persistKernelEvent` 对 steer 事件**旁路广播**(`emitQueueFrame`:seq 分配+环形缓冲+
  broadcast,**不经 pump**——queue 帧不喂转录内核/影子投影,防 default 分支 sealSeg 误闭合开启段);
  重连补发经 frames 环窗天然覆盖;
- GUI `use-session-events` sink.on 顶部截收 queue 帧 → `setQueued`(快照播种仍是初始权威);
  **退役** done 帧双刷轮询(refreshQueued 的 done 挂钩)——轮收束 takePending/回队即发帧;
- `chat-reducer.applyChatEvent` 顶部加 `queue` 直通守卫(返回原 state,防御性——正常路径不达)。

### 1.4 端点:`POST /session/:id/steer/edit {seq,text}`

- `session.steerEdit(seq,text)` → kernel.steerEditAt;text 空白串 400(与 steer 同口径);越界 400
  (no such queued entry,与 cancel/move 同形);既有四端点语义不变(改走内核态)。

### 1.5 TUI:Ctrl+Q 队列管理面板

- 新组件 `components/QueuePanel.tsx` + `use-queue-keys.ts`(use-browse-keys 同构);App 判定序
  新位:**board(4/5)之后、问询卡(6)之前**(轻模态:在场吞键,Esc/任务卡优先级更高);
- Ctrl+Q 开合;面板操作(对齐 GUI 全动作):↑↓ 选条 / **E** 内联编辑(Enter 提交 steer/edit、
  Esc 撤)/ **D** 删除 / **I** 插入新条(输入行回车入队)/ **N** 直接发送(撤条+中断当前轮+立即
  提交新一轮,GUI pauseAndSend 同语义)/ **F** 置首插入 / **Ctrl+↑↓** 重排;Esc 关面板;
- 显示:`序. [插入发送] 文本` 标记 front;KeyHints 补 Ctrl+Q 提示;submit 运行中入队改走
  kernel.steerEnqueue(转录/持久化随 P3 既有 onKernelEvent 自动落 steer 行)。

### 1.6 GUI:queue 帧实时 + 内联编辑钮

- `connection.ts` 增 `editSteer(id,seq,text)`(POST steer/edit);
- `SteerQueue.tsx` 行增**内联编辑钮**(Pencil):点行文本变输入框,Enter 提交 editSteer、
  Esc 还原;既有拖拽/插入/立即/放回输入框/删除全不变。

## 2. 实施序(依赖单向)

1. **内核**(src/session/kernel.ts + v2log.ts + tui/session-journal.ts 行型):队列态+ops+事件+
   行映射+reduceSteerRows;kernel.test.ts 增队列组、v2log.test.ts 增往返组。
2. **harness 退役**(src/harness/index.ts + tui/runtime.ts):steerSource 口;steering.ts 删;
   全仓 `harness.steering` 引用清零(编译器兜底)。
3. **daemon**(serve/session.ts + session-handlers.ts + daemon.ts):ops 改内核态、emitQueueFrame、
   steerSeed、steer/edit 端点、attach 回种;serve 侧测试。
4. **TUI**(tui/session.ts + approval.ts + components/QueuePanel + use-queue-keys + App.tsx +
   KeyHints):ctrl 队列 API、面板、键位;session.steer.test 回归+面板测试。
5. **GUI**(connection.ts + use-session-events.ts + SteerQueue.tsx + chat-reducer.ts):
   editSteer、queue 帧截收(退役 done 轮询)、编辑钮、守卫;GUI 测试。

## 3. 验收(2026-10-18 实测回填)

- [x] 内核:enqueue/edit/move/front/remove/drain/takePending 全操作含 seq 重排与 front 标记
      (emitSteer 单点按位置归一 seq);restore 不发事件;变更即发 steer 事件(items=全量列表)
- [x] 持久化:变更→steer 行落档(daemon/TUI 同 kernelEventRows 写形);重载 restore 恢复队列
      (末行为准——workspace ④ steer 行装载断言);TUI resume reduceSteerRows 回种
- [x] 事件:每次变更广播 queue 帧(session-queue P5 帧/seq/lastSeq 断言);pump 主链不被污染
      (⓯c 开启段保持;emitQueueFrame 旁路不经 pump)
- [x] 端点:steer/edit 增改(contract ④ 扩);四旧端点照常;快照 queued 仍回显
- [x] TUI:Ctrl+Q 面板六操作+front 标记+Esc(App.queue.test);运行中提交入队走内核
      (session.steer.test 回归过);中断丢弃提示回归(approval.ts 改 ctrl API)
- [x] GUI:queue 帧实时回显(done 轮询退役——use-session-events 截收 setQueued);内联编辑钮
      (Pencil→steer/edit);既有 chips 动作全回归;chat-reducer queue 直通守卫
- [x] 全量:daemon 1851 用例 1849 pass / 0 fail(2 skip 既有);GUI 335/335;tsc 双端 0 error

### 实测修正(相对 §1 设计)

- seq 归一化:重排/删撤后由 emitSteer 单点按位置重写 seq(初版只重排在读面——move 后 findIndex
  寻址漂移,已修);steerRestore 同样按位置归一(坏档 seq 夹取);
- use-input parser 增补 Ctrl+↑/↓(`\u001B[1;5A/B` → upArrow/downArrow + ctrl)——原解析器不识别
  带参数 CSI,重排键不可达;
- TUI persistKernelEvent 惰性建档对齐 daemon(P5 起 steer 行可先于自然语言提交到达);
- 行为裁定:daemon setMode 换 runtime 不再丢队列(内核不随 runtime 换,比旧行为合理);
  reset 仍清(kernel 整体换新=/new 语义)。
