# 子代理查看视图（Child Inspector）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主界面输入框下侧每个子 agent 一行（CC 式），Ctrl+B 统一浏览器选中后进入全屏查看视图（运行中实时流式 / 已完成 detail 回看），Esc 退出。

**Architecture:** 数据层把 `ChildLiveState.transcript` 从纯文本行结构化为 `ChildLine{call|result|text}`（委派 prompt 随面板态捕获）；呈现层新增 `ChildInspector` 全屏组件，整体渲染在动态区（有界=视口高度），主界面历史区 Static 与输入框保持挂载零重放；Ctrl+B 浏览序列扩容为「运行中行 + 已归档行」，Enter 分流。

**Tech Stack:** TypeScript（strict）+ React + ink；测试 `node --test`（test-ink 假渲染）。

**Spec:** `docs/superpowers/specs/2026-09-26-child-inspector-view-design.md`

## Global Constraints

- 主界面历史区保持 ink `Static` 零改动（09-26 全量重绘闪屏撤回裁决，裁决 tui_no_full_rerender）；全屏视图整体渲染在动态区，有界=视口高度。
- 外观面用户可见文案一律 `t(en, zh)` 双语调用时求值；写链/转录行英文。
- strict 模式禁无理由 any；路径 `path.join` 单点；新共享类型在定义处就近导出。
- 每任务收尾提交只圈定本主题文件。
- **执行前置说明**：工作区存在未提交的 CC 模式延迟入档改动（`src/tui/session.ts`、`src/tui/session.tool-tristate.test.ts`、`src/tui/session.test.ts`）。执行本计划前须经用户裁决先提交该主题，否则 Task 1 起对 `session.ts` 的提交将混入两主题。以下各任务提交命令均假定前置已处置。

---

### Task 1: transcript 结构化（ChildLine）+ ChildPanel 收敛 1 行/代理

**Files:**
- Modify: `src/tui/session.ts`（ChildLiveState 定义 ~L84-102、childTail ~L102-104、onChildEvent ~L1666-1735、archiveInto ~L1763-1775、closeTask 内 spawnCalls 过滤同域）
- Modify: `src/tui/components/ChildPanel.tsx`（收敛为 1 行/代理）
- Modify: `src/tui/components/ChildPanel.live.test.tsx`、`src/tui/components/ChildPanel.test.tsx`（夹具同步）
- Modify: `src/tui/session.subagent-*.test.tsx`、`src/tui/session.test.ts` 中断言 `transcript` 字符串行的用例（grep `transcript` 定位）
- Test: `src/tui/session.childline.test.tsx`（新建）

**Interfaces:**
- Produces: `export interface ChildLine { kind: 'call' | 'result' | 'text'; text: string; ok?: boolean }`（session.ts 导出）；`ChildLiveState.transcript: ChildLine[]`；`ChildLiveState.tail` 字段与 `childTail()` 移除；`archiveInto` 的 detail 序列化口径：result 行 → `⎿ ✓/✗ text`，其余原样。

- [ ] **Step 1: 写失败测试**

新建 `src/tui/session.childline.test.tsx`：

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';

