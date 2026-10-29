# 会话链逐步入链 + 崩溃兜底回灌 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主链写入从「run 收束批量回写」改为「轮边界增量入链」，崩溃丢失窗口从整轮收窄到在飞一轮；resume 对崩溃档 seg 转录行全量归约回灌。

**Architecture:** Reactor 内加 `appendedCount`/`trimmedRows` 双游标，`chatRound` 每轮成功返回后 `appendChain(steps.slice(appendedCount))`（journal chain 行随既有 onContextChange 事件即时落盘）；压缩点 trim 增量化；收束点退化为补尾。seg 侧新增两个纯函数（崩溃窗口提取 + 条目→链行归约），TUI/daemon 两处 resume 路径在 journal attach 后回灌。

**Tech Stack:** TypeScript（Node test runner，`pnpm build` + `node dist/**/*.test.js`）。

**Spec:** `docs/superpowers/specs/2026-10-30-chain-incremental-persistence-design.md`

## Global Constraints

- 链只增不改（CLAUDE.md §11）；链行经 `appendChain` 单点（`src/harness/context/index.ts:167`）。
- fork 作用域（`scope !== 'session'`）零主链回写不变量：runtime.test「fork 作用域零主链回写」钉子必须保住。
- 落档吞错纪律：持久化失败不中断任务执行（settle 吞错同款）。
- journal 词汇封闭：本计划**不新增** journal 事件类型（chain/compact 行复用既有词汇）。
- 收束后主链内容与现实现逐字节一致（只是写入时机分散）——既有全量测试是等价性回归网。
- 测试命令：`pnpm build && node dist/<path>/<file>.test.js`；全量 `pnpm test`。

---

### Task 1: seg 崩溃窗口提取与链行归约纯函数

**Files:**
- Modify: `src/session/seglog.ts`（文件尾追加两个导出函数；顶部 import 补 `ChainAction`）
- Test: `src/session/seglog.test.ts`（文件尾追加测试）

**Interfaces:**
- Consumes: `reduceSegRows`（seglog.ts:146，既有）、`KernelEntry`（entry.ts:33，既有）、`ChainAction`（types.ts:462，既有）。
- Produces: `crashWindowEntries(rows: ReadonlyArray<SegRowLike>): KernelEntry[]`、`entriesToChainSteps(entries: readonly KernelEntry[]): Array<{ action?: ChainAction; observation: string; images?: string[]; reasoning?: string; thinkSeconds?: number }>` —— Task 3 两处 resume 路径按此签名消费。

- [ ] **Step 1: 写失败测试**（追加到 `src/session/seglog.test.ts` 尾部；沿用该文件既有的行构造辅助，若无则用下方自带的 `seg`/`chain` 行字面量）

