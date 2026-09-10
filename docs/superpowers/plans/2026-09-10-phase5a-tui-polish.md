# 阶段五 5A+ · TUI 产品化精装（对标 Claude Code）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 5A TUI 上落地产品级交互面：启动横幅、答复增量流式、思考内容展示、英文执行步骤、常驻边框输入框、状态栏（本轮 tokens / runs / 上下文命中率）。

**Architecture:** 事件消费端增强。运行时仅做两处加法——`UsageHooks` 增 `onReasoning`、`SessionEventType` 增 `reasoning`/`usage`，reactor 在既有 `callModel` 装配点把思考增量与本轮用量转发为事件；TUI 侧新增纯状态机 `ReplyStreamExtractor` 把协议 JSON 里的 `reply` 字段逐字上屏（终稿仍以 `done` 载荷为准），`SessionController` 归约扩展维护 live 实时区与 metrics，渲染层拆成单职责组件并由 `App` 装配。协议语义、工具链、权限链、路由零改动。

**Tech Stack:** TypeScript strict（CommonJS，`jsx: react-jsx`）、Node.js ≥ 22.9、ink@^3.2.0（React 18 渲染，CJS 尾线）、node:test + node:assert/strict、既有 `src/tui/test-ink.ts` 渲染替身（零新增依赖）。

**上游 spec:** `docs/superpowers/specs/2026-09-10-phase5a-tui-polish-design.md`（初稿 f799bec + 自审修正 b5894e0）

## Global Constraints

- tsconfig strict 开启；CommonJS + `moduleResolution: Node`；`rootDir: src`；禁无理由 any。
- 不新增任何 npm 依赖；不升级 ink（锁 `ink@^3.2.0` CJS 线，`ink@5` ESM-only 与项目冲突）。
- 运行时扩展仅两处加法：`UsageHooks.onReasoning?`、`SessionEventType` 增 `'reasoning' | 'usage'`；缺省零副作用。
- 不改 reactor 输出协议（不加 `thought` 协议键，思考仅走 SSE 通道）；不改工具链/权限链/路由；不改 `run`/`pipeline` 的既有输出（selfcheck 仅升级 `tui` 一行）。
- 所有共享类型登记在 `src/types.ts`；TUI 局部类型留在 `src/tui/session.ts`。
- 消息终稿权威性：流式提取只服务观感，`assistant` 消息一律取 `done` 载荷（缺失时回退流式草稿）。
- 渲染职责归口渲染层：`⏺ ⎿ ✻ ▶ !` 前缀与着色由组件补齐，归约层消息文本只存原始正文。
- 全量基线 = 当前 328 用例；`src/tui/components/App.test.tsx` 中 4 处旧角色标签断言随 Task 7 迁移（断言意图不变）。
- 只写 `/workspace/wt-*`，禁止写 `/skills`；工作目录 `/workspace/wt-59f36a81fc`。
- 每任务：红 → 绿 → 全量回归 → 独立 commit（`type(scope): 中文描述`）。命令 `npm run build`（tsc strict 零错）、`npm test`、`npm run selfcheck`。
- 既有测试统一使用「先经控制器驱动至终态再渲染，断言首帧全量映射」策略；ink3 增量刷帧不可依赖（节流器不落增量帧）。

---

### Task 1: 事件面扩展——reasoning / usage 事件与 adapter 思考解析

**Files:**
- Modify: `src/types.ts:155-160`（SessionEventType 联合 + text 注释）
- Modify: `src/model/adapter.ts:5-8`（UsageHooks）、`src/model/adapter.ts:107-118`（SSE 解析）
- Modify: `src/harness/reactor.ts:93`（callModel 装配点）
- Test: `src/model/stream.test.ts`（追加用例）、`src/harness/reactor.events.test.ts`（追加用例）

**Interfaces:**
- Consumes: 既有 `UsageHooks`、`Reactor.emit(type, text?, payload?)`、`SessionEventType`。
- Produces:
  - `UsageHooks.onReasoning?: (delta: string) => void`
  - `SessionEventType` 增 `'reasoning' | 'usage'`
  - `reasoning` 事件：`text` = 思考增量；`usage` 事件：`payload = { tokens: number; turnTotal: number }`（`turnTotal` 为本 run 累计）

- [ ] **Step 1: 写失败测试（adapter 思考解析）**

追加到 `src/model/stream.test.ts` 末尾：

```ts
test('OpenAIAdapter.completeStream：reasoning_content/reasoning 经 onReasoning 回传，不混入 content', async () => {
  const srv = await startSse([
    'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '先想' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { reasoning: '一步' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '答复' } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k', model: 'm' });
    const deltas: string[] = [];
    const reasons: string[] = [];
    const full = await a.completeStream('p', (t) => deltas.push(t), { onReasoning: (t) => reasons.push(t) });
    assert.equal(full, '答复');
    assert.deepEqual(deltas, ['答复']);
    assert.deepEqual(reasons, ['先想', '一步']);
  } finally {
    srv.close();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "reasoning_content|onReasoning|failures" | tail -20`
Expected: FAIL（`onReasoning` 未定义，`reasons` 为空）

- [ ] **Step 3: 写失败测试（reactor 事件发射）**

追加到 `src/harness/reactor.events.test.ts` 末尾，并把文件头第 16 行 import 改为：

```ts
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
```

追加用例：

```ts
test('事件流：usage/reasoning 事件随流式调用发射（载荷 turnTotal 累计）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ev4-'));
  try {
    const events: SessionEvent[] = [];
    const probe: ModelAdapter & {
      completeStream: (p: string, onDelta: (t: string) => void, hooks?: UsageHooks) => Promise<string>;
    } = {
      provider: 'probe',
      complete: async () => '{"done":true,"reply":"ok"}',
      completeStream: async (_p, onDelta, hooks) => {
        hooks?.onReasoning?.('想一想');
        const text = '{"done":true,"reply":"ok"}';
        for (const ch of text) onDelta(ch);
        hooks?.onUsage?.(7);
        return text;
      },
    };
    const r = await makeReactor(tmp, probe, (e) => events.push(e)).run({ goal: 'g' }, { maxSteps: 2 });
    assert.equal(r.done, true);
    assert.equal(r.tokensUsed, 7, 'run 结果应累计 usage');
    const usage = events.filter((e) => e.type === 'usage');
    assert.equal(usage.length, 1, 'usage 事件应随模型调用发射');
    assert.deepEqual(usage[0]?.payload, { tokens: 7, turnTotal: 7 }, 'usage 载荷含单次用量与累计');
    assert.deepEqual(
      events.filter((e) => e.type === 'reasoning').map((e) => e.text),
      ['想一想'],
      'reasoning 增量应透传为事件',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: 运行确认失败**

Run: `npm test 2>&1 | grep -E "usage|reasoning|Type error|error TS" | tail -20`
Expected: FAIL（`SessionEventType` 无 `usage`/`reasoning`；TS 编译报错）

- [ ] **Step 5: 改 types.ts**

`src/types.ts` 中：

```ts
export type SessionEventType =
  | 'token' | 'tool-call' | 'tool-result' | 'step'
  | 'route' | 'approval-request' | 'approval-resolved'
  | 'done' | 'error';
```

改为：

```ts
export type SessionEventType =
  | 'token' | 'reasoning' | 'usage' | 'tool-call' | 'tool-result' | 'step'
  | 'route' | 'approval-request' | 'approval-resolved'
  | 'done' | 'error';
```

并把 `SessionEvent` 的 `text` 注释 `/** token 增量文本 / step 动作摘要 / error 原因 */` 改为 `/** token/reasoning 增量文本 / step 动作摘要 / error 原因 */`。

- [ ] **Step 6: 改 adapter.ts**

`src/model/adapter.ts` 中：

```ts
export interface UsageHooks {
  onUsage?: (tokens: number) => void;
}
```

改为：

```ts
export interface UsageHooks {
  onUsage?: (tokens: number) => void;
  /** 思考增量（SSE reasoning_content / reasoning 键）；端点不回传则永不触发 */
  onReasoning?: (delta: string) => void;
}
```

`completeStream` 内 SSE 解析处：

```ts
              const ev = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = ev.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                onDelta(delta);
              }
              const usage = extractUsage(ev);
              if (usage > 0) hooks?.onUsage?.(usage);
