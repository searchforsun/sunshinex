# Plan 2:SessionKernel daemon 接入(v2 单档唯一写者,P2)

- Spec:docs/superpowers/specs/2026-10-17-session-kernel-design.md(§3.1b/§3.2/§4b/§5)
- 前置:P1 已落地(src/session/{entry,kernel,kernel.test},aa58bf8)
- 目标:daemon 会话运行时内嵌 SessionKernel;`<dataDir>/sessions/<journalId>.jsonl` 升 v2(增段级行型)成为转录唯一持久化;collector/链派生播种/G14.213b 第二 jsonl 全部退役;快照 = kernel.replay。
- 明确不做:TUI journal 面不动(P3)、GUI 消费零改动(契约超集)、steer 队列持久化(spec §12 另 plan)、run 执行生命周期不变。

## 勘察结论(计划依据的代码事实)

- daemon 会话 id(`s1`)≠ journal 档 id(惰性建档随机生成)——**v2 装载只能在 attach 位**(daemon.ts 已持 journalId + parseJournalFile),构造器装载不可行(G14.213b 构造器路径随之删除)。
- daemon 档今天只落 header/chain/compact/runmeta/snapshots 行(无 msg/user 行)——v2 = 同文件增行型,非换文件。
- GUI SnapshotTranscriptEntry 契约 = {seq,ts,kind,md,seconds?,meta?};KernelEntry 为结构超集(callId/name/input/result、meta 扩展字段),JSON 序列化多余字段 GUI 侧忽略——零改动。

## 行型扩充(JournalEvent 封闭词汇 v2,session-journal.ts)

```ts
| { t: 'seg'; kind: KernelEntry['kind']; md: string; ts: number; seq: number;
    callId?: string; name?: string; input?: Record<string, unknown> }   // 段闭合行(assistant/thinking)/即终态条目行(user/notice/error/tool);seq=live 序号原样随档
| { t: 'seg-update'; callId: string; ts: number; seq: number;
    name?: string; input?: Record<string, unknown>; result?: { text: string; ok: boolean } } // 工具条回填行(重放按 callId upsert)
| { t: 'run-open'; ts: number; seq: number }
| { t: 'truncate'; upToSeq: number }  // rewind/compact/reset 视界截断(upToSeq=0 即全清)
```

- chain/compact/runmeta/snapshots/model/todos/view 行型与读写面**原样保留**(§3.2 表三个读面不变)。
- header `v: 2`(SessionJournal.start 加 version 参数,缺省 1——TUI 面 P3 前不受扰);daemon 侧惰性建档处传 2。
- `msg`/`msg-update`/`user` 行 daemon 从未落过,TUI 继续用(P3 收编)。

## 内核段级事件(§3.1b 落地,entry.ts/kernel.ts)

```ts
export type KernelEvent =
  | { t: 'seg-open'; entry: KernelEntry }    // 条目新建(assistant/thinking=开启段;其余即终态)
  | { t: 'seg-close'; entry: KernelEntry }   // 正文/思考段闭合(终态 md/seconds)
  | { t: 'seg-update'; entry: KernelEntry }  // 工具条回填(name/input/result)
  | { t: 'truncate'; upToSeq: number };
```

- `applyEventEvents(state, e): { state, events }` 内层实现;`applyEvent` 包装保持 P1 签名(P1 用例零改动)。
- SessionKernel 构造 opts 增 `onKernelEvent?`;pump 后逐事件外抛;`truncate()` 同抛。
- `SessionKernel.submit(goal)` 新增(collector.submit 平移:user 条 + seg-open 事件)。
- `applySeed` 语义修正:入参 `seq > 0` 沿用(v2 行 seq 与 live 同源,truncate 可对位),缺省/0 才续发(nextSeq = max+1)——P1 ⑧ 用例的 batch 全部无 seq,断言不变。

## SessionRuntime 接线(serve/session.ts)

- `transcriptImpl: TranscriptCollector` → `kernel: SessionKernel`;构造器删 transcript.jsonl 读写,onKernelEvent → `persistKernelEvent`(映射落行:seg-open 的 run→run-open 行、assistant/thinking→不落(等 seg-close)、其余→seg 行;seg-close→seg 行;seg-update→seg-update 行;truncate→truncate 行;journal 未挂载时丢弃——惰性建档前零落盘)。
- `submit()`:`transcriptImpl.submit(goal)` → `kernel.submit(goal)`;`pump()`:`push(e)` → `kernel.pump(e)`。
- `reset()`:落 `{t:'truncate', upToSeq:0}` 行 + kernel 换新(回放视界与 live 清空对齐)。
- `snapshotResponse().messages` = `kernel.replay()`(TranscriptEntry 类型位换成 KernelEntry,结构超集直换)。
- `transcript` getter / `transcriptCount()` → kernel 外窥(`kernelSeed(entries)` 新增供 attach 装载)。

