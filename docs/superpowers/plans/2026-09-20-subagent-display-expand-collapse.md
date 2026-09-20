# 子代理显示逐行展开/折叠 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个 `[SPAWN]` 调用行可逐行独立展开/折叠——折叠=任务名摘要单行（步数/耗时尾注），展开=头行 `▾` + 思考与工具转录缩进重放；Ctrl+B 进入浏览模式用 ↑/↓ 高亮、Enter 切换、Esc 退出。

**Architecture:** 纯 TUI 渲染与交互层改动，零提示词/前缀缓存影响、零新工具、零 journal 事件。数据面仅两处小增：`ChatItem.subagentMeta`（archiveChild 归档时同 map 写入 steps/耗时）与 `RetainedUiState.spawnExpanded`（展开行 seq 集合，跨 resize 重挂保留、不持久化）。渲染面在 ToolRow 的 SPAWN call 分支加两态；交互面在 App useInput 加 Ctrl+B 浏览模式短接管 ↑/↓/Enter/Esc。

**Tech Stack:** TypeScript strict + ink 3 + React 18（CJS），node:test 测试，pnpm/node scripts/run-tests.js 测试启动器。

## Global Constraints

- 提示词与链行恒英文单语；本改动全部为外观面（上屏显示），用户可见提示文案一律 `t(en, zh)` 双语调用时求值，禁止模块级常量冻结语言（CLAUDE.md §15）
- 前缀缓存第一要义：零 `appendChain`/装配面改动；新增任何进上下文的产出面须盘点动态源——本计划无任何此类面（CLAUDE.md §11）
- 工具清单零新增：不动 tools.ts/builtin.ts，无前缀断点
- 平台纪律：路径一律 path.join/path.resolve；pnpm scripts 零 shell 语法依赖（CLAUDE.md §14）
- 图标字形禁带 emoji 呈现属性（⏺/✳ 教训）：本计划用 `●`（折叠态，既有）与 `▾`/`▸`（展开/折叠头标，均无 emoji 变体）
- 测试纪律：新测试文件独立命名防并发线竞态；Spinner 定时器测试必须 unmount（断言失败先于 unmount 会泄漏 setInterval 挂起事件循环）；单文件测试跑编译产物 `node --require ./scripts/test-env.cjs --test --test-force-exit dist/<path>.test.js`
- 全局门禁：`npx tsc -p tsconfig.json` 零报错（工作区混叠并发线 WIP，报错须甄别归属）；定向套件全绿；`node scripts/run-tests.js` 全量 fail 0（并发线在飞 WIP 的既有红如实登记归属，硬闸门只对本线新增用例与既有 TUI 套件）；`node dist/cli/index.js selfcheck` OK
- 设计规格：docs/superpowers/specs/2026-09-20-subagent-display-expand-collapse-design.md（验收矩阵 A1–A8 为本计划的验收来源）
- 浏览模式进入门槛：仅 `state.status === 'idle' || state.status === 'error'` 可进入（规格裁定比 Tab 更保守：Tab 运行中可切因其只改视图模式，浏览模式短接管 ↑/↓ 与运行中 steer 取回/审批键存在语义交叠，收窄门槛免歧义）；awaiting-approval/awaiting-plan/awaiting-question 等模态键盘态由既有分发序自然优先，浏览模式分支排在全部模态分支之后

## 落点与现行代码事实（已逐字节核实，实施时以此为基线；行号为 2026-09-20 快照、以锚点文本为准）