```

改为：

```ts
              const ev = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
              const d = ev.choices?.[0]?.delta;
              const reason = d?.reasoning_content ?? d?.reasoning;
              if (reason) hooks?.onReasoning?.(reason);
              if (d?.content) {
                full += d.content;
                onDelta(d.content);
              }
              const usage = extractUsage(ev);
              if (usage > 0) hooks?.onUsage?.(usage);
```

- [ ] **Step 7: 改 reactor.ts 装配点**

`src/harness/reactor.ts` 中：

```ts
        raw = await this.callModel(router.resolve(effectiveTier), prompt, { onUsage: (t) => { tokensUsed += t; } });
```

改为：

```ts
        raw = await this.callModel(router.resolve(effectiveTier), prompt, {
          onUsage: (t) => {
            tokensUsed += t;
            this.emit('usage', undefined, { tokens: t, turnTotal: tokensUsed });
          },
          onReasoning: (t) => this.emit('reasoning', t),
        });
```

- [ ] **Step 8: 运行全量回归**

Run: `npm test 2>&1 | tail -25`、`npm run build 2>&1 | tail -10`
Expected: 全绿（328 + 2 新增）；tsc 零报错

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/model/adapter.ts src/harness/reactor.ts src/model/stream.test.ts src/harness/reactor.events.test.ts
git commit -m "feat(tui): 事件面新增 reasoning/usage 通道（SSE 思考增量 + 本轮用量）"
```

---

### Task 2: 增量协议提取器 ReplyStreamExtractor

**Files:**
- Create: `src/tui/stream-extractor.ts`
- Test: `src/tui/stream-extractor.test.ts`

**Interfaces:**
- Consumes: 无（纯状态机，零依赖）。
- Produces:
  - `export type ExtractorMode = 'seek' | 'after-key' | 'in-reply' | 'settled' | 'ignore' | 'plain';`
  - `export class ReplyStreamExtractor { constructor(onReplyDelta: (text: string) => void); feed(delta: string): void; reset(): void; get currentMode(): ExtractorMode; }`

- [ ] **Step 1: 写失败测试**

创建 `src/tui/stream-extractor.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyStreamExtractor } from './stream-extractor';

/** 喂入若干片段，返回拼接后的提取文本与提取器终态 */
function collect(chunks: string[]): { out: string; ex: ReplyStreamExtractor } {
  let out = '';
  const ex = new ReplyStreamExtractor((t) => { out += t; });
  for (const c of chunks) ex.feed(c);
  return { out, ex };
}

test('提取器：reply 字段逐段透出，协议骨架不上屏', () => {
  const { out, ex } = collect(['{"done":true,', '"reply":"你好', '世界"}']);
  assert.equal(out, '你好世界');
  assert.equal(ex.currentMode, 'settled');
});

test('提取器：转义序列还原（\\n \\t \\" \\\\ \\/ \\uXXXX 跨块）', () => {
  const { out } = collect(['{"reply":"a\\nb\\t', 'c\\"d\\\\e\\/f\\u4f6', '0g"}']);
  assert.equal(out, 'a\nb\tc"d\\e/f你g');
});

test('提取器：键名跨块分裂仍可识别', () => {
  const { out } = collect(['{"done":true,"rep', 'ly":"ok"}']);
  assert.equal(out, 'ok');
});

test('提取器：tool 键先现则忽略整回合（输入内出现 reply 字样也不误提取）', () => {
  const { out, ex } = collect(['{"tool":"write","input":{"path":"a.txt","content":"see \\"reply\\" 字样"},"done":false}']);
  assert.equal(out, '');
  assert.equal(ex.currentMode, 'ignore');
});

test('提取器：首个非空白非 { 视为裸文本，原文透传（含前导空白）', () => {
  const { out, ex } = collect(['  这是裸文本\n', '第二行']);
  assert.equal(out, '  这是裸文本\n第二行');
  assert.equal(ex.currentMode, 'plain');
});

test('提取器：reset 复位后提取下一回合', () => {
  let out = '';
  const ex = new ReplyStreamExtractor((t) => { out += t; });
  ex.feed('{"done":true,"reply":"第一"}');
  assert.equal(out, '第一');
  ex.reset();
  ex.feed('{"tool":"read","input":{"path":"a"}}');
  assert.equal(out, '第一');
  ex.reset();
  ex.feed('{"reply":"第二"}');
  assert.equal(out, '第一第二');
});

test('提取器：转义引号不触发收束（\\" 不终止 reply）', () => {
  const { out, ex } = collect(['{"reply":"say \\"hi\\" now"}']);
  assert.equal(out, 'say "hi" now');
  assert.equal(ex.currentMode, 'settled');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "stream-extractor|Cannot find module" | tail -20`
Expected: FAIL（模块不存在，编译失败）

- [ ] **Step 3: 实现提取器**

创建 `src/tui/stream-extractor.ts`：

```ts
/** 协议增量提取模式：seek 找键 → after-key 等冒号引号 → in-reply 透出 → settled 吞尾；ignore 工具回合；plain 协议违规原文透传 */
export type ExtractorMode = 'seek' | 'after-key' | 'in-reply' | 'settled' | 'ignore' | 'plain';

const TOOL_KEY = '"tool"';
const REPLY_KEY = '"reply"';
/** seek 态滚动窗口长度：保证跨 chunk 分裂的键（如 `"rep` + `ly"`）仍可识别 */
const TAIL = 8;

/**
 * 增量协议提取器：模型输出的 JSON 协议骨架不上屏，只透出 reply 字段文本。
 * 纯状态机（零 IO、零依赖）：供渲染层逐段刷新，终稿仍以 done 载荷为准。
 */
export class ReplyStreamExtractor {
  private mode: ExtractorMode = 'seek';
  private tail = '';
  private lead = '';          // seek 态跳过的前导空白（plain 回退时补发）
  private sawLead = false;    // 是否已见首个非空白字符
  private colonSeen = false;  // after-key 态是否已消费冒号
  private escaped = false;    // in-reply 态：上一字符是否为未消费的反斜杠
  private unicode = '';       // \uXXXX 累积缓冲
  private out = '';

  constructor(private readonly onReplyDelta: (text: string) => void) {}

  /** 当前状态（测试断言用） */
  get currentMode(): ExtractorMode {
    return this.mode;
  }

  /** 回合复位：tool-call / done / error 后调用，隔离下一回合的协议骨架 */
  reset(): void {
    this.mode = 'seek';
    this.tail = '';
    this.lead = '';
    this.sawLead = false;
    this.colonSeen = false;
    this.escaped = false;
    this.unicode = '';
    this.out = '';
  }

  /** 消费一段原始增量（可任意切分）；提取出的 reply 文本按段回调 */
  feed(delta: string): void {
    this.out = '';
    for (const ch of delta) this.step(ch);
    if (this.out.length > 0) this.onReplyDelta(this.out);
  }

  private emit(text: string): void {
    this.out += text;
  }

  private step(ch: string): void {
    switch (this.mode) {
      case 'seek':
        this.stepSeek(ch);
        return;
      case 'after-key':
        this.stepAfterKey(ch);
        return;
      case 'in-reply':
        this.stepInReply(ch);
        return;
      case 'plain':
        this.emit(ch);
        return;
      default: // ignore / settled：协议剩余骨架一律吞掉
        return;
    }
  }

  private stepSeek(ch: string): void {
    if (!this.sawLead) {
      if (/\s/.test(ch)) {
        this.lead += ch;
        return;
      }
      this.sawLead = true;
      if (ch !== '{') {
        // 协议违规：非 JSON 输出按原文透传（补发已跳过的前导空白）
        this.mode = 'plain';
        this.emit(this.lead + ch);
        return;
      }
    }
    this.tail = (this.tail + ch).slice(-TAIL);
    if (this.tail.endsWith(TOOL_KEY)) {
      this.mode = 'ignore';
      return;
    }
    if (this.tail.endsWith(REPLY_KEY)) {
      this.mode = 'after-key';
    }
  }

  private stepAfterKey(ch: string): void {
    if (/\s/.test(ch)) return;
    if (ch === ':' && !this.colonSeen) {
      this.colonSeen = true;
      return;
    }
    if (ch === '"' && this.colonSeen) {
      this.mode = 'in-reply';
      return;
    }
    this.mode = 'ignore'; // 结构不符协议：放弃实时提取，done 收尾兜底
  }

  private stepInReply(ch: string): void {
    if (this.unicode.length > 0) {
      this.unicode += ch;
      if (this.unicode.length === 4) {
        const code = parseInt(this.unicode, 16);
        this.emit(Number.isNaN(code) ? '' : String.fromCharCode(code));
        this.unicode = '';
      }
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (ch === 'n') this.emit('\n');
      else if (ch === 't') this.emit('\t');
      else if (ch === 'r') this.emit('\r');
      else if (ch === 'u') this.unicode = '';
      else this.emit(ch); // \" \\ \/ 及其它：转义后取原字符
      return;
    }
    if (ch === '\\') {
      this.escaped = true;
      return;
    }
    if (ch === '"') {
      this.mode = 'settled';
      return;
    }
    this.emit(ch);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test 2>&1 | grep -E "stream-extractor|failures|pass" | tail -20`
