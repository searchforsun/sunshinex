# /skill 命令与选择卡 filterable 筛选能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/skill` 斜杠命令（技能清单选择卡、选定即链尾追持久加载、链上去重）与选择卡 filterable 筛选能力（OptionSelector 可选筛选 + `/resume`、`/memory-rm` 两卡接线）。

**Architecture:** 三单元——① `OptionSelector` 增受控 `filter`/`indexMap` props 与纯函数 `filterOptions`（组件保持纯受控渲染，不挂 useInput）；② `App` 问询卡增 filterable 键盘分发（`deriveFilterableView` 纯函数承载「空词分页 / 有词全量直出」双态）；③ `session` 增 `skillFlow`（链尾追注入 + 去重 + 守卫）并把 `/resume`、`/memory-rm` 的 >8 分支切到 filterable 单次问询。

**Tech Stack:** TypeScript strict + React(ink) + node:test；零新依赖（不引 fuzzy 库，子串包含够用）。

## Global Constraints

- 规格来源：`docs/superpowers/specs/2026-09-22-skill-command-filterable-design.md`（D1–D9 裁决、验收矩阵 A1–A8、YAGNI 清单）
- 门禁：每任务 `pnpm build`（tsc strict 零报错）→ 定向测试绿；Task 5 收尾 `pnpm test` 全量 fail 0 + `pnpm selfcheck` OK
- 测试同目录就近放置（CLAUDE.md §5）：`*.test.tsx` 与被测文件同目录；定向跑法 `pnpm build && node --require ./scripts/test-env.cjs --test <dist 下测试文件>`
- 写链面恒英文单语（CLAUDE.md §15）：`[Skill] …` 头行英文；上屏回执与卡片文案一律 `t(en, zh)` 双语、运行期求值
- 前缀缓存：技能正文只经 `ContextManager.appendChain` 尾追；筛选词纯 TUI 瞬态不进 session/journal；模型工具清单零新增（零前缀断点）
- 零兼容：非 filterable 卡路径行为逐字节不动（钉子用例锁定）；CLI stdin 编号回落与 headless 桩对 `filterable` 忽略降级、零改动
- 提交纪律：每任务独立提交、`git add` 显式 pathspec；工作区存在并发线 WIP（CLAUDE.md/MANUAL.md/data-dir 等），MANUAL.md 混叠他线 hunks 时按 Task 5 拆分规则处置
- `setSkillBlock`/`pendingSkill` 是 loop skillRef 一次性首帧槽，本计划全程零触碰

## 现场勘误登记（规格→计划核实修正）

1. **命令总数**：规格 D1 写「第 19 条扁平命令」；现场核实 `SLASH_COMMANDS`（App.tsx:27）已含 `/tasks` 共 19 条，`/skill` 实为**第 20 条**，插在 `/tasks` 之后（Tab 邻位 `/tasks → /skill → /new`，不动 `/new → /resume` 既有邻位断言）。规格存档不回改，以本条为准。
2. **注入通道**：规格 §2 勘误段已定稿为链尾追（`appendChain([{ action: 'skill', observation }])`，头行对齐 `loop/engine.ts:120` 既有格式 `[Skill] <name> (id=<id> v=<version>)`），本计划按该定稿执行。
3. **去重与断言观察面**：链条目随事件级 journal 落盘，测试经 `listSessions(resolveDataDir(root))` → `parseJournalFile(meta.file)` → `reduceJournal(...)` 读 `replay.chain`，断言 `action === 'skill'` 条目（与 `/resume`、链相关测试同观察路径）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tui/components/OptionSelector.tsx` | 修改 | 增 `filterOptions` 纯函数 + `filter`/`indexMap` 受控 props（筛选行渲染、勾选按原下标换算、筛选态隐藏数字编号） |
| `src/tui/components/OptionSelector.filter.test.tsx` | 新建 | filterOptions 纯函数与筛选渲染用例（含无 filter 逐字节回归钉） |
| `src/types.ts` | 修改 | `AskUserRequest` 增 `filterable?: boolean` |
| `src/tui/components/App.tsx` | 修改 | 问询卡 filterable 键盘分发（两段式 Esc/字符进词/映射提交/导航翻页）+ `deriveFilterableView` 纯函数 + `SLASH_COMMANDS` 增 `/skill` |
| `src/tui/components/App.skill-filter.test.tsx` | 新建 | App 层筛选交互用例（含非 filterable 数字快选回归钉） |
| `src/tui/session.ts` | 修改 | `skillFlow` 私有方法 + `/skill` 分支 + slashHelp 行 + `/resume`、`/memory-rm` >8 接线 |
| `src/tui/session.skill.test.ts` | 新建 | /skill 守卫、链尾追、去重、resolve 失败、dismissed 静默用例 |
| `src/tui/session.selector.test.ts` | 修改 | /resume >8 用例改断言 filterable 全量卡 |
| `src/tui/session.memory.test.ts` | 修改 | /memory-rm >8 用例改断言 filterable 全量卡 |
| `src/tui/session.test.ts` | 修改 | /help 命令清单断言 18→20 条（补 `/tasks`、`/skill`） |
| `MANUAL.md` | 修改 | 命令总表 /skill 行 + /resume、/memory-rm 筛选口径 |

---

### Task 1: filterOptions 纯函数与 OptionSelector 筛选渲染

**Files:**
- Modify: `src/tui/components/OptionSelector.tsx`
- Test: `src/tui/components/OptionSelector.filter.test.tsx`（新建）

**Interfaces:**
- Consumes: 既有 `SelectorOption`、`OptionSelectorProps`、`moveCursor`、`togglePick`（同文件，签名零改动）
- Produces: `filterOptions(options: SelectorOption[], query: string): { view: SelectorOption[]; map: number[] }`（新导出，Task 2 App 层依赖）；`OptionSelectorProps` 增 `filter?: string`、`indexMap?: number[]`——语义钉：`filter` 传空串也算筛选态（渲染筛选行 `/ ▊`）；`map[i]` = 视图第 i 行对应的原下标；`indexMap` 缺省时组件内部按 `filter` 自行推导

- [ ] **Step 1: 写失败测试**

新建 `src/tui/components/OptionSelector.filter.test.tsx`：

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { filterOptions, OptionSelector } from './OptionSelector';

const opts = [
  { label: 'code-review', description: 'Review changes since a fixed point' },
  { label: 'brainstorming', description: 'Turn ideas into designs' },
  { label: 'retro', description: 'Conduct a retrospective' },
];

test('filterOptions：空词恒等（视图=全量、map=[0..n)）', () => {
  const r = filterOptions(opts, '');
  assert.deepEqual(r.view, opts);
  assert.deepEqual(r.map, [0, 1, 2]);
});

test('filterOptions：label 命中、大小写不敏感', () => {
  const r = filterOptions(opts, 'CODE');
  assert.deepEqual(r.map, [0]);
  assert.equal(r.view[0]?.label, 'code-review');
});

test('filterOptions：description 命中', () => {
  const r = filterOptions(opts, 'retrospective');
  assert.deepEqual(r.map, [2]);
});

test('filterOptions：无命中返回空视图（map 空）', () => {
  const r = filterOptions(opts, 'zzz');
  assert.equal(r.view.length, 0);
  assert.deepEqual(r.map, []);
});

test('OptionSelector：filter 渲染筛选行 + 过滤视图 + 勾选按原下标换算 + 编号隐藏', () => {
  const { lastFrame, unmount } = render(
    <OptionSelector question="Load which skill?" options={opts} cursor={0} picked={[2]} multiple filter="re" indexMap={[0, 2]} />,
  );
  const f = lastFrame() ?? '';
  assert.ok(f.includes('/ re▊'), '筛选行显示当前词');
  assert.ok(f.includes('code-review') && f.includes('retro'), '两个命中项渲染');
  assert.ok(!f.includes('brainstorming'), '未命中项不渲染');
  assert.ok(!f.includes('1. code-review') && !f.includes('3. retro'), '筛选态隐藏数字编号前缀');
  assert.ok(f.includes('◉'), '勾选标记按原下标换算（retro 原下标 2 在 picked）');
  unmount();
});

test('OptionSelector：空筛选词渲染筛选行但列表全量（恒等）', () => {
  const { lastFrame, unmount } = render(
    <OptionSelector question="q" options={opts} cursor={0} picked={[]} filter="" />,
  );
  const f = lastFrame() ?? '';
  assert.ok(f.includes('/ ▊'), '空词筛选行');
  assert.ok(f.includes('brainstorming'), '全量渲染');
  unmount();
});

test('OptionSelector：无 filter 渲染与旧形态一致（回归钉：编号照旧、无筛选行）', () => {
  const { lastFrame, unmount } = render(<OptionSelector question="q" options={opts} cursor={1} picked={[1]} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('2. brainstorming'), '编号前缀照旧');
  assert.ok(!f.includes('/ ▊'), '无筛选行');
  unmount();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/components/OptionSelector.filter.test.js`
