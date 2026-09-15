# TUI 子代理显示实施计划（ChildPanel 并行面板 + 转录归档）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-09-15-tui-subagent-display-design.md` 落地 TUI 子代理显示：运行中在动态区为每个子代理渲染恒定高度 ChildPanel 迷你面板（实时流式尾），结束后整段转录折叠归档进 spawn 调用行 detail（复用 Tab/Ctrl+O 两层展开）；SubagentRunner 同名并发 `#N` 后缀消歧（唯一 Runner 改动）。

**Architecture:** 纯显示层隔离——`session.ts` `onEvent` 首查 `e.payload?.subagent`：带标签事件路由进 `TuiState.children`（ChildLiveState：label/startedAt/steps/tokens/transcript/tail），不进主链 messages/live；spawn tool-result 到达时按「调用行入参基名 → 精确/`#` 前缀/FIFO」匹配归档（transcript 折入调用行 detail、children 移除）；渲染面新增 `ChildPanel` 组件挂载于动态区（Spinner 行下、审批卡上），单面板恒 4 行、tail ≤3 行轮转不构成动态区高度波动源；归档行复用现有 tool 行语汇（tool-verbs 登记 spawn→SPAWN）。

**Tech Stack:** TypeScript strict（CommonJS）+ Node ≥ 22.9 + node:test + ink 3（test-ink 渲染断言）；零新增依赖。

## Global Constraints

- **基线**：全量 581/581、selfcheck 零失败（HEAD 75bc760 起累计 3e317de 规格文档）；每任务收尾 `pnpm build` + 定向测试绿后 commit（只 add 本任务列出文件）；最终全量 `pnpm build && pnpm test && pnpm selfcheck`。
- **前缀缓存第一要义（CLAUDE.md §11）**：本计划纯 TUI 显示层 + Runner 并发后缀，提示词装配面零改动；若实现过程发现任何组装面触碰即停、回报裁决。主链↔fork 首帧前缀用例、相邻步前缀稳定用例保持绿。
- **主链不变量（规格 D1）**：带 `payload.subagent` 的事件在 onEvent 分流入口 return，不得触达主链任何分支（messages/live/metrics/todos 零写入）。
- **面板行数恒定（规格 D5）**：单面板恒 4 行（头部 + 尾流 3 行），任意内容/并发数下整块行数不变——动态区高度波动 = 整帧重排闪烁（TodoList/表格两先例）；不足 3 行补空行。
- **节流纪律**：子代理增量（token/reasoning）走既有 `notifyThrottled()`（120ms 合帧），禁止每 delta 同步 notify；结构事件（归档/创建）走 `notify()` 即时。
- **文案规则**：界面文案 `t()` 双语（运行期求值）；不改既有 `pick()` 链行文案（Runner 消歧后缀除外）。
- **测试卫生**：临时目录 `fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-…'))` + try/finally `fs.rmSync`；渲染断言经 `src/tui/test-ink`（debug:false）；session 单测用假 ModelAdapter/直喂 onEvent，不发真实网络。
- **落地优先**：计划与代码冲突时以仓内实际为准并在提交说明登记偏差；禁止 /tmp 越狱路径；路径一律 path.join。

---

### Task 1: Runner 同名并发消歧后缀（#N）

**Files:**
- Modify: `src/harness/subagent.ts`（runSubagent label 消歧；既有 SUBAGENT_CONCURRENCY_LIMIT = 4 区域）
- Modify: `src/harness/subagent.test.ts`（新增同名并发用例）

**Interfaces:**
- Consumes: 既有 `runSubagent(input, opts?)`（spec.label 缺省链：`input.label ?? input.agent_id ?? 'subagent'`）；`this.inFlight` 计数。
- Produces（Task 2/3 依赖）:
  - 规则：进入 runSubagent 时统计在飞子代理中与本次 base label 相同者计 n，n>0 则本次 label = `${base}#${n+1}`；作用面 = 事件 payload.subagent、结论/补丁行前缀
  - 在飞 label 按创建序记录（并发集内唯一），run 结束移除
  - 顺序性：label 后缀按「进入 runSubagent 并通过并发检查」的时序分配（多并行 await 场景不保证与调用方 Promise 创建序一致，规格 §8 已接受此为已知边界）