```ts
test('crashWindowEntries: chain 行落点为入链水位——其后 seg 行为崩溃窗口,之前零窗口', () => {
  const rows: SegRowLike[] = [
    { t: 'seg', kind: 'user', md: 'task one', ts: 1, seq: 1 },
    { t: 'chain', steps: [{ step: 1, action: 'task', observation: 'task one' }] },
    { t: 'seg', kind: 'user', md: 'task two', ts: 2, seq: 2 },
    { t: 'seg', kind: 'assistant', md: 'working…', ts: 3, seq: 3 },
  ];
  const win = crashWindowEntries(rows);
  assert.deepEqual(win.map((e) => e.md), ['task two', 'working…'], '末个 chain 行之后的 seg 行=在飞窗口');
});

test('crashWindowEntries: 正常档(chain 行收尾)零窗口;无 chain 行全窗口', () => {
  const normal: SegRowLike[] = [
    { t: 'seg', kind: 'user', md: 'a', ts: 1, seq: 1 },
    { t: 'chain', steps: [{ step: 1, action: 'task', observation: 'a' }] },
    { t: 'seg', kind: 'assistant', md: 'done', ts: 2, seq: 2 },
    { t: 'chain', steps: [{ step: 2, action: 'reply', observation: 'done' }] },
  ];
  assert.deepEqual(crashWindowEntries(normal), [], '末行 chain 收尾:全部 seg 已入链,零窗口');
  const orphan: SegRowLike[] = [{ t: 'seg', kind: 'user', md: 'x', ts: 1, seq: 1 }];
  assert.equal(crashWindowEntries(orphan).length, 1, '无 chain 行(首 run 即崩):全窗口');
});

test('entriesToChainSteps:四类映射逐类断言 + thinking 前挂后继 assistant + 残缺容错', () => {
  const steps = entriesToChainSteps([
    { seq: 1, ts: 1, kind: 'user', md: 'do it' },
    { seq: 2, ts: 2, kind: 'thinking', md: 'hmm', seconds: 3 },
    { seq: 3, ts: 3, kind: 'assistant', md: 'ans' },
    { seq: 4, ts: 4, kind: 'tool', md: '', callId: 'c1', name: 'read', input: { path: 'a' }, result: { text: 'short', ok: true, full: 'full observation' } },
    { seq: 5, ts: 5, kind: 'error', md: 'boom' },
    { seq: 6, ts: 6, kind: 'notice', md: 'note text' },
    { seq: 7, ts: 7, kind: 'run', md: '' },
    { seq: 8, ts: 8, kind: 'tool', md: '', callId: 'c2' }, // 悬空(无 result):跳过
  ]);
  assert.deepEqual(steps[0], { action: 'task', observation: 'do it' });
  assert.deepEqual(steps[1], { action: 'reply', observation: 'ans', reasoning: 'hmm', thinkSeconds: 3 }, 'thinking 附挂后继 assistant 行');
  assert.equal(steps[2].action, 'tool-result');
  assert.equal(steps[2].observation, 'full observation', '观察行取 result.full(全量观测优先)');
  assert.deepEqual(steps[3], { action: 'note', observation: 'Error: boom' });
  assert.deepEqual(steps[4], { action: 'note', observation: 'note text' });
  assert.equal(steps.length, 5, 'run 条与无结果悬空 tool 行跳过');
});

test('entriesToChainSteps:孤立 thinking(无后继 assistant)自落 note 行', () => {
  const steps = entriesToChainSteps([{ seq: 1, ts: 1, kind: 'thinking', md: 'alone' }]);
  assert.deepEqual(steps, [{ action: 'note', observation: '[thinking] alone' }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node dist/session/seglog.test.js`
Expected: FAIL — `crashWindowEntries` / `entriesToChainSteps` 未导出（编译期即报）。

- [ ] **Step 3: 实现**（`src/session/seglog.ts` 文件尾追加；import 行补 `{ ChainAction }`）

```ts
// ===== 崩溃兜底回灌(2026-10-30 spec §2):seg 面有而链没有的在飞窗口 → 链行 =====

/** 崩溃窗口提取:journal 顺序扫描,chain/compact 行落点即「此前 seg 行已入链」的水位标记——其后新增
 *  的 seg 行=未入链在飞窗口(崩溃档特征;轮边界入链后正常档窗口恒空)。返回 reduceSegRows 全集按
 *  seq > 水位过滤(truncate 行在全档重放中对位,窗口过滤在其后统一生效)。纯件零 IO。 */
export function crashWindowEntries(rows: ReadonlyArray<SegRowLike>): KernelEntry[] {
  let boundarySeq = 0;
  let seq = 0;
  for (const row of rows) {
    if (row.t === 'chain' || row.t === 'compact') boundarySeq = seq;
    const s = num(row.seq);
    if (s !== undefined && s > seq) seq = s;
  }
  return reduceSegRows(rows).filter((e) => e.seq > boundarySeq);
}

/** seg 条目 → 链行归约(兜底口径,非逐字节恢复):user→task;assistant→reply;thinking 前挂后继
 *  assistant(无后继自落 note);tool→tool-result 观察行(observation=result.full ?? text;悬空 tool
 *  已由 reduceSegRows 补 interrupted result,无回执面跳过);notice/error→note;run 条跳过。
 *  纯件零 IO,restore 消费方(TUI commands-session/daemon session-lifecycle)共用。 */
export function entriesToChainSteps(entries: readonly KernelEntry[]): Array<{ action?: ChainAction; observation: string; images?: string[]; reasoning?: string; thinkSeconds?: number }> {
  const out: Array<{ action?: ChainAction; observation: string; images?: string[]; reasoning?: string; thinkSeconds?: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind === 'run') continue;
    if (e.kind === 'user') {
      out.push({ action: 'task', observation: e.md, ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}) });
      continue;
    }
    if (e.kind === 'assistant') {
      out.push({ action: 'reply', observation: e.md });
      continue;
    }
    if (e.kind === 'thinking') {
      const next = entries[i + 1];
      if (next !== undefined && next.kind === 'assistant') {
        out.push({ action: 'reply', observation: next.md, reasoning: e.md, ...(e.seconds !== undefined ? { thinkSeconds: e.seconds } : {}) });
        i += 1; // 思考已并入后继正文行,后继跳过
        continue;
      }
      out.push({ action: 'note', observation: `[thinking] ${e.md}` });
      continue;
    }
    if (e.kind === 'tool') {
      const obs = e.result?.full ?? e.result?.text ?? '';
      if (obs === '') continue; // 配对残缺容错:无回执面跳过,不阻塞恢复
      out.push({ action: 'tool-result', observation: obs });
      continue;
    }
    if (e.kind === 'error') {
      out.push({ action: 'note', observation: `Error: ${e.md}` });
      continue;
    }
    if (e.kind === 'notice') {
      out.push({ action: 'note', observation: e.md });
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node dist/session/seglog.test.js`
Expected: PASS（含既有全部用例）。