Expected: FAIL——`filterOptions` 未导出、`filter`/`indexMap` props 不存在（TS 编译期即报错）

- [ ] **Step 3: 最小实现**

`src/tui/components/OptionSelector.tsx` 三处改动：

① `OptionSelectorProps` 增两个字段（插在 `hint?: string;` 之后）：

```ts
  /** 筛选态受控值：undefined=非筛选卡（渲染与旧形态逐字节一致）；空串也算筛选态（渲染 `/ ▊` 行） */
  filter?: string;
  /** 视图下标→原下标映射（调用方预计算传入；缺省时组件按 filter 自行推导） */
  indexMap?: number[];
```

② 文件内 `togglePick` 之后新增导出纯函数：

```ts
/** 筛选纯函数（规格 D6）：query 空恒等；非空按 label+description 小写化子串包含，返回视图与「视图下标→原下标」映射 */
export function filterOptions(options: SelectorOption[], query: string): { view: SelectorOption[]; map: number[] } {
  if (query.length === 0) return { view: options, map: options.map((_, i) => i) };
  const q = query.toLowerCase();
  const view: SelectorOption[] = [];
  const map: number[] = [];
  options.forEach((o, i) => {
    if (`${o.label}\n${o.description ?? ''}`.toLowerCase().includes(q)) {
      view.push(o);
      map.push(i);
    }
  });
  return { view, map };
}
```

③ 组件签名与渲染体替换（保持纯受控；`orig` 统一取映射，非筛选态 map 为恒等 → 渲染字节与旧形态一致）：

```tsx
export function OptionSelector({ question, options, cursor, picked, multiple, title, hint, filter, indexMap }: OptionSelectorProps): JSX.Element {
  const filtering = filter !== undefined;
  const derived = filtering ? filterOptions(options, filter) : undefined;
  const view = derived ? derived.view : options;
  const map = indexMap ?? derived?.map ?? options.map((_, i) => i);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {title ? <Text bold>{title}</Text> : null}
      <Text bold>{question}</Text>
      {filtering ? <Text dimColor>/ {filter}▊</Text> : null}
      {view.map((o, i) => {
        const orig = map[i] ?? i;
        const cursorMark = i === cursor ? '❯ ' : '  ';
        const pickMark = multiple ? (picked.includes(orig) ? '◉ ' : '○ ') : '';
        return (
          <Text key={`${orig}-${o.label}`}>
            {cursorMark}
            {pickMark}
            {filtering ? '' : `${orig + 1}. `}
            {o.label}
            {o.description ? <Text dimColor> — {o.description}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>{hint ?? t('↑/↓ move · space select · enter submit · esc cancel', '↑/↓ 移动 · 空格选定 · 回车提交 · Esc 取消')}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: 跑测试确认通过 + 既有套件零误伤**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/components/OptionSelector.filter.test.js dist/tui/components/OptionSelector.test.js dist/tui/components/App.selector.test.js`