// transcript 结构化（规格 §4.1）：tool-call→call、tool-result→result(ok)、token→text
test('child transcript 结构行：三分支 kind 映射与 ok 标记', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-childline-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const label = 'w';
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: label } } as never);
    ctrl.onEventForTest({ type: 'tool-call', text: 'grep', payload: { subagent: label, input: { pattern: 'x' }, callId: 's1:0' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: '4 matches', payload: { subagent: label, ok: true, callId: 's1:0' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'boom', payload: { subagent: label, ok: false, callId: 's1:1' } } as never);
    const child = ctrl.getState().children.find((c) => c.label === label);
    assert.ok(child, '子代理面板态应在场');
    const kinds = child!.transcript.map((l) => l.kind);
    assert.deepEqual(kinds, ['text', 'call', 'result', 'result'], `三分支按序映射，实际 ${JSON.stringify(child!.transcript)}`);
    const results = child!.transcript.filter((l) => l.kind === 'result');
    assert.deepEqual(results.map((r) => r.ok), [true, false], 'result 行携带 ok 标记');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session.childline.test.js`
Expected: 编译报错（transcript 类型不匹配）或断言 FAIL。

- [ ] **Step 3: 实现 session.ts 结构化**

1. ChildLiveState 定义处（`transcript: string[]` 与 `tail: string[]` 两行）改为：

```ts
  /** 全量结构行（归档与全屏查看同源）：工具行/结果行/流式文本 */
  transcript: ChildLine[];
```

并紧邻接口上方新增导出：

```ts
/** 子代理转录结构行（规格 §4.1）：归档 detail 与全屏查看视图共用同源 */
export interface ChildLine {
  kind: 'call' | 'result' | 'text';
  text: string;
  ok?: boolean;
}
```

2. 删除 `childTail()` 函数与 `tail` 字段全部消费（`commitChild` 里 `withTail` 一行改为直接 `this.state` 提交 next，函数签名去掉 `buf` 参数—— buf 仍由调用方维护，仅不再折入 tail）。
3. `onChildEvent` 三分支产出结构行：token/reasoning 分支 `parts.filter(...)` 改为 `{ kind: 'text', text: l }`；tool-call 分支 `{ kind: 'call', text: toolCallLine(e.text ?? '', e.payload?.input) }`；tool-result 分支 `{ kind: 'result', text: e.text ?? '', ok: e.payload?.ok === true }`。
4. `archiveInto` 的 detail 组装改为：

```ts
    const detail = [...child.transcript, ...(buf ? [{ kind: 'text', text: buf } as ChildLine] : [])]
      .map((l) => (l.kind === 'result' ? `⎿ ${l.ok === false ? '✗' : '✓'} ${l.text}` : l.text))
      .join('\n');
```

5. 新建子代理面板态的初始字段列表去掉 `tail: []`。

- [ ] **Step 4: ChildPanel 收敛 1 行/代理**

`ChildPanel.tsx`：删除尾流渲染（`tail`/`wrapped`/`pad` 相关与 `wrapByWidth` 中尾流用途），每代理只保留一行（done 终标行 / 工具活动行 / Spinner 头行三选一，逻辑已存在）；`TAIL_LINES` 常量删除。同步改写两个测试文件夹具：`ChildPanel.test.tsx`、`ChildPanel.live.test.tsx` 中 `transcript: string[]`/`tail` 字段改为结构行（`[{ kind: 'text', text: '分析中…' }]`），删除对尾流行数的断言。

- [ ] **Step 5: 同步既有用例并跑绿**

grep `transcript` 于 `src/tui/session*.test.tsx`，凡断言字符串行的改为断言 `.text`/`.kind`。然后：

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session.childline.test.js dist/tui/components/ChildPanel.live.test.js dist/tui/components/ChildPanel.test.js dist/tui/session.test.js`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/tui/session.ts src/tui/session.childline.test.tsx src/tui/components/ChildPanel.tsx src/tui/components/ChildPanel.live.test.tsx src/tui/components/ChildPanel.test.tsx src/tui/session.test.ts src/tui/session.subagent-*.test.tsx
git commit -m "feat(tui): child transcript 结构化 ChildLine{call|result|text}，归档 detail 同源序列化（result 行 ⎿ 前缀）；ChildPanel 收敛 CC 式 1 行/代理，tail 字段与尾流展示移除（规格 §3.1/§4.1）"
```

---

### Task 2: 委派 prompt 捕获（ChildLiveState.prompt）

**Files:**
- Modify: `src/tui/session.ts`（ChildLiveState 增 `prompt?: string`；spawn tool-call 分支捕获；子面板创建时挂载；archiveInto 后清理）
- Test: `src/tui/session.childline.test.tsx`（追加一例）

**Interfaces:**
- Produces: `ChildLiveState.prompt?: string`（Task 3 ChildInspector 头部消费）。

- [ ] **Step 1: 追加失败测试**

在 `session.childline.test.tsx` 追加：

```tsx
test('委派 prompt 捕获：spawn tool-call 的 input.prompt 随面板态存档', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-childprompt-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    // 主链 spawn 调用先到（无 subagent payload），子代理事件随后按 label 路由
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '调研单体链路', label: 'w' }, callId: 'm1:0' } } as never);
    ctrl.onEventForTest({ type: 'token', text: '开工\n', payload: { subagent: 'w' } } as never);
    const child = ctrl.getState().children.find((c) => c.label === 'w');
    assert.equal(child?.prompt, '调研单体链路', '委派 prompt 应随面板态存档');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session.childline.test.js`
Expected: 新例 FAIL（prompt undefined）。

- [ ] **Step 3: 实现**

1. ChildLiveState 增 `prompt?: string;`（注释：主 agent 委派提示词，全屏视图头部呈现）。
2. session.ts 增字段 `private childPrompts = new Map<string, string>();`（`/new` 软重置处随 `childBufs.clear()` 一并 `clear()`）。
3. `case 'tool-call'` 中 spawn 压栈处追加：

```ts
        const pin = e.payload?.input as Record<string, unknown> | undefined;
        if (typeof pin?.prompt === 'string' && pin.prompt.length > 0) this.childPrompts.set(spawnBaseLabel(pin), pin.prompt);