- [ ] **Step 5: Commit**

```bash
git add src/session/seglog.ts src/session/seglog.test.ts
git commit -m "feat(session): seg 崩溃窗口提取与链行归约纯函数——crashWindowEntries 以 chain/compact 行落点为入链水位取在飞窗口,entriesToChainSteps 四类映射(user→task/assistant→reply/tool→tool-result/thinking 附挂)兜底回灌恢复面"
```

---

### Task 2: Reactor 轮边界增量入链

**Files:**
- Modify: `src/harness/reactor.ts`（run() 内：游标声明、appendNewSteps 闭包、steer/recite 注入点、轮边界、两个压缩点、退位重试 guard、收束退化）
- Test: `src/harness/reactor.chat.test.ts`（追加 2 个测试）

**Interfaces:**
- Consumes: `context.appendChain` / `context.trimChainFront`（ContextManager，index.ts:167/:200，既有）；`StepRecord`（reactor 内局部 steps 条目形）。
- Produces: 无新导出。行为契约：`scope === 'session'` 时每轮完成后 `context.chainView()` 已含该轮行；收束后链内容与旧实现逐字节一致。

- [ ] **Step 1: 写失败测试**（追加到 `src/harness/reactor.chat.test.ts` 尾部；自带探针桩——在第二轮请求发出前断言第一轮行已入链）

```ts
/** 逐轮探针桩:每次 chat 前回调(轮边界入链断言钩子) */
class ProbeStub implements ModelAdapter {
  readonly provider = 'openai';
  private i = 0;
  readonly requests: ChatRequest[] = [];
  constructor(private steps: ChatResult[], private onChat: (index: number) => void) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.onChat(this.i);
    this.requests.push(req);
    const s = this.steps[Math.min(this.i, this.steps.length - 1)];
    this.i += 1;
    return s;
  }
  async chatStream(req: ChatRequest, onDelta: (t: string) => void, _hooks?: unknown): Promise<ChatResult> {
    const r = await this.chat(req);
    for (const ch of r.content) onDelta(ch);
    return r;
  }
}

test('轮边界增量入链:第一轮完成后 chainView 即含该轮行(收束前可见),收束后与旧口径逐字节一致', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat-inc-'));
  fs.writeFileSync(path.join(tmp, 'inc.txt'), 'incremental body');
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  let sawAfterRound1 = false;
  const adapter = new ProbeStub([
    { finish: 'tool_calls', content: 'Reading', toolCalls: [{ id: 'c1', name: 'read', argsJson: '{"path":"inc.txt"}' }] },
    stop('final reply'),
  ], (idx) => {
    if (idx === 1) sawAfterRound1 = context.chainView().some((s) => s.observation.includes('incremental body'));
  });
  const reactor = new Reactor({ registry, safety, context, model: adapter });
  const r = await reactor.run({ goal: 'g' });
  assert.equal(r.done, true);
  assert.equal(sawAfterRound1, true, '第二轮模型请求前,第一轮的 tool-result 观察行已在主链上(轮边界入链)');
  assert.ok(context.chainView().some((s) => s.action === 'reply' && s.observation === 'final reply'), '收束 reply 行照常入链');
});

test('fork 作用域零主链回写不变量:run 全程(含轮边界)chainView 长度恒定', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-chat-fork-'));
  fs.writeFileSync(path.join(tmp, 'inc.txt'), 'fork body');
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const base = context.chainView().length;
  let midRunLen = -1;
  const adapter = new ProbeStub([
    { finish: 'tool_calls', content: 'phase', toolCalls: [{ id: 'c1', name: 'read', argsJson: '{"path":"inc.txt"}' }] },
    stop('fork reply'),
  ], (idx) => {
    if (idx === 1) midRunLen = context.chainView().length;
  });
  const reactor = new Reactor({ registry, safety, context, model: adapter });
  await reactor.run({ goal: 'g' }, { scope: 'fork' } as never);
  assert.equal(midRunLen, base, 'fork run 途中主链零增长');
  assert.equal(context.chainView().length, base, 'fork run 收束后主链零增长(既有不变量)');
});
```