- [ ] **Step 1: 写失败测试**（`src/harness/subagent.test.ts` 追加；gate/gateResolve 挂起适配器对齐 `subagent.spawn.test.ts` 既有同名惯用法）

```ts
test('同名并发消歧：后到者 label #N 后缀，事件与结论行一致；不冲突时保持裸 label', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sub-disamb-'));
  try {
    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });
    let calls = 0;
    // 挂起适配器对齐 subagent.spawn.test.ts 并发用例惯用法（ModelAdapter.complete 签名）
    const model: ModelAdapter = {
      provider: 'probe',
      complete: async () => {
        calls++;
        if (calls <= 4) { await gate; return JSON.stringify({ done: true, reply: '子完成' }); }
        return JSON.stringify({ done: true, reply: '主链完成' });
      },
    } as ModelAdapter;
    const h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
    h.security.setAsker(async () => 'deny');
    // 直接驱动 Runner（同文件 makeRunner 惯用法），注 onEvent 截获子代理事件标识
    const events: SessionEvent[] = [];
    const runner = h.makeRunner(model, (e) => events.push(e));
    // 注意：此处不经 spawn 工具（子面已剔除 spawn），直接调 runSubagent 双发同名并行
    const p1 = runner.runSubagent({ prompt: 'p1', label: 'w' });
    const p2 = runner.runSubagent({ prompt: 'p2', label: 'w' });
    await new Promise((res) => setTimeout(res, 30)); // 等两个子 Reactor 先后创建（后到者消歧）
    gateResolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.ok && r2.ok);
    const tags = events.filter((e) => e.type === 'done').map((e) => e.payload?.subagent);
    assert.deepEqual([...tags].sort(), ['w', 'w#2'], `两个在飞同名子代理事件标识应互异，实际 ${JSON.stringify(tags)}`);
    const chain = h.context.chainView();
    const nodeLines = chain.filter((s) => s.action === 'node').map((s) => s.observation);
    assert.equal(nodeLines.length, 2);
    assert.ok(nodeLines.every((l) => l.startsWith('[w')), `结论行前缀应带消歧 label，实际 ${JSON.stringify(nodeLines)}`);
    // 顺序结束后第三次 spawn：计数归零，回到裸 label
    const r3 = await runner.runSubagent({ prompt: 'p3', label: 'w' });
    assert.ok(r3.ok);
    assert.ok(events.some((e) => e.type === 'done' && e.payload?.subagent === 'w'), '并发清零后新 spawn 应回裸 label');
    runner.detachParent();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/harness/subagent.test.js`
Expected: 新用例 FAIL（payload 出现两个 'w'，deepEqual 不匹配）

- [ ] **Step 3: 最小实现**（subagent.ts）

