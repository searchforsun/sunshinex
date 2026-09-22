# todo_write 通用模型工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为模型提供 `todo_write` 工具——复杂任务中自主建清单/实时更新进度，与 /plan 清单同源合流为单一状态面（规格 docs/superpowers/specs/2026-09-22-todowrite-tool-design.md，D1–D10）。

**Architecture:** TodoItem 二态升三态并升格为共享类型（types.ts）；`session.setTodos()` 为唯一写点（模型工具调用 / plan 引擎推进两条运行期路径共用，journal 重放为恢复路径直接赋值防自我回写）；工具恒注册沿 skill 先例（未装配 facade 执行报 `todo_not_configured`，生产装配点 Harness 恒注入）；fork 子面沿 spawn 先例剔除。

**Tech Stack:** TypeScript strict + node:test + ink（渲染）；ScriptedAdapter 字符串步 DSL 承载端到端。

## Global Constraints

- 工具 id 恒 `todo_write`；入参 `{ todos: [{ text, status }] }` 全量替换（规格 D3）；`todos: []` 合法=清空清单；条数 >50 报 `INVALID_ARG`（显式拒绝，不静默截断）
- `ToolCategory` 新增 `'todo'`：单发独占（reactor 并行闸门，不进并行批）；免审批（guard 三模式放行，deny 规则与破坏性硬底线仍先行）（规格 D4）
- `TodoItem` 三态 `{ text, status: 'pending' | 'in_progress' | 'completed' }`；无 activeForm（规格 D5）
- journal `todos` 事件词汇零扩展，仅载荷形态升级；旧载荷 `{text, done}` 重放归一（done:true→completed / false→pending）（规格 D8）
- fork 派生子面恒无 `todo_write`（无论显式 tools 是否列名）（规格 D9）
- 工具 description 与观察行恒英文单语（CLAUDE.md §15）；使用纪律写进 description（复杂多步任务才建、同刻恰一个 in_progress、完成即标、全量替换语义）
- 前缀缓存：工具清单 +1 = 一次全量断点（规格 D10，已裁决即论据）；零新增动态源（无时间戳/随机值进提示词面）
- 提交纪律：本线 src 代码文件与工作区并发 WIP（CLAUDE.md/MANUAL.md/src/config/cli.test.ts）零交集可正常提交；**CLAUDE.md 与 MANUAL.md 有他线未提交 hunks，文档改动提交须按 hunk 隔离**（临时索引+commit-tree 或现场裁决，无法干净拆分则登记待用户指令）
- 测试同目录就近放置（CLAUDE.md §5）；全量测试经 `pnpm test`（run-tests.js 启动器）

## File Structure

| 文件 | 职责 | 动作 |
|------|------|------|
| src/types.ts | TodoStatus/TodoItem 共享类型登记、ToolCategory +'todo' | Modify |
| src/tui/session.ts | TodoItem 定义改再导出、setTodos 单点、runPlanItems 三态推进 | Modify |
| src/tui/session-journal.ts | normalizeTodoItems 旧载荷归一（reduce 单点挂接） | Modify |
| src/tui/components/TodoList.tsx | 三态渲染（✓绿/▸高亮/○暗）、紧凑当前项 in_progress 优先 | Modify |
| src/tui/components/StatusBar.tsx | done 计数迁 status 判据 | Modify |
| src/harness/tools/builtin.ts | todo_write 注册（schema+executor，第 12 可选参 facade） | Modify |
| src/harness/security/guard.ts | todo_write 三模式免审批放行 | Modify |
| src/harness/reactor.ts | 并行闸门 + 'todo'；拒绝文案补全 | Modify |
| src/harness/subagent.ts | TODO_TOOL_NAME + deriveChildRegistry 恒剔除 | Modify |
| src/harness/index.ts | HarnessOptions.todos 接线（缺省 no-op） | Modify |
| src/tui/runtime.ts | TuiRuntimeOpts.onTodos 透传 Harness | Modify |
| MANUAL.md / CLAUDE.md §3 | 待办卡三态口径 / 工具注释 | Modify |

---

### Task 1: TodoItem 三态升格与 journal 旧载荷归一