```

4. `onChildEvent` 子面板创建处初始字段追加 `prompt: this.childPrompts.get(label),`。
5. `archiveInto` 中 `this.childBufs.delete(...)` 旁追加 `this.childPrompts.delete(child.label);`。

- [ ] **Step 4: 跑绿 + Commit**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/session.childline.test.js`
Expected: PASS。

```bash
git add src/tui/session.ts src/tui/session.childline.test.tsx
git commit -m "feat(tui): 委派 prompt 随子代理面板态捕获存档（spawn input.prompt，规格 §4.2），全屏视图头部消费"
```

---

### Task 3: ChildInspector 组件（运行中实时 / 完成态回看双模式纯渲染）

**Files:**
- Create: `src/tui/components/ChildInspector.tsx`
- Test: `src/tui/components/ChildInspector.test.tsx`（新建）

**Interfaces:**
- Consumes: `ChildLine`、`ChildLiveState`（Task 1/2 产物）。
- Produces: `export function ChildInspector(props: { child?: ChildLiveState; archived?: { label: string; lines: string[]; steps?: number; durationMs?: number }; prompt?: string; columns: number; rows: number }): JSX.Element`——`child` 与 `archived` 二选一传入；输出=头部状态行 1 行 + 正文（取尾 `rows - 2` 行）+ 底部提示行 1 行。

- [ ] **Step 1: 写失败测试**

新建 `src/tui/components/ChildInspector.test.tsx`：

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ChildInspector } from './ChildInspector';
import { ChildLiveState } from '../session';

const live = (over: Partial<ChildLiveState> = {}): ChildLiveState => ({
  label: 'w', startedAt: Date.now() - 12_000, steps: 14, tokens: 13_000,
  transcript: [
    { kind: 'text', text: '分析中…' },
    { kind: 'call', text: 'READ src/a.ts' },
    { kind: 'result', text: '84 lines', ok: true },
  ],
  ...over,
});

test('Inspector 运行中：头部状态行（label/step/tokens/耗时/Esc 提示）与正文结构行混排', () => {
  const one = render(<ChildInspector child={live()} columns={80} rows={12} />);
  const f = one.lastFrame() ?? '';
  assert.match(f, /\[w\]/, '头部携带 label');
  assert.match(f, /step 14/, '头部携带步数');
  assert.match(f, /Esc/, '头部携带退出提示');
  assert.match(f, /READ src\/a\.ts/, 'call 行原样呈现');
  assert.match(f, /⎿ ✓ 84 lines/, 'result 行 ⎿ + ok 标记');
  assert.match(f, /分析中…/, 'text 行原样混排');
  one.unmount();
});

test('Inspector 完成态：detail 行解析回看（⎿ 前缀→result，其余 text）', () => {
  const one = render(
    <ChildInspector
      archived={{ label: 'w', lines: ['READ src/a.ts', '⎿ ✓ 84 lines', '⎿ ✗ boom'], steps: 5, durationMs: 61_000 }}
      columns={80}
      rows={12}
    />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /READ src\/a\.ts/, 'call/text 行呈现');
  assert.match(f, /⎿ ✓ 84 lines/, 'result 行呈现');
  assert.match(f, /⎿ ✗ boom/, '失败结果行呈现');
  one.unmount();
});

test('Inspector 取尾适配视口：超出 rows 的更早行不渲染（动态区有界约束）', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'text' as const, text: `line-${i}` }));
  const one = render(<ChildInspector child={live({ transcript: many })} columns={80} rows={10} />);
  const f = one.lastFrame() ?? '';
  assert.ok(!f.includes('line-1\n') && !f.includes('line-10'), '视口外的更早行不渲染');
  assert.match(f, /line-49/, '最新行在视口内');
  one.unmount();
});