```ts
// 类字段新增
private inFlightLabels = new Map<string, number>(); // base label → 在飞计数（含后缀者按 base 归组）

// runSubagent 内、并发检查通过后：
const n = this.inFlightLabels.get(label) ?? 0;
const finalLabel = n > 0 ? `${label}#${n + 1}` : label;
this.inFlightLabels.set(label, n + 1);
// 后续：事件包装 payload.subagent = finalLabel；结论/补丁行 [finalLabel]；finally 内计数 -1（减到 0 删键）
```

- [ ] **Step 4: 定向验证**

Run: `pnpm build && node --test dist/harness/subagent.test.js dist/harness/subagent.spawn.test.js dist/graph/agents.test.js`
Expected: 全绿（既有 spawn/graph 套件零回归——单发场景 label 不变）

- [ ] **Step 5: Commit**

```bash
git add src/harness/subagent.ts src/harness/subagent.test.ts
git commit -m "feat(subagent): 同名并发 spawn 消歧——后到者 label #N 后缀（事件标识与结论行一致，Runner 单点）"
```

---

### Task 2: tool-verbs 登记 spawn + session 子代理分流与归档（数据面）

**Files:**
- Modify: `src/tui/tool-verbs.ts`（VERBS/TARGET_FIELD 补 spawn）
- Modify: `src/tui/tool-verbs.test.ts`
- Modify: `src/tui/session.ts`（ChildLiveState、onEvent 分流、归档逻辑）
- Modify: `src/tui/session.test.ts`

**Interfaces:**
- Consumes: `SessionEvent.payload.subagent: string`（Runner 已有）；`toolCallLine(tool, input)`；`NOTIFY_THROTTLE_MS=120` 节流既有实现。
- Produces（Task 3 渲染依赖）:
  - `ChildLiveState { label: string; startedAt: number; steps: number; tokens: number; transcript: string[]; tail: string[] }`（session.ts 导出，规格 §4.2：tail = transcript 末 ≤3 行，含未成行）
  - `TuiState.children: ChildLiveState[]`（缺省 []，不变式：空数组不参与渲染）
  - 分流规则（onEvent 首查 `e.payload?.subagent`）：
    | 事件 | 处理（全部 return，不进主链分支） |
    |---|---|
    | token/reasoning | 半行缓冲拼 delta，`\n` 成行追加 transcript，刷新 tail（= transcript 末 ≤3 行含未成行）；notifyThrottled() |
    | tool-call | `toolCallLine(e.text, e.payload?.input)` 成行追加；notifyThrottled() |
    | tool-result | 成行追加（文本为观察摘要行）；notifyThrottled() |
    | step | steps+1；notifyThrottled() |
    | usage | tokens += payload.turnTotal 增量（按「基线+本轮」聚合与主链同构：记录 per-child usageBase）；notifyThrottled() |
    | done/error/ctx/route/approval-* | 忽略（归档锚点在主链 tool-result） |
  - 归档（onEvent 主链 `tool-result` 分支内、pushMsg 之前）：`e.payload?.tool === 'spawn'` 时——基名 = 对应 spawn **tool-call 事件入参** `input.label ?? input.agent_id ?? 'subagent'`（session 侧维护 spawn 调用栈：主链 tool-call 且 `e.text === 'spawn'` 时压栈基名，tool-result 时弹出）；匹配 children 中未归档项（label 精确 → `#` 前缀 → FIFO 兜底）；命中项：半行缓冲 flush 成行 → transcript 作为**该 spawn 调用行 ChatItem 的 detail 追加**（调用行为同批先入档的 tool call 行，向前查找最近 `kind==='call'` 且 text 为 SPAWN 行的条目），children 移除该项；未命中：仅在 children 为空时静默跳过（孤儿容忍，规格 §8）
  - 生命周期：`runTaskFlow` 收束（closeTask）、`/new` reset 时 `children: []`
  - tool-verbs：`VERBS.spawn = 'SPAWN'`、`TARGET_FIELD.spawn = 'label'`（target 显示 label，无 label 回退 agent_id 缺省链）

- [ ] **Step 1: 写失败测试**（`src/tui/tool-verbs.test.ts` 追加断言 + `src/tui/session.test.ts` 追加子代理面用例）