**Files:**
- Modify: `src/types.ts`（ToolCategory 行前新增类型）
- Modify: `src/tui/session.ts`（TodoItem 定义删除改再导出；`setTodos` 单点；runPlanItems 种子与推进；~517/545 行）
- Modify: `src/tui/session-journal.ts`（新增 normalizeTodoItems 导出；reduce `case 'todos'` 挂接）
- Modify: `src/tui/components/TodoList.tsx`（三态渲染）
- Modify: `src/tui/components/StatusBar.tsx:40`（done 计数判据）
- Test: `src/tui/session-journal.test.ts`（既有 180-193 用例断言迁移 + 新增归一用例）、`src/tui/components/TodoList.test.tsx`（夹具迁移 + 新增三态用例）、`src/tui/session.plan.test.ts`（新增 todos 事件序列用例）

**Interfaces:**
- Consumes: 无（本任务为地基）
- Produces: `TodoStatus`/`TodoItem`（src/types.ts，session.ts 再导出保持既有 import 路径）；`normalizeTodoItems(raw: unknown[]): TodoItem[]`（session-journal.ts 导出）；`SessionController.setTodos(items: TodoItem[]): void`（private，Task 3 工具路径复用）

- [ ] **Step 1: 写失败测试（journal 归一）**

`src/tui/session-journal.test.ts` 追加（沿用既有 replayJournal 用例形态，参考 180-193 行既有 todos 用例）：

```ts
test('todos 旧载荷布尔形态重放归一为三态（todo_write 规格 D8）', () => {
  const r = replayJournal([
    { t: 'todos', items: [{ text: '旧项', done: true }, { text: '中项', done: false }, { text: '新项', status: 'in_progress' }] },
  ] as JournalEvent[]);
  assert.deepEqual(r.todos, [
    { text: '旧项', status: 'completed' },
    { text: '中项', status: 'pending' },
    { text: '新项', status: 'in_progress' },
  ]);
});
```

同时把既有用例（180-193 行）的输入保持旧布尔形态、断言改为归一后三态：

```ts
// 输入不变：{ t: 'todos', items: [{ text: '旧待办', done: true }] }, { t: 'todos', items: [{ text: '新待办', done: false }] },
// 断言改为：
assert.deepEqual(r.todos, [{ text: '新待办', status: 'pending' }]);
```

- [ ] **Step 2: 写失败测试（TodoList 三态渲染）**

`src/tui/components/TodoList.test.tsx`：既有 `todos` 夹具整体迁移三态（`done: true` → `status: 'completed' as const`、`done: false` → `status: 'pending' as const`），三个既有用例的 ▸/✓ 断言语义不变（in_progress 与 pending 展开形态当前都显 ▸，下一 Step 实现后 ○ 属 pending——夹具先行统一，断言随实现校正）；追加两个新用例：

```tsx
const todos3 = [
  { text: '阅读 prd.md', status: 'completed' as const },
  { text: '梳理技术栈版本', status: 'in_progress' as const },
  { text: '输出架构总览', status: 'pending' as const },
];

test('TodoList 三态展开：✓ 已完成 / ▸ 进行中 / ○ 未开始（todo_write 规格 §8）', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos3} expanded columns={80} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('✓ 阅读 prd.md'), 'completed 勾选展示');
  assert.ok(f.includes('▸ 梳理技术栈版本'), 'in_progress 箭头展示');
  assert.ok(f.includes('○ 输出架构总览'), 'pending 圆圈展示');
  unmount();
});

test('TodoList 紧凑当前项：取首个 in_progress，无则回退首个 pending', () => {
  const a = render(<TodoList todos={todos3} expanded={false} columns={80} />);
  assert.ok((a.lastFrame() ?? '').includes('▸ 梳理技术栈版本'), 'in_progress 优先于 pending');
  a.unmount();
  const b = render(<TodoList todos={[todos3[0], todos3[2]]} expanded={false} columns={80} />);
  assert.ok((b.lastFrame() ?? '').includes('▸ 输出架构总览'), '无 in_progress 回退首个 pending');
  b.unmount();
});
```

- [ ] **Step 3: 写失败测试（plan 步骤推进轨迹）**