注意：`scope: 'fork'` 的正确传参形态沿 `reactor.prefix.test.ts` / `fork-face.test.ts` 既有用法（若其用 `opts` 其他键名如 `{ scope: 'fork' }` 之外的字段装配 seed，以既有为准修正上例）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node dist/harness/reactor.chat.test.js`
Expected: 第一条 FAIL（`sawAfterRound1 === false`——现实现收束才回写）；fork 条 PASS（现状即零回写，钉住防回归）。

- [ ] **Step 3: 实现 reactor.ts 改动**

3a. `run()` 内 `:167`（`const steps: StepRecord[] = [...seed];`）之后加游标与闭包（`toChainRow` 从收束点 `:354-357` 的内联映射提取，收束点改用同一份）：

```ts
const steps: StepRecord[] = [...seed];
// 轮边界增量入链双游标(2026-10-30 spec §1)：appendedCount=局部 steps 已入链条目数;
// trimmedRows=本 run 已 trimChainFront 的主链条目数(压缩 trim 增量记账,防重复折算)
let appendedCount = 0;
let trimmedRows = 0;
// StepRecord→链行映射单点(原收束点内联式提取——轮边界与收束两消费面共用一份,漂移温床拆除)
const toChainRow = (s: StepRecord) => ({ ...(s.action !== undefined ? { action: s.action } : {}), observation: s.observation, ...(s.reasoning !== undefined ? { reasoning: s.reasoning } : {}), ...(s.thinkSeconds !== undefined ? { thinkSeconds: s.thinkSeconds } : {}), ...(s.images !== undefined ? { images: s.images } : {}) });
// 主链中步号 ≤ 水位的条目数(种子全量 + 已入链新步按水位取交)——压缩 trim 的折叠目标计数
const foldOf = (watermark: number): number =>
  seed.filter((s) => s.step <= watermark).length + steps.slice(0, appendedCount).filter((s) => s.step <= watermark).length;
// 轮边界增量入链(session 作用域限定;fork 短路——零主链回写不变量):已完成轮的链行立即落主链
// (journal chain 行随 onContextChange 事件即时落盘)——崩溃丢失窗口从整轮收窄到在飞一轮,面板/模型
// seed 三面随轮一致。append 抛错吞掉、游标不推进(落档尽力而为,后续边界与收束点自然补写——
// append 未成功即无数据,无双写面;与 settle 吞错纪律同款)
const appendNewSteps = (): void => {
  if (scope !== 'session' || steps.length <= appendedCount) return;
  try {
    this.deps.context.appendChain(steps.slice(appendedCount).map(toChainRow));
    appendedCount = steps.length;
  } catch {
    /* 吞错:持久化失败不中断任务执行 */
  }
};
```

注意声明顺序：`scope`/`seed`/`steps` 均在 `:163-167` 已声明，闭包置于其后即可。

3b. steer 注入点（`:224` `steps.push(...injected);` 的 emit 之后）加 `appendNewSteps();`。
3c. recite 注入点（`:238-239` push+emit 之后）加 `appendNewSteps();`。
3d. 轮边界：try 块内 `if (outcome.done) { ...; break; }`（`:310-320`）之后、`} catch` 之前加：

```ts
        // 轮边界增量入链(2026-10-30 spec §1):本轮链行已完成即落主链;done 轮归收束点(与 reply 行同批)
        appendNewSteps();