## 退役(no-compat)

- 删 `src/serve/transcript.ts` + `transcript.test.ts`(用例已在 kernel.test.ts);TranscriptEntry 类型随退,SessionSnapshot.messages 换 KernelEntry。
- 删 `journalMessagesToEntries` / `chainStepsToEntries`(daemon.ts import 同步删)。跨端影响:TUI 档被 GUI attach 时转录显示空窗(无 seg 行)——P3 TUI 落 v2 后自愈,开发期接受(no-compat 裁定)。
- attach 版本守卫 `!== 1` → `!== 2`(v1 旧档拒载);`scripts/purge-legacy-sessions.ts`(spec §5)提前到本 plan:列/删 v1 档与 `<id>.transcript.jsonl` 残档。
- daemon.test.ts `chainStepsToEntries` 用例删除;session.test.ts 三处 `transcript.entries()` 换 kernel 外窥。

## 装载序(daemon.attach,§4b)

1. parseJournalFile → `reduceJournal`(chain/compact 上下文 + 参数快照,不变)+ 新 `reduceV2Rows`(seg/run-open/seg-update/runmeta/truncate 行 → KernelEntry[],callId 回填、悬空 run-open 标 `meta.stopped=true`——run 随 daemon 重启已死,回放显「已停止」)。
2. `restoreSession`(不变)→ `session.kernelSeed(entries)` → journal.attach + attachJournal(续写同档)。

## 测试

- v2log 单测:reduceV2Rows(seg 顺序/seg-update callId 回填/truncate 截断/runmeta 合入/悬空 run stopped);applySeed seq 保留与续发两形态。
- session.test:往返断言(事件流→journal 行→重放→kernel.replay 等价);reset 落 truncate 行且 kernel 清空;submit user 条落档。
- daemon.test:attach v2 档(转录+上下文恢复);v1 档拒载 INVALID_ARG。
- 回归:daemon 全量 + GUI vitest(GUI 契约超集,零改动全绿)+ tsc 双侧。

## 验收(2026-10-17 实测)

- [x] SessionRuntime 内嵌 SessionKernel(pump/submit/reset 三入口;persistKernelEvent 段级事件 → v2 行)
- [x] v2 单档唯一写者:JournalEvent 增 seg/seg-update/run-open/truncate 行型;header v:2(惰性建档 start(2)——首 run 的 user/run-open 行不再丢档,实测 ⑤ 抓出)
- [x] 装载序:daemon.attach → reduceJournal(chain/compact)+ reduceV2Rows(seg 面)→ kernelSeed
- [x] 退役:transcript.ts/test 删除;journalMessagesToEntries/chainStepsToEntries 删除;G14.213b 第二 jsonl 读写删除;attach 版本守卫 v2-only;purge 脚本(scripts/purge-legacy-sessions.mjs,dry-run 缺省)
- [x] 回归:daemon 全量 1843 过 0 挂(含新 v2log 6 例+attach v2 用例);GUI 333 过(tsc 双侧净;project-menu 未读点用例全量并发下偶发超时,单跑/复跑恒过——既有偶发,与本轮无关,GUI 源码零改动)
- [x] 事件差分实现裁定:KernelEvent 由 pump 前后态 diff 推导(条目引用比对),applyEvent 签名零改——P1 的 21 例全数不动;seg-open 带 open 标志(done 无开启段终答以闭合态直建,写者立即落行)
- [x] v2log 裁定:seg-update 按 seq upsert(无 callId 的 FIFO 条也可寻址);name 回填保留行面既有 ⎿ 结果行;悬空 run 标 meta.stopped
- 表面零变化:快照/重连/刷新行为一致;daemon 重启 + attach 后转录不空窗(v2 回放);双 jsonl 消失。
- 消费者状态:daemon=kernel;TUI/GUI 旧投影仍在(P3/P4 退役)。GUI e2e 造场 seedWorkspace 已升 v2(seg 行)。