Expected: 全部 PASS（含既有 selector 用例——非 filter 路径渲染逐字节不变）

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/OptionSelector.tsx src/tui/components/OptionSelector.filter.test.tsx
git commit -m "feat(tui): 选择卡 filterable 能力——filterOptions 纯函数与受控筛选行渲染（规格 D6）"
```

---

### Task 2: AskUserRequest.filterable 与 App 层筛选键盘分发

**Files:**
- Modify: `src/types.ts`（AskUserRequest 增 `filterable?: boolean`）
- Modify: `src/tui/components/App.tsx`（filterable 分发分支 + `deriveFilterableView` 纯函数 + 筛选态/页码 state + 渲染透传）
- Test: `src/tui/components/App.skill-filter.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 `filterOptions`（`./OptionSelector`）；既有 `paginateOptions`（`../session` 导出）；既有 `moveCursor`/`togglePick`；`SessionController.askUser(req)`（public，测试用它直接挂起 filterable 卡）与 `resolveAskAnswer`
- Produces: `deriveFilterableView(full, query, page): { view; map: number[]; moreIdx: number; backIdx: number }`（App.tsx 新导出，map[i]=视图第 i 行对应 `q.options` 原下标，导航行无席位、经 moreIdx/backIdx 标记）；`AskUserRequest.filterable?: boolean`（Task 3/4 的 session 侧消费）

- [ ] **Step 1: 写失败测试**

新建 `src/tui/components/App.skill-filter.test.tsx`：

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App, deriveFilterableView } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function flushKey(term: ReturnType<typeof render>): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

/* ---------- deriveFilterableView 纯函数 ---------- */

const full10 = Array.from({ length: 10 }, (_, i) => ({ label: `m-${i}`, description: `d ${i}` }));

test('deriveFilterableView：空词分页——8 实项 + More…，导航行无映射席位', () => {
  const r = deriveFilterableView(full10, '', 0);
  assert.equal(r.view.length, 9, '8 实项 + More…');
  assert.equal(r.view[8]?.label, 'More…');
  assert.deepEqual(r.map, [0, 1, 2, 3, 4, 5, 6, 7], '实项映射原下标');
  assert.equal(r.moreIdx, 8, 'More… 视图下标');
  assert.equal(r.backIdx, -1, '首页无 Back…');
});

test('deriveFilterableView：第 2 页带 Back…，More… 先于 Back…', () => {
  const r = deriveFilterableView(full10, '', 1);
  assert.equal(r.view.length, 3, '2 实项 + Back…');
  assert.deepEqual(r.map, [8, 9]);
  assert.equal(r.moreIdx, -1);
  assert.equal(r.backIdx, 2);
});

test('deriveFilterableView：有词全量过滤直出、无导航行', () => {
  const three = [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }];
  const r = deriveFilterableView(three, 'a', 0);
  assert.deepEqual(r.map, [0, 2], 'alpha/gamma 命中');
  assert.equal(r.moreIdx, -1);
  assert.equal(r.backIdx, -1, '有词无导航');
});

/* ---------- App 键盘分发（经 ctrl.askUser 直挂 filterable 卡） ---------- */