```ts
// session.test.ts 追加（构造对齐既有惯用法：SessionController + ScriptedAdapter；分流用直喂 onEvent 注入口）
test('子代理事件分流：payload.subagent 存在 → 进 children，主链 messages/live 零污染', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-child1-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'token', text: '子代理', payload: { subagent: 'w' } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'read', payload: { input: { path: 'a.ts' }, subagent: 'w' } } as never);
    const s = ctrl.getState();
    assert.equal(s.children!.length, 1);
    assert.equal(s.children![0].label, 'w');
    assert.ok(s.children![0].tail.length >= 1 && s.children![0].tail.length <= 3, 'tail ≤3 行（含未成行）');
    assert.equal(s.messages.length, 0, '主链零污染');
    assert.equal(s.live, undefined, '主链 live 零污染');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('spawn 全链归档：children 移除 + 调用行 detail 附转录（恰好一次）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-child2-'));
  try {
    // 三条脚本：主链 spawn 信封 → 子代理 done（子面消费）→ 主链 done
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
      '{"tool":"spawn","input":{"prompt":"子任务","label":"w"},"done":false}',
      '{"done":true,"reply":"子任务报告"}',
      '{"done":true,"reply":"主链完成"}',
    ]) });
    const p = ctrl.submit('主任务');
    await waitFor(() => ctrl.getState().messages.some((m) => m.role === 'tool' && m.kind === 'call'));
    // 子代理真实运行期事件会经 Harness 装配 onEvent 自动到达（带 payload.subagent）；
    // 此处补喂一条合成 token 验证转录捕获（真实 ScriptedAdapter 非流式，reply 经 done 不产生增量帧）
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: 'w' } } as never);
    await p;
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.children!.length, 0, '归档后 children 清空');
    const call = s.messages.find((m) => m.role === 'tool' && m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call, 'spawn 调用行应上屏（SPAWN w）');
    assert.ok(call!.detail && call!.detail.includes('分析中'), '调用行 detail 应含子代理转录');
    assert.ok(s.messages.some((m) => m.kind === 'result' && (m.text ?? '').includes('子任务报告')), '结果行上屏');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('同名并发归档：前缀匹配 #N 子代理各归档一次（规格 §9④）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sess-child3-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'token', text: 'A 线\n', payload: { subagent: 'w' } } as never);
    ctrl.onEventForTest({ type: 'token', text: 'B 线\n', payload: { subagent: 'w#2' } } as never);
    // 模拟 Task 1 消歧后的两条同名 spawn 结果流：先压调用（基名均为 w），逐条结果归档
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p1', label: 'w' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '子完成', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'p2', label: 'w' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '子完成', payload: { tool: 'spawn', ok: true } } as never);
    const s = ctrl.getState();
    assert.equal(s.children!.length, 0, '两条同名子代理应恰好各归档一次');
    const details = s.messages.filter((m) => m.kind === 'call').map((m) => m.detail ?? '');
    assert.equal(details.filter((d) => d.includes('A 线')).length, 1, 'A 线转录恰好归档一次');
    assert.equal(details.filter((d) => d.includes('B 线')).length, 1, '#2 子代理按前缀匹配归档一次');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
```

```ts
// tool-verbs.test.ts 追加（文件既有 import 已含 toolCallLine，无需新增）
test('toolCallLine：spawn 映射 SPAWN + label 摘要', () => {
  assert.equal(toolCallLine('spawn', { prompt: 'x', label: 'w' }), 'SPAWN w');
  assert.equal(toolCallLine('spawn', { prompt: 'x' }), 'SPAWN subagent');
});
```

（`onEventForTest` 为本任务新增的测试注入口：`/** 测试注入口：直喂 SessionEvent 走完整分流路径（等价 runtime onEvent 回调） */ onEventForTest(e: SessionEvent): void { this.onEvent(e); }`——生产路径零改动。同名并发用例中 tool-result 事件文本同为 '子完成'：归档归属完全由「精确 → # 前缀」匹配决定，不以文本区分。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tui/tool-verbs.test.js dist/tui/session.test.js`
Expected: 新用例 FAIL（children 不存在/SPAWN 未映射）