- `src/tui/components/ToolRow.tsx`：call 分支 `const detailLines = item.detail && !collapsed ? item.detail.split('\n') : [];`，头行 `<Text dimColor>● </Text><Text color="cyan">[{verb}]</Text>{target && <Text color="gray"> {target}</Text>}`
- `src/tui/session.ts`：`ChatItem`（L26-41，字段 seq/kind/ok/level/detail）；`spawnCalls: { seq: number; base: string }[]`（L194）；`onEvent` spawn call 行 `if (e.text === 'spawn') this.spawnCalls.push({ seq: this.msgSeq, base: spawnBaseLabel(e.payload?.input) })`（L1135）；`private archiveChild()`（L1296-1313，messages 经 `map((m) => (m.seq === pending.seq ? { ...m, detail } : m))` 回填）；`ChildLiveState` 含 `label/startedAt/steps/tokens/done`（done 为并行完成态修复线新增字段）
- `src/tui/components/App.tsx`：useInput 分发序 = awaiting-question（L222）→ approval（L293）→ awaiting-plan（L305）→ ↑ steer 取回（L382）→ idle/error 输入历史 ↑↓（L393）→ Tab（L317）→ Ctrl+O（L343）→ Home/End/⌦/Ctrl+A/E → 普通字符入缓冲（L443）；重绘触发 effect `}, [expandAll, latestFull]);`（L161）；retain 回写 effect（L144-151）；MessageList 挂载（L452-459）；渲染态 `const [expandAll, setExpandAll]`/`latestFull` 自 `store`（L138-139）
- `src/tui/ui-state.ts`：`RetainedUiState { buffer; cursor; expandAll; latestFull; history; histIdx }` + `initialRetained()`
- `src/tui/components/MessageList.tsx`：`buildTranscriptDecisions(messages, { expandAll, latestFull })` 逐条预计算 `{ full, visible }`；`<MessageRow item collapsed={!entry.full}>`；ToolRow 调用点在 MessageRow 尾部；`TranscriptEntry` message 变体字段 `{ item, full, visible }`
- 测试基线：`ToolRow.spawn.test.tsx`（render + lastFrame 口径）、`App.test.tsx`（render(<App controller>) + write 键入 + waitFor 口径）、`session.test.ts` 子代理段（onEventForTest 合成事件口径）

---

### Task 1: 数据面——ChatItem.subagentMeta 与归档写入

**Files:**
- Modify: `src/tui/session.ts`（ChatItem 接口 + archiveChild）
- Test: `src/tui/session.subagent-meta.test.tsx`（新建，独立文件防并发线竞态）

**Interfaces:**
- Consumes: 既有 `archiveChild()`（L1296）、`spawnCalls` 栈、`ChildLiveState`（含 `steps/startedAt`）、`onEventForTest`（测试接缝）
- Produces: `ChatItem.subagentMeta?: { steps: number; durationMs: number }`——Task 2 ToolRow 折叠尾注的唯一数据源；写入收敛 archiveChild 单点