`src/tui/session.plan.test.ts` 追加（夹具复用既有第一个用例的 ScriptedAdapter 三步形态）：

```ts
test('/plan 步骤推进：todos 事件序列记录 in_progress→completed 全轨迹（规格 D7）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-todo-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 步骤A\\n2. 步骤B"}',
        '{"done":true,"reply":"步骤A 完成"}',
        '{"done":true,"reply":"步骤B 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const todos = ctrl.getState().todos;
    assert.deepEqual(todos, [
      { text: '步骤A', status: 'completed' },
      { text: '步骤B', status: 'completed' },
    ]);
    // journal todos 事件流：种子(全 pending) → A in_progress → A completed → B in_progress → B completed
    const dir = sessionsDir(resolveDataDir(tmp));
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    assert.ok(file, '会话 journal 已建档');
    const parsed = parseJournalFile(path.join(dir, file!));
    const seq = parsed.events.filter((e) => e.t === 'todos').map((e) => e.items);
    assert.ok(seq.length >= 5, '种子+逐步推进均落 todos 事件');
    assert.deepEqual(seq[0], [{ text: '步骤A', status: 'pending' }, { text: '步骤B', status: 'pending' }], '种子全 pending');
    assert.deepEqual(
      seq.find((items) => items.some((it) => it.text === '步骤A' && it.status === 'in_progress')),
      [{ text: '步骤A', status: 'in_progress' }, { text: '步骤B', status: 'pending' }],
      '步骤A 开始即 in_progress',
    );
    assert.deepEqual(seq[seq.length - 1], todos, '末条与最终状态一致');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

（import 补 `parseJournalFile, sessionsDir` from './session-journal'、`resolveDataDir` from '../config/data-dir'；若 sessionsDir 签名为 `(dataDir) => path` 与现场不符，以 session-journal.branch.test.ts 既有用法为准校正调用形态。）

- [ ] **Step 4: 跑测试确认失败**

Run: `node --test --test-reporter=dot dist/tui/session-journal.test.js dist/tui/components/TodoList.test.js 2>/dev/null || pnpm build && node --test dist/tui/session-journal.test.js dist/tui/components/TodoList.test.js dist/tui/session.plan.test.js`
Expected: FAIL——夹具 `done` 字段与三态类型不符（tsc 编译期即红）或归一/三态断言失败

- [ ] **Step 5: 实现**

① `src/types.ts`（ToolCategory 行前）：

```ts
/** todo_write 条目状态（规格 D5）：三态——「同刻恰一个 in_progress」为使用纪律，由工具 description 承载 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 会话 todo 清单条目（原 TUI 局部类型升格共享：harness 工具面与 TUI 状态面同源，规格 D2 单点状态面） */
export interface TodoItem {
  text: string;
  status: TodoStatus;
}
```

② `src/tui/session.ts`：删除本地 `TodoItem` interface，原位改再导出（保持 './session' import 路径零改动）；文件顶部追加 `import type { TodoItem, TodoStatus } from '../types';`（再导出行保留，本文件内 setTodos/runPlanItems 标注类型用 import 形态）：

```ts
export type { TodoItem, TodoStatus } from '../types';
```

新增唯一写点（放 `logTodos()` 旁）：

```ts
/** todo 清单唯一写点（规格 D6）：state 更新 + journal 即时落盘 + notify；模型工具/plan 引擎两条运行期路径共用。journal 重放为恢复路径，直接赋值不走此点（防重放自我回写） */
private setTodos(items: TodoItem[]): void {
  this.state = { ...this.state, todos: items };
  this.logTodos();
  this.notify();
}
```

runPlanItems 种子（原 517 行）：

```ts
this.state = { ...this.state, status: 'running' };
this.setTodos(items.map((t) => ({ text: t, status: 'pending' as TodoStatus })));
```

步骤开始推进（`ctx.appendInstructionLine` 之前插入）：

```ts
this.setTodos(this.state.todos.map((td) => (td.text === items[i] && td.status === 'pending' ? { ...td, status: 'in_progress' } : td)));
```

步骤完成（替换原 545-547 行的手动 todos 拼装 + logTodos）：

```ts
this.setTodos(this.state.todos.map((td) => (td.text === items[i] ? { ...td, status: 'completed' } : td)));
```

③ `src/tui/session-journal.ts`：新增导出并在 reduce 挂接（TodoItem 改从 '../types' import，再导出保持 './session' 兼容不必须——该文件 import type { ChatItem, TodoItem } from './session' 仍可用）：

```ts
/** todos 载荷三态归一（规格 D8）：旧档 {text, done} 布尔形态 → status（done:true→completed / false→pending），新载荷原样通过 */
export function normalizeTodoItems(raw: unknown[]): TodoItem[] {
  return raw.map((it) => {
    const o = (it ?? {}) as { text?: unknown; status?: unknown; done?: unknown };
    const text = typeof o.text === 'string' ? o.text : '';
    if (o.status === 'pending' || o.status === 'in_progress' || o.status === 'completed') return { text, status: o.status };
    return { text, status: o.done === true ? 'completed' : 'pending' };
  });
}
```

reduce 内 `case 'todos': r.todos = e.items;` 改为 `case 'todos': r.todos = normalizeTodoItems(e.items as unknown[]);`

④ `src/tui/components/TodoList.tsx`：

```tsx
const done = todos.filter((td) => td.status === 'completed').length;
const current = todos.find((td) => td.status === 'in_progress') ?? todos.find((td) => td.status === 'pending');
```

展开形态逐行渲染改三态：

```tsx
{todos.map((item, i) =>
  item.status === 'completed' ? (
    <Text key={i} color="green">  ✓ {item.text}</Text>
  ) : item.status === 'in_progress' ? (
    <Text key={i}>  ▸ {item.text}</Text>
  ) : (
    <Text key={i} dimColor>  ○ {item.text}</Text>
  ),
)}
```

组件头注释同步三态口径（紧凑单行/展开行数恒定不变量文字保持）。

⑤ `src/tui/components/StatusBar.tsx:40`：`(t) => t.done` 改 `(t) => t.status === 'completed'`。

⑥ grep 清零：`grep -rn '\.done' src/tui src/harness --include='*.ts' --include='*.tsx' | grep -iv test`——除 journal 归一函数外零命中。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm build && node --test dist/tui/session-journal.test.js dist/tui/components/TodoList.test.js dist/tui/session.plan.test.js dist/tui/session.journal.test.js`
Expected: PASS（含既有用例迁移后全绿）

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tui/session.ts src/tui/session-journal.ts src/tui/components/TodoList.tsx src/tui/components/StatusBar.tsx src/tui/session-journal.test.ts src/tui/components/TodoList.test.tsx src/tui/session.plan.test.ts
git commit -m "feat(tui): TodoItem 三态升格与 journal 旧载荷归一（todo_write 规格 T1）"
```

---

### Task 2: todo_write 工具注册与调度/安全面

**Files:**
- Modify: `src/types.ts:215`（ToolCategory 联合追加 `'todo'`）
- Modify: `src/harness/tools/builtin.ts`（import 追加 `TodoStatus`；builtinTools 签名追加第 12 可选参 `todos`；注册数组尾部追加 todo_write 条目）
- Modify: `src/harness/security/guard.ts`（ask_question 放行行之后追加 todo_write 放行）
- Modify: `src/harness/reactor.ts`（并行闸门拒绝条件追加 `'todo'`；拒绝文案更新）
- Modify: `src/tui/tool-verbs.ts`（VERBS 追加 `todo_write: 'TODO'`；extractTarget 追加 todo_write 分支）
- Test: `src/harness/security/guard.test.ts`、`src/harness/reactor.chat.test.ts`、`src/harness/tools/builtin.schema.test.ts`、`src/harness/memory/memory-write.test.ts:38` 与 `src/harness/tools/builtin.memorywrite.test.ts:27`（两处 BUILTIN_NAMES 清单追加 `'todo_write'`）

**Interfaces:**
- Consumes: `TodoItem`/`TodoStatus`（Task 1，src/types.ts）
- Produces: 工具名 `'todo_write'`（Task 3 引用）；`ToolCategory` 联合含 `'todo'`；`builtinTools` 签名第 12 可选参 `todos?: { set(items: TodoItem[]): void }`（Task 3 Harness 接线消费）

- [ ] **Step 1: 写失败测试（guard 三模式放行）**

`src/harness/security/guard.test.ts` 追加（夹具沿用既有形态：`new SecurityGuard(new PolicyEngine(), mode)`）：

```ts
test('todo_write 三模式放行（零 IO 副作用，规格 D4）；deny 规则仍先行', () => {
  const p = new PolicyEngine();
  p.add('deny', 'todo_write');
  for (const mode of ['manual', 'plan', 'dontAsk'] as const) {
    assert.equal(new SecurityGuard(p, mode).preToolUse('todo_write', { todos: [] }).allowed, false, `${mode} 下 deny 规则先行`);
    assert.equal(new SecurityGuard(new PolicyEngine(), mode).preToolUse('todo_write', { todos: [] }).allowed, true, `${mode} 下缺省放行`);
  }
});
```

- [ ] **Step 2: 写失败测试（reactor 并行闸门）**

`src/harness/reactor.chat.test.ts` 追加（形态逐字沿既有「exec 混入并行批」用例）：

```ts
test('todo_write 混入并行批：整批拒绝、每调用各得拒绝回喂、todo_write 未执行（规格 D4 单发独占）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor-todo1-'));
  fs.writeFileSync(path.join(tmp, 'd.txt'), 'x');
  const adapter = new ChatStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'todo_write', argsJson: '{"todos":[{"text":"a","status":"pending"}]}' },
        { id: 'c2', name: 'read', argsJson: '{"path":"d.txt"}' },
      ],
    },
    stop('ok'),
  ]);
  const reactor = makeReactor(tmp, adapter);
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 5 });
  assert.equal(r.done, true);
  const second = adapter.requests[1].messages;
  const toolMsgs = second.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  for (const m of toolMsgs) {
    assert.ok(m.role === 'tool' && /rejected/i.test(m.content), 'each call must receive the rejection feedback');
  }
});
```

- [ ] **Step 3: 写失败测试（执行面校验与未接线报错）**

`src/harness/tools/builtin.schema.test.ts` 追加（todo_write 由既有全注册 schema 断言自动覆盖 additionalProperties 闭合与 required 全含；此处补执行面三断言）：

```ts
test('todo_write 执行面：条数钳制 >50 拒绝、非法 status 拒绝、facade 未注入报 todo_not_configured', async () => {
  const tmp = tmpDir('sunshinex-todowrite-exec-');
  try {
    const safety = makeSafety(tmp);
    const reg = new ToolRegistry();
    // 不注入第 12 参：恒注册但未接线（bare 形态）
    for (const t of builtinTools(safety, tmp)) reg.register(t);
    const tool = reg.get('todo_write');
    assert.ok(tool, 'todo_write 恒注册（对标 skill 先例）');
    await assert.rejects(() => tool!.executor({ todos: [] }), /todo_not_configured/);
    const wired: Array<{ text: string; status: string }> = [];
    const reg2 = new ToolRegistry();
    for (const t of builtinTools(safety, tmp, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { set: (items) => wired.push(...items) })) reg2.register(t);
    const wiredTool = reg2.get('todo_write')!;
    await assert.rejects(() => wiredTool.executor({ todos: Array.from({ length: 51 }, (_, i) => ({ text: `t${i}`, status: 'pending' })) }), /INVALID_ARG.*50/);
    await assert.rejects(() => wiredTool.executor({ todos: [{ text: 'a', status: 'doing' }] }), /INVALID_ARG.*status/);
    await wiredTool.executor({ todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }] });
    assert.equal(wired.length, 2, 'facade 收到全量替换清单');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm build 2>&1 | head -20; node --test dist/harness/security/guard.test.js dist/harness/reactor.chat.test.js dist/harness/tools/builtin.schema.test.js`
Expected: FAIL——`'todo_write'` 未注册（get 返回 undefined）、guard 放行断言失败、并行批放行（闸门无 'todo'）

- [ ] **Step 5: 实现**

① `src/types.ts:215`：

```ts
export type ToolCategory = 'read' | 'write' | 'bash' | 'network' | 'external' | 'subagent' | 'ask' | 'worktree' | 'todo';
```

② `src/harness/tools/builtin.ts`：import 行补 `TodoStatus`（并入既有 `from '../../types'`）。`builtinTools(...)` 签名末尾追加：

```ts
todos?: { set(items: { text: string; status: TodoStatus }[]): void },
```

注册数组尾部（worktree 条目之后）追加：

```ts
{
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['todos'],
    properties: {
      todos: {
        type: 'array',
        description: 'Full replacement todo list (empty array clears the list; max 50 items)',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'status'],
          properties: {
            text: { type: 'string', description: 'Task description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
        },
      },
    },
  },
  name: 'todo_write',
  description:
    'Write the session todo list (full replacement). Use it for complex multi-step tasks: create the list up front, keep exactly one item in_progress at a time, mark items completed as soon as they are done, and rewrite the whole list whenever it changes. Skip it for simple single-step tasks.',
  category: 'todo',
  executor: async (input: ToolInput) => {
    if (!todos) throw new CodedToolError('todo_not_configured', 'todo list is not wired in this runtime');
    const arr = input.todos;
    if (!Array.isArray(arr)) throw new CodedToolError('INVALID_ARG', 'todos must be an array');
    if (arr.length > 50) throw new CodedToolError('INVALID_ARG', `todos exceeds the limit of 50 items (got ${arr.length})`);
    const items = arr.map((raw) => {
      const o = (raw ?? {}) as { text?: unknown; status?: unknown };
      if (typeof o.text !== 'string' || o.text.trim() === '') throw new CodedToolError('INVALID_ARG', 'each todo needs a non-empty text');
      if (o.status !== 'pending' && o.status !== 'in_progress' && o.status !== 'completed')
        throw new CodedToolError('INVALID_ARG', `status must be pending | in_progress | completed (got ${String(o.status)})`);
      return { text: o.text, status: o.status };
    });
    todos.set(items);
    const done = items.filter((it) => it.status === 'completed').length;
    const wip = items.filter((it) => it.status === 'in_progress').length;
    return execOut(`todo list updated: ${items.length} items (${done} completed, ${wip} in progress)`);
  },
},
```

③ `src/harness/security/guard.ts`（ask_question 放行行之后）：

```ts
// todo_write（todo_write 规格 D4）：零 IO 副作用的进程内状态写，三模式放行（对标 ask_question/spawn 先例）；
// deny 规则与破坏性硬底线仍先行
if (tool === 'todo_write') return { allowed: true };
```

④ `src/harness/reactor.ts`（并行闸门）：拒绝条件改为

```ts
return cat === 'bash' || cat === 'ask' || cat === 'worktree' || cat === 'todo' || cat === undefined;
```

拒绝文案改为（既有断言只匹配 `Parallel batch rejected` 前缀，安全）：

```ts
: 'Parallel batch rejected: exec, ask, worktree and todo must run exclusively on their own; remove them and retry, or fall back to a single-tool call';
```

⑤ `src/tui/tool-verbs.ts`：VERBS 追加 `todo_write: 'TODO',`；extractTarget 在 spawn 分支之后追加：

```ts
if (tool === 'todo_write') {
  const arr = Array.isArray(obj.todos) ? (obj.todos as unknown[]) : [];
  return clip(`${arr.length} items`);
}
```

⑥ 两处 `BUILTIN_NAMES` 数组（`src/harness/memory/memory-write.test.ts:38`、`src/harness/tools/builtin.memorywrite.test.ts:27`）末尾追加 `'todo_write'`。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/security/guard.test.js dist/harness/reactor.chat.test.js dist/harness/tools/builtin.schema.test.js dist/harness/memory/memory-write.test.js dist/harness/tools/builtin.memorywrite.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/harness/tools/builtin.ts src/harness/security/guard.ts src/harness/reactor.ts src/tui/tool-verbs.ts src/harness/security/guard.test.ts src/harness/reactor.chat.test.ts src/harness/tools/builtin.schema.test.ts src/harness/memory/memory-write.test.ts src/harness/tools/builtin.memorywrite.test.ts
git commit -m "feat(harness): todo_write 工具注册与单发独占/免审批调度面（todo_write 规格 T2）"
```

