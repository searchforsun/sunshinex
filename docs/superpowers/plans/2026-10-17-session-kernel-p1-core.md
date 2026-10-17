# Plan 1:SessionKernel 内核转录单点(P1)

- Spec:docs/superpowers/specs/2026-10-17-session-kernel-design.md(§3.1b/§3.2/§3.3)
- 目标:把「SessionEvent → 转录条目」的投影收敛为**内核单点**(合并 TUI session / daemon collector / GUI chat-reducer 三份实现),**不接任何消费者**——三份旧实现并行存在,P2-P4 逐个退役。
- 明确不做:持久化落盘(P2 接 daemon 时接)、board/delegation 投影迁移(留在 SessionRuntime)、消费者切换。

## 新增文件

- `src/session/entry.ts` — KernelEntry 模型 + 纯 reducer `applyEvent(state, event)`
- `src/session/kernel.ts` — `SessionKernel` 类:pump(event)/replay()/truncate(seq)
- `src/session/kernel.test.ts` — 合并三份实现的既有用例(参数化表)

## 条目模型(spec §3.3)

```ts
interface KernelEntry {
  seq: number; ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'thinking' | 'run' | 'notice' | 'error';
  md: string;
  callId?: string; name?: string; input?: Record<string, unknown>;
  result?: { text: string; ok: boolean };
  seconds?: number;
  meta?: RunMeta;               // run 收段统计(steps/tokens/seconds/stopped/…)
}
```

- `streaming` 不入模型:末段「开启中」即流式中,由 reducer 派生态表达(G14.213 §3.1b 词汇收缩的内核侧)。
- 事件语义(合并三份的并集):
  - `token` → 末条 assistant 段聚合(流内);`reasoning` → thinking 段聚合(seconds=事件计数);
  - 段边界(`tool-call/tool-result/user/notice/error/done/model-start` 等非流内事件)→ 关闭开启中的 assistant/thinking 段;
  - `tool-call` → tool 段(● 行 + callId/name/input,streaming);`tool-result` → 按 callId 回填 result + ⎿ 行(乱序 FIFO 兜底,同 transcript.test ④);
  - `model-start` → run 段(streaming);`done` → run 段收 meta(payload.steps/tokens…)+ 终答 assistant 段(done.text 与流式段同文不重复);
  - `user/notice/error` → 直映射;`delegation-*/task-*/gate-*/usage/step/route/ctx` → 不产条目(delegation 状态不显示,G14.213;board 投影另路)。

## 任务

- [ ] 1. `src/session/entry.ts`:模型 + `applyEvent`(纯函数,state 进出,零副作用)
- [ ] 2. `src/session/kernel.ts`:`SessionKernel`——`pump(e)`(seq 分配 + applyEvent)、`replay()`(条目只读快照)、`truncate(seq)`(rewind/compact 预留)
- [ ] 3. `src/session/kernel.test.ts`:用例合并表——
  - token 段聚合(transcript.test ①/chat-reducer 流式光标语义)
  - 配对乱序 FIFO(transcript.test ③④)
  - done 收段+runmeta(transcript.test ①/daemon runmeta)
  - delegation 不产条目(G14.213)
  - thinking seconds(Chat.test 思考秒语义)
  - truncate
- [ ] 4. 回归:三份旧实现与全部既有测试零改动全绿(本 plan 不接线)

## 验收

- `node --test dist/session/kernel.test.js` 全绿;`vitest run` GUI 全绿;`tsc` 双侧干净。
- 明确产出:**内核单测全绿的新模块**——消费者接线在 P2(daemon)/P3(TUI)/P4(GUI)。