```

3e. 主动压缩点（`:269` `compactedUpToStep = ...` 之后、`runCompaction` 之前）加：

```ts
          // 压缩 trim 增量化(2026-10-30 spec §1):主链折叠目标按水位取交精确计数,增量推进——
          // 已折部分记账,收束点只补余量(防「链+压缩块」双份的职责不变,量从收束一次性改为随压缩分散)
          {
            const fold = foldOf(compactedUpToStep) - trimmedRows;
            if (fold > 0) {
              try {
                this.deps.context.trimChainFront(fold);
                trimmedRows += fold;
              } catch {
                /* 吞错:trim 失败留待收束点重试(trimmedRows 未推进) */
              }
            }
          }
```

3f. 反应式压缩点（`:333` `runCompaction` 之前）加同款块（水位用当前 `compactedUpToStep`——可能为 0,`foldOf(0)` 恒 0 即不折,语义安全）。
3g. 退位重试（`:337-338`）替换 pop 行：

```ts
          // 退位重试（轮边界入链后收窄）：只移除未入链的末步——已入链行在 append-only 主链上不可撤销
          // （截尾需新 journal 词汇,兜底不值得）；失败轮零产出（steps.length == appendedCount）则保留
          // 原末步、下轮步号顺延（guardrail 多计一轮,可接受）
          if (steps.length > appendedCount) steps.pop();