test('App filterable 卡：数字进筛选词（快选让位）、Enter 经 map 提交原 label', async () => {
  const tmp = tmpDir('sunshinex-appfilt1-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const options = Array.from({ length: 10 }, (_, i) => ({ label: `skill-${i}`, description: `desc ${i}` }));
    const p = ctrl.askUser({ question: 'Load which skill?', options, filterable: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('Load which skill?'), 3000);
    term.write('9');
    await flushKey(term);
    const f = term?.lastFrame() ?? '';
    assert.ok(f.includes('/ 9▊'), '筛选行显示数字词');
    assert.ok(!f.includes('skill-0'), '未命中项隐藏');
    assert.ok(f.includes('skill-9'), '命中项渲染');
    term.write('\r');
    assert.deepEqual(await p, { type: 'selected', labels: ['skill-9'] }, 'Enter 经 map 提交原 label');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App filterable 卡：Backspace 删字；Esc 两段式——先清词再退出 dismissed', async () => {
  const tmp = tmpDir('sunshinex-appfilt2-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const options = [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }];
    const p = ctrl.askUser({ question: 'q?', options, filterable: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('q?'), 3000);
    term.write('ab');
    await flushKey(term);
    term.write('\u007F'); // Backspace 删字
    await flushKey(term);
    assert.ok((term?.lastFrame() ?? '').includes('/ a▊'), '删字后剩 a');
    term.write('\u001B'); // Esc：词非空 → 清词
    await flushKey(term);
    assert.ok((term?.lastFrame() ?? '').includes('/ ▊'), 'Esc 先清词、卡仍在');
    assert.ok((term?.lastFrame() ?? '').includes('alpha'), '清词后全量列表回归');
    term.write('\u001B'); // Esc：词空 → 退出
    assert.deepEqual(await p, { type: 'dismissed' }, 'Esc 两段式退出');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App filterable 多选卡：Space 按原下标勾选、More… 翻页、Enter 提交勾选累积集', async () => {
  const tmp = tmpDir('sunshinex-appfilt3-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const p = ctrl.askUser({ question: 'rm?', options: full10, multiple: true, filterable: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('rm?'), 3000);
    term.write(' '); // cursor 0 → 勾 m-0
    await flushKey(term);
    assert.ok((term?.lastFrame() ?? '').includes('◉'), '勾选标记上屏');
    term.write('\u001B[B'); // ↓ 到 More…（视图下标 8）
    await flushKey(term);
    term.write('\r'); // 翻页
    await flushKey(term);
    const f1 = term?.lastFrame() ?? '';
    assert.ok(f1.includes('Back…') && f1.includes('m-8'), '翻到第 2 页');
    term.write('\u001B[B'); // 翻页后 cursor 归 0（m-8）→ ↓ 到 m-9
    await flushKey(term);
    term.write(' '); // 勾 m-9
    await flushKey(term);
    term.write('\r'); // 提交累积集
    assert.deepEqual(await p, { type: 'selected', labels: ['m-0', 'm-9'] }, '跨页勾选累积提交（升序）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App 非 filterable 卡：数字快选照旧（回归钉，规格 D6 零触碰承诺）', async () => {
  const tmp = tmpDir('sunshinex-appfilt4-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const options = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
    const p = ctrl.askUser({ question: 'plain?', options });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('plain?'), 3000);
    term.write('2');
    assert.deepEqual(await p, { type: 'selected', labels: ['B'] }, '数字 2 快选第二项');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/components/App.skill-filter.test.js`
Expected: FAIL——`deriveFilterableView` 未导出、`filterable` 字段不存在（TS 编译期报错）

- [ ] **Step 3: 最小实现**

① `src/types.ts`：`AskUserRequest` 末尾（`customIndex?: number;` 之后）增：

```ts
  /** 筛选卡标记（规格 D6，仅 TUI 渲染面消费）：调用方按 items.length > 8 设置；CLI stdin 编号回落与 headless 桩忽略降级 */
  filterable?: boolean;
```

② `src/tui/components/App.tsx` 四处改动：

(a) import 行扩展——`import { moveCursor, OptionSelector, togglePick, filterOptions } from './OptionSelector';` 与 `import { SessionController, TuiState, paginateOptions } from '../session';`

(b) `planSelectorOptions` 之后新增导出纯函数：

```ts
/** filterable 卡视图派生单点（规格 D8）：空词=全量分页视图（More…/Back… 导航行无映射席位）；有词=全量过滤直出、无导航行。
 *  map[i]=视图第 i 行对应的 q.options 原下标；moreIdx/backIdx=-1 表示该导航行不在场 */
export function deriveFilterableView(
  full: Array<{ label: string; description?: string }>,
  query: string,
  page: number,
): { view: Array<{ label: string; description?: string }>; map: number[]; moreIdx: number; backIdx: number } {
  if (query.length > 0) {
    const { view, map } = filterOptions(full, query);
    return { view, map, moreIdx: -1, backIdx: -1 };
  }
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(full.length / pageSize));
  const realCount = Math.max(0, Math.min(pageSize, full.length - page * pageSize));
  const map: number[] = [];
  for (let i = 0; i < realCount; i++) map.push(page * pageSize + i);
  let moreIdx = -1;
  let backIdx = -1;
  let navAt = map.length;
  if (page + 1 < totalPages) { moreIdx = navAt; navAt += 1; }
  if (page > 0) { backIdx = navAt; }
  return { view: paginateOptions(full, page).options, map, moreIdx, backIdx };
}
```

(c) 选择器本地态区（`setQText` 定义之后）增筛选词/页码两组 state+ref，并在「新问询卡到达」effect 的归位块（`setQText('');` 之后）追加 `setQFilter(''); setQPage(0);`：

```ts
  // filterable 卡筛选态（规格 D6/D7）：词与页码 ref 真值 + state 渲染，随新问询卡归位清零
  const [qFilter, setQFilterState] = React.useState('');
  const [qPage, setQPageState] = React.useState(0);
  const qFilterRef = React.useRef('');
  const qPageRef = React.useRef(0);
  const setQFilter = (v: string): void => { qFilterRef.current = v; setQFilterState(v); };
  const setQPage = (v: number): void => { qPageRef.current = v; setQPageState(v); };
```

(d) 问询卡分发分支（`const q = state.question;` 之后、`qCustomRef` 分支之前）插入 filterable 分支：

```ts
      // filterable 卡（规格 D6–D8）：可打印字符（含数字）进筛选词、Backspace 删字、Esc 两段式、
      // 词变 cursor 归 0；↑/↓/Space/Enter 作用于视图，导航行翻页、实项经 map 落原下标
      if (q.filterable) {
        const { view, map, moreIdx, backIdx } = deriveFilterableView(q.options, qFilterRef.current, qPageRef.current);
        if (key.ctrl && input === 'c') { controller.resolveAskAnswer({ type: 'dismissed' }); controller.interrupt(); return; }
        if (key.escape) {
          if (qFilterRef.current.length > 0) { setQFilter(''); setQCursor(0); return; }
          controller.resolveAskAnswer({ type: 'dismissed' });
          return;
        }
        if (key.backspace || key.delete) { setQFilter(qFilterRef.current.slice(0, -1)); setQCursor(0); return; }
        if (key.upArrow) { setQCursor(moveCursor(qCursorRef.current, view.length, -1)); return; }
        if (key.downArrow) { setQCursor(moveCursor(qCursorRef.current, view.length, 1)); return; }
        if (key.return || input === ' ') {
          if (qCursorRef.current === moreIdx) { setQPage(qPageRef.current + 1); setQCursor(0); return; }
          if (qCursorRef.current === backIdx) { setQPage(qPageRef.current - 1); setQCursor(0); return; }
          const orig = map[qCursorRef.current] ?? -1;
          if (orig < 0) return;
          if (key.return) {
            if (q.multiple) {
              const labels = qPickedRef.current.map((i) => q.options[i]?.label).filter((l): l is string => typeof l === 'string');
              controller.resolveAskAnswer(labels.length > 0 ? { type: 'selected', labels } : { type: 'dismissed' });
            } else {
              controller.resolveAskAnswer({ type: 'selected', labels: [q.options[orig]!.label] });
            }
            return;
          }
          if (q.multiple) setQPicked(togglePick(qPickedRef.current, orig, true));
          else controller.resolveAskAnswer({ type: 'selected', labels: [q.options[orig]!.label] });
          return;
        }
        if (input && !key.ctrl && !key.meta) { setQFilter(qFilterRef.current + input); setQCursor(0); return; }
        return; // 模态：其余键不落输入缓冲
      }
```

(e) 渲染块改造——渲染体内（`const columns = …` 之后）计算 `const fq = state.question?.filterable ? deriveFilterableView(state.question.options, qFilter, qPage) : undefined;`，`state.question ?` JSX 块的 `<OptionSelector …>` 改为：

```tsx
          <OptionSelector
            question={state.question.question}
            options={fq ? fq.view : state.question.options}
            cursor={qCursor}
            picked={qPicked}
            multiple={state.question.multiple}
            filter={fq ? qFilter : undefined}
            indexMap={fq ? fq.map : undefined}
            title={t('AskQuestion', '问询')}
            hint={
              fq
                ? t('type to filter · enter submit · esc clear/cancel', '输入筛选 · 回车提交 · Esc 清词/取消')
                : qCustom
                  ? t('type your answer · enter submit · esc back to options', '输入回答 · 回车提交 · Esc 返回选项')
                  : undefined
            }
          />
```

- [ ] **Step 4: 跑测试确认通过 + 既有套件零误伤**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/components/App.skill-filter.test.js dist/tui/components/App.selector.test.js dist/tui/components/App.ask.test.js dist/tui/components/App.input.test.js`
Expected: 全部 PASS（非 filterable 卡路径不变，数字快选回归钉绿）

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/tui/components/App.tsx src/tui/components/App.skill-filter.test.tsx
git commit -m "feat(tui): 问询卡 filterable 键盘分发——两段式 Esc/字符进词/映射提交/导航翻页（规格 D6-D8）"
```

---

### Task 3: /skill 命令面——skillFlow、分发分支、补全清单与帮助

**Files:**
- Modify: `src/tui/session.ts`（handleSlash 分支 + `skillFlow` 私有方法 + slashHelp 行）
- Modify: `src/tui/components/App.tsx`（SLASH_COMMANDS 增 `'/skill'`，插在 `'/tasks'` 之后）
- Modify: `src/tui/session.test.ts`（/help 命令清单断言 18→20 条：补 `'/tasks'`、`'/skill'`）
- Modify: `src/tui/components/App.input.test.tsx`（补全断言两行）
- Test: `src/tui/session.skill.test.ts`（新建）

**Interfaces:**
- Consumes: `this.runtime.harness.skills`（`SkillsFacade.list()/resolve()`，harness/index.ts:64 装配）；`this.runtime.harness.context.chainView()/appendChain()`（context/index.ts:175/180）；`this.askUser(req)`（挂起即置 `status='awaiting-question'`）；`this.pushMsg(text, { level })`
- Produces: `SessionController` 私有 `skillFlow()`（handleSlash `'/skill'` 分支调用）；`SLASH_COMMANDS` 含 `'/skill'`（Tab 邻位 `/tasks → /skill → /new`）；链上条目形态 `{ action: 'skill', observation: '[Skill] <name> (id=<id> v=<version>)\n\n<body>' }`（规格 D2/D3 的去重锚点）

- [ ] **Step 1: 写失败测试**

新建 `src/tui/session.skill.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, parseJournalFile, reduceJournal } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = tmpdir('sunshinex-sess-skill-');
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function sysTexts(ctrl: SessionController): string[] {
  return ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text);
}

/** 项目级技能夹具（.sunshinex/skills/<id>/SKILL.md，优先级链最高根） */
function writeSkill(root: string, id: string, name: string, description: string, extraFm = ''): void {
  const dir = path.join(root, '.sunshinex', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: ${description}`, 'version: 1.0.0'];
  if (extraFm) lines.push(extraFm);
  lines.push('---', '', `Body of ${name}.`);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
}

/** 事件级 journal 读链（chain 事件逐条直写，链条目即观察面） */
function chainEntries(root: string): Array<{ action?: string; observation: string }> {
  const meta = listSessions(resolveDataDir(root))[0];
  if (!meta) return [];
  return reduceJournal(parseJournalFile(meta.file).events).chain;
}

test('/skill：选择卡列技能、选定即链尾追注入 + 回执', async () => {
  await withRoot(async (root) => {
    writeSkill(root, 'greet', 'Greet', 'Say hello to someone');
    writeSkill(root, 'retro', 'Retro', 'Conduct a retrospective');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.ok(q, '选择卡挂起');
    assert.equal(q!.filterable, undefined, '≤8 项不开筛选');
    assert.deepEqual(q!.options.map((o) => o.label), ['Greet', 'Retro'], '按名排序（formatSkillsIndex 同比较器）');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Greet'] });
    await p;
    const entry = chainEntries(root).find((s) => s.action === 'skill');
    assert.ok(entry, '链上出现 action=skill 条目');
    assert.match(entry!.observation, /^\[Skill\] Greet \(id=greet v=1\.0\.0\)\n\nBody of Greet\./, '头行对齐 loop skillRef 格式 + 正文随后');
    assert.ok(sysTexts(ctrl).some((x) => /Skill loaded: Greet/.test(x)), '加载回执上屏');
    assert.equal(ctrl.getState().status, 'idle');
  });
});

test('/skill：>8 技能全量选项 + filterable 标记（筛选在渲染层，会话层不分页）', async () => {
  await withRoot(async (root) => {
    for (let i = 1; i <= 9; i++) writeSkill(root, `s${i}`, `Skill ${i}`, `desc ${i}`);
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.equal(q!.filterable, true, '>8 启用筛选');
    assert.equal(q!.options.length, 9, '全量直出、无 More… 导航行');
    assert.ok(!q!.options.some((o) => o.label === 'More…'), '会话层不注入导航行');
    ctrl.resolveAskAnswer({ type: 'dismissed' });
    await p;
  });
});

test('/skill：重复加载去重——回执已加载、链上仅一条', async () => {
  await withRoot(async (root) => {
    writeSkill(root, 'greet', 'Greet', 'Say hello');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p1 = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Greet'] });
    await p1;
    const p2 = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Greet'] });
    await p2;
    assert.ok(sysTexts(ctrl).some((x) => /already loaded|已加载/.test(x)), '去重回执');
    assert.equal(chainEntries(root).filter((s) => s.action === 'skill' && s.observation.includes('(id=greet)')).length, 1, '链上恰好一条');
  });
});

test('/skill：含必填模板参数的技能——resolve 失败 warn 回执零注入', async () => {
  await withRoot(async (root) => {
    writeSkill(root, 'paramed', 'Paramed', 'Needs a param', 'params: target');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Paramed'] });
    await p;
    assert.ok(sysTexts(ctrl).some((x) => x.includes('SKILL_PARAM_MISSING')), 'resolve 失败回执带错误码');
    assert.equal(chainEntries(root).filter((s) => s.action === 'skill').length, 0, '零注入');
  });
});

test('/skill：空清单回执不弹卡；运行中拒绝；带参形态无法识别；dismissed 静默', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/skill');
    assert.ok(sysTexts(ctrl).some((x) => /No skills available|暂无可用技能/.test(x)), '空清单回执');
    assert.equal(ctrl.getState().question, undefined, '不弹卡');

    // 运行中拒绝（守卫沿 /resume 先例；manual 模式写审批挂起即非 idle）
    writeSkill(root, 'greet', 'Greet', 'Say hello');
    const guarded = new SessionController({
      root,
      mode: 'manual',
      model: new ScriptedAdapter(['{"tool":"write","input":{"path":"a.txt","content":"1"},"done":false}', '{"done":true,"reply":"ok"}']),
    });
    const task = guarded.submit('写任务');
    await waitFor(() => guarded.getState().status === 'awaiting-approval');
    await guarded.submit('/skill');
    assert.ok(sysTexts(guarded).some((x) => /A task is running|暂不能执行/.test(x)), '运行中拒绝回执');
    assert.equal(guarded.getState().status, 'awaiting-approval', '仍挂审批、未弹技能卡');
    guarded.resolveApproval('deny');
    await task;

    // 带参形态走裸形式守卫（D1，不在 FREE_TEXT_ARGS 集）
    const bare = new SessionController({ root, model: new ScriptedAdapter([]) });
    await bare.submit('/skill greet');
    assert.ok(sysTexts(bare).some((x) => x.includes('Unrecognized command')), '带参形态统一无法识别');

    // dismissed 静默：无「Skill loaded」回执
    const quiet = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = quiet.submit('/skill');
    await waitFor(() => quiet.getState().status === 'awaiting-question');
    quiet.resolveAskAnswer({ type: 'dismissed' });
    await p;
    assert.ok(!sysTexts(quiet).some((x) => /Skill loaded/.test(x)), 'dismissed 零回执');
  });
});
```

修改 `src/tui/session.test.ts` /help 用例（数组补 `'/tasks'`、`'/skill'`，标题改 20 条）：

```ts
test('会话控制器：/help 列出全部 20 条扁平命令，旧子命令语法零残留', async () => {
  const tmp = tmpdir('sunshinex-sess-help20-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/help');
    const text = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    for (const c of ['/help', '/init', '/status', '/tasks', '/skill', '/new', '/resume', '/rewind', '/fork', '/compact', '/plan', '/goal', '/model', '/model-effort', '/memory', '/memory-add', '/memory-rm', '/memory-gc', '/memory-on', '/memory-off']) {
      assert.ok(text.includes(c), `missing ${c}`);
    }
    assert.ok(!/\/model effort|\/memory add|\/memory rm|\/memory gc|\/memory on\b|\/memory off\b/.test(text), '旧子命令语法零残留');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

（整段替换原「/help 列出全部 18 条」用例；`tmpdir` helper 为 session.test.ts 既有件，零新增。）

修改 `src/tui/components/App.input.test.tsx` 首个用例，`/goal` 断言行后追加两行：

```ts
  assert.ok(SLASH_COMMANDS.includes('/skill'), '/skill 已登记补全清单');
  assert.deepEqual(slashCandidates('/sk'), ['/skill']);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/session.skill.test.js dist/tui/session.test.js dist/tui/components/App.input.test.js`
Expected: FAIL——`/skill` 进「Unrecognized command」分支（卡不挂起、链无条目、补全清单缺项）

- [ ] **Step 3: 最小实现**

① `src/tui/components/App.tsx` `SLASH_COMMANDS`：`'/tasks'` 之后插入 `'/skill'`。

② `src/tui/session.ts` `slashHelp()`：`/tasks` 行之后插入：

```ts
    t('  /skill         load a skill into context (selector, type to filter)', '  /skill         加载技能进上下文（选择卡，输入筛选）'),
```

③ `src/tui/session.ts` `handleSlash()`：`/tasks` 分支块之后、`/new` 分支之前插入：

```ts
    if (cmd === '/skill') {
      // 技能选择卡（规格 D1/D5）：裸形式、单选选定即链尾追加载；带参形态由裸形式守卫统一无法识别
      await this.skillFlow();
      return;
    }
```

④ `src/tui/session.ts` `memoryRm()` 方法之前新增私有方法：

```ts
  /** /skill 技能选择卡（规格 D1–D5）：单选选定即加载；正文经链尾追持久注入（与模型 skill 工具观察同语义），
   *  链上同 id 去重；>8 项 filterable（筛选在渲染层，会话层全量直出） */
  private async skillFlow(): Promise<void> {
    if (this.state.status !== 'idle') {
      this.pushMsg('system', t('A task is running; /skill unavailable now', '当前有任务进行中，暂不能执行 /skill'), { level: 'warn' });
      return;
    }
    const manifests = [...this.runtime.harness.skills.list()].sort((a, b) =>
      a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
    );
    if (manifests.length === 0) {
      this.pushMsg('system', t('No skills available — add .sunshinex/skills/<id>/SKILL.md', '暂无可用技能——放置 SKILL.md 到 .sunshinex/skills/<id>/ 目录'), { level: 'warn' });
      return;
    }
    const labelToId = new Map<string, string>();
    const options = manifests.map((m) => {
      const label = labelToId.has(m.name) ? `${m.name} (${m.id})` : m.name;
      labelToId.set(label, m.id);
      return { label, description: m.description.length > 128 ? `${m.description.slice(0, 128)}…` : m.description };
    });
    const answer = await this.askUser({
      question: t('Load which skill? (type to filter)', '加载哪个技能？（输入即筛选）'),
      options,
      ...(options.length > 8 ? { filterable: true } : {}),
    });
    if (answer.type !== 'selected') return; // dismissed 静默（规格 D4，沿既有卡取消语义）
    const id = labelToId.get(answer.labels[0] ?? '');
    if (id === undefined) return;
    const loaded = this.runtime.harness.context.chainView().some((s) => s.action === 'skill' && s.observation.includes(`(id=${id})`));
    if (loaded) {
      this.pushMsg('system', t(`Skill ${id} already loaded in this session`, `技能 ${id} 本会话已加载`));
      return;
    }
    const r = this.runtime.harness.skills.resolve(id);
    if (!r.ok) {
      this.pushMsg('system', t(`Skill load failed: ${r.error.message}`, `技能加载失败：${r.error.message}`), { level: 'warn' });
      return;
    }
    const m = r.value.manifest;
    // 链尾追持久注入（规格 D2）：头行对齐 loop skillRef 既有格式，正文随后续每帧经链携带
    this.runtime.harness.context.appendChain([{ action: 'skill', observation: `[Skill] ${m.name} (id=${m.id} v=${m.version})\n\n${r.value.body}` }]);
    this.pushMsg('system', t(`Skill loaded: ${m.name} (id=${m.id}) — included in context for subsequent tasks`, `技能已加载：${m.name}（id=${m.id}）——随后续任务进上下文`));
  }
```

- [ ] **Step 4: 跑测试确认通过 + 帮助/补全面零误伤**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/session.skill.test.js dist/tui/session.test.js dist/tui/session.memory.test.js dist/tui/components/App.input.test.js`
Expected: 全部 PASS（/help 20 条、补全 `/sk → /skill`、既有 memory 套件零误伤）

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.skill.test.ts src/tui/session.test.ts src/tui/components/App.tsx src/tui/components/App.input.test.tsx
git commit -m "feat(tui): /skill 技能选择卡——选定即链尾追持久加载、链上去重、第 20 条扁平命令（规格 D1-D5）"
```

---

### Task 4: /resume 与 /memory-rm 的 >8 分支接线 filterable

**Files:**
- Modify: `src/tui/session.ts`（`resumeFlow` 增 >8 filterable 分支；`memoryRm` 增 >8 分支 + 批删执行面收敛 `applyMemoryRemoval` 单点）
- Modify: `src/tui/session.selector.test.ts`（>8 用例改断言 filterable 全量卡）
- Modify: `src/tui/session.memory.test.ts`（>8 用例改断言 filterable 全量卡）

**Interfaces:**
- Consumes: `AskUserRequest.filterable`（Task 2）；App 层 deriveFilterableView 双态（Task 2，渲染面）；既有 `paginateOptions`/`restoreFromSession`/`MemoryStore.remove/capacityNotice`
- Produces: `SessionController` 私有 `applyMemoryRemoval(store, picked: string[]): void`（两形态共用批删回执单点）；行为契约——**≤8 项路径逐字节不变**（仍走既有分页循环形态，仅 >8 分支切单次 filterable 问询）

- [ ] **Step 1: 改写两个失败测试**

`src/tui/session.selector.test.ts`：原「/resume：>8 条分页——首页 8 条 + More……」用例整段替换为：

```ts
test('/resume：>8 条 filterable 全量卡——一次问询直达恢复（规格 D8）', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    for (let i = 0; i < 9; i++) {
      const c = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
      await c.submit(`任务${i}`);
      await c.waitIdle();
    }
    assert.equal(listSessions(dataDir).length, 9, '前置：9 个存档会话');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']) });
    const p = ctrl.submit('/resume');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.equal(q?.filterable, true, '>8 启用筛选');
    assert.equal(q?.options.length, 9, '全量直出、无 More… 导航行');
    assert.ok(!q?.options.some((o) => o.label === 'More…'), '会话层不注入导航行');
    const labels = q?.options.map((o) => o.label) ?? [];
    ctrl.resolveAskAnswer({ type: 'selected', labels: [labels[0]!] });
    await p;
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', '选中即恢复目标会话');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

`src/tui/session.memory.test.ts`：原「/memory-rm 分页：>8 条 More… 翻页、跨页勾选累积批删」用例整段替换为：

```ts
test('/memory-rm >8 条 filterable 全量卡：一次问询勾选批删（规格 D8）', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    for (let i = 1; i <= 9; i++) await ctrl.submit(`/memory-add memo number ${i}`);
    const store = new MemoryStore(root);
    assert.equal(store.count(), 9, '前提：九条记忆');
    const p = ctrl.submit('/memory-rm');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.equal(q?.filterable, true, '>8 启用筛选');
    assert.equal(q?.options.length, 9, '全量直出、无 More… 导航行');
    const labels = q?.options.map((o) => o.label) ?? [];
    ctrl.resolveAskAnswer({ type: 'selected', labels: [labels[0]!, labels[1]!] });
    await p;
    assert.equal(store.count(), 7, '勾选 2 条已批删');
    assert.ok(sysTexts(ctrl).some((x) => /Removed 2 memories|已删除 2 条/.test(x)), '批删回执');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/session.selector.test.js dist/tui/session.memory.test.js`
Expected: FAIL——两用例断言 `filterable === true` 得 `undefined`（现行 >8 走分页循环）

- [ ] **Step 3: 最小实现**

① `resumeFlow()`：候选空守卫之后、`moreLabel` 声明之前插入分支（≤8 既有循环零改动）：

```ts
    // >8 项切 filterable 卡（规格 D6/D8）：全量直出、渲染层筛选，一次问询直达；≤8 项维持既有循环形态不变
    if (sessions.length > 8) {
      const items = sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') }));
      const answer = await this.askUser({
        question: t('Resume which session? (type to filter)', '恢复哪个会话？（输入即筛选）'),
        options: items,
        filterable: true,
      });
      if (answer.type !== 'selected') {
        this.pushMsg('system', t('Resume cancelled', '已取消恢复'));
        return;
      }
      const pick = sessions.find((s) => s.id === answer.labels[0]);
      if (!pick) {
        this.pushMsg('system', t('No such session: ' + (answer.labels[0] ?? ''), '没有这个会话：' + (answer.labels[0] ?? '')), { level: 'warn' });
        return;
      }
      this.restoreFromSession(pick);
      return;
    }
```

② `memoryRm()`：`items` 构造之后插入分支，并把方法尾部批删块（`const unique = …` 至 `].join('\n'));`）收敛为 `this.applyMemoryRemoval(store, picked);`：

```ts
    // >8 条切 filterable 卡（规格 D6/D8）：一次问询勾选批删；≤8 条维持既有分页循环不变
    if (items.length > 8) {
      const answer = await this.askUser({
        question: t('Select memories to delete (Space to toggle, Enter to delete; type to filter)', '选择要删除的记忆（Space 勾选，Enter 批量删除；输入即筛选）'),
        options: items,
        multiple: true,
        filterable: true,
      });
      if (answer.type !== 'selected' || answer.labels.length === 0) {
        this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
        return;
      }
      this.applyMemoryRemoval(store, answer.labels);
      return;
    }
```

类内新增私有方法（`memoryRm` 之后）：

```ts
  /** 批删执行面（/memory-rm 分页与 filterable 两形态共用单点）：去重→逐条删除→回执 */
  private applyMemoryRemoval(store: MemoryStore, picked: string[]): void {
    const unique = [...new Set(picked)];
    if (unique.length === 0) {
      this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const slug of unique) {
      const r = store.remove(slug);
      if (r.ok) ok += 1;
      else fail += 1;
    }
    const capacity = store.capacityNotice();
    this.pushMsg('system', [
      t(ok === 1 ? `Removed 1 memory${fail ? ` (${fail} failed)` : ''}` : `Removed ${ok} memories${fail ? ` (${fail} failed)` : ''}`, `已删除 ${ok} 条${fail ? `（失败 ${fail} 条）` : ''}`),
      ...(capacity ? [capacity] : []),
    ].join('\n'));
  }
```

- [ ] **Step 4: 跑测试确认通过 + 既有套件零误伤**

Run: `pnpm build && node --require ./scripts/test-env.cjs --test dist/tui/session.selector.test.js dist/tui/session.memory.test.js dist/tui/session.rewind.test.js dist/tui/session.journal.test.js dist/tui/components/App.skill-filter.test.js`
Expected: 全部 PASS（≤8 路径用例、血缘标注、跨轮合并等既有用例零误伤）

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.selector.test.ts src/tui/session.memory.test.ts
git commit -m "feat(tui): /resume、/memory-rm >8 分支接线 filterable 全量卡，批删收敛单点（规格 D6/D8）"
```

---

### Task 5: MANUAL 同步与全量门禁收尾

**Files:**
- Modify: `MANUAL.md`（命令总表 /skill 行 + /resume、/memory-rm 筛选口径）

- [ ] **Step 1: 手册三处更新**

命令总表 `/tasks` 行之后插入：

```markdown
| `/skill` | 加载技能进上下文：选择卡列出可用技能（`↑`/`↓` 选择、输入即筛选、`Esc` 取消），选定即载入、本会话重复加载回执已加载 |
```

`/resume` 行中「`>8 条分页；`」改为「`>8 条支持输入筛选（`Esc` 先清词再取消）；`」；`/memory-rm` 行中「`>8 条分页（`More…`/`Back…`）`」改为「`>8 条支持输入筛选（`Esc` 先清词再取消）`」。改完 `grep -n '分页' MANUAL.md` 全文核对，其余「分页」关联句（5.4 等）按新口径校正；工作区 MANUAL.md 若混叠并发线 hunks，提交走 Step 3 的拆分规则。

- [ ] **Step 2: 全量门禁**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: tsc strict 零报错；全量 fail 0（基线 1140 + 本线新增 19：OptionSelector.filter 7 + App.skill-filter 7 + session.skill 5）；selfcheck exit 0、工具清单零新增（/skill 是用户命令、非模型工具，零前缀断点）

- [ ] **Step 3: 提交**

```bash
# MANUAL.md 若仅含本线 hunks：
git add MANUAL.md
git commit -m "docs(manual): /skill 命令行与 /resume、/memory-rm 筛选口径同步（规格 D6/D8）"
# 若混叠并发线 hunks：沿 c0f4cfe 先例以临时索引+commit-tree 单文件拆分提交（树差异仅 MANUAL.md、真实索引与并发 WIP 零触碰），随后 git reset HEAD -- MANUAL.md 对齐防索引残渣
```

- [ ] **Step 4: 残留终验**

Run: `grep -rn "18 条扁平命令" src/ MANUAL.md; grep -n "More…" MANUAL.md`
Expected: 「18 条」零命中（/help 断言已改 20 条）；MANUAL 中 More… 仅允许存在于非 filterable 路径（≤8 分页语义仍存在，/resume、/memory-rm 行内不得再有）

## 计划自审记录

- **规格覆盖**：D1（Task 3 分支+补全）、D2/D3（Task 3 链尾追+chainView 去重）、D4（Task 3 五守卫用例）、D5（Task 3 排序/截断/单选）、D6（Task 1 组件 + Task 2 类型与分发）、D7（Task 2 键位六用例）、D8（Task 2 deriveFilterableView + Task 4 两卡接线）、D9（Global Constraints + Task 5 selfcheck 零新增工具）；A1–A8 ↔ Task 3 用例 1/链尾追语义、Task 3 用例 3（A3）、rewind 语义（A4，既有套件承载）、Task 4（A5）、Task 2 回归钉（A6/A7）、Task 5 终验（A8）。
- **占位符扫描**：全部步骤含完整代码/命令，无 TBD/「参照前文」；自审把 session.test.ts /help 用例的「夹具同原用例」缩写改为整段内联（Task 3 Step 1），全计划零缩写引用。
- **类型一致性**：`filterOptions`（Task 1 导出 = Task 2 消费）、`deriveFilterableView` 返回四元组（Task 2 定义 = 渲染与分发消费）、`filterable`（Task 2 类型 = Task 3/4 调用方）、`applyMemoryRemoval`（Task 4 定义 = 两分支调用）签名前后一致。
- **现场勘误**：SLASH_COMMANDS 现为 19 条（/tasks 已并入），/skill 为第 20 条（见头部勘误 §1）；session.selector/memory 两处 >8 用例的 helper 名（tmpRoot/pinDataDir/withRoot/sysTexts/waitFor）已按现行文件核实。