---

### Task 3: TUI/Harness 接线与 fork 面剔除 + 端到端

**Files:**
- Modify: `src/harness/index.ts`（HarnessOptions 追加 `todos` 接缝；builtinTools 调用第 12 参注入，缺省 no-op）
- Modify: `src/tui/runtime.ts`（TuiRuntimeOpts 追加 `onTodos`；createRuntime 透传 Harness）
- Modify: `src/tui/session.ts`（createRuntime 调用处传 `onTodos`）
- Modify: `src/harness/subagent.ts`（`TODO_TOOL_NAME` 常量；deriveChildRegistry 两分支恒剔除）
- Test: `src/harness/subagent.test.ts`（derive 剔除断言）、`src/tui/session.todowrite.test.ts`（新建端到端）

**Interfaces:**
- Consumes: `SessionController.setTodos`（Task 1 private 方法）；todo_write 注册与第 12 参签名（Task 2）
- Produces: `TODO_TOOL_NAME`（subagent.ts 导出常量）；`HarnessOptions.todos`；`TuiRuntimeOpts.onTodos`

- [ ] **Step 1: 写失败测试（fork 面剔除）**

`src/harness/subagent.test.ts` 追加（夹具沿用既有「Runner 工具面收窄」用例的 `makeHarness`/`makeRunner` 形态）：