Expected: PASS（7 用例全绿）

- [ ] **Step 5: 全量回归 + Commit**

Run: `npm test 2>&1 | tail -8`、`npm run build 2>&1 | tail -5`

```bash
git add src/tui/stream-extractor.ts src/tui/stream-extractor.test.ts
git commit -m "feat(tui): 增量协议提取器（reply 逐字提取 + 转义/跨块/回退容错）"
```

---

### Task 3: 工具动词映射 tool-verbs

**Files:**
- Create: `src/tui/tool-verbs.ts`
- Test: `src/tui/tool-verbs.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `export function toolCallLine(tool: string, input: unknown): string`（`VERB target`，无 target 时仅 `VERB`）

- [ ] **Step 1: 写失败测试**

创建 `src/tui/tool-verbs.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallLine } from './tool-verbs';

test('toolCallLine：已登记工具映射英文动词 + target 摘要', () => {
  assert.equal(toolCallLine('exec', { command: 'ls -la' }), 'EXEC ls');
  assert.equal(toolCallLine('read', { path: 'SUNSHINE.md' }), 'READ SUNSHINE.md');
  assert.equal(toolCallLine('write', { path: 'README.md', content: 'x' }), 'WRITE README.md');
  assert.equal(toolCallLine('grep', { pattern: 'TODO' }), 'GREP TODO');
  assert.equal(toolCallLine('glob', { pattern: 'src/**/*.ts' }), 'GLOB src/**/*.ts');
  assert.equal(toolCallLine('webfetch', { url: 'https://x.dev' }), 'FETCH https://x.dev');
  assert.equal(toolCallLine('kb_search', { query: '部署' }), 'SEARCH 部署');
});

test('toolCallLine：MCP 工具统一 MCP，未登记工具大写原名', () => {
  assert.equal(toolCallLine('mcp__fs__read', { path: 'a.txt' }), 'MCP a.txt');
  assert.equal(toolCallLine('custom_tool', { x: 1 }), 'CUSTOM_TOOL {"x":1}');
});

test('toolCallLine：无输入回退为空 target（仅动词）', () => {
  assert.equal(toolCallLine('read', {}), 'READ');
  assert.equal(toolCallLine('read', undefined), 'READ');
});

test('toolCallLine：超长 target 截断到 60 字符', () => {
  const line = toolCallLine('read', { path: 'x'.repeat(120) });
  assert.equal(line.length, 'READ '.length + 61);
  assert.ok(line.endsWith('…'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "tool-verbs|Cannot find module" | tail -10`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/tui/tool-verbs.ts`：

```ts
/** 工具动词映射（英文步骤标识）：已登记工具映射为英文动词，未登记工具大写原名，MCP 工具统一 MCP */
const VERBS: Record<string, string> = {
  exec: 'EXEC',
  read: 'READ',
  write: 'WRITE',
  grep: 'GREP',
  glob: 'GLOB',
  webfetch: 'FETCH',
  kb_search: 'SEARCH',
};

/** 工具调用行文本：`VERB target`（无 target 时仅 VERB）；exec 取命令首段，其余取代表字段并截断 60 字符 */
export function toolCallLine(tool: string, input: unknown): string {
  const verb = tool.startsWith('mcp__') ? 'MCP' : (VERBS[tool] ?? tool.toUpperCase());
  const target = extractTarget(tool, input);
  return target ? `${verb} ${target}` : verb;
}

function extractTarget(tool: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const candidates = [obj.path, obj.pattern, obj.query, obj.url, obj.command];
  const raw = candidates.find((v) => typeof v === 'string' && v.length > 0) as string | undefined;
  if (!raw) {
    if (Object.keys(obj).length === 0) return '';
    return clip(JSON.stringify(input));
  }
  const one = tool === 'exec' ? raw.trim().split(/\s+/)[0] : raw.replace(/\s+/g, ' ').trim();
  return clip(one);
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test 2>&1 | grep -E "tool-verbs|failures" | tail -10`
Expected: PASS

- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/tui/tool-verbs.ts src/tui/tool-verbs.test.ts
git commit -m "feat(tui): 工具动词映射（英文执行步骤的 VERB/target 摘要）"
```

---

### Task 4: 显示格式化纯函数（text-band + format）

**Files:**
- Create: `src/tui/text-band.ts`、`src/tui/format.ts`
- Test: `src/tui/text-band.test.ts`、`src/tui/format.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export function displayWidth(s: string): number`
  - `export function wrapByWidth(text: string, width: number): string[]`
  - `export function bandLines(text: string, columns: number): string[]`
  - `export function formatTokens(n: number): string`

- [ ] **Step 1: 写失败测试**

创建 `src/tui/text-band.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, wrapByWidth, bandLines } from './text-band';

test('displayWidth：CJK 记 2，ASCII 记 1', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('a中'), 3);
});

test('wrapByWidth：按显示宽度折行且不丢字', () => {
  assert.deepEqual(wrapByWidth('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrapByWidth('中文中文', 4), ['中文', '中文']);
});

test('wrapByWidth：不拆宽字符（宽度 3 装不下两个汉字）', () => {
  assert.deepEqual(wrapByWidth('中文', 3), ['中', '文']);
});

test('bandLines：左右各留 1 空格并补齐至 columns', () => {
  const lines = bandLines('hi', 10);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], ' hi       ');
  assert.equal(displayWidth(lines[0]), 10);
});

test('bandLines：多行 + 折行各自补齐', () => {
  const lines = bandLines('a\nbb', 6);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], ' a    ');
  assert.equal(lines[1], ' bb   ');
  assert.ok(lines.every((l) => displayWidth(l) === 6));
});
```

创建 `src/tui/format.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens } from './format';

test('formatTokens：千以下原样，千以上记 k', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(12345), '12k');
});

test('formatTokens：负值与非有限值按 0 收束', () => {
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(Number.NaN), '0');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "text-band|format.test|Cannot find module" | tail -10`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/tui/text-band.ts`：

```ts
/** 显示宽度：CJK/全角记 2，其余记 1（终端色带补齐与折行按显示宽度计算） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** 按显示宽度折行（不拆宽字符）；width<=0 时返回原文本单行 */
export function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let cur = '';
  let w = 0;
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > width && cur.length > 0) {
      lines.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  lines.push(cur);
  return lines;
}

/** 用户消息色带行：按 columns-2 折行，每行左右各留 1 空格并补齐至 columns（ink3 仅 Text 支持 backgroundColor，整行文本铺色） */
export function bandLines(text: string, columns: number): string[] {
  const inner = Math.max(1, columns - 2);
  return text
    .split('\n')
    .flatMap((seg) => wrapByWidth(seg, inner))
    .map((l) => ` ${l}${' '.repeat(Math.max(0, inner - displayWidth(l)))} `);
}
```

创建 `src/tui/format.ts`：

```ts
/** token 数紧凑显示：≥1000 记 k（1200 → 1.2k；12345 → 12k），负值/非有限值按 0 收束 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test 2>&1 | grep -E "text-band|format|failures" | tail -10`
Expected: PASS

- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/tui/text-band.ts src/tui/format.ts src/tui/text-band.test.ts src/tui/format.test.ts
git commit -m "feat(tui): 显示格式化纯函数（CJK 宽度/色带折行/token 计数）"
```

---

### Task 5: 横幅信息 banner-info

**Files:**
- Create: `src/tui/banner-info.ts`
- Test: `src/tui/banner-info.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export interface BannerInfo { version: string; model: string; root: string }`
  - `export const FALLBACK_VERSION = '0.1.0';`
  - `export function buildBannerInfo(input?: { version?: string; model?: string; root?: string }): BannerInfo`

- [ ] **Step 1: 写失败测试**

创建 `src/tui/banner-info.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBannerInfo, FALLBACK_VERSION } from './banner-info';