```

3h. 收束点（`:350-358`）替换为：

```ts
    // 主链作用域收束回写（轮边界入链后退化为补尾）：未入链余量 + 结论行/补丁行尾追进链
    // （fork 作用域私有不回写）；折叠目标按水位取交精确计数,减去压缩点已折部分只补余量。
    // 产出链行序列与「收束批量回写」旧口径逐字节一致（等价性由既有全量测试承载）
    if (scope === 'session') {
      const cut = Math.max(compactedUpToStep, seedLastStep);
      const fold = foldOf(compactedUpToStep) - trimmedRows;
      if (fold > 0) this.deps.context.trimChainFront(fold);
      this.deps.context.appendChain(
        steps
          .slice(appendedCount)
          .filter((s) => s.step > cut)
          .map(toChainRow),
      );
      appendedCount = steps.length;
```

其后的 reply/note 分支（`:359-370`）原样保留。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm build && node dist/harness/reactor.chat.test.js && node dist/harness/reactor.test.js && node dist/harness/fork-face.test.js && node dist/harness/reactor.prefix.test.ts 2>/dev/null || node dist/harness/reactor.prefix.test.js`
Expected: 新增 2 条 PASS；既有「收束回写」「压缩」「settle/notice」「prefix」全绿。

Run: `pnpm test`
Expected: 全绿（0 fail）。既有断言若红，逐条判别：断言「run 中途 chainView 不变」的（session 作用域）属需翻转的旧口径，改断言；其余红=实现错，修实现。

- [ ] **Step 5: Commit**

```bash
git add src/harness/reactor.ts src/harness/reactor.chat.test.ts
git commit -m "feat(harness): reactor 轮边界增量入链——chatRound 每轮完成即 appendChain(appendedCount 游标),steer/recite 注入行即时入链;压缩 trim 随 foldOf 水位取交增量化(trimmedRows 记账);退位重试只 pop 未入链末步;收束点退化补尾(链行序列与旧口径逐字节一致);fork 零回写不变量钉住"
```

---

### Task 3: resume 消费点接线（TUI + daemon）

**Files:**
- Modify: `src/tui/commands-session.ts`（`restoreFromSession`，`:200` `ctrl.ensureJournal().attach(meta.id);` 之后）
- Modify: `src/serve/session-lifecycle.ts`（`attachSessionIn`，`:173` `session.attachJournal(journal);` 之后）
- Test: `src/tui/session.resume.test.ts`（追加端到端用例，沿该文件既有 fixture）

**Interfaces:**
- Consumes: Task 1 的 `crashWindowEntries` / `entriesToChainSteps`（`../session/seglog`）；`context.appendChain`。
- Produces: 无新导出。行为契约：伪造「seg 多于 chain」的 journal 档，restore 后 `context.chainView()` 含回灌行，且回灌行经订阅落 journal chain 行。

- [ ] **Step 1: 写失败测试**（追加到 `src/tui/session.resume.test.ts`；fixture 形态沿该文件既有用例——构造 v3 journal 档的辅助若已存在则复用，核心事件序列如下）

journal 档事件序列（「崩溃档」：末个 chain 行之后还有未入链 seg 行）：

```ts
// header(v:3) → seg:user('crash task') → chain:[task 行] → seg:assistant('partial answer')
// → seg:tool(callId c9, name read, input…, result { text: 'file body', ok: true, full: 'file body' })
// （run 中途崩溃:无收尾 chain 行）
```

断言（restore 完成后）：

```ts
// ① chainView 含回灌行:reply('partial answer') 与 tool-result('file body')
// ② journal 档尾新增 chain 事件（回灌行经订阅落档——读回 parseJournalFile 断言）
// ③ 正常档（chain 行收尾）restore 后 chainView 长度与 chain 事件步数一致——零回灌回归
```

daemon 侧同构断言若 `src/serve/daemon.test.ts` 既有 attach fixture 可复用则加一条；否则以 TUI 端到端 + Task 1 纯函数钉子覆盖（两消费点接线为三行同构调用，diff 审查面即可判别）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node dist/tui/session.resume.test.js`
Expected: 新增用例 FAIL（chainView 不含回灌行——现实现只回放 chain 行）。

- [ ] **Step 3: 接线**

3a. `src/tui/commands-session.ts`：import 行补 `import { crashWindowEntries, entriesToChainSteps } from '../session/seglog';`；`restoreFromSession` 内 `:200`（`ctrl.ensureJournal().attach(meta.id);`）之后、模型漂移告警之前插：

```ts
  // 崩溃档兜底回灌（2026-10-30 spec §2）：seg 面有而链没有的在飞窗口归约成链行 appendChain——
  // 走单点故压缩/面板/后续 seed 自动一致；attach 之后执行,回灌行经订阅落 journal chain 行（恢复
  // 即持久化）。正常档窗口恒空、零开销;回灌失败（appendChain 抛错）不阻塞 resume——恢复永远可用,
  // 只是兜底少一条（spec §3 错误处理）
  try {
    const crash = entriesToChainSteps(crashWindowEntries(parsed.events));
    if (crash.length > 0) ctrl.runtime.harness.context.appendChain(crash);
  } catch {
    /* 兜底尽力而为:残缺档不阻塞恢复 */
  }
```

3b. `src/serve/session-lifecycle.ts`：同款 import；`attachSessionIn` 内 `:173`（`session.attachJournal(journal);`）之后、`io.setActive(id);` 之前插同款块（`parsed.events` 换为 `replayEvents`，`ctrl.runtime.harness.context` 换为 `session.runtime.harness.context`）：

```ts
  // 崩溃档兜底回灌（2026-10-30 spec §2）：与 TUI restoreFromSession 同构（attachJournal 之后执行,
  // 回灌行经订阅落 journal chain 行）；注释与容错口径见 TUI 侧
  try {
    const crash = entriesToChainSteps(crashWindowEntries(replayEvents));
    if (crash.length > 0) session.runtime.harness.context.appendChain(crash);
  } catch {
    /* 兜底尽力而为:残缺档不阻塞恢复 */
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm build && node dist/tui/session.resume.test.js && node dist/session/seglog.test.js`
Run: `pnpm test`
Expected: 全绿（0 fail）。

- [ ] **Step 5: Commit**

```bash
git add src/tui/commands-session.ts src/serve/session-lifecycle.ts src/tui/session.resume.test.ts src/serve/daemon.test.ts
git commit -m "feat(resume): 崩溃档 seg 回灌接线——TUI restoreFromSession 与 daemon attachSessionIn 同构三行(journal attach 后 crashWindowEntries→entriesToChainSteps→appendChain),回灌行经订阅落 chain 行恢复即持久化;正常档零窗口零开销"
```

---

### Task 4: 全量验证与收尾

**Files:** 无新改动（验证 + 既有失败判别）。

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 0 fail（2 skipped 为既有跳过）。若有偶发红（此前观察到 tui-loop 有与改动无关的抖动），单独重跑该文件判别。

- [ ] **Step 2: 真机冒烟（可选但推荐）**

Run: `pnpm start`（或 `pnpm shell:dev`）开一个会话跑一个两轮任务，`/context` 观察「会话链」段逐轮增长；Ctrl+C 杀进程后 `--continue` 恢复，确认模型能复述上轮做到哪（回灌生效）。

- [ ] **Step 3: 最终 commit（如有零散修正）**

```bash
git add -A src docs
git commit -m "fix(harness): 会话链逐步入链收尾修正（如有）"
```