- [ ] **Step 1: 写失败测试**

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('spawn 归档写入 subagentMeta（steps + durationMs）', () => {
  const tmp = tmpdir('sunshinex-sess-spawnmeta-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '审查', label: 'rv' } } } as never);
    ctrl.onEventForTest({ type: 'token', text: '审查中\n', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'rv', turnTotal: 4200 } } as never);
    ctrl.onEventForTest({ type: 'done', text: '审查结论', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'rv 完成', payload: { tool: 'spawn', ok: true } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('spawn'));
    assert.ok(call, 'spawn 调用行在链');
    assert.ok(call!.detail?.includes('审查结论'), '转录已折入 detail');
    assert.ok(call!.subagentMeta, '归档应写入 subagentMeta');
    assert.ok(call!.subagentMeta!.steps >= 1, 'steps 取自 ChildLiveState.steps');
    assert.ok(call!.subagentMeta!.durationMs >= 0, 'durationMs = 归档时刻 - startedAt');
    assert.equal(ctrl.getState().children.length, 0, '归档后面板移除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('INVALID_ARG 即败零子事件：spawn 调用行无 subagentMeta（折叠态省尾注）', () => {
  const tmp = tmpdir('sunshinex-sess-spawnmeta2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: {} } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'INVALID_ARG', payload: { tool: 'spawn', ok: false } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('spawn'));
    assert.ok(call);
    assert.equal(call!.subagentMeta, undefined, '零子事件无归档命中，meta 保持缺省');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --require ./scripts/test-env.cjs --test --test-force-exit dist/tui/session.subagent-meta.test.js`
Expected: FAIL——`subagentMeta` 类型不存在（tsc 报错即红灯；若 tsc 因并发线文件报错，甄别归属后直接跑 dist 编译产物）

- [ ] **Step 3: 最小实现**

① `ChatItem`（session.ts，`detail?: string;` 之后）新增：

```ts
  /** 子代理归档摘要（SPAWN call 行专属）：steps=子代理步数、durationMs=归档时刻-startedAt；零子事件即败时缺省 */
  subagentMeta?: { steps: number; durationMs: number };
```

② `archiveChild()` 中，`const detail = ...` 拼装行之后、`this.state = {` 之前新增：

```ts
    const subagentMeta = { steps: child.steps, durationMs: Math.max(0, Date.now() - child.startedAt) };
```

并把 messages 回填的 map 改为：

```ts
      messages: this.state.messages.map((m) => (m.seq === pending.seq ? { ...m, detail, subagentMeta } : m)),
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（2/2）

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.subagent-meta.test.tsx
git add -p src/tui/session.ts   # 只挑 ChatItem 字段 + archiveChild 两处 hunk，零卷入并发线改动
git commit -m "feat(tui): spawn 归档写入 subagentMeta（steps+durationMs）供折叠摘要尾注"
```

---

### Task 2: 渲染面——ToolRow SPAWN 行两态（meta 尾注 + ▾ 展开重放）

**Files:**
- Modify: `src/tui/components/ToolRow.tsx`（call 分支两态渲染）
- Test: `src/tui/components/ToolRow.spawn-expand.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ChatItem.subagentMeta`；`src/tui/format.ts` 的 `formatDuration(seconds: number): string`（1h 21m 30s 形态，既有导出）
- Produces: `ToolRow` 新增可选 props `spawnExpanded?: boolean`、`spawnHighlighted?: boolean`（缺省 false，既有调用点零改动）；渲染契约=折叠头 `● [SPAWN] target（N steps · Xs）`、展开头 `▾` + 4 空格缩进转录行

- [ ] **Step 1: 写失败测试**

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ToolRow } from './ToolRow';
import { ChatItem } from '../session';

const spawnCall: ChatItem = {
  role: 'tool', text: 'SPAWN reviewer', ts: 0, seq: 1, kind: 'call',
  detail: 'READ a.ts\n4 matches\n结论行',
  subagentMeta: { steps: 3, durationMs: 42_000 },
};

test('SPAWN 折叠态：● 头行带 meta 尾注，不重放转录', () => {
  const f = render(<ToolRow item={spawnCall} columns={80} collapsed={true} />).lastFrame() ?? '';
  assert.match(f, /● \[SPAWN\] reviewer（3 steps · 42s）/);
  assert.doesNotMatch(f, /结论行/);
});

test('SPAWN 展开态（spawnExpanded）：▾ 头行 + 转录缩进重放', () => {
  const f = render(<ToolRow item={spawnCall} columns={80} collapsed={true} spawnExpanded={true} />).lastFrame() ?? '';
  assert.match(f, /▾ \[SPAWN\] reviewer/);
  assert.match(f, /结论行/);
});

test('meta 缺省：折叠态无尾注；Tab 全场展开（collapsed=false）行为不变', () => {
  const bare: ChatItem = { ...spawnCall, subagentMeta: undefined };
  const f1 = render(<ToolRow item={bare} columns={80} collapsed={true} />).lastFrame() ?? '';
  assert.match(f1, /● \[SPAWN\] reviewer\n/m);
  assert.doesNotMatch(f1, /steps/);
  const f2 = render(<ToolRow item={spawnCall} columns={80} collapsed={false} />).lastFrame() ?? '';
  assert.match(f2, /结论行/, 'Tab 全展开重放保持既有行为');
});

test('非 SPAWN 调用行形态零变化：无尾注、头标恒 ●', () => {
  const write: ChatItem = { role: 'tool', text: 'WRITE a.ts', ts: 0, seq: 2, kind: 'call' };
  const f = render(<ToolRow item={write} columns={80} collapsed={true} spawnExpanded={true} />).lastFrame() ?? '';
  assert.match(f, /● \[WRITE\] a\.ts/);
  assert.doesNotMatch(f, /steps/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --require ./scripts/test-env.cjs --test --test-force-exit dist/tui/components/ToolRow.spawn-expand.test.js`
Expected: FAIL——折叠态无尾注（subagentMeta 未被消费）、展开态无 ▾

- [ ] **Step 3: 最小实现**——`ToolRow.tsx` 组件签名与 call 分支替换为：

```tsx
import { formatDuration } from '../format';

export function ToolRow({ item, columns, collapsed, spawnExpanded = false, spawnHighlighted = false }: {
  item: ChatItem; columns: number; collapsed: boolean;
  /** SPAWN 行逐行展开（Ctrl+B 浏览模式 Enter 切换）：仅 SPAWN call 行消费 */
  spawnExpanded?: boolean;
  /** 浏览模式光标行反色标记 */
  spawnHighlighted?: boolean;
}): JSX.Element {
  if (item.kind === 'call') {
    const sp = item.text.indexOf(' ');
    const verb = sp > 0 ? item.text.slice(0, sp) : item.text;
    const target = sp > 0 ? item.text.slice(sp + 1) : '';
    const isSpawn = verb === 'SPAWN' && item.detail !== undefined;
    // 两态命中任一即重放转录：Tab 全场展开（!collapsed，既有）或浏览模式逐行展开（spawnExpanded）
    const expanded = item.detail !== undefined && (!collapsed || spawnExpanded);
    const meta = item.subagentMeta;
    // 折叠摘要尾注（规格 §3.2）：meta 缺省（零子事件即败）整体省略
    const metaTail = isSpawn && meta ? `（${meta.steps} steps · ${formatDuration(Math.round(meta.durationMs / 1000))}）` : '';
    const detailLines = expanded ? (item.detail ?? '').split('\n') : [];
    return (
      <Box flexDirection="column">
        <Text backgroundColor={spawnHighlighted ? 'gray' : undefined}>
          <Text dimColor>{expanded && isSpawn ? '▾ ' : '● '}</Text>
          <Text color="cyan">[{verb}]</Text>
          {target ? <Text color="gray"> {target}{metaTail}</Text> : null}
        </Text>
        {detailLines.map((l, i) => (
          <Text key={i} dimColor>{'    ' + l}</Text>
        ))}
      </Box>
    );
  }
  // ……result 分支原样保留，零改动
```

- [ ] **Step 4: 跑测试确认通过 + 既有用例零误伤**

Run: `node --require ./scripts/test-env.cjs --test --test-force-exit dist/tui/components/ToolRow.spawn-expand.test.js dist/tui/components/ToolRow.spawn.test.js`
Expected: PASS（新 4 条 + 既有 3 条）

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/ToolRow.spawn-expand.test.tsx src/tui/components/ToolRow.tsx
git commit -m "feat(tui): SPAWN 调用行两态渲染（meta 摘要尾注 + ▾ 展开转录重放）"
```

---

### Task 3: 状态面——RetainedUiState.spawnExpanded + MessageList 透传

**Files:**
- Modify: `src/tui/ui-state.ts`（RetainedUiState + initialRetained）
- Modify: `src/tui/components/MessageList.tsx`（props 透传到 ToolRow）
- Test: `src/tui/components/MessageList.spawn-expand.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 2 的 ToolRow 可选 props
- Produces: `RetainedUiState.spawnExpanded: number[]`（App Task 4 读写同一字段）；`MessageList` 可选 props `spawnExpandedSeqs?: number[]`、`spawnHighlightSeq?: number`

- [ ] **Step 1: 写失败测试**

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList } from './MessageList';
import { BannerInfo } from '../banner-info';
import { ChatItem } from '../session';

const banner = { version: '0.0.0', model: 'test', root: '/tmp/proj' } as unknown as BannerInfo;

const msgs: ChatItem[] = [
  { role: 'tool', text: 'SPAWN reviewer', ts: 0, seq: 7, kind: 'call', detail: 'READ a.ts\n结论行A', subagentMeta: { steps: 2, durationMs: 1000 } },
  { role: 'tool', text: 'SPAWN writer', ts: 0, seq: 8, kind: 'call', detail: 'WRITE b.ts\n结论行B', subagentMeta: { steps: 1, durationMs: 500 } },
];

test('spawnExpandedSeqs 命中行展开为 ▾，未命中行保持 ● 折叠', () => {
  // Static 区内容打印一次后不进动态帧：历史断言一律走 allOutput()（test-ink 口径）
  const f = render(
    <MessageList messages={msgs} columns={80} banner={banner} expandAll={false} latestFull={false} spawnExpandedSeqs={[8]} />,
  ).allOutput();
  assert.match(f, /● \[SPAWN\] reviewer/);
  assert.match(f, /▾ \[SPAWN\] writer/);
  assert.match(f, /结论行B/, '命中行转录重放');
  assert.doesNotMatch(f, /结论行A/, '未命中行转录不重放');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --require ./scripts/test-env.cjs --test --test-force-exit dist/tui/components/MessageList.spawn-expand.test.js`
Expected: FAIL——`spawnExpandedSeqs` prop 不存在（TS 报错即红灯）

- [ ] **Step 3: 最小实现**

① `ui-state.ts`：`RetainedUiState` 增字段（`latestFull` 之后）：

```ts
  /** 子代理行逐行展开集合（Ctrl+B 浏览模式 Enter 切换，存 SPAWN 调用行 seq）：跨重挂保留、瞬态 UI 态不进 journal */
  spawnExpanded: number[];
```

`initialRetained()` 返回值补 `spawnExpanded: []`。

② `MessageList.tsx`：签名增两个可选 props；`entries` 每条 message 追加两字段；`MessageRow` 透传——

```tsx
export function MessageList({
  messages, live, columns, banner, expandAll, latestFull,
  spawnExpandedSeqs, spawnHighlightSeq,
}: {
  /* ……既有 props 原样…… */
  /** SPAWN 行逐行展开 seq 集合（Ctrl+B 浏览模式），缺省=全折叠 */
  spawnExpandedSeqs?: number[];
  /** 浏览模式光标行 seq（反色高亮，缺省无高亮） */
  spawnHighlightSeq?: number;
}): JSX.Element {
```

`TranscriptEntry` message 变体扩为 `{ kind: 'message'; item: ChatItem; full: boolean; visible: boolean; spawnExpanded: boolean; spawnHighlighted: boolean }`；entries map 内：

```tsx
    ...messages.map((item, i) => ({
      kind: 'message' as const, item,
      full: decisions[i].full, visible: decisions[i].visible,
      spawnExpanded: spawnExpandedSeqs?.includes(item.seq) ?? false,
      spawnHighlighted: item.seq === spawnHighlightSeq,
    })),
```

`MessageRow` props 增 `spawnExpanded: boolean; spawnHighlighted: boolean` 并原样传给 `<ToolRow ... spawnExpanded={...} spawnHighlighted={...} />`（React.memo 逐字段比较自动生效）。

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（1/1）

- [ ] **Step 5: 提交**

```bash
git add src/tui/ui-state.ts src/tui/components/MessageList.tsx src/tui/components/MessageList.spawn-expand.test.tsx
git commit -m "feat(tui): SPAWN 行展开状态入 RetainedUiState 并经 MessageList 透传 ToolRow"
```

---

### Task 4: 交互面——App Ctrl+B 浏览模式状态机 + 重绘接线

**Files:**
- Modify: `src/tui/components/App.tsx`（useInput 分发 + 浏览模式态 + retain 回写 + 提示行）
- Test: `src/tui/components/App.spawn-browse.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 3 的 `store.spawnExpanded`、MessageList 新 props；既有 `useInput`/`onRequestRepaint` 重绘 effect
- Produces: 浏览模式本地态 `browseMode: boolean` + `browseCursor: number`（光标指向 messages 中第 N 条 SPAWN call 行）；Ctrl+B 切换、↑/↓ 移动、Enter 翻转展开、Esc 退出；输入框下方提示行 `t('subagent browse · ↑↓ move · Enter toggle · Esc exit', '子代理浏览 · ↑↓ 移动 · Enter 切换 · Esc 退出')`（反色单行、浏览模式激活时渲染、恒 1 行不构成动态区高度波动——浏览模式仅在 idle/error 态存在，此时动态区无流式内容）

- [ ] **Step 1: 写失败测试**

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 终态会话：两条已归档 SPAWN 调用行（detail 含转录）+ 一条普通 write 调用行 */
async function settledCtrl(tmp: string): Promise<SessionController> {
  const ctrl = new SessionController({
    root: tmp,
    model: new ScriptedAdapter([
      '{"tools":[{"tool":"spawn","input":{"prompt":"a","label":"rv"}},{"tool":"spawn","input":{"prompt":"b","label":"wr"}}],"done":false}',
      '{"done":true,"reply":"ok"}',
    ]),
  });
  // 子代理事件流（两次 spawn 各一）直接经测试接缝注入，确保归档命中并携带 detail
  ctrl.onEventForTest({ type: 'token', text: 'rv 线\n', payload: { subagent: 'rv' } } as never);
  ctrl.onEventForTest({ type: 'done', text: 'rv 结论', payload: { subagent: 'rv' } } as never);
  ctrl.onEventForTest({ type: 'token', text: 'wr 线\n', payload: { subagent: 'wr' } } as never);
  ctrl.onEventForTest({ type: 'done', text: 'wr 结论', payload: { subagent: 'wr' } } as never);
  const p = ctrl.submit('跑两个子代理');
  await p;
  await ctrl.waitIdle();
  return ctrl;
}

test('App：Ctrl+B 浏览模式（进入/高亮移动/Enter 展开/Esc 退出）', async () => {
  const tmp = tmpdir('sunshinex-app-browse-');
  try {
    const ctrl = await settledCtrl(tmp);
    const calls = ctrl.getState().messages.filter((m) => m.kind === 'call');
    assert.ok(calls.length >= 2 && calls.every((m) => m.detail), '前置：两条 SPAWN 调用行已归档');

    const { write, lastFrame, allOutput, unmount } = render(<App controller={ctrl} />);
    await new Promise((r) => setTimeout(r, 200)); // 等挂载：ink 未接管 stdin 时首段输入会丢失
    const idleFrame = lastFrame() ?? '';
    assert.doesNotMatch(idleFrame, /subagent browse/, '缺省非浏览模式无提示行');

    write('\u0002'); // Ctrl+B 进入
    await new Promise((r) => setTimeout(r, 150));
    assert.match(lastFrame() ?? '', /subagent browse · ↑↓ move · Enter toggle · Esc exit/, '提示行出现');
    // 光标缺省落最后一条 SPAWN 行（最近优先）：该行反色 + 折叠头 ●
    write('\r'); // Enter 翻转展开
    await new Promise((r) => setTimeout(r, 150));
    // SPAWN 行属 Static 区（打印一次后不进动态帧）：展开形态断言走 allOutput()；提示行为动态区走 lastFrame()
    const expandedAll = allOutput();
    assert.match(expandedAll, /▾ \[SPAWN\]/, '展开头标 ▾');
    assert.match(expandedAll, /wr 结论|rv 结论/, '转录行重放');

    write('\u001b[A'); // ↑ 移动光标到上一条 SPAWN 行
    await new Promise((r) => setTimeout(r, 150));
    write('\r'); // 翻转上一条
    await new Promise((r) => setTimeout(r, 150));
    assert.match(allOutput(), /rv 结论/, '上一条也展开');

    // A4 边界钳制：光标已在末行，↓ 不移动（钳制），Enter 仍作用于末行 → 末行由展开转折叠
    write('\u001b[B');
    await new Promise((r) => setTimeout(r, 150));
    write('\r');
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(allOutput().slice(expandedAll.length), /▾ \[SPAWN\]/, '末行 ↓ 钳制不移动，Enter 收拢末行');

    write('\u001b'); // Esc 退出
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent browse/, '退出后提示行消失');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：运行中 Ctrl+B 不进入浏览模式（模态/运行门槛）', async () => {
  const tmp = tmpdir('sunshinex-app-browse2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"sleep 1"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    const p = ctrl.submit('长任务');
    await new Promise((r) => setTimeout(r, 120)); // 等进入 running
    assert.equal(ctrl.getState().status, 'running');
    const { write, lastFrame, unmount } = render(<App controller={ctrl} />);
    await new Promise((r) => setTimeout(r, 200));
    write('\u0002');
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotMatch(lastFrame() ?? '', /subagent browse/, '运行中不进入');
    await p;
    await ctrl.waitIdle();
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --require ./scripts/test-env.cjs --test --test-force-exit dist/tui/components/App.spawn-browse.test.js`
Expected: FAIL——Ctrl+B 无响应（无浏览模式分支），提示行断言失败

- [ ] **Step 3: 最小实现**（App.tsx 五处小改，锚点文本为准）

① 本地态（`latestFull` state 之后）：

```tsx
  // 子代理浏览模式（Ctrl+B）：本地态 + ref 真值（useInput 处理器经 effect 重挂存在闭包滞后，对标 qCursor 先例）
  const [browseMode, setBrowseMode] = React.useState(false);
  const browseModeRef = React.useRef(false);
  const [browseCursor, setBrowseCursor] = React.useState(0);
  const browseCursorRef = React.useRef(0);
  const [spawnExpanded, setSpawnExpanded] = React.useState<number[]>(store.spawnExpanded);
  const setBrowse = (mode: boolean, cursor = 0): void => {
    browseModeRef.current = mode;
    browseCursorRef.current = cursor;
    setBrowseMode(mode);
    setBrowseCursor(cursor);
  };
```

② retain 回写 effect 补一行：`store.spawnExpanded = spawnExpanded;`

③ 重绘触发 effect 依赖数组 `}, [expandAll, latestFull]);` 改为 `}, [expandAll, latestFull, browseMode, spawnExpanded]);`（Static 不可变：展开/收拢必须经清屏重挂整屏重放，与 Tab 同路径）。

④ useInput 分发：在 awaiting-question 分支之前插入浏览模式分支（浏览模式为 App 本地模态，优先于一切 controller 态分流）：

```tsx
    // 子代理浏览模式（Ctrl+B 进入）：短接管 ↑/↓/Enter/Esc，Q 键同 Esc 退出；其余全部吞掉不落输入缓冲
    if (browseModeRef.current) {
      const spawnSeqs = state.messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.detail).map((m) => m.seq);
      if (spawnSeqs.length === 0) { setBrowse(false); return; }
      const clamp = (n: number): number => Math.max(0, Math.min(spawnSeqs.length - 1, n));
      if (key.escape || (input === 'q' && !key.ctrl)) { setBrowse(false); return; }
      if (key.upArrow) { setBrowse(true, clamp(browseCursorRef.current - 1)); return; }
      if (key.downArrow) { setBrowse(true, clamp(browseCursorRef.current + 1)); return; }
      if (key.return) {
        const seq = spawnSeqs[clamp(browseCursorRef.current)];
        setSpawnExpanded((list) => (list.includes(seq) ? list.filter((s) => s !== seq) : [...list, seq]));
        return;
      }
      if (key.ctrl && input === 'c') { setBrowse(false); return; }
      return;
    }
    // Ctrl+B 进入浏览模式：仅 idle/error 态、且场上存在已归档 SPAWN 行；无 SPAWN 行静默 no-op
    if (key.ctrl && input === 'b') {
      if ((state.status === 'idle' || state.status === 'error') && state.messages.some((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.detail)) {
        const seqs = state.messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.detail).map((m) => m.seq);
        setBrowse(true, seqs.length - 1); // 光标缺省落最近一条
      }
      return;
    }
```

⑤ 渲染：MessageList 增传 `spawnExpandedSeqs={spawnExpanded}` 与 `spawnHighlightSeq={browseMode ? (state.messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.detail).map((m) => m.seq)[browseCursor] ?? undefined) : undefined}`；`{state.status === 'running' ? <Spinner .../> : null}` 之后插入提示行：

```tsx
      {browseMode ? (
        <Text backgroundColor="gray"> {t('subagent browse · ↑↓ move · Enter toggle · Esc exit', '子代理浏览 · ↑↓ 移动 · Enter 切换 · Esc 退出')} </Text>
      ) : null}
```

（实现时把「过滤 SPAWN call 行」抽为组件内一个 `spawnCallSeqs(state.messages)` 局部函数避免四处重复表达式。）

- [ ] **Step 4: 跑测试确认通过 + 既有 App 套件零误伤**

Run: `node --require ./scripts/test-env.cjs --test --test-force-exit dist/tui/components/App.spawn-browse.test.js dist/tui/components/App.test.js`
Expected: PASS（新增 2 条 + 既有 App 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/App.spawn-browse.test.tsx
git add -p src/tui/components/App.tsx   # 只挑本线五处 hunk，零卷入并发线（askquestion/steering/中断线）改动
git commit -m "feat(tui): Ctrl+B 子代理浏览模式（↑↓ 高亮移动、Enter 逐行展开/折叠、Esc 退出）"
```

---

### Task 5: 手册同步 + 三门禁收口

**Files:**
- Modify: `TUI-MANUAL.md`（快捷键段 + 子代理段）

**Interfaces:**
- Consumes: Task 1–4 全部落地形态
- Produces: 文档口径与实现一致；A1–A8 验收矩阵全数可勾稽

- [ ] **Step 1: TUI-MANUAL.md 快捷键表追加一行**

```markdown
| Ctrl+B | 子代理浏览模式：↑/↓ 在 SPAWN 调用行间移动高亮，Enter 展开/折叠该行（思考与工具转录），Esc 退出；运行中不可进入 |
```

并在子代理段落补两态口径：归档后的子代理调用行折叠为单行摘要（`● [SPAWN] 任务名（N steps · Xs）`），Ctrl+B 浏览模式下 Enter 展开为 `▾` 头行 + 缩进转录全文；展开状态跨窗口缩放保留、跨会话恢复（/resume）回落折叠。

- [ ] **Step 2: 定向全量回归**

Run: `npx tsc -p tsconfig.json && node --require ./scripts/test-env.cjs --test --test-force-exit dist/tui/components/ToolRow.spawn-expand.test.js dist/tui/components/ToolRow.spawn.test.js dist/tui/components/MessageList.spawn-expand.test.js dist/tui/components/App.spawn-browse.test.js dist/tui/components/ChildPanel.test.js dist/tui/session.subagent-meta.test.js dist/tui/session.subagent-done.test.js dist/tui/session.detail.test.js`
Expected: PASS fail 0（A1–A8 全数覆盖：A1 折叠摘要/A2 Enter 切换/A3 进入退出与 no-op/A4 边界钳制/A5 跨重挂保留/A6 运行中门槛/A7 Tab 正交/A8 journal 零新事件）

- [ ] **Step 3: 全量门禁**

Run: `npx tsc -p tsconfig.json && node scripts/run-tests.js && node dist/cli/index.js selfcheck`
Expected: tsc 零报错；全量 fail 0（并发线在飞 WIP 的既有红如实登记归属，不掩盖不卷入）；selfcheck OK

- [ ] **Step 4: 自审收口**

- `grep -rn "spawnExpandedSeqs\|browseMode" src/tui/` 确认落点齐全无悬空引用
- 动态面盘点：本线新增渲染产物（meta 尾注/提示行/▾ 头标）均只有上屏一条去向，零 appendChain、零提示词面、零时间戳进链
- A8 断言复核：`git diff --stat` 确认 session-journal.ts 零改动

- [ ] **Step 5: 最终提交**

```bash
git add TUI-MANUAL.md
git commit -m "docs(tui): 子代理浏览模式与 SPAWN 行两态口径同步 TUI-MANUAL"
```