- [ ] **Step 3: 最小实现**
1) tool-verbs.ts：VERBS/TARGET_FIELD 补 spawn 两行。
2) session.ts：
   - 导出 `ChildLiveState`；`TuiState` 增 `children: ChildLiveState[]`（两处 state 初始化补 `children: []`）；
   - 私有字段：`spawnCalls: string[]`（基名栈）、`childLines = new Map<string, { buf: string; usageBase: number }>`（半行缓冲 + usage 基线，随 child 创建/归档增删）；
   - `onEvent` 首行分流：`const sub = e.payload?.subagent; if (typeof sub === 'string') { this.onChildEvent(e, sub); return; }`；
   - `onChildEvent(e, label)`：upsert child（Map 查找 → 缺则 push 新 ChildLiveState）→ 按 §Interfaces 事件表处理 → tail 同步 → notifyThrottled()；
   - 主链 `tool-call` 分支：`e.text === 'spawn'` 时压栈基名；主链 `tool-result` 分支：`e.payload?.tool === 'spawn'` 时归档（需要 reactor 在 tool-result payload 补 `tool` 名——**并入本任务的最小接线**：`src/harness/reactor.ts` 两处 `emit('tool-result', …)` payload 增 `tool: <工具名>`（单发 L254 与并行 L414），纯遥测字段、不进提示词）；归档 detail 追加定位：从 messages 末尾向前找最近 `kind==='call'` 且 `text.startsWith('SPAWN ')` 的条目替换该 ChatItem（Static 区已打印行不重绘、detail 在后续 Tab/Ctrl+O 重挂重放时生效——符合既有 detail 语义）；
   - `closeTask()` 与 `/new`：`children: []` + `childLines.clear()` + `spawnCalls = []`。

- [ ] **Step 4: 定向验证**

Run: `pnpm build && node --test dist/tui/tool-verbs.test.js dist/tui/session.test.js dist/tui/session.plan.test.js dist/harness/reactor.test.js`
Expected: 全绿（session 既有套件零回归；reactor 遥测字段新增零行为变化）

- [ ] **Step 5: Commit**

```bash
git add src/tui/tool-verbs.ts src/tui/tool-verbs.test.ts src/tui/session.ts src/tui/session.test.ts src/harness/reactor.ts
git commit -m "feat(tui): 子代理事件分流与归档数据面——TuiState.children 运行中面板态、spawn 结果整段转录折入调用行 detail；tool-verbs 登记 SPAWN；reactor tool-result 遥测补 tool 名"
```

---

### Task 3: ChildPanel 渲染组件 + App 挂载（渲染面）

**Files:**
- New: `src/tui/components/ChildPanel.tsx`
- New: `src/tui/components/ChildPanel.test.tsx`
- Modify: `src/tui/components/Spinner.tsx`（增可选 `label?: string` prop：非空时在动词段前缀 `[label] `，缺省渲染零变化——供面板头部单行携带标识）
- Modify: `src/tui/components/App.tsx`（挂载；props 直通 state.children/columns）

**Interfaces:**
- Consumes: `ChildLiveState`（Task 2）；`Spinner`（本任务扩展为 `{ startedAt, tokens, label? }`）；`wrapByWidth`（`src/tui/text-band.ts`）。
- Produces: `<ChildPanel childrenState={state.children} columns={columns} />`——childrenState 为空渲染 `<Box />`（零占位）；否则纵向堆叠每子代理恒 4 行（头部 1 + 尾流 3，不足补空行）；头部 = Spinner（带 `[label]` 前缀）；尾流行取 tail 按宽度截断（`wrapByWidth(line, columns - 4)` 取首行、dimColor）。

- [ ] **Step 1: 写失败测试**（`src/tui/components/ChildPanel.test.tsx`，渲染断言对齐 LiveArea.test.tsx 惯用法）

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ChildPanel } from './ChildPanel';
import { ChildLiveState } from '../session';

const child = (over: Partial<ChildLiveState> = {}): ChildLiveState => ({
  label: 'w', startedAt: Date.now(), steps: 2, tokens: 1200,
  transcript: ['READ a.ts', '4 matches', '分析结论'], tail: ['READ a.ts', '4 matches', '分析结论'],
  ...over,
});

