# 呈现层统计增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子代理完成统计可回放（done 行补步数/耗时、归档摘要行入档）、主 agent 任务收尾产出 ⏱ 统计行（入档）、状态栏 ↑tokens 合并子代理消耗。

**Architecture:** 全部落在既有数据流上——`ChildLiveState` 补 `doneAt` 冻结耗时；`archiveInto()` 归档时把 `tokens` 写进 `subagentMeta` 并在 detail 尾追摘要行；子代理 usage 事件路由处增量累加 `turnChildTokens`/`sessionChildTokens` 两级累计器；任务流起点建统计基线快照、`closeTask()` done 路径以差值产出统计行经 `pushMsg('system')` 入档。

**Tech Stack:** TypeScript strict + Node.js（node --test）、ink（test-ink 渲染测试）。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-26-stats-enhancement-design.md`（三项用户裁决：归档行内补统计 / dim 系统行入档 / 合并总数；子代理 cache 命中率不做）。

## Global Constraints

- 历史区保持 ink Static 零改动（09-26 闪屏撤回裁决）：统计行只经 `pushMsg` 尾追入档，禁止任何重绘/重放路径。
- 用户可见系统行走 `t(en, zh)` 双语（外观面）；SPAWN 归档 detail 内的摘要行走英文形态（与 transcript 既有行一致，非 `t()` 面）。
- 零新增依赖；稳定段/工具清单零改动；fork-safe（子代理面零变化）。
- 测试统一 `pnpm test`；单文件跑 `node --test dist/<path>.test.js`；改后 `pnpm build` 零报错。
- **提交纪律**：只圈定本主题文件。`src/tui/session.ts` 当前混有并行会话 WIP（/resume 丢档修复：`flushReply`/journal 挂钩区域）——每个含 session.ts 的提交步骤前必须 `git diff src/tui/session.ts` 审查 hunk 归属；若混有非主题 hunk（flushReply 切块入档、journal 相关），该任务提交 **parked**（跳过 commit 步骤、勾选注明，改动保留工作区），收尾任务统一汇报。

---

### Task 1: doneAt 字段 + ChildPanel done 行统计

**Files:**
- Modify: `src/tui/session.ts`（ChildLiveState 接口 + done/error 事件分支，约 103 行接口、1724 行事件分支）
- Modify: `src/tui/components/ChildPanel.tsx:21`（done 行）
- Test: `src/tui/components/ChildPanel.test.tsx`

**Interfaces:**
- Consumes: `ChildLiveState`（session.ts 导出）、`formatDuration`/`formatTokens`（`../format`，ChildPanel 已导入）。
- Produces: `ChildLiveState.doneAt?: number`（Task 4 无依赖；Task 2 归档摘要行可选消费）。

- [ ] **Step 1: 写失败测试**（追加到 `src/tui/components/ChildPanel.test.tsx` 末尾）

```tsx
test('ChildPanel：done 行含步数/冻结耗时/tokens（doneAt 冻结，不随帧跳动）', () => {
  const start = Date.now() - 5000;
  const one = render(
    <ChildPanel childrenState={[child({ done: true, doneAt: start + 4000, startedAt: start, steps: 14, tokens: 1300 })]} columns={80} />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /✓ \[w\] done \(14 steps · 4s · ↑1\.3k tokens\)/, 'done 行 = steps · 冻结耗时 · tokens');
  one.unmount();
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build && node --test dist/tui/components/ChildPanel.test.js`
Expected: 新用例 FAIL（doneAt 类型不存在编译报错 / done 行缺 steps·耗时 段）。注意：若既有用例锁了旧 done 行格式 `done (↑… tokens)`，红点可能先在那里出现——一并改写为新格式断言（本主题文件）。

- [ ] **Step 3: 最小实现**

`src/tui/session.ts` ChildLiveState 接口（`done?: boolean` 之后）：

```ts
  /** 完成时刻（done/error 事件置位）：done 行耗时冻结在完成时刻，不随渲染帧跳动 */
  doneAt?: number;
```

done/error 事件分支（原 1724 行）：

```ts
        this.commitChild(list, idx, { ...child, transcript, steps, tokens, done: true, doneAt: Date.now() }, buf);
```

`src/tui/components/ChildPanel.tsx:21` done 行改为：

```tsx
            <Text backgroundColor={selectedLabel === c.label ? 'gray' : undefined} color="green" dimColor>✓ [{c.label}] done ({c.steps} steps · {formatDuration(Math.max(0, Math.round(((c.doneAt ?? Date.now()) - c.startedAt) / 1000)))} · ↑{formatTokens(c.tokens)} tokens)</Text>
```

- [ ] **Step 4: 跑绿**

Run: `pnpm build && node --test dist/tui/components/ChildPanel.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git diff src/tui/session.ts   # 审查 hunk：只应有 ChildLiveState.doneAt + done 分支两处主题 hunk
git add src/tui/session.ts src/tui/components/ChildPanel.tsx src/tui/components/ChildPanel.test.tsx
git commit -m "feat(tui): 子代理 done 行补步数/冻结耗时（doneAt 冻结，规格 2026-09-26-stats-enhancement §3.1）"
```

混有并行 WIP hunk（flushReply/journal 区域）→ 本步 parked，勾选注明。

---

### Task 2: subagentMeta.tokens + 归档摘要行

**Files:**
- Modify: `src/tui/session.ts`（ChatItem.subagentMeta 类型约 48 行、archiveInto 约 1773–1788 行、文件头 import 区）
- Test: `src/tui/session.subagent-bg.test.tsx`（追加一例）

**Interfaces:**
- Consumes: `formatTokens`/`formatDuration`（`./format`，session.ts 需新增 import）、`ChildLiveState.tokens/steps/startedAt`（Task 1 的 doneAt 不消费——归档时刻距 done 有主链收批延迟，duration 以归档锚点时刻为事实）。
- Produces: `subagentMeta: { steps: number; durationMs: number; tokens: number }`（ChildInspector 回看视图既有消费面自动获得 tokens；Task 4 不直接消费）。

- [ ] **Step 1: 写失败测试**（追加到 `src/tui/session.subagent-bg.test.tsx` 末尾）

```tsx
test('归档统计摘要：subagentMeta.tokens 在位、detail 尾行含 ⏱ 步数耗时 tokens', () => {
  const tmp = tmpdir('sunshinex-sess-stats-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '调研', label: 'r' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'task t-1 started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'step', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'step', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'r', turnTotal: 1200 } } as never);
    ctrl.onEventForTest({ type: 'done', text: '结论', payload: { subagent: 'r' } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call?.subagentMeta, 'subagentMeta 在位');
    assert.equal(call!.subagentMeta!.tokens, 1200, 'tokens 归档');
    assert.equal(call!.subagentMeta!.steps, 2, '步数归档');
    assert.match(call!.detail ?? '', /⏱ \S+ · 2 steps · ↑1\.2k tokens$/m, 'detail 尾行为统计摘要行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build && node --test dist/tui/session.subagent-bg.test.js`
Expected: 新用例 FAIL（subagentMeta 无 tokens 字段 / detail 无摘要行）。

- [ ] **Step 3: 最小实现**

session.ts import 区补：

```ts
import { formatDuration, formatTokens } from './format';
```

ChatItem.subagentMeta（原 47–48 行）：

```ts
  /** 子代理归档摘要（SPAWN call 行专属）：steps=子代理步数、durationMs=归档时刻-startedAt、tokens=子代理 token 消耗；零子事件即败时缺省 */
  subagentMeta?: { steps: number; durationMs: number; tokens: number };
```

archiveInto 内（detail 构造与 meta 行整体替换）：

```ts
    const durS = Math.max(0, Math.round((Date.now() - child.startedAt) / 1000));
    const detail = [...child.transcript, ...(buf ? [{ kind: 'text', text: buf } as ChildLine] : [])]
      .map((l) => (l.kind === 'result' ? `⎿ ${l.ok === false ? '✗' : '✓'} ${l.text}` : l.text))
      .concat(`⏱ ${formatDuration(durS)} · ${Math.max(1, child.steps)} steps · ↑${formatTokens(child.tokens)} tokens`)
      .join('\n');
    const subagentMeta = { steps: Math.max(1, child.steps), durationMs: Math.max(0, Date.now() - child.startedAt), tokens: child.tokens };
```

- [ ] **Step 4: 跑绿**

Run: `pnpm build && node --test dist/tui/session.subagent-bg.test.js`
Expected: 全部 PASS（含既有「后台 spawn 两段式」两例）。

- [ ] **Step 5: 提交**

```bash
git diff src/tui/session.ts   # hunk 审查同 Global Constraints
git add src/tui/session.ts src/tui/session.subagent-bg.test.tsx
git commit -m "feat(tui): 子代理归档摘要行（⏱ steps·耗时·tokens）与 subagentMeta.tokens（规格 §3.1）"
```

---

### Task 3: 子代理 token 累计器 + 状态栏合并口径

**Files:**
- Modify: `src/tui/session.ts`（StatusMetrics 接口约 55–71、初始 metrics 约 224、/new 重置字面量约 1085–1096、三处任务流起点 metrics 重置、applyChildEvent 'usage' 分支约 1713）
- Modify: `src/tui/components/StatusBar.tsx:49`
- Test: `src/tui/components/StatusBar.test.tsx`、`src/tui/session.subagent-bg.test.tsx`（各追加）

**Interfaces:**
- Consumes: 子代理 usage 事件（`payload.subagent` 路由、`payload.turnTotal` 为该子代理单 run 累计值）。
- Produces: `StatusMetrics.turnChildTokens: number`、`StatusMetrics.sessionChildTokens: number`（Task 4 消费 sessionChildTokens 做基线差值）。

- [ ] **Step 1: 写失败测试**

StatusBar.test.tsx：`metrics()` 夹具补 `turnChildTokens: 0, sessionChildTokens: 0` 两字段（编译需要），末尾追加：

```tsx
test('StatusBar：↑tokens 合并子代理消耗（主链+子代理总数）', () => {
  const f = frameOf(metrics({ turnTokens: 1200, turnChildTokens: 2_600_000 }), 'm');
  assert.match(f, /↑2601k tokens/, '↑tokens = 主链 + 子代理合并值');
});

test('StatusBar：ctx 水位与 cache 口径不受子代理 tokens 影响（维持仅主链）', () => {
  const f = frameOf(
    metrics({ turnChildTokens: 5_000_000, turnPromptTokens: 1000, sessionPromptTokens: 1000, sessionCacheTokens: 640 }),
    'm', 'idle', { used: 1000, window: 100_000 },
  );
  assert.match(f, /ctx 1k\/100k \(\d+(\.\d+)?%\)/, 'ctx 维持主链口径');
  assert.match(f, /cache 64\.0%/, 'cache 维持主链口径（cached/prompt）');
});
```

session.subagent-bg.test.tsx 追加：

```tsx
test('子代理 token 累计器：usage 增量并入 turn/session 两级（per-run 累计值取差值，不重复计）', () => {
  const tmp = tmpdir('sunshinex-sess-childtok-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: 'x', label: 'r' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'task t-1 started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: '', payload: { subagent: 'r' } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'r', turnTotal: 500 } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'r', turnTotal: 1200 } } as never);
    const m = ctrl.getState().metrics;
    assert.equal(m.turnChildTokens, 1200, 'turn 级 = 增量聚合（1200-500 差值）');
    assert.equal(m.sessionChildTokens, 1200, 'session 级同步累计');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build 2>&1 | head -30 && node --test dist/tui/components/StatusBar.test.js dist/tui/session.subagent-bg.test.js`
Expected: 编译报错列出所有缺新字段的 StatusMetrics 字面量位（逐个记录，Step 3 一并补）；新三例 FAIL。

- [ ] **Step 3: 最小实现**

StatusMetrics 接口（`ctxUsed` 之前）：

```ts
  /** 本轮子代理 tokens（payload.subagent usage 增量聚合；随任务流起点与 turnTokens 同步归零；状态栏 ↑tokens 合并项） */
  turnChildTokens: number;
  /** 会话累计子代理 tokens（跨任务不清零、仅 /new 归零；任务收尾统计行的子代理差值基线） */
  sessionChildTokens: number;
```

补齐全部 StatusMetrics 字面量位（Step 2 编译报错清单 = 权威清单，已知至少四处）：
- `session.ts:224` 初始 metrics：`turnChildTokens: 0, sessionChildTokens: 0`
- `session.ts` /new 重置字面量（约 1085–1096）：同上两行
- 三处任务流起点（`grep -n "turnStartedAt: Date.now(), turnTokens: 0" src/tui/session.ts`，startPlanFlow / runTaskFlow / runGoalFlow）：各补 `turnChildTokens: 0`（sessionChildTokens 不重置——跨任务累计）
- `StatusBar.test.tsx` metrics() 夹具

applyChildEvent 'usage' 分支（原 `tokens = …` 行后、落入底部 commitChild 前）：

```ts
      case 'usage': {
        // per-run turnTotal 为该子代理 run 的累计值（单一 run），直接采信
        tokens = typeof e.payload?.turnTotal === 'number' ? e.payload.turnTotal : child.tokens;
        // 子代理 token 两级累计（规格 §3.3）：per-run 累计值取对子代理前值的增量并入，归档不清零、仅 /new 归零
        const cm = this.state.metrics;
        const delta = Math.max(0, tokens - child.tokens);
        if (delta > 0) {
          this.state = { ...this.state, metrics: { ...cm, turnChildTokens: cm.turnChildTokens + delta, sessionChildTokens: cm.sessionChildTokens + delta } };
        }
        break;
      }
```

（底部 `commitChild` 以 `{ ...this.state, children: … }` 摊开，此处已并入的 metrics 保留。）

StatusBar.tsx:49：

```tsx
      {' '}↑{formatTokens(metrics.turnTokens + metrics.turnChildTokens)} tokens
```

- [ ] **Step 4: 跑绿 + 全量**

Run: `pnpm build && node --test dist/tui/components/StatusBar.test.js dist/tui/session.subagent-bg.test.js dist/tui/components/ChildPanel.test.js && pnpm test`
Expected: 主题面全 PASS；全量零新增失败（若出现批量 Cannot find module，见 Global Constraints 的并行 clean-dist 踩踏定性流程：单文件复跑归因）。

- [ ] **Step 5: 提交**

```bash
git diff src/tui/session.ts   # hunk 审查同 Global Constraints
git add src/tui/session.ts src/tui/components/StatusBar.tsx src/tui/components/StatusBar.test.tsx src/tui/session.subagent-bg.test.tsx
git commit -m "feat(tui): 状态栏 ↑tokens 合并子代理消耗（turn/session 两级累计器，规格 §3.3）"
```

---

### Task 4: formatTaskStatsLine + closeTask 收尾统计行（入档）

**Files:**
- Modify: `src/tui/session.ts`（模块级导出函数 + 私有字段 ×2 + beginTaskStats() + pushInterruptedNotice + closeTask + 三处任务流起点调用 + 两处失败路径清基线 + /new 清基线）
- Test: `src/tui/session.task-stats.test.tsx`（新建）

**Interfaces:**
- Consumes: `StatusMetrics.sessionChildTokens`（Task 3）、`formatDuration`/`formatTokens`（Task 2 已导入 session.ts）、`t()`（已导入）、`pushMsg`（既有私有方法）。
- Produces: `export function formatTaskStatsLine(durationS: number, steps: number, totalTokens: number, childTokens: number): string`（测试直接消费）。

- [ ] **Step 1: 写失败测试**（新建 `src/tui/session.task-stats.test.tsx`）

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setLanguage } from '../i18n';
import { SessionController, formatTaskStatsLine } from './session';
import { ScriptedAdapter } from '../model/adapter';

setLanguage('en');

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('formatTaskStatsLine：无子代理消耗省略子代理段', () => {
  assert.equal(formatTaskStatsLine(192, 25, 3_100_000, 0), '⏱ 3m 12s · 25 steps · ↑3.1M tokens');
});

test('formatTaskStatsLine：含子代理段（合并总数 + 子代理分量）', () => {
  assert.equal(formatTaskStatsLine(192, 25, 3_100_000, 2_600_000), '⏱ 3m 12s · 25 steps · ↑3.1M tokens (subagents 2.6M)');
});

test('任务收尾统计行：done 后 messages 尾部产出 ⏱ 行（基线差值口径）', async () => {
  const tmp = tmpdir('sunshinex-sess-stats2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"好的"}']) });
    await ctrl.submit('写个总结');
    const msgs = ctrl.getState().messages;
    const last = msgs[msgs.length - 1]!;
    assert.equal(last.kind, 'system', '统计行为 system 行（入档、/resume 可回放）');
    assert.match(last.text, /⏱ \S+ · \d+ steps · ↑\d+(\.\d+)?k? tokens/, '形态 = ⏱ 时长 · steps · tokens');
    assert.ok(!last.text.includes('subagents'), '无子代理消耗省略子代理段');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build 2>&1 | head -5; node --test dist/tui/session.task-stats.test.js`
Expected: `formatTaskStatsLine` 未导出编译失败 / 收尾行断言 FAIL。

- [ ] **Step 3: 最小实现**

session.ts 模块级（ChildLiveState 接口之后、spawnBaseLabel 附近）：

```ts
/** 任务收尾统计行（规格 2026-09-26-stats-enhancement §3.2）：done 正常完成路径尾追入档；无子代理消耗省略子代理段 */
export function formatTaskStatsLine(durationS: number, steps: number, totalTokens: number, childTokens: number): string {
  const base = `⏱ ${formatDuration(Math.max(0, durationS))} · ${Math.max(0, steps)} steps · ↑${formatTokens(Math.max(0, totalTokens))} tokens`;
  return childTokens > 0
    ? t(`${base} (subagents ${formatTokens(childTokens)})`, `${base}（含子代理 ${formatTokens(childTokens)}）`)
    : t(base, base);
}
```

SessionController 类内私有字段（taskAbort 声明附近）：

```ts
  /** 任务统计基线（规格 §3.2）：任务流起点建（与 turnTokens 归零同点）、closeTask done 路径算差值产出统计行 */
  private taskStats?: { startedAt: number; startSteps: number; startTokens: number; startChildTokens: number };
  /** 中断抑制位：pushInterruptedNotice 单点置位——中断路径不产出收尾统计行 */
  private taskStatsSuppressed = false;
```

私有方法（closeTask 之前）：

```ts
  /** 任务统计基线建立单点：任务流起点调用（同点 turnTokens 已归零，startTokens 即 0 起算主链增量） */
  private beginTaskStats(): void {
    this.taskStats = { startedAt: Date.now(), startSteps: this.state.metrics.sessionSteps, startTokens: this.state.metrics.turnTokens, startChildTokens: this.state.metrics.sessionChildTokens };
    this.taskStatsSuppressed = false;
  }
```

三处任务流起点（Task 3 已定位的同三处 metrics 重置之后）各加一行 `this.beginTaskStats();`。
`pushInterruptedNotice()` 体内补 `this.taskStatsSuppressed = true;`。
closeTask 守卫之后插入：

```ts
    // 任务收尾统计行（规格 §3.2）：done 正常完成路径产出（基线差值，含子代理合并口径）；中断经抑制位跳过；error 态不走 closeTask
    if (this.taskStats && !this.taskStatsSuppressed) {
      const ts = this.taskStats;
      const m = this.state.metrics;
      const mainTokens = Math.max(0, m.turnTokens - ts.startTokens);
      const childTokens = Math.max(0, m.sessionChildTokens - ts.startChildTokens);
      this.pushMsg('system', formatTaskStatsLine(Math.round((Date.now() - ts.startedAt) / 1000), m.sessionSteps - ts.startSteps, mainTokens + childTokens, childTokens));
    }
    this.taskStats = undefined;
```

失败早退路径清基线（error 路径不产出统计行）：startPlanFlow 的「规划失败 catch」与「未产出编号步骤 return」两处、`closeTask()` 调用前各加 `this.taskStats = undefined;`。/new 处理体内加 `this.taskStats = undefined;`。

- [ ] **Step 4: 跑绿**

Run: `pnpm build && node --test dist/tui/session.task-stats.test.js dist/tui/session.subagent-bg.test.js && pnpm test`
Expected: 主题面全 PASS；全量零新增失败。

- [ ] **Step 5: 提交**

```bash
git diff src/tui/session.ts   # hunk 审查同 Global Constraints
git add src/tui/session.ts src/tui/session.task-stats.test.tsx
git commit -m "feat(tui): 任务收尾 ⏱ 统计行（时长·步数·tokens 含子代理，入档可回放，规格 §3.2）"
```

中断抑制路径说明（非占位，是已评估的边界）：session 级夹具无确定性中断接缝（ScriptedAdapter 不支持挂起触发 interrupt），`taskStatsSuppressed` 由 `pushInterruptedNotice` 单点置位承载语义；该单点是全部中断路径的唯一汇点，代码路径审查 + 既有中断流程回归守护。

---

### Task 5: 终验 + 提交协调收尾

**Files:**
- 无新增改动（验证与收尾任务）。

- [ ] **Step 1: 全量 + selfcheck**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: build 零报错；全量零新增失败（并行 WIP 基线红灯以单文件复跑 + `git stash` 对照归因，同既有定性流程）；selfcheck exit=0。

- [ ] **Step 2: 提交协调汇报**

逐任务核对提交状态：凡因 session.ts 混入并行 WIP 而 parked 的提交，向用户列出（含 parked 原因：/resume 丢档修复主题同文件未入库），请用户裁决——先提交并行主题再补提，或合并提交由用户确认。全部入库后工作区应仅余并行会话 WIP 文件。

---

## Self-Review 结论（已执行）

1. **Spec coverage**：§3.1 done 行（Task 1）+ 归档摘要行/subagentMeta.tokens（Task 2）；§3.2 收尾统计行（Task 4，含基线差值/省略规则/中断·error 边界）；§3.3 状态栏合并 + ctx/cache 口径不变（Task 3）；§5 测试计划逐条有落点（中断抑制无确定性接缝已在 Task 4 显式声明）。无缺口。
2. **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码；「已知至少四处」字面量位有权威枚举来源（编译器报错清单），非占位。
3. **Type consistency**：`doneAt?: number`（Task 1 定义、ChildPanel 消费）；`subagentMeta.tokens: number`（Task 2 定义）；`turnChildTokens/sessionChildTokens: number`（Task 3 定义、Task 4 消费）；`formatTaskStatsLine` 签名（Task 4 定义 = 测试消费）。一致。