test('buildBannerInfo：显式入参全量采用', () => {
  const info = buildBannerInfo({ version: '9.9.9', model: 'm1', root: '/tmp/x' });
  assert.deepEqual(info, { version: '9.9.9', model: 'm1', root: '/tmp/x' });
});

test('buildBannerInfo：version 空回退 FALLBACK_VERSION', () => {
  assert.equal(buildBannerInfo({ version: '' }).version, FALLBACK_VERSION);
  assert.equal(buildBannerInfo().version, FALLBACK_VERSION);
});

test('buildBannerInfo：model 缺省读 OPENAI_MODEL，缺失显示未配置', () => {
  const prev = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_MODEL;
  try {
    assert.equal(buildBannerInfo({ version: '1.0.0' }).model, '未配置');
  } finally {
    if (prev === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = prev;
  }
});

test('buildBannerInfo：root 缺省取 process.cwd()', () => {
  assert.equal(buildBannerInfo({ version: '1.0.0', model: 'm' }).root, process.cwd());
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "banner-info|Cannot find module" | tail -10`
Expected: FAIL

- [ ] **Step 3: 实现**

创建 `src/tui/banner-info.ts`：

```ts
export interface BannerInfo {
  version: string;
  model: string;
  root: string;
}

export const FALLBACK_VERSION = '0.1.0';

/** 横幅信息（纯函数）：version 由装配层 entry.ts 读取 package.json 注入（空回退）；model 读 OPENAI_MODEL；root 缺省 cwd */
export function buildBannerInfo(input: { version?: string; model?: string; root?: string } = {}): BannerInfo {
  return {
    version: input.version && input.version.length > 0 ? input.version : FALLBACK_VERSION,
    model: input.model && input.model.length > 0 ? input.model : (process.env.OPENAI_MODEL ?? '未配置'),
    root: input.root ?? process.cwd(),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test 2>&1 | grep -E "banner-info|failures" | tail -10`
Expected: PASS

- [ ] **Step 5: 全量回归 + Commit**

```bash
git add src/tui/banner-info.ts src/tui/banner-info.test.ts
git commit -m "feat(tui): 横幅信息纯函数（版本/模型/root 组装）"
```

---

### Task 6: 会话归约扩展（live 实时区 / 思考折叠 / metrics 口径）

**Files:**
- Modify: `src/tui/session.ts`（类型 + 构造 + onEvent 重写 + helpers + submit/plan//new）
- Test: `src/tui/session.stream.test.ts`

**Interfaces:**
- Consumes: `ReplyStreamExtractor`（Task 2）、`toolCallLine`（Task 3）、`SessionEvent`（Task 1 扩后的类型）。
- Produces:
  - `export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'thinking' | 'step';`
  - `export interface ChatItem { role: ChatRole; text: string; ts: number; kind?: 'call' | 'result'; ok?: boolean; }`
  - `export interface StatusMetrics { turnStartedAt: number; turnTokens: number; runs: number; hitRate: number; }`
  - `export interface LiveBlock { kind: 'reply' | 'thinking'; text: string; startedAt: number; }`
  - `export interface TuiState { messages; approval?; todos; status; metrics: StatusMetrics; live?: LiveBlock; }`

- [ ] **Step 1: 写失败测试**

创建 `src/tui/session.stream.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 钩子适配器：reasoning/usage 可注入，token 逐字流式（验证会话归约对三类增量事件的消费） */
class HookAdapter implements ModelAdapter {
  readonly provider = 'hooks';
  constructor(
    private readonly text: string,
    private readonly opts: { reasoning?: string[]; usage?: number } = {},
  ) {}
  async complete(): Promise<string> {
    return this.text;
  }
  async completeStream(_prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    for (const r of this.opts.reasoning ?? []) hooks?.onReasoning?.(r);
    for (const ch of this.text) onDelta(ch);
    if (this.opts.usage) hooks?.onUsage?.(this.opts.usage);
    return this.text;
  }
}

test('会话归约：token 增量进 live.reply（协议骨架不上屏），done 以终稿收束且不重复', async () => {
  const tmp = tmpdir('sunshinex-stream1-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"流式答复"}']) });
    const snapshots: string[] = [];
    ctrl.onState((s) => {
      if (s.live?.kind === 'reply') snapshots.push(s.live.text);
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    assert.equal(s.live, undefined, 'done 后实时区清空');
    assert.ok(snapshots.length > 0, '应观测到流式增量');
    assert.ok(
      snapshots.some((t) => t.length > 0 && t.length < '流式答复'.length),
      '应存在中间增量（非整段一次性）',
    );
    const assistant = s.messages.filter((m) => m.role === 'assistant').map((m) => m.text);
    assert.deepEqual(assistant, ['流式答复'], '终稿取 done 载荷且仅一条');
    assert.ok(!s.messages.some((m) => m.text.includes('"reply"')), '协议骨架不得泄漏进消息区');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：reasoning 实时区折叠为 Thought 摘要行', async () => {
  const tmp = tmpdir('sunshinex-stream2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const s = ctrl.getState();
    const thinking = s.messages.filter((m) => m.role === 'thinking');
    assert.equal(thinking.length, 1, '思考实时区收束为一条摘要行');
    assert.match(thinking[0].text, /^Thought for \d+s$/);
    assert.equal(s.live, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：usage 事件驱动本轮 tokens（turnTotal 累计）', async () => {
  const tmp = tmpdir('sunshinex-stream3-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"ok"}', { usage: 7 }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().metrics.turnTokens, 7, '本轮 tokens 应取 usage.turnTotal');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：工具调用/结果两行形态（英文动词 + ✓/✗）', async () => {
  const tmp = tmpdir('sunshinex-stream4-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"写完"}',
      ]),
    });
    await ctrl.submit('写文件');
    await ctrl.waitIdle();
    const msgs = ctrl.getState().messages;
    const call = msgs.find((m) => m.role === 'tool' && m.kind === 'call');
    assert.equal(call?.text, 'WRITE a.txt', '工具调用行应为英文动词 + 路径');
    const result = msgs.find((m) => m.role === 'tool' && m.kind === 'result');
    assert.equal(result?.ok, true, 'write 成功结果应标记 ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：/plan 逐项执行落 Step 步骤行', async () => {
  const tmp = tmpdir('sunshinex-stream5-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"1. 建 a\\n2. 建 b"}',
        '{"done":true,"reply":"a 完成"}',
        '{"done":true,"reply":"b 完成"}',
      ]),
    });
    await ctrl.submit('/plan 建两个文件');
    assert.equal(ctrl.getState().status, 'awaiting-plan');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    const steps = ctrl.getState().messages.filter((m) => m.role === 'step').map((m) => m.text);
    assert.deepEqual(steps, ['Step 1/2 — 建 a', 'Step 2/2 — 建 b']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "stream|thought|turnTokens|Step 1|Type error|error TS" | tail -20`
Expected: FAIL（`metrics`/`live` 类型缺失，TS 编译失败）

- [ ] **Step 3: 改类型与 import**

`src/tui/session.ts` 顶部：

```ts
import { ApprovalDecision, ApprovalRequest, GraphContext, SessionEvent } from '../types';
import { makeRoleAgent } from '../graph/agents';
import { TuiRuntime, TuiRuntimeOpts, createRuntime } from './runtime';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatItem {
  role: ChatRole;
  text: string;
  ts: number;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'awaiting-plan' | 'error';

export interface TuiState {
  messages: ChatItem[];
  approval?: ApprovalRequest;
  todos: TodoItem[];
  status: SessionStatus;
}
```

改为：

```ts
import { ApprovalDecision, ApprovalRequest, GraphContext, SessionEvent } from '../types';
import { makeRoleAgent } from '../graph/agents';
import { TuiRuntime, TuiRuntimeOpts, createRuntime } from './runtime';
import { ReplyStreamExtractor } from './stream-extractor';
import { toolCallLine } from './tool-verbs';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'thinking' | 'step';

export interface ChatItem {
  role: ChatRole;
  text: string;
  ts: number;
  /** tool 行细分：call（⏺ 调用行）/ result（⎿ 结果行） */
  kind?: 'call' | 'result';
  /** tool 结果行成功标记 */
  ok?: boolean;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'awaiting-plan' | 'error';

export interface StatusMetrics {
  turnStartedAt: number;
  turnTokens: number;
  runs: number;
  hitRate: number;
}

export interface LiveBlock {
  kind: 'reply' | 'thinking';
  text: string;
  startedAt: number;
}

export interface TuiState {
  messages: ChatItem[];
  approval?: ApprovalRequest;
  todos: TodoItem[];
  status: SessionStatus;
  metrics: StatusMetrics;
  live?: LiveBlock;
}
```

- [ ] **Step 4: 改字段初始化与构造**

`src/tui/session.ts` 中：

```ts
  readonly runtime: TuiRuntime;
  private state: TuiState = { messages: [], todos: [], status: 'idle' };
  private listeners = new Set<(s: TuiState) => void>();
```

改为：

```ts
  readonly runtime: TuiRuntime;
  private readonly extractor = new ReplyStreamExtractor((t) => this.appendLive('reply', t));
  private state: TuiState = {
    messages: [],
    todos: [],
    status: 'idle',
    metrics: { turnStartedAt: 0, turnTokens: 0, runs: 0, hitRate: 0 },
  };
  private listeners = new Set<(s: TuiState) => void>();
```

构造内 `createRuntime({...})` 之后（`if (opts.mode === 'manual') ...` 行之后）追加一行：

```ts
    this.state = { ...this.state, metrics: { ...this.state.metrics, runs: this.runtime.harness.ledger.summary().runs } };
```

- [ ] **Step 5: 改 submit 起始重置**

`src/tui/session.ts` 中 `async submit(...)` 内：

```ts
    this.pushMsg('user', text);
    if (this.state.status === 'running' || this.state.status === 'awaiting-approval') {
```

改为：

```ts
    this.pushMsg('user', text);
    this.extractor.reset();
    if (this.state.status === 'running' || this.state.status === 'awaiting-approval') {
```

- [ ] **Step 6: 改 runTaskFlow（本轮计时/用量重置）**

`src/tui/session.ts` 中：

```ts
  private async runTaskFlow(goal: string): Promise<void> {
    this.state = { ...this.state, status: 'running' };
    this.notify();
```

改为：

```ts
  private async runTaskFlow(goal: string): Promise<void> {
    this.state = {
      ...this.state,
      status: 'running',
      metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0 },
      live: undefined,
    };
    this.notify();
```

- [ ] **Step 7: 改 runPlanItems（步骤行 + 逐项计时）**

`src/tui/session.ts` 中 `runPlanItems` 的循环体：

```ts
    for (let i = 0; i < items.length; i++) {
      try {
        const r = await this.runtime.runTask(items[i]);
```

改为：

```ts
    for (let i = 0; i < items.length; i++) {
      this.pushMsg('step', `Step ${i + 1}/${items.length} — ${items[i]}`);
      this.state = {
        ...this.state,
        metrics: { ...this.state.metrics, turnStartedAt: Date.now(), turnTokens: 0 },
      };
      this.notify();
      try {
        const r = await this.runtime.runTask(items[i]);
```

- [ ] **Step 8: 改 /new（清 live 与 metrics）**

`src/tui/session.ts` 中 `/new` 分支：

```ts
    if (cmd === '/new') {
      this.runtime.harness.security.clearSessionAllows();
      this.state = { messages: [], todos: [], status: 'idle' };
      this.pushMsg('system', '软重置：消息与待办已清空，会话级审批登记已清除（记忆与账本保留）');
      return;
    }
```

改为：

```ts
    if (cmd === '/new') {
      this.runtime.harness.security.clearSessionAllows();
      this.extractor.reset();
      this.state = {
        messages: [],
        todos: [],
        status: 'idle',
        metrics: {
          turnStartedAt: 0,
          turnTokens: 0,
          runs: this.state.metrics.runs,
          hitRate: this.state.metrics.hitRate,
        },
        live: undefined,
      };
      this.pushMsg('system', '软重置：消息与待办已清空，会话级审批登记已清除（记忆与账本保留）');
      return;
    }
```

- [ ] **Step 9: 重写 onEvent 与新增 helpers**

`src/tui/session.ts` 中，`private onEvent(...)` 整段与 `private pushMsg(...)` 替换为：

```ts
  private onEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'token':
        this.extractor.feed(e.text ?? '');
        return;
      case 'reasoning':
        this.appendLive('thinking', e.text ?? '');
        return;
      case 'usage': {
        const total = typeof e.payload?.turnTotal === 'number' ? e.payload.turnTotal : this.state.metrics.turnTokens;
        this.state = { ...this.state, metrics: { ...this.state.metrics, turnTokens: total } };
        this.notify();
        return;
      }
      case 'tool-call':
        this.closeLive();
        this.extractor.reset();
        this.pushMsg('tool', toolCallLine(e.text ?? '', e.payload?.input), { kind: 'call' });
        return;
      case 'tool-result':
        this.pushMsg('tool', e.text ?? '', { kind: 'result', ok: e.payload?.ok === true });
        return;
      // 说明：reactor 的 step 事件仅携带动作名，与 ⏺ 工具行信息重复，故不上屏（spec §4.3 括号注明 step 行由 plan 流程产出）
      case 'step':
        return;
      case 'done': {
        const draft = this.state.live?.kind === 'reply' ? this.state.live.text : '';
        this.closeLive();
        this.extractor.reset();
        const finalText = e.text && e.text.length > 0 ? e.text : draft;
        if (finalText) this.pushMsg('assistant', finalText);
        this.refreshMetrics();
        return;
      }
      case 'error':
        this.closeLive();
        this.extractor.reset();
        this.pushMsg('system', `错误：${e.text ?? '（无说明）'}`);
        this.refreshMetrics();
        return;
      default:
        return; // route / approval-* 不落消息区
    }
  }

  private pushMsg(role: ChatRole, text: string, extra?: Partial<Pick<ChatItem, 'kind' | 'ok'>>): void {
    this.state = {
      ...this.state,
      messages: [...this.state.messages, { role, text, ts: Date.now(), ...(extra ?? {}) }],
    };
    this.notify();
  }

  /** 追加实时区内容：同类续接；异类先收束旧块（thinking 折叠为摘要行，reply 交由 done 定稿避免重复） */
  private appendLive(kind: LiveBlock['kind'], delta: string): void {
    if (!delta) return;
    const live = this.state.live;
    if (live && live.kind !== kind) this.closeLive();
    const cur = this.state.live;
    if (cur && cur.kind === kind) {
      this.state = { ...this.state, live: { ...cur, text: cur.text + delta } };
    } else {
      this.state = { ...this.state, live: { kind, text: delta, startedAt: Date.now() } };
    }
    this.notify();
  }

  /** 收束实时区：thinking 折叠为一行摘要；reply 不落消息（终稿由 done 接管） */
  private closeLive(): void {
    const live = this.state.live;
    if (!live) return;
    this.state = { ...this.state, live: undefined };
    if (live.kind === 'thinking') {
      const secs = Math.max(1, Math.round((Date.now() - live.startedAt) / 1000));
      this.pushMsg('thinking', `Thought for ${secs}s`);
      return;
    }
    this.notify();
  }

  /** done/error 后刷新账本 runs 与上下文命中率 */
  private refreshMetrics(): void {
    this.state = {
      ...this.state,
      metrics: {
        ...this.state.metrics,
        runs: this.runtime.harness.ledger.summary().runs,
        hitRate: this.runtime.harness.context.session.hitRate(),
      },
    };
    this.notify();
  }
```

- [ ] **Step 10: 运行确认通过**

Run: `npm test 2>&1 | grep -E "session.stream|会话归约|failures" | tail -20`
Expected: PASS（5 用例全绿；既有 session/plan 用例同时通过）

- [ ] **Step 11: 全量回归 + Commit**

Run: `npm test 2>&1 | tail -8`、`npm run build 2>&1 | tail -5`

```bash
git add src/tui/session.ts src/tui/session.stream.test.ts
git commit -m "feat(tui): 会话归约扩展（live 实时区/思考折叠/metrics 口径/步骤行）"
```

---

### Task 7: 渲染组件层 + App 装配 + entry 注入 + 既有断言迁移

**Files:**
- Create: `src/tui/components/Banner.tsx`、`Spinner.tsx`、`MessageList.tsx`、`ToolRow.tsx`、`InputBox.tsx`、`StatusBar.tsx`
- Modify: `src/tui/components/App.tsx`（重写）、`src/tui/entry.ts`（banner 注入）
- Test: `src/tui/components/App.visual.test.tsx`（新建）；`src/tui/components/App.test.tsx`（迁移 4 处旧标签断言）

**Interfaces:**
- Consumes: `SessionController`/`TuiState`/`ChatItem`/`LiveBlock`/`StatusMetrics`/`SessionStatus`（Task 6）、`toolCallLine`（Task 3）、`bandLines`（Task 4）、`formatTokens`（Task 4）、`BannerInfo`/`buildBannerInfo`（Task 5）。
- Produces:
  - `Banner({ info, columns })`、`Spinner({ startedAt, tokens })`、`MessageList({ messages, live, columns })`、`ToolRow({ item })`、`InputBox({ buffer, placeholder, active })`、`StatusBar({ metrics, status, todos })`
  - `App({ controller, banner? })`；`inputPlaceholder(status)` 纯函数导出

- [ ] **Step 1: 写失败测试（视觉冒烟）**

创建 `src/tui/components/App.visual.test.tsx`：

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

test('App：启动横幅 + 输入框 + 状态栏常驻渲染', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-vis1-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"hi"}']) });
    const { lastFrame, unmount } = render(
      <App controller={ctrl} banner={{ version: '0.1.0', model: 'test-model', root: tmp }} />,
    );
    const frame = lastFrame() ?? '';
    assert.match(frame, /SunshineX TUI v0\.1\.0/);
    assert.match(frame, /test-model/);
    assert.match(frame, /\/help 查看命令/);
    assert.match(frame, /❯/);          // 输入框提示符
    assert.match(frame, /↑0 tokens/);  // 状态栏本轮 tokens
    assert.match(frame, /ctx 命中率/); // 状态栏命中率
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：消息区新渲染口径（去标签/工具两行/助手裸文本）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-vis2-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('写个文件');
    await ctrl.waitIdle();
    const { lastFrame, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /⏺ WRITE a\.txt/); // 工具调用行英文动词
    assert.match(frame, /✓/);              // 工具结果行成功
    assert.match(frame, /写个文件/);        // 用户消息（色带）
    assert.match(frame, /ok/);             // 助手裸文本答复
    assert.ok(!frame.includes('[你]'), '不得出现 [你] 角色标签');
    assert.ok(!frame.includes('[助手]'), '助手答复应为裸文本');
    assert.ok(!frame.includes('[工具]'), '工具行应为 ⏺/⎿ 形态');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test 2>&1 | grep -E "Banner|Spinner|MessageList|Cannot find module" | tail -20`
Expected: FAIL（组件模块不存在）

- [ ] **Step 3: 创建 Banner.tsx**

```tsx
import * as React from 'react';
import { Box, Text } from 'ink';
import { BannerInfo } from '../banner-info';

/** 启动横幅：图标 + 版本/模型 + 命令提示；窄终端（<40 列）降级为单行 */
export function Banner({ info, columns }: { info: BannerInfo; columns: number }): JSX.Element {
  if (columns < 40) {
    return <Text color="yellow">☀ SunshineX TUI v{info.version} · /help</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text color="yellow">   ＼ ｜ ／</Text>
      <Text>
        <Text color="yellow">  ―― ☀ ――   </Text>
        <Text bold>SunshineX TUI v{info.version}</Text>
        <Text dimColor> · model {info.model}</Text>
      </Text>
      <Text>
        <Text color="yellow">   ／ ｜ ＼  </Text>
        <Text dimColor>/help 查看命令 · /plan 先规划后执行</Text>
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: 创建 Spinner.tsx**

```tsx
import * as React from 'react';
import { Text } from 'ink';
import { formatTokens } from '../format';

const FRAMES = ['✻', '✽', '✶', '✳', '✢'];
const VERBS = ['Pondering', 'Brewing', 'Weaving', 'Distilling'];

/** 运行态活动行：帧动画 + 动词轮换 + 耗时 + 本轮 tokens（英文标识） */
export function Spinner({ startedAt, tokens }: { startedAt: number; tokens: number }): JSX.Element {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 160);
    return () => clearInterval(timer);
  }, []);
  const glyph = FRAMES[frame % FRAMES.length];
  const verb = VERBS[Math.floor(frame / 25) % VERBS.length];
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return (
    <Text dimColor>
      {glyph} {verb}… ({secs}s · ↑{formatTokens(tokens)} tokens)
    </Text>
  );
}
```

- [ ] **Step 5: 创建 ToolRow.tsx**

```tsx
import * as React from 'react';
import { Text } from 'ink';
import { ChatItem } from '../session';

/** 工具两行：调用行 ⏺ VERB target（暗灰）；结果行 ⎿ ✓/✗ summary（绿/红） */
export function ToolRow({ item }: { item: ChatItem }): JSX.Element {
  if (item.kind === 'call') {
    return <Text color="gray">⏺ {item.text}</Text>;
  }
  return (
    <Text color={item.ok ? 'green' : 'red'}>
      {'  ⎿ '}
      {item.ok ? '✓' : '✗'} {item.text}
    </Text>
  );
}
```

- [ ] **Step 6: 创建 MessageList.tsx**

```tsx
import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { bandLines } from '../text-band';
import { ToolRow } from './ToolRow';

/** 消息区：用户整行底色带（无标签）/ 助手裸文本 / 工具两行 / 思考折叠行 / 系统 ! 行 / 计划步骤行 + 实时区 */
export function MessageList({ messages, live, columns }: { messages: ChatItem[]; live?: LiveBlock; columns: number }): JSX.Element {
  if (messages.length === 0 && !live) {
    return <Text dimColor>SunshineX TUI — 输入任务或 /help 查看命令</Text>;
  }
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => (
        <Box key={i} marginBottom={1}>
          <MessageRow item={m} columns={columns} />
        </Box>
      ))}
      {live ? <LiveArea live={live} /> : null}
    </Box>
  );
}

function MessageRow({ item, columns }: { item: ChatItem; columns: number }): JSX.Element {
  if (item.role === 'user') {
    return (
      <Box flexDirection="column">
        {bandLines(item.text, columns).map((line, i) => (
          <Text key={i} backgroundColor="gray">{line}</Text>
        ))}
      </Box>
    );
  }
  if (item.role === 'assistant') return <Text>{item.text}</Text>;
  if (item.role === 'system') return <Text color="yellow">! {item.text}</Text>;
  if (item.role === 'thinking') return <Text dimColor italic>✻ {item.text}</Text>;
  if (item.role === 'step') return <Text color="cyan">▶ {item.text}</Text>;
  return <ToolRow item={item} />;
}

/** 实时区：答复草稿原样上屏；思考滚动只显示末尾 6 行（避免长思考撑爆视口） */
function LiveArea({ live }: { live: LiveBlock }): JSX.Element {
  if (live.kind === 'reply') return <Text>{live.text}</Text>;
  const tail = live.text.split('\n').slice(-6).map((l) => `✻ ${l}`).join('\n');
  return <Text dimColor italic>{tail}</Text>;
}
```

- [ ] **Step 7: 创建 InputBox.tsx**

```tsx
import * as React from 'react';
import { Box, Text } from 'ink';

/** 常驻边框输入框：❯ 提示符 + 缓冲/占位；空闲态显示静态光标 ▊（键盘分发仍在 App 单一 useInput） */
export function InputBox({ buffer, placeholder, active }: { buffer: string; placeholder: string; active: boolean }): JSX.Element {
  return (
    <Box borderStyle="round" borderColor={active ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
      <Text>
        <Text color="cyan">❯ </Text>
        {buffer.length > 0 ? <Text>{buffer}</Text> : <Text dimColor>{placeholder}</Text>}
        {active ? <Text>▊</Text> : null}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 8: 创建 StatusBar.tsx**

```tsx
import * as React from 'react';
import { Text } from 'ink';
import { SessionStatus, StatusMetrics, TodoItem } from '../session';
import { formatTokens } from '../format';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: '空闲',
  running: '运行中',
  'awaiting-approval': '等待审批',
  'awaiting-plan': '待确认计划',
  error: '出错',
};

/** 底部状态栏：本轮 tokens · runs · 上下文命中率 · 待办进度 · 状态词（不重复活动行动画） */
export function StatusBar({ metrics, status, todos }: { metrics: StatusMetrics; status: SessionStatus; todos?: TodoItem[] }): JSX.Element {
  const done = (todos ?? []).filter((t) => t.done).length;
  return (
    <Text dimColor>
      {' '}↑{formatTokens(metrics.turnTokens)} tokens · runs {metrics.runs} · ctx 命中率 {Math.round(metrics.hitRate * 100)}%
      {todos && todos.length > 0 ? ` · 待办 ${done}/${todos.length}` : ''} · {STATUS_LABEL[status]}
    </Text>
  );
}
```

- [ ] **Step 9: 重写 App.tsx**

`src/tui/components/App.tsx` 整文件替换为：

```tsx
import * as React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ApprovalDecision } from '../../types';
import { SessionController, TuiState } from '../session';
import { BannerInfo, buildBannerInfo } from '../banner-info';
import { Banner } from './Banner';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';
import { StatusBar } from './StatusBar';
import { Spinner } from './Spinner';

/** 审批键盘映射：y 放行一次 / a 本会话放行 / n 拒绝（纯函数，独立单测） */
export function approvalKeyToDecision(input: string): ApprovalDecision | undefined {
  if (input === 'y') return 'allow';
  if (input === 'a') return 'always';
  if (input === 'n') return 'deny';
  return undefined;
}

/** 输入框占位文案（按会话状态分流；纯函数便于断言） */
export function inputPlaceholder(status: TuiState['status']): string {
  switch (status) {
    case 'awaiting-approval': return '等待审批：y 放行一次 / a 本会话放行 / n 拒绝';
    case 'awaiting-plan': return '计划待确认：y 执行 / n 放弃';
    case 'running': return '运行中…（输入将排队）';
    case 'error': return '上次任务出错；输入新任务继续';
    default: return '输入任务，Enter 发送 · /help 查看命令';
  }
}

/** Ink 渲染层（纯渲染 + 单一 useInput 键盘分发）：状态全量来自 controller 订阅 */
export function App({ controller, banner }: { controller: SessionController; banner?: BannerInfo }): JSX.Element {
  const [state, setState] = React.useState<TuiState>(controller.getState());
  const [buffer, setBuffer] = React.useState('');
  React.useEffect(() => controller.onState(() => setState({ ...controller.getState() })), [controller]);
  const info = React.useMemo(() => banner ?? buildBannerInfo(), [banner]);
  const columns = useStdout().stdout?.columns ?? 80;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return; // 退出由入口层 SIGINT 统一处理
    if (state.status === 'awaiting-approval') {
      const d = approvalKeyToDecision(input);
      if (d) controller.resolveApproval(d);
      return;
    }
    if (state.status === 'awaiting-plan') {
      if (input === 'y') void controller.confirmPlan(true);
      if (input === 'n') void controller.confirmPlan(false);
      return;
    }
    if (key.return) {
      const text = buffer.trim();
      setBuffer('');
      if (text) controller.submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
  });

  return (
    <Box flexDirection="column">
      <Banner info={info} columns={columns} />
      <MessageList messages={state.messages} live={state.live} columns={columns} />
      {state.status === 'running' ? (
        <Spinner startedAt={state.metrics.turnStartedAt} tokens={state.metrics.turnTokens} />
      ) : null}
      {state.approval ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text bold>
            审批 {state.approval.id}（{state.approval.kind}）
          </Text>
          <Text>{state.approval.subject}</Text>
          <Text dimColor>y 放行一次 · a 本会话放行 · n 拒绝</Text>
        </Box>
      ) : null}
      <InputBox buffer={buffer} placeholder={inputPlaceholder(state.status)} active={state.status === 'idle' || state.status === 'error'} />
      <StatusBar metrics={state.metrics} status={state.status} todos={state.todos} />
    </Box>
  );
}
```

- [ ] **Step 10: 迁移既有 App.test.tsx 断言**

`src/tui/components/App.test.tsx` 中，测试 2（`App：manual 审批流终态渲染`）的渲染断言段：

```ts
    const { lastFrame, unmount } = render(<App controller={ctrl} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /\[你\] 写个文件/);
    assert.match(frame, /\[工具\] \[OK\]/);
    assert.match(frame, /\[助手\] ok/);
    assert.match(frame, /空闲/);
    unmount();
```

改为：

```ts
    const { lastFrame, unmount } = render(<App controller={ctrl} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /写个文件/);        // 用户消息（整行底色带，无 [你] 标签）
    assert.match(frame, /⏺ WRITE a\.txt/); // 工具调用行（英文动词）
    assert.match(frame, /✓/);              // 工具结果行（成功）
    assert.match(frame, /ok/);             // 助手裸文本答复
    assert.match(frame, /空闲/);           // 状态栏状态词
    assert.ok(!frame.includes('[你]'), '不得出现 [你] 角色标签');
    assert.ok(!frame.includes('[助手]'), '助手答复应为裸文本');
    unmount();
```

测试 3（`App：dontAsk 任务终态渲染`）的断言段：

```ts
    const { lastFrame, unmount } = render(<App controller={ctrl} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /\[助手\] done-reply/);
    assert.match(frame, /空闲/);
    assert.ok(!frame.includes('审批'), 'dontAsk 不应出现审批模态');
    unmount();
```

改为：

```ts
    const { lastFrame, unmount } = render(<App controller={ctrl} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /done-reply/);
    assert.match(frame, /空闲/);
    assert.ok(!frame.includes('[助手]'), '助手答复应为裸文本');
    assert.ok(!frame.includes('审批'), 'dontAsk 不应出现审批模态');
    unmount();
```

- [ ] **Step 11: entry.ts 注入 banner**

`src/tui/entry.ts` 整文件替换为：

```ts
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { render } from 'ink';
import { App } from './components/App';
import { SessionController } from './session';
import { buildBannerInfo } from './banner-info';
import type { CliArgs } from '../cli';

/** 读根 package.json 版本（失败回退 undefined，由 buildBannerInfo 兜底） */
function readPackageVersion(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** TUI 入口：同进程装配会话控制器与 Ink 渲染；manual 审批经键盘 y/a/n 在会话内裁决 */
export async function runTui(args: CliArgs): Promise<void> {
  const root = args.positional[0] ?? process.cwd();
  const modeFlag = typeof args.flags.mode === 'string' ? args.flags.mode : undefined;
  const mode = modeFlag === 'dontAsk' || modeFlag === 'plan' ? modeFlag : 'manual';
  const ctrl = new SessionController({ root, mode });
  const banner = buildBannerInfo({ version: readPackageVersion(), root });
  const instance = render(React.createElement(App, { controller: ctrl, banner }));
  const shutdown = (): void => {
    instance.unmount();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  await instance.waitUntilExit();
}
```

- [ ] **Step 12: 运行确认通过**

Run: `npm test 2>&1 | grep -E "App|visual|failures" | tail -20`
Expected: PASS（visual 2 用例 + 既有 App 5 用例全绿）

- [ ] **Step 13: 全量回归 + Commit**

Run: `npm test 2>&1 | tail -8`、`npm run build 2>&1 | tail -5`

```bash
git add src/tui/components/Banner.tsx src/tui/components/Spinner.tsx src/tui/components/MessageList.tsx src/tui/components/ToolRow.tsx src/tui/components/InputBox.tsx src/tui/components/StatusBar.tsx src/tui/components/App.tsx src/tui/entry.ts src/tui/components/App.visual.test.tsx src/tui/components/App.test.tsx
git commit -m "feat(tui): 精装渲染层（横幅/消息区/工具两行/输入框/状态栏/活动行）+ 断言迁移"
```

---

### Task 8: selfcheck 流式冒烟 + 手册同步 + 全量验收

**Files:**
- Modify: `src/cli/commands/selfcheck.ts`（tui 行升级）
- Modify: `TUI-MANUAL.md`（界面布局/任务执行/故障排查同步）

**Interfaces:**
- Consumes: `SessionController`（Task 6）、`ReplyStreamExtractor`（Task 2）、`ModelAdapter`/`UsageHooks`/`StubAdapter`（Task 1）。

- [ ] **Step 1: 改 selfcheck.ts**

`src/cli/commands/selfcheck.ts` 头部 import：

```ts
import { StubAdapter } from '../../model/adapter';
```

改为：

```ts
import { ModelAdapter, StubAdapter, UsageHooks } from '../../model/adapter';
```

删除两行（tui 冒烟改用 SessionController 驱动，不再直接 createRuntime）：

```ts
import { createRuntime } from '../../tui/runtime';
import { SessionEvent } from '../../types';
```

新增两行：

```ts
import { SessionController } from '../../tui/session';
import { ReplyStreamExtractor } from '../../tui/stream-extractor';
```

`runSelfcheck` 函数前新增适配器类：

```ts
/** 自检用流式适配器：合成 reasoning → token 逐字流 → usage 上报（离线、零网络，驱动流式管线冒烟） */
class SelfcheckStreamAdapter implements ModelAdapter {
  readonly provider = 'selfcheck-stream';
  async complete(): Promise<string> {
    return '{"done":true,"reply":"流式自检 OK"}';
  }
  async completeStream(_prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    hooks?.onReasoning?.('自检思考');
    const text = '{"done":true,"reply":"流式自检 OK"}';
    for (const ch of text) onDelta(ch);
    hooks?.onUsage?.(3);
    return text;
  }
}
```

替换 tui 冒烟段：

```ts
  const tuiEvents: SessionEvent[] = [];
  const tuiRt = createRuntime({ root: process.cwd(), model: new StubAdapter(), onEvent: (e) => tuiEvents.push(e) });
  await tuiRt.runTask('selfcheck tui 冒烟');
  console.log('tui     :', `headless 事件流 OK（${tuiEvents.length} 事件）`);
```

改为：

```ts
  // TUI 流式管线冒烟：合成流式适配器驱动 SessionController（reasoning→thinking 折叠、token→reply 流式、usage→本轮 tokens）
  const tuiCtrl = new SessionController({ root: process.cwd(), model: new SelfcheckStreamAdapter() });
  await tuiCtrl.submit('selfcheck tui 流式冒烟');
  await tuiCtrl.waitIdle();
  const tuiState = tuiCtrl.getState();
  const tuiReply = tuiState.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('');
  const tuiThink = tuiState.messages.filter((m) => m.role === 'thinking').length;
  if (tuiReply !== '流式自检 OK') throw new Error(`tui 流式答复异常：${tuiReply}`);
  if (tuiThink < 1) throw new Error('tui 思考折叠未生效');
  if (tuiState.metrics.turnTokens !== 3) throw new Error(`tui 本轮 tokens 异常：${tuiState.metrics.turnTokens}`);
  // 增量提取器：跨 chunk 的协议 JSON 应只透出 reply 文本
  let extracted = '';
  const ex = new ReplyStreamExtractor((t) => { extracted += t; });
  for (const chunk of ['{"done":true,"re', 'ply":"流式提取 OK"}']) ex.feed(chunk);
  if (extracted !== '流式提取 OK') throw new Error(`流式提取异常：${extracted}`);
  console.log('tui     :', `流式管线 OK（${tuiState.messages.length} 条消息；答复「${tuiReply}」；思考折叠 ${tuiThink} 段；提取「${extracted}」）`);
```

- [ ] **Step 2: 运行 selfcheck 验证**

Run: `npm run selfcheck 2>&1 | tail -20`
Expected: `tui     : 流式管线 OK（…；答复「流式自检 OK」；思考折叠 1 段；提取「流式提取 OK」）`，无抛错

- [ ] **Step 3: 同步 TUI-MANUAL.md**

`TUI-MANUAL.md` 第 2 节「界面布局」的代码块整体替换为：

```text
   ＼ ｜ ／
  ―― ☀ ――   SunshineX TUI v0.1.0 · model glm-5.3-flash  ← 启动横幅
   ／ ｜ ＼  /help 查看命令 · /plan 先规划后执行
░ 帮我创建 note.txt，内容写 hello ░                       ← 消息流（整行底色带）
✻ Pondering… (8s · ↑1.2k tokens)                          ← 运行态活动行（思考/执行中）
  ✻ 思考流：灰色斜体实时滚动                               ← 思考内容（端点回传 reasoning 时）
⏺ WRITE note.txt                                          ← 工具调用行（英文动词）
  ⎿ ✓ 42 bytes                                            ← 工具结果行（成功绿/失败红）
已创建 note.txt，内容为 hello。                            ← 助手答复（裸文本）
! 审批裁决：allow                                          ← 系统消息（! 前缀）
┌ 审批 req-1（write） ─────────┐                          ← 审批卡（出现时拦截输入）
│ write note.txt               │
│ y 放行一次 · a 本会话放行 · n 拒绝 │
└──────────────────────────────┘
╭─ ❯ 输入任务，Enter 发送 · /help 查看命令 ▊ ─╮            ← 常驻边框输入框
╰────────────────────────────────────────────╯
 ↑1.2k tokens · runs 5 · ctx 命中率 83% · 空闲             ← 状态栏
```

代码块后的说明段「状态栏五种状态：…」替换为：

```text
状态栏口径：`↑本轮 tokens`（本轮 submit 周期 provider 上报的用量累计，未上报显示 0）· `runs`（账本运行次数）· `ctx 命中率`（上下文缓存命中率）· 待办进度 · 状态词（空闲/运行中/等待审批/待确认计划/出错）。运行态在消息区末尾显示活动行（帧动画 + 英文动词 + 耗时 + 本轮 tokens），思考内容在端点回传 reasoning 时以灰色斜体实时滚动、收束后折叠为 `✻ Thought for Ns`。
```

第 4 节「任务执行」的「工具事件实时可见」「答复收束」两条 bullet 替换为：

```text
- **答复流式上屏**：模型输出经增量协议提取，`reply` 字段逐字上屏（协议 JSON 骨架不上屏）；任务完成时以 `done` 载荷定稿（终稿权威，不与流式草稿重复）。
- **工具事件实时可见**：模型每次调用工具，消息流追加 `⏺ VERB target` 调用行，执行后追加 `⎿ ✓/✗ summary` 结果行，无需等任务结束。
- **思考内容可见**：端点回传 `reasoning_content`/`reasoning` 时，思考流以灰色斜体实时滚动，收束折叠为 `✻ Thought for Ns`；端点不回传则该区域整体不出现（静默降级）。
- **失败呈现**：模型/网络异常以 `! 错误：…` 落屏，会话回到可用状态，不影响后续输入。
```

第 9 节「故障排查」表格末尾追加一行：

```text
| 看不到思考内容（✻） | 端点未回传 reasoning 字段（部分模型不含）；属静默降级，不影响答复与工具执行 |
```

- [ ] **Step 4: 全量验收**

Run: `npm run build 2>&1 | tail -5`（tsc strict 零错）
Run: `npm test 2>&1 | tail -12`（全量绿，应比 328 基线新增约 20 用例）
Run: `npm run selfcheck 2>&1 | tail -16`（tui 行升级生效）
Expected: 三者全部通过

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/selfcheck.ts TUI-MANUAL.md
git commit -m "feat(tui): selfcheck 流式冒烟 + TUI 手册同步（界面布局/流式/思考/状态栏口径）"
```

---

## Spec 覆盖对照（自审）

| spec 章节 | 落地任务 |
| --- | --- |
| §4.1 事件面扩展（reasoning/usage） | Task 1 |
| §4.2 增量提取器 | Task 2 |
| §4.5 纯函数工具（tool-verbs/text-band/banner-info/format） | Task 3 / 4 / 5 |
| §4.3 会话归约（live/thinking/metrics/步骤行） | Task 6 |
| §4.4 渲染组件 + App 装配 + §3.2 渲染规则 | Task 7 |
| §11 文档同步（TUI-MANUAL）+ §7 验收（selfcheck 升级） | Task 8 |
| §6 错误与降级 | Task 2（plain/ignore 回退）、Task 7（无 reasoning 静默）、Task 8（手册故障排查） |
| §8 边界与不做 | Global Constraints（不升级 ink/零依赖/不改协议/不动 CLI） |