```ts
test('Runner 工具面收窄：todo_write 恒不在子面（规格 D9）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-runner-todo-'));
  try {
    const h = makeHarness(tmp);
    const runner = h.makeRunner(new ScriptedAdapter([JSON.stringify({ done: true, reply: 'ok' })]));
    const deft = runner.deriveChildRegistry();
    assert.ok(!deft.has('todo_write'), '缺省派生子面恒无 todo_write');
    const explicit = runner.deriveChildRegistry({ prompt: 'w', tools: ['todo_write', 'read'] });
    assert.ok(explicit.has('read'), '显式清单保留 read');
    assert.ok(!explicit.has('todo_write'), '显式列名同样剔除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 写失败测试（端到端）**

新建 `src/tui/session.todowrite.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { parseJournalFile, sessionsDir } from './session-journal';

test('todo_write 端到端：模型调用 → 待办状态 → journal 落盘（规格 D1/D6/D8）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-todowrite-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"todo_write","input":{"todos":[{"text":"调研","status":"completed"},{"text":"实现","status":"in_progress"},{"text":"验证","status":"pending"}]}}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('做一件事');
    await ctrl.waitIdle();
    assert.deepEqual(ctrl.getState().todos, [
      { text: '调研', status: 'completed' },
      { text: '实现', status: 'in_progress' },
      { text: '验证', status: 'pending' },
    ]);
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'tool' && m.kind === 'call' && m.text.startsWith('TODO')),
      '调用行上屏（TODO 动词）',
    );
    const dir = sessionsDir(resolveDataDir(tmp));
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    assert.ok(file, 'journal 已建档');
    const parsed = parseJournalFile(path.join(dir, file!));
    const todosEvents = parsed.events.filter((e) => e.t === 'todos');
    assert.equal(todosEvents.length, 1, '模型一次调用恰好一条 todos 事件');
    assert.deepEqual(
      (todosEvents[0] as { items: Array<{ text: string; status: string }> }).items[1],
      { text: '实现', status: 'in_progress' },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

（若 `sessionsDir` 实际签名与调用形态不符，以 `session-journal.branch.test.ts` 既有用法为准校正——断言语义不变。）

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm build 2>&1 | head -20; node --test dist/harness/subagent.test.js dist/tui/session.todowrite.test.js`
Expected: FAIL——子面含 todo_write / 端到端 todos 未更新（接线缺失）

- [ ] **Step 4: 实现**

① `src/harness/subagent.ts`（SPAWN_TOOL_NAME 旁）：

```ts
/** todo_write 工具名（规格 D9：fork 子面恒剔除——子代理私有步骤零主链状态污染，进度经既有结论行回写） */
export const TODO_TOOL_NAME = 'todo_write';
```

`deriveChildRegistry` 改为（注释同步为单一实现点收窄两件）：

```ts
deriveChildRegistry(input?: SubagentSpawnInput): ToolRegistry {
  if (input?.tools && input.tools.length > 0) {
    const child = this.deps.registry.derive({ only: input.tools });
    child.unregister(TODO_TOOL_NAME);
    return child;
  }
  return this.deps.registry.derive({ exclude: [SPAWN_TOOL_NAME, TODO_TOOL_NAME] });
}
```

② `src/harness/index.ts`：types import 行补 `TodoItem`；`HarnessOptions` 追加：

```ts
/** todo_write 接缝（todo_write 规格 D6）：TUI 注入会话实接（setTodos）；缺省 no-op——CLI/headless 下模型可正常维护清单（观察行进链），仅无 UI 卡 */
todos?: { set(items: TodoItem[]): void };
```

builtinTools 装配行末尾（`() => this.safety.activeRoot` 之后）追加第 12 实参 `opts.todos ?? { set: () => {} }`。

③ `src/tui/runtime.ts`：`TuiRuntimeOpts` 追加：

```ts
/** todo_write 接缝（todo_write 规格 D6）：模型更新清单的会话回调（setTodos）；缺省不注入＝Harness no-op */
onTodos?: (items: TodoItem[]) => void;
```

（`TodoItem` 并入该文件既有 `from '../types'` import。）createRuntime 的 `new Harness({...})` 追加一行：

```ts
...(opts.onTodos ? { todos: { set: opts.onTodos } } : {}),
```

④ `src/tui/session.ts`：createRuntime 调用（构造函数内）追加：

```ts
onTodos: (items) => this.setTodos(items),
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/subagent.test.js dist/harness/subagent.spawn.test.js dist/tui/session.todowrite.test.js dist/tui/session.plan.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/harness/index.ts src/tui/runtime.ts src/tui/session.ts src/harness/subagent.ts src/harness/subagent.test.ts src/tui/session.todowrite.test.ts
git commit -m "feat(tui): todo_write 会话接线与 fork 子面剔除，端到端贯通（todo_write 规格 T3）"
```

---

### Task 4: 文档同步与全量门禁

**Files:**
- Modify: `MANUAL.md:227`（待办卡三态口径 + todo_write 一句模型工具说明）
- Modify: `CLAUDE.md` §3 目录树注释（builtin.ts 工具清单行补 `worktree/todo_write`——现行注释缺 worktree 属失配，顺带对齐）

- [ ] **Step 1: MANUAL.md 待办卡口径**

定位 `grep -n '执行中待办卡' MANUAL.md`（现行 227 行），整句替换为：

```markdown
执行中待办卡默认只显示当前进行项，`Tab` 展开完整清单（✓ 已完成 / ▸ 进行中 / ○ 未开始）；运行中模型可经 `todo_write` 工具自主维护清单（全量替换、同刻恰一项进行中），待办卡实时跟随；某项失败即暂停剩余步骤并说明原因。
```

- [ ] **Step 2: CLAUDE.md §3 工具清单注释**

`tools/builtin.ts` 行注释工具清单更新为：

```text
内置工具（read/write/grep/glob/exec/webfetch/websearch/kb_search/skill/memory_write/ask_question/worktree/todo_write）
```

- [ ] **Step 3: 全量门禁**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: tsc strict 零报错；全量 fail 0（基线 + 本线新增用例）；selfcheck 工具清单含 todo_write 且按名排序

- [ ] **Step 4: 动态面盘点**

Run: `grep -rn 'new Date\|Math.random' src/harness/tools/builtin.ts src/tui/tool-verbs.ts src/harness/subagent.ts | grep -v test`
Expected: 零命中（本线新增代码零动态源）

- [ ] **Step 5: Commit（按 hunk 隔离）**

```bash
# CLAUDE.md 与 MANUAL.md 均有他线未提交 hunks：仅暂存本线所属 hunk（临时索引+commit-tree 或现场逐 hunk add），
# 无法干净拆分时登记待用户指令，禁止整文件卷入
git add MANUAL.md CLAUDE.md
git commit -m "docs: todo_write 三态待办卡口径与工具清单注释同步（todo_write 规格 T4）"
```