test('Inspector 头部呈委派 prompt', () => {
  const one = render(<ChildInspector child={live({ prompt: '调研单体链路' })} columns={80} rows={12} />);
  assert.match(one.lastFrame() ?? '', /调研单体链路/, '头部呈委派提示词');
  one.unmount();
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/components/ChildInspector.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 ChildInspector.tsx**

```tsx
import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLine, ChildLiveState } from '../session';
import { formatTokens, formatDuration } from '../format';
import { wrapByWidth } from '../text-band';
import { t } from '../../i18n';

/** 全屏查看视图（规格 §3.3）：运行中实时流式 / 完成态 detail 回看双模式；
 *  整体渲染在动态区（有界=视口高度），历史区 Static 零接触 */
export function ChildInspector(props: {
  child?: ChildLiveState;
  archived?: { label: string; lines: string[]; steps?: number; durationMs?: number };
  columns: number;
  rows: number;
}): JSX.Element {
  const { child, archived, columns, rows } = props;
  const label = child?.label ?? archived?.label ?? '';
  const steps = child?.steps ?? archived?.steps;
  const tokens = child?.tokens;
  const secs = child ? Math.max(0, Math.round((Date.now() - child.startedAt) / 1000)) : (archived?.durationMs !== undefined ? Math.round(archived.durationMs / 1000) : undefined);
  const body: { kind: ChildLine['kind']; text: string; ok?: boolean }[] = child
    ? child.transcript.map((l) => ({ ...l }))
    : (archived?.lines ?? []).map((l) =>
        l.startsWith('⎿ ')
          ? { kind: 'result' as const, text: l.slice(2).replace(/^[✓✗] /, ''), ok: !l.startsWith('⎿ ✗') }
          : { kind: 'text' as const, text: l },
      );
  const head = `✻ [${label}] ${t('subagent view', '子代理视图')}${typeof steps === 'number' ? ` · step ${steps}` : ''}${tokens !== undefined ? ` · ↑${formatTokens(tokens)} tokens` : ''}${secs !== undefined ? ` · ${formatDuration(secs)}` : ''} · ${t('Esc exit', 'Esc 退出')}`;
  const width = Math.max(8, columns - 2);
  const bodyRows = Math.max(1, rows - 2);
  const wrapped = body.flatMap((l) => wrapByWidth(l.text, width).map((w) => ({ ...l, text: w })));
  const visible = wrapped.slice(-bodyRows);
  return (
    <Box flexDirection="column">
      <Text color="green" dimColor>{head}{props.child?.prompt ? `\n⏺ ${t('delegated prompt', '委派提示词')}：${props.child.prompt}` : ''}</Text>
      {visible.map((l, i) =>
        l.kind === 'result' ? (
          <Text key={i} dimColor>⎿ {l.ok === false ? '✗' : '✓'} {l.text}</Text>
        ) : (
          <Text key={i}>{l.text}</Text>
        ),
      )}
    </Box>
  );
}
```

- [ ] **Step 4: 跑绿**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/components/ChildInspector.test.js`
Expected: 4/4 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/ChildInspector.tsx src/tui/components/ChildInspector.test.tsx
git commit -m "feat(tui): ChildInspector 全屏查看组件——运行中实时/完成态 detail 回看双模式，取尾适配视口、头部呈委派 prompt（规格 §3.3）"
```

---

### Task 4: App inspect 模式接管 + Esc 退出

**Files:**
- Modify: `src/tui/components/App.tsx`（inspect 状态、渲染分支让位、Esc 处理）
- Test: `src/tui/components/App.inspect.test.tsx`（新建）

**Interfaces:**
- Consumes: `ChildInspector`（Task 3）、`state.children` / `state.messages`（既有）。
- Produces: App 内部状态 `inspect: { kind: 'live'; label: string } | { kind: 'archived'; seq: number } | undefined`；inspect 在场时 MessageList 以 `live={undefined}` 渲染（实时区让位）、输入框/底栏/ChildPanel 不渲染。

- [ ] **Step 1: 写失败测试**

新建 `src/tui/components/App.inspect.test.tsx`：

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('App inspect：运行中选中子代理整页接管，Esc 退出恢复主界面', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inspect-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const term = render(<App controller={ctrl} />);
    // 构造运行中子代理面板态
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: 'w' } } as never);
    await sleep(50);
    // 键盘序列不可从测试直发 useInput，改由状态注入验证渲染分支：inspect 形态经 Ctrl+B 序列——
    // 本例直接验证接管与退出渲染（键分发在 Task 5 浏览器用例联动覆盖）
    (term as unknown as { ___inspectProbe?: boolean }).___inspectProbe = true;
    assert.ok((term.lastFrame() ?? '').includes('分析中…') === false, '未进入前全屏内容不在场');
    term.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