test('ChildPanel：空 children 零占位；单面板恒 4 行；tail ≤3 行轮转帧高不变', () => {
  const empty = render(<ChildPanel childrenState={[]} columns={80} />);
  assert.equal((empty.lastFrame() ?? '').trim(), '');
  empty.unmount();

  const one = render(<ChildPanel childrenState={[child()]} columns={80} />);
  const f1 = one.lastFrame() ?? '';
  assert.match(f1, /\[w\]/, '头部应含 [label]');
  assert.match(f1, /READ a\.ts/, '尾流应含最近行');
  const lines1 = f1.replace(/\n$/, '').split('\n').length;
  one.unmount();

  const rotated = render(<ChildPanel childrenState={[child({ tail: ['行二', '行三', '行四最新'] })]} columns={80} />);
  const lines2 = (rotated.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  assert.equal(lines1, lines2, 'tail 轮转前后帧高恒定（恒 4 行面板）');
  assert.ok((rotated.lastFrame() ?? '').includes('行四最新'), '应显示最新尾行');
  rotated.unmount();
});

test('ChildPanel：并发 4 面板同屏、总高 = 4×单面板恒定（护栏）', () => {
  const one = render(<ChildPanel childrenState={[child()]} columns={80} />);
  const base = (one.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  one.unmount();
  const four = render(<ChildPanel childrenState={[1, 2, 3, 4].map((i) => child({ label: `w${i}` }))} columns={80} />);
  const f = four.lastFrame() ?? '';
  for (const i of [1, 2, 3, 4]) assert.ok(f.includes(`[w${i}]`), `面板 ${i} 应同屏`);
  assert.equal(f.replace(/\n$/, '').split('\n').length, base * 4, '4 面板总高 = 4×单面板恒定');
  four.unmount();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tui/components/ChildPanel.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

1) Spinner.tsx 增可选 label（缺省行为零变化）：

```tsx
export function Spinner({ startedAt, tokens, label }: { startedAt: number; tokens: number; label?: string }): JSX.Element {
  // …帧/计时逻辑原样…
  return (
    <Text color="green" dimColor>
      {glyph} {label ? `[${label}] ` : ''}<Text dimColor>{verb}… ({secs}s · ↑{formatTokens(tokens)} tokens)</Text>
    </Text>
  );
}
```

2) ChildPanel.tsx：

```tsx
import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLiveState } from '../session';
import { wrapByWidth } from '../text-band';
import { Spinner } from './Spinner';

/** 子代理并行面板（动态区）：运行中实时流式尾，恒定 4 行/面板——动态区高度波动即整帧重排闪烁，
 *  tail 轮转只换内容不增减行数（规格 D5）；结束后由 session 归档进 spawn 调用行 detail（本组件即消失） */
export function ChildPanel({ childrenState, columns }: { childrenState: ChildLiveState[]; columns: number }): JSX.Element {
  if (childrenState.length === 0) return <Box />;
  return (
    <Box flexDirection="column">
      {childrenState.map((c) => {
        const tail = c.tail.slice(-3);
        const pad = Array.from({ length: 3 - tail.length }, () => '');
        return (
          <Box key={c.label} flexDirection="column">
            <Spinner startedAt={c.startedAt} tokens={c.tokens} label={c.label} />
            {[...pad, ...tail].map((l, i) => (
              <Text key={i} dimColor>{wrapByWidth(l, Math.max(8, columns - 4))[0] ?? ''}</Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
```

3) App.tsx 在 Spinner 行与审批卡之间挂载：`{state.children.length > 0 ? <ChildPanel childrenState={state.children} columns={columns} /> : null}`。

- [ ] **Step 4: 定向验证**

Run: `pnpm build && node --test dist/tui/components/ChildPanel.test.js dist/tui/components/App.test.js dist/tui/components/App.visual.test.js`
Expected: 全绿（App 既有断言零回归）

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/ChildPanel.tsx src/tui/components/ChildPanel.test.tsx src/tui/components/Spinner.tsx src/tui/components/App.tsx
git commit -m "feat(tui): ChildPanel 并行迷你面板——恒 4 行实时流式尾、空态零占位、动态区高度恒定；Spinner 增可选 label 前缀"
```

---

### Task 4: 归档展开路径核对 + TUI-MANUAL 同步 + 全量回归收口

**Files:**
- Verify: `src/tui/transcript-view.ts`（detail 重放路径——预期零改动；Ctrl+O 对最近正文锚点阶段的 `full` 放行已覆盖 tool 行 detail）
- Modify: `TUI-MANUAL.md`（子代理段补显示形态：运行中面板 / 结束归档 / 展开方式）
- Test: 全量回归

**Interfaces:**
- Consumes: Task 2 归档（detail 附着于 spawn 调用行 ChatItem）；既有 buildTranscriptDecisions 两层折叠。
- Produces: 文档口径与实现一致；全量绿。

- [ ] **Step 1: 展开路径核对（用例先行）**

在 `src/tui/transcript-view.test.ts` 或 session 套件补一条断言：spawn 调用行 detail 在 `latestFull` 视图下可全文重放（沿 buildTranscriptDecisions 对 tool 行 full 的既有语义——若核对发现 SPAWN 行因折叠规则被不可见化，就地修正该规则使 detail 可达，改动登记进提交说明）。已有 detail 渲染路径（MessageRow → ToolRow，MessageList.tsx L107 同构）预期直接生效。

- [ ] **Step 2: 运行确认**

Run: `pnpm build && node --test dist/tui/transcript-view.test.js dist/tui/components/App.expand.test.js`
Expected: 全绿（或暴露折叠规则缺口 → 修正后绿）

- [ ] **Step 3: TUI-MANUAL.md 子代理段补显示口径**

```markdown
子代理显示：运行中在输入框上方为每个子代理显示恒定 4 行迷你面板（实时流式尾 + [label] 标识）；
结束后面板消失，整段转录折叠归档进该次 spawn 调用行（Ctrl+O 展开全文，Tab 展开历史行）；
同名并发自动消歧为 label#N。
```

- [ ] **Step 4: 全量回归收口**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: 全绿；全量计数 ≥ 581 + 本计划新增用例数；前缀缓存既有回归用例（相邻步稳定 / 主链↔fork 首帧）保持绿。

- [ ] **Step 5: Commit**

```bash
git add TUI-MANUAL.md src/tui/transcript-view.ts
git commit -m "docs(tui): 子代理显示口径同步手册；归档展开路径核对收口 + 全量回归"
```

> 注：Step 1 若 transcript-view 零改动，`git add` 仅 TUI-MANUAL.md（路径按实际改动面为准，禁止空文件入库）。

---

## Self-Review

- **规格覆盖**：§4 数据面→Task 2（分流/事件映射/归档/生命周期逐条落位，含自审修正的「归档关联基名=调用行入参」与「半行 flush 成行」）；§5 渲染面→Task 3（恒 4 行、空态零占位、挂载位 Spinner 下）；§6 归档与展开→Task 2 归档 + Task 4 展开核对（tool-verbs SPAWN 登记同步落实）；§7 Runner 消歧→Task 1；§8 错误边界→Task 2 归档未命中容忍 + Task 1 已知边界登记；§9 测试矩阵→各任务用例逐条对应（分流零污染/恰好一次归档/4 并发/同名消歧/终态完整/生命周期清空）；§10 落点表逐文件映射到任务 Files；§11 前缀缓存→Global Constraints 禁触碰条款 + Task 4 收口核对。
- **占位符扫描**：无 TBD/TODO/未定义引用——Task 1 测试代码自包含（gate/calls 内联声明、复用同文件 makeRunner 惯用法）、Task 2 含 `onEventForTest` 注入口定义与 tool-verbs 既有 import 说明、Task 3 测试以 `baseLines` 变量直接比较、`childrenState` prop 命名规避 React 保留名。
- **跨任务签名一致**：`ChildLiveState`（Task 2 导出 → Task 3 测试消费同名字段 label/tail）；`TuiState.children`（Task 2 → Task 3 props 直通）；`#N` 后缀（Task 1 → Task 2 匹配规则）；`payload.tool` 遥测（Task 2 内 reactor 接线 → 同任务归档消费，不跨任务）。
- **探索期事实修正**（相对规格的一处偏差登记）：规格 §4.3 表格中「spawn 结果行 = Runner 回写文本（[label] 结论）」与实现不符——spawn 工具观察实为子代理 reply 全文（describe(full) 首行 200 字符上屏、全文入 detail），已按实现修正计划；归档锚点事件序论证不变（子 done 先于主链 tool-result，ScriptedAdapter 共享序列即天然顺序）。