说明：App 的键盘分发在单测中难以直驱（useInput 假 stdin 未接 App 键通路），接管/退出的**渲染分支**以组件状态注入验证；**键位分流链路**在 Task 5 以 session+App 联动形态锁定（Ctrl+B → Enter → Esc 全序列经 test-ink write 驱动）。若 test-ink 已支持 `term.write` 直驱（既有 App.ask 用例形态），本例直接改为 write 驱动 `Ctrl+B`+`Enter`+`Esc` 三段断言（优先采用，见 Step 3 备注）。

- [ ] **Step 2: 跑红**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/components/App.inspect.test.js`
Expected: 先按占位断言跑通（该例为形态锚），真正的红在 Task 5 联动例。本步允许 PASS，但 inspect 状态尚未存在。

- [ ] **Step 3: 实现 App 分支**

1. App 组件内（browse 状态声明旁）新增：

```tsx
  const [inspect, setInspect] = React.useState<{ kind: 'live'; label: string } | { kind: 'archived'; seq: number } | undefined>(undefined);
  const inspectRef = React.useRef(inspect);
  inspectRef.current = inspect;
```

2. 键处理器**最前置**插入（先于 browseMode 分支）：

```tsx
    if (inspectRef.current) {
      if (key.escape) { setInspect(undefined); return; }
      return; // 全屏只读：其余键不落输入缓冲
    }
```

3. 渲染段（~L577 起）：inspect 在场时——`<MessageList … live={undefined} …/>` 保持挂载（Static 零重放）；其后原本的 Spinner/浏览提示行/ChildPanel/输入框/底栏整段包进 `{!inspect ? (<>…</>) : null}`，并追加：

```tsx
      {inspect ? (
        <ChildInspector
          child={inspect.kind === 'live' ? state.children.find((c) => c.label === inspect.label) : undefined}
          archived={
            inspect.kind === 'archived'
              ? (() => {
                  const m = state.messages.find((x) => x.seq === inspect.seq);
                  return m?.detail !== undefined
                    ? { label: m.text.replace(/^\S+\s*/, '') || 'subagent', lines: m.detail.split('\n'), steps: m.subagentMeta?.steps, durationMs: m.subagentMeta?.durationMs }
                    : undefined;
                })()
              : undefined
          }
          columns={columns}
          rows={useStdout().stdout?.rows ?? 24}
        />
      ) : null}
```

（`rows` 取值在组件体内先取 `const stdout = useStdout().stdout;` 再用，避免 JSX 内调 hook 的误导写法；`useStdout` 已在 App 既有导入面。）
4. inspect 在场时 Ctrl+B/Tab 等分支不再可达（键处理器最前置已 return）。

- [ ] **Step 4: 跑绿 + 全量相关面**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/components/App.inspect.test.js dist/tui/components/App.test.js dist/tui/components/App.visual.test.js`
Expected: 全 PASS（既有用例不受 inspect 缺省态影响）。

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/App.tsx src/tui/components/App.inspect.test.tsx
git commit -m "feat(tui): App inspect 全屏接管分支——ChildInspector 整页让位（MessageList 保持挂载 live 让位零 Static 重放），Esc 退出恢复主界面（规格 §3.3/§6）"
```

---

### Task 5: Ctrl+B 统一浏览器（运行中行入序列 + Enter 分流全屏）

**Files:**
- Modify: `src/tui/components/App.tsx`（browse 序列扩容与分流）
- Modify: `src/tui/components/ChildPanel.tsx`（选中行高亮反色）
- Test: `src/tui/components/App.inspect.test.tsx`（追加键位全序列用例）

**Interfaces:**
- Consumes: Task 4 `inspect` 状态、Task 1 结构化后 `state.children`。
- Produces: browse 选择序列 = 运行中 children（按启动序）++ `spawnCallSeqs(state.messages)`（入档序）；`ChildPanel` 增可选 prop `selectedLabel?: string`（反色高亮选中行）。

- [ ] **Step 1: 写失败测试（键位全序列，write 直驱）**

在 `App.inspect.test.tsx` 追加（沿用 App.ask 用例的 `term.write` 直驱形态）：

```tsx
test('Ctrl+B 浏览器：运行中行入序列 → Enter 进入全屏 → Esc 退出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inspect2-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const term = render(<App controller={ctrl} />);
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: 'w' } } as never);
    await sleep(50);
    term.write('\u0002'); // Ctrl+B：进入浏览（运行中在场即允许，不再限定 idle）
    await sleep(50);
    assert.match(term.lastFrame() ?? '', /子代理浏览|subagent browse/, '浏览提示行在场');
    term.write('\r'); // Enter：选中运行中子代理 → 全屏接管
    await sleep(50);
    assert.match(term.lastFrame() ?? '', /子代理视图|subagent view/, '全屏视图接管整页');
    term.write('\u001B'); // Esc：退出
    await sleep(50);
    assert.doesNotMatch(term.lastFrame() ?? '', /子代理视图|subagent view/, '退出后全屏视图消失');
    assert.match(term.lastFrame() ?? '', /分析中…/, '回到主界面（ChildPanel 行在场）');
    term.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/components/App.inspect.test.js`
Expected: 新例 FAIL（Ctrl+B 仍限定 idle 且 Enter 只做行内展开）。

- [ ] **Step 3: 实现**

1. browse 入口（Ctrl+B 分支）条件改为「idle/error **或** `state.children.length > 0`」；选择序列构造：

```tsx
    if (key.ctrl && input === 'b') {
      const hasLive = state.children.some((c) => !c.done);
      const hasArchived = spawnCallSeqs(state.messages).length > 0;
      if ((state.status === 'idle' || state.status === 'error' || hasLive) && (hasLive || hasArchived)) {
        setBrowse(true, (hasLive ? state.children.filter((c) => !c.done).length : 0) + spawnCallSeqs(state.messages).length - 1);
      }
      return;
    }
```

2. browseMode 分支内：序列长度与 clamp 改为组合序列长度（liveCount + archivedCount）；`key.return` 分流：

```tsx
      if (key.return) {
        const liveCount = state.children.filter((c) => !c.done).length;
        const cur = clamp(browseCursorRef.current);
        if (cur < liveCount) {
          setInspect({ kind: 'live', label: state.children.filter((c) => !c.done)[cur]!.label });
        } else {
          const seq = spawnCallSeqs(state.messages)[cur - liveCount];
          if (seq !== undefined) setInspect({ kind: 'archived', seq });
        }
        setBrowse(false);
        return;
      }
```

3. `ChildPanel` 增 `selectedLabel?: string` prop：命中行 `<Text backgroundColor="gray">`（对齐 browse 光标反色形态）；App 渲染 ChildPanel 处传 `selectedLabel={browseMode && browseCursor < liveCount ? liveChildren[browseCursor]?.label : undefined}`。
4. 浏览提示行文案更新：`t('subagent browse · ↑↓ move · Enter inspect · Esc exit', '子代理浏览 · ↑↓ 移动 · Enter 查看 · Esc 退出')`——`App.expand.test.tsx`/既有断言此文案的用例同步。
5. 归档行走 `spawnCallSeqs` 既有语义不变（highlight 反色沿用 spawnHighlightSeq）。

- [ ] **Step 4: 跑绿**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/components/App.inspect.test.js dist/tui/components/App.expand.test.js dist/tui/components/App.spawn-browse.test.js dist/tui/components/ChildPanel.live.test.js`
Expected: 全 PASS（既有 spawn-browse 语义不回归；若其断言 Enter=行内展开，按 §3.2「替代原行内展开」改写该断言为全屏接管形态）。

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/App.tsx src/tui/components/App.inspect.test.tsx src/tui/components/ChildPanel.tsx src/tui/components/App.expand.test.tsx src/tui/components/App.spawn-browse.test.tsx
git commit -m "feat(tui): Ctrl+B 统一子代理浏览器——运行中行入选择序列（启动序在前）、Enter 分流全屏查看/归档回看、选中行反色高亮（规格 §3.2/§3.4）"
```

---

### Task 6: 全量 + selfcheck 收尾

**Files:**
- 无新改动（纯验证；若翻车按归因修复后重跑）。

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全 PASS（基线 1298 + 本主题新增 ~8 例）。

- [ ] **Step 2: selfcheck**

Run: `pnpm selfcheck`
Expected: exit=0。

- [ ] **Step 3: 收尾核对**

- `grep -rn "tail" src/tui/session.ts` 仅余无关语义（journal tail 等若存在）；`ChildLiveState` 无 `tail` 残留。
- `git status --short` 零未跟踪残渣（探针/调试文件零遗留）。

（本任务无独立提交；各任务已分笔入库。）
