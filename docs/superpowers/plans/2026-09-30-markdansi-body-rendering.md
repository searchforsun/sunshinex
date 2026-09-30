# markdansi 正文流式渲染替换 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 流式 reply 切块与 Static 正文渲染、子代理转录渲染统一换 markdansi，退役自研补丁链（reply-flusher/LiveArea reply 分支/envelope 链/cont 产生端）。

**Architecture:** 主链 streamer 片段（自带 ANSI）即 Static 条目（`ChatItem.ansi` 分流直嵌 `<Text>`）；done/seal 收口 = `streamer.finish()`；表格/围栏缓冲期动态区显示 `tailPartial` 原文。子代理（ChildInspector/ChildTranscript/SPAWN 展开转录）text 段统一 `renderMd` 一次性渲染（无 streamer 状态），transcript/detail 继续存源 markdown。

**Tech Stack:** markdansi 0.3.4（已入依赖）、slice-ansi、string-width（markdansi 传递依赖，直接 import）、既有 highlight.ts（HiSpan→SGR 适配）。

**Spec:** `docs/superpowers/specs/2026-09-30-markdansi-body-rendering-design.md`

## Global Constraints

- 终端宽度：`process.stdout.columns ?? 80`（streamer/renderMd 创建时捕获；已印行不随 resize 重折——与现状 Static 语义一致）
- markdansi API（0.3.4 实测定形）：`createMarkdownStreamer({ render })` 返回 `{ push(chunk): string; finish(): string; reset(): void }`；**options 不透传**——width/highlighter 必须闭包绑定进 render：`(md) => markdansiRender(md, { width, highlighter })`
- streamer 缓冲语义（实测定形）：散文行即发、表格/围栏缓冲至闭合整块（**围栏无兜底切刀**，30 行代码也整块等待）、未闭合结构 `finish()` 冲刷为完整框线块（自动补框线）
- 回退：git revert 本批次；不设运行时开关
- 内容层保留：全角表格符号归一（行级、围栏内不归一）、`wrapAnsiLines` 超长行爆栈护栏（20 万列无空格行 yoga 计宽爆栈不回归）
- 仓库纪律：测试与被测模块同目录、`pnpm test` 全量门禁 fail 0、提交信息中文前缀（feat/fix/refactor/test/docs）
- Node ≥22 `require(esm)` 已验证可用（markdansi 为 ESM-only，tsc CJS 输出直接 require）

---

### Task 1: `md-ansi.ts` 单点出口（renderMd/wrapAnsiLines/tailPartial/ansiLineCount/normalizeCjkLine）

**Files:**
- Create: `src/tui/md-ansi.ts`
- Create: `src/tui/md-ansi.test.ts`（如 tsconfig 报 markdansi 无类型：补 `src/types/markdansi.d.ts`，见 Step 3）

**Interfaces:**
- Produces（后续任务全部依赖，签名精确）:
  - `renderMd(src: string, width: number): string` — 源 markdown → ANSI（normalize 行级归一 + markdansi render + wrapAnsiLines 兜底）
  - `wrapAnsiLines(fragment: string, width: number): string` — ANSI 安全按显示宽折行
  - `ansiLineCount(fragment: string): number` — 剥 ANSI 后行数（tail 账本消费）
  - `tailPartial(src: string): string` — 尾部未完结构（已开表格/未闭合围栏/未换行行）原文；无未完结构返回 `''`
  - `createMdRender(width: number): (md: string) => string` — 闭包绑定 width/highlighter 的 render 工厂（streamer 构造消费）
  - `normalizeCjkLine(line: string, inFence: boolean): string` — 行级全角归一（围栏内原样返回）
  - `isFenceLine(line: string): boolean` — ```/~~~ 开栏行判定（session 行喂入围栏状态跟踪用）

- [ ] **Step 1: 写失败测试**

```ts
// src/tui/md-ansi.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMd, wrapAnsiLines, ansiLineCount, tailPartial, normalizeCjkLine, isFenceLine } from './md-ansi';

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');

test('renderMd：表格成框线、ANSI 输出、宽度受控', () => {
  const out = renderMd('| a | b |\n|---|---|\n| 1 | 2 |', 60);
  assert.ok(out.includes('│'), '表格框线成形');
  assert.ok(strip(out).split('\n').every((l) => l.length <= 60), '行宽 ≤ width');
});

test('renderMd：全角分隔行归一后成表（|───|───|）', () => {
  const out = renderMd('| 包 | 职责 |\n|───|───|\n| x | y |', 60);
  assert.ok(out.includes('│'), '全角分隔行归一生效');
});

test('wrapAnsiLines：20 万列无空格行折行不爆栈、ANSI 码不切坏', () => {
  const huge = '\x1b[31m' + 'a'.repeat(200_000) + '\x1b[0m';
  const out = wrapAnsiLines(huge, 60);
  const lines = out.split('\n');
  assert.ok(lines.length > 3000, '已按宽折行');
  assert.ok(lines.every((l) => strip(l).length <= 60), '剥码后行宽恒 ≤ 60');
  assert.ok(!/\u001b$/.test(out), '行尾不留半截转义码');
});

test('ansiLineCount：剥码行数', () => {
  assert.equal(ansiLineCount('\x1b[31m甲\x1b[0m\n乙\n'), 2);
});

test('tailPartial：表格已开返回表头起原文；闭合后返回未完行；无未完返回空', () => {
  assert.equal(tailPartial('前言。\n\n| a | b |\n|---|\n| 1'), '| a | b |\n|---|\n| 1');
  assert.equal(tailPartial('第一行\n第二行'), '第二行');
  assert.equal(tailPartial('完整。\n'), '');
});

test('tailPartial：未闭合围栏返回围栏原文（含开栏行）', () => {
  assert.equal(tailPartial('```\ncode'), '```\ncode');
});

test('normalizeCjkLine：全角管道/破折号/冒号归一；围栏内原样', () => {
  assert.equal(normalizeCjkLine('｜ a ｜───｜', false), '| a |---|');
  assert.equal(normalizeCjkLine('|：x：|', false), '|:x:|');
  assert.equal(normalizeCjkLine('｜ 不动 ｜', true), '｜ 不动 ｜');
});

test('isFenceLine：以 ```/~~~ 开头即围栏行（开/闭奇偶由调用侧跟踪）', () => {
  assert.ok(isFenceLine('```ts'));
  assert.ok(isFenceLine('``` 后内容'));
  assert.ok(isFenceLine('~~~'));
  assert.ok(!isFenceLine('普通行'));
});

test('createMdRender：闭包绑定 width/highlighter（streamer options 不透传，实测定形）', () => {
  const render40 = createMdRender(40);
  const out = render40('| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(out.includes('│'), '表格渲染成功');
  assert.ok(out.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').split('\n').every((l) => l.length <= 40), 'width 绑定生效');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build 2>&1 | tail -3 && node --test dist/tui/md-ansi.test.js 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: 编译失败（模块不存在）或测试 FAIL。

- [ ] **Step 3: 实现 md-ansi.ts**

```ts
// src/tui/md-ansi.ts
import { render as mdRender } from 'markdansi';
import slice from 'slice-ansi';
import stringWidth from 'string-width';
import { highlightLine, HiKind } from './highlight';

/** HiKind → SGR 前景码（与 MarkdownText HI_COLOR 同色系：magenta/green/gray/yellow） */
const HI_SGR: Record<HiKind, string> = {
  keyword: '\x1b[35m', string: '\x1b[32m', comment: '\x1b[90m', number: '\x1b[33m', plain: '',
};

/** markdansi highlighter 适配：行级 HiSpan → ANSI 着色文本 */
function mdHighlighter(code: string, lang?: string): string {
  return code
    .split('\n')
    .map((l) => highlightLine(lang ?? '', l).map((s) => `${HI_SGR[s.kind]}${s.text}${s.kind === 'plain' ? '' : '\x1b[0m'}`).join(''))
    .join('\n');
}

/** 剥 ANSI 转义（SGR 与光标类） */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

export function ansiLineCount(fragment: string): number {
  return stripAnsi(fragment).replace(/\n$/, '').split('\n').length;
}

/** ANSI 安全按显示宽折行（爆栈护栏：无空格超长 token markdansi 段落不折、ink Static yoga 计宽即 RangeError） */
export function wrapAnsiLines(fragment: string, width: number): string {
  return fragment
    .split('\n')
    .flatMap((l) => (stringWidth(stripAnsi(l)) <= width ? [l] : hardSlice(l, width)))
    .join('\n');
}

function hardSlice(line: string, width: number): string[] {
  // 先按显示宽切纯文本段，再以 slice-ansi 对原行逐段切（保留码）；简单可靠形态：按 width 步进 slice
  const out: string[] = [];
  for (let i = 0; i < 1_000; i++) {
    const seg = slice(line, i * width, (i + 1) * width);
    if (seg === '') break;
    out.push(seg);
  }
  return out.length > 0 ? out : [''];
}

/** 行级全角归一（中文模型全角表格符号，CommonMark 只认 ASCII；围栏内代码内容不归一） */
export function normalizeCjkLine(line: string, inFence: boolean): string {
  if (inFence) return line;
  if (!/^\s*[｜|]/.test(line)) return line;
  return line.replace(/｜/g, '|').replace(/[—–―─━－﹘]/g, '-').replace(/：/g, ':');
}

export function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** 源 markdown → ANSI 单点出口（归一 + render + 爆栈兜底）；高亮经闭包绑定（streamer options 不透传，实测定形） */
export function renderMd(src: string, width: number): string {
  return wrapAnsiLines(mdRender(src, { width, highlighter: mdHighlighter }), width);
}

/** streamer 消费的 render 工厂：闭包绑定 width/highlighter（createMarkdownStreamer 的 options 不透传） */
export function createMdRender(width: number): (md: string) => string {
  return (md) => wrapAnsiLines(mdRender(md, { width, highlighter: mdHighlighter }), width);
}

/** 尾部未完结构原文（动态区预览）：自尾向前找「结构起点」——已开表格的表头行 / 未闭合围栏开栏行 / 最近换行后的未完行 */
export function tailPartial(src: string): string {
  const lines = src.split('\n');
  const last = lines[lines.length - 1] ?? '';
  // 未闭合围栏：最后一个开栏行起
  let fenceIdx = -1;
  for (let i = 0; i < lines.length; i++) if (isFenceLine(lines[i]!)) fenceIdx = fenceIdx >= 0 ? -1 : i;
  if (fenceIdx >= 0) return lines.slice(fenceIdx).join('\n');
  // 已开表格（表头+分隔行成对后未闭合）：自表头行起
  for (let i = lines.length - 2; i >= 0; i--) {
    if (/^\s*[|｜]/.test(lines[i] ?? '') && /^\s*[|｜][-–—━＿\s:：|]+[|｜]\s*$/.test(lines[i + 1] ?? '')) {
      return lines.slice(i).join('\n');
    }
  }
  // 未完行（最后换行之后）
  return last;
}
```

若 tsc 报 `markdansi`/`slice-ansi`/`string-width` 类型缺失：`pnpm add -D @types/slice-ansi @types/string-width`；markdansi 无类型则建 `src/types/markdansi.d.ts`：

```ts
declare module 'markdansi' {
  export interface RenderOptions { width?: number; highlighter?: (code: string, lang?: string) => string; [k: string]: unknown }
  export function render(markdown: string, options?: RenderOptions): string;
  export function strip(markdown: string, options?: RenderOptions): string;
  export function createMarkdownStreamer(options: { render: (md: string) => string } & RenderOptions): { push(chunk: string): string; finish(): string; reset(): void };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build 2>&1 | tail -2 && node --test dist/tui/md-ansi.test.js 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: PASS 7。

- [ ] **Step 5: 提交**

```bash
git add src/tui/md-ansi.ts src/tui/md-ansi.test.ts src/types/markdansi.d.ts package.json pnpm-lock.yaml 2>/dev/null || git add src/tui/md-ansi.ts src/tui/md-ansi.test.ts
git commit -m "feat(tui): md-ansi 单点出口——renderMd（归一+markdansi render+爆栈兜底）/wrapAnsiLines（ANSI 安全折行）/tailPartial（未完结构原文预览）/ansiLineCount（账本行数）/normalizeCjkLine（行级全角归一，围栏内不归一）"
```

---

### Task 2: session 主链 streamer 集成（行喂入/finish 收口/ansi 入档）

**Files:**
- Modify: `src/tui/session.ts`（appendLive/flushReply/done/sealReply 一带，约 1560–1700 与 1960–2040 行区域）
- Test: `src/tui/session.stream.test.ts`（新增用例）、`src/tui/session.test.ts`（切块断言改口径）

**Interfaces:**
- Consumes: Task 1 的 `normalizeCjkLine/isFenceLine/renderMd`
- Produces: `ChatItem.ansi?: true`（ChatItem 接口加字段，session.ts:31 一带）；assistant 条目 text 承载 ANSI 渲染结果（`item.ansi === true` 时）

- [ ] **Step 1: ChatItem 加字段 + 写失败测试**

`session.ts` ChatItem 接口（`subagentMeta` 字段后）加：

```ts
  /** markdansi 渲染结果条目（2026-09-30 替换批次）：text 承载 ANSI（非 markdown 源），渲染层直嵌 <Text>；
   *  journal 按原样序列化，resume 回放照显 */
  ansi?: true;
```

`session.stream.test.ts` 追加：

```ts
test('会话归约：流式正文 markdansi 行级入档——散文行即发、表格缓冲至闭合整块（ansi 条目）', async () => {
  const tmp = tmpdir('sunshinex-stream-md-');
  try {
    const text = '第一行\n第二行\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n收尾。';
    const ctrl = new SessionController({ root: tmp, model: new HookAdapter(text) });
    const ansiSeen: string[] = [];
    ctrl.onState((s) => {
      for (const m of s.messages) if (m.role === 'assistant' && m.ansi && !ansiSeen.includes(m.text)) ansiSeen.push(m.text);
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const items = ctrl.getState().messages.filter((m) => m.role === 'assistant');
    assert.ok(items.length >= 2, '行级/段级多块入档');
    assert.ok(items.every((m) => m.ansi === true), '流式条目全部 ansi');
    const table = items.find((m) => m.text.includes('│'));
    assert.ok(table, '表格块含框线（闭合后整块）');
    assert.ok(items.some((m) => m.text.includes('第一行')), '散文行入档');
    // 源不丢不重：剥 ANSI 拼接含全部内容
    const joined = items.map((m) => m.text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')).join('');
    for (const probe of ['第一行', '第二行', '收尾']) assert.ok(joined.includes(probe), `内容不丢：${probe}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话归约：工具边界旁白封口走 finish 冲刷（未闭合围栏渲染为完整框线块）', async () => {
  const tmp = tmpdir('sunshinex-stream-md2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        JSON.stringify({ tools: [{ tool: 'read', input: { path: 'a.ts' } }], done: false, reply: '前言\n\n```ts\ncode' }),
        JSON.stringify({ done: true, reply: 'ok' }),
      ]),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const msgs = ctrl.getState().messages;
    const fence = msgs.find((m) => m.ansi && m.text.includes('┌'));
    assert.ok(fence, '未闭合围栏经 finish 冲刷为框线块（旁白封口）');
    const callIdx = msgs.findIndex((m) => m.kind === 'call');
    const fenceIdx = msgs.findIndex((m) => m === fence);
    assert.ok(fenceIdx < callIdx, '旁白先于工具行（CC 交错形态保持）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build 2>&1 | tail -2 && node --test dist/tui/session.stream.test.js 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: 新用例 FAIL（无 ansi 条目）。

- [ ] **Step 3: 实现 session 集成**

`session.ts` 字段区（`committedLen` 一带）替换为：

```ts
  /** markdansi 流式通道（2026-09-30 替换批次）：live reply 期间持有；行级归一喂入、片段即时入档（ansi 条目）；
   *  工具边界/done 经 finish() 冲刷收口（终稿 dedup 天然成立——streamer 不重不发），随后置空 */
  private mdStream: { push(chunk: string): string; finish(): string; reset(): void } | undefined;
  /** 行喂入缓冲（preprocess 需行级上下文：围栏内不归一） */
  private mdLineBuf = '';
  private mdInFence = false;
```

`appendLive`（kind==='reply' 分支）改造：delta 追加后调 `this.mdFeed()`：

```ts
  /** 行级喂入 + 片段即时入档：遇 \n 成行→归一（围栏状态跟踪）→streamer.push；片段非空白规范后 pushMsg(ansi) */
  private mdFeed(): void {
    const live = this.state.live;
    if (!live || live.kind !== 'reply' || this.mdStream === undefined) return;
    this.mdLineBuf += /* live 新增 delta——由调用方传入更稳：见下 */ '';
  }
```

实现要点（写代码时落实，避免双重维护 delta）：
1. `appendLive('reply', delta)` 内：先累积 live.text，再 `this.mdConsume(delta)`。
2. `mdConsume(delta)`：`mdLineBuf += delta`；`while (mdLineBuf.includes('\n'))` 取首个整行 `line`（含 \n）→ `mdInFence` 翻转判定（`isFenceLine`）→ `streamer.push(normalizeCjkLine(line, mdInFence))`；循环。
3. streamer 创建（首个 reply 块时）：`this.mdStream = createMarkdownStreamer({ render: (md) => mdRender(md, { width: process.stdout.columns ?? 80, highlighter: mdHighlighter }) })`——mdHighlighter/绑定形态从 md-ansi.ts 导出（Task 1 补导出 `createMdRender(width): (md: string) => string`，测试里钉住含 width）。
4. 每次 push/flush 返回片段：`frag.replace(/\n+$/, '\n')` 规范；`stripAnsi(frag).trim()` 为空则跳过（视觉间隔由条目 margin 承载）；否则 `this.pushMsg('assistant', frag, { ansi: true })`（`planReplyNoArchive` 时跳过入档只推进）。
5. `sealReply`/done 收口：`const tail = this.mdStream?.finish()` → 同规范入档 → `this.mdStream = undefined; this.mdLineBuf = ''; this.mdInFence = false;`。done 防御：`finalText` 非空且与已推源不一致（`!finalText.startsWith(已累积源)`）时降级 `pushMsg('assistant', renderMd(finalText 剩余差量), { ansi: true })`。
6. 删除：`flushReply` 整方法、`committedLen`、`replyContPending`、`appendBlankToLastReply`、token 分支里的 `this.flushReply()` 调用（session.ts:1562 一带）。

- [ ] **Step 4: 跑测试（含旧套件改口径）**

`session.test.ts`「流式答复安全点切块增量入档」用例改断言：块≥2 且 `chunks.map(strip).join('')` 含 reply 全部 probe 词（不再要求 `join === reply`——渲染态文本与源不同）。追加 `ansi === true` 断言。

Run: `pnpm build 2>&1 | tail -2 && node --test dist/tui/session.stream.test.js dist/tui/session.test.js dist/tui/session-journal.test.js 2>&1 | grep -E "ℹ (pass|fail)"`
Expected: PASS（journal 需确认 ansi 条目序列化回放无损，必要时补 msg-update 断言）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.stream.test.ts src/tui/session.test.ts src/tui/md-ansi.ts
git commit -m "feat(tui): session 主链接 markdansi 流式通道——行级归一喂入（围栏状态跟踪）、片段即时入档为 ansi 条目、工具边界/done 走 finish 冲刷收口（未闭合围栏渲染完整框线块、终稿 dedup 天然成立）；committedLen/flushReply/cont 产生端/空白并块退役"
```

---

### Task 3: MessageList ansi 分流 + MdBufferPreview + 账本口径

**Files:**
- Modify: `src/tui/components/MessageList.tsx`（MessageRow 分流 + LiveArea 调用点）、`src/tui/tail-rewrite.ts`（printedEntryLines）、`src/tui/components/LiveArea.tsx`（reply 分支退役在 Task 5，本任务只加 MdBufferPreview 挂载）
- Test: `src/tui/components/MessageList.test.tsx`（若无则建）、`src/tui/tail-rewrite.test.tsx`

**Interfaces:**
- Consumes: `ChatItem.ansi`（Task 2）、`ansiLineCount/tailPartial/renderMd`（Task 1）
- Produces: MessageRow 对 `item.ansi` 条目渲染 `<Text>{item.text}</Text>`；`printedEntryLines(item, full, columns)` 对 ansi 条目返回 `ansiLineCount(item.text)`

- [ ] **Step 1: 写失败测试**

`src/tui/components/MessageList.test.tsx`：

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList } from './MessageList';
import { ChatItem, LiveBlock } from '../session';
import { BannerInfo } from '../banner-info';

const banner: BannerInfo = { version: '1.0', model: 'm', root: 'r' } as BannerInfo;
const mk = (over: Partial<ChatItem>): ChatItem => ({ role: 'assistant', text: '', ts: 1, seq: 1, ...over });

test('MessageList：ansi 条目直嵌 Text（框线表格呈现），普通条目照旧', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 1, text: '│ a │ b │\n├───┼───┤', ansi: true })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  assert.ok(one.allOutput().includes('│ a │ b │'), 'ANSI 表格行原样上屏');
  one.unmount();
});

test('MessageList：live reply 期间 MdBufferPreview 显示 tailPartial 原文（表格已开表头可见）', () => {
  const live: LiveBlock = { kind: 'reply', text: '前言。\n\n| a | b |\n|---|\n| 1', committedLen: 0, startedAt: 0 } as LiveBlock;
  const one = render(
    <MessageList banner={banner} messages={[]} live={live} columns={80} expandAll={false} latestFull={false} />,
  );
  assert.match(one.lastFrame() ?? '', /\| a \| b \|/, '未闭合表格表头原文在动态区');
  one.unmount();
});
```

`tail-rewrite.test.tsx` 追加：

```tsx
test('printedEntryLines：ansi 条目按剥码行数计', () => {
  const item = { role: 'assistant', text: '\x1b[31m甲\x1b[0m\n乙\n', ts: 1, seq: 1, ansi: true } as never;
  assert.equal(printedEntryLines(item, false, 80), 2);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `pnpm build 2>&1 | tail -2 && node --test dist/tui/components/MessageList.test.js dist/tui/tail-rewrite.test.js 2>&1 | grep -E "ℹ (pass|fail)"`，Expected FAIL。

- [ ] **Step 3: 实现**

MessageList.tsx：
1. `MessageRow` 首行加：`if (item.ansi) return <Text>{item.text}</Text>;`
2. LiveArea 调用点前加预览（live?.kind === 'reply' 时）：`<Box flexDirection="column" marginBottom={1}><Text dimColor>{tailPartial(live.text)}</Text></Box>`——抽 `MdBufferPreview({ live, columns })` 小组件（live.reply 时渲染 tailPartial 逐行 Text；columns 预留）。LiveArea 的 reply 分支此任务先保留（thinking 用）但调用改为仅 `live.kind === 'thinking'` 时挂 LiveArea；Task 5 删 LiveArea reply 代码。
3. imports：`tailPartial` from '../md-ansi'。

tail-rewrite.ts `printedEntryLines` 首行加：`if ((item as { ansi?: true }).ansi) return ansiLineCount(item.text);`（imports ansiLineCount）。

- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令，Expected PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/MessageList.tsx src/tui/components/MessageList.test.tsx src/tui/tail-rewrite.ts src/tui/tail-rewrite.test.tsx
git commit -m "feat(tui): MessageList ansi 条目分流直嵌 Text + MdBufferPreview（未闭合表格/围栏原文预览）+ tail 账本 ansi 行数实账（ansiLineCount）"
```

---

### Task 4: 子代理转录渲染统一（ChildInspector/ChildTranscript 换 renderMd）

**Files:**
- Modify: `src/tui/components/ChildInspector.tsx`（md 段/尾段预览）、`src/tui/components/ChildTranscript.tsx`（TranscriptSegView md 段）
- Test: `src/tui/components/ChildInspector.test.tsx`（改断言：md 段呈现框线表格）

**Interfaces:**
- Consumes: `renderMd`（Task 1）
- Produces: 子代理 text 段与主链正文同一渲染出口（验收「观感一致」）；detail/transcript 序列化格式**零变更**

- [ ] **Step 1: 写失败测试**

ChildInspector.test.tsx 改「Inspector 运行中」用例 + 新增：

```tsx
test('Inspector：text 段 markdansi 渲染——表格框线、与主链同出口（renderMd）', () => {
  const one = render(
    <ChildInspector
      child={{
        label: 'w', startedAt: Date.now(), steps: 1, tokens: 10,
        transcript: [{ kind: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |' }],
      }}
      columns={80}
      rows={20}
    />,
  );
  assert.ok(one.allOutput().includes('│'), '表格框线（markdansi 出口）');
  one.unmount();
});
```

- [ ] **Step 2: 确认失败** — Run: `pnpm build 2>&1 | tail -2 && node --test dist/tui/components/ChildInspector.test.js 2>&1 | grep -E "ℹ (pass|fail)"`，Expected FAIL（现走 MarkdownText 自研框线形态不同）。

- [ ] **Step 3: 实现**

ChildInspector.tsx：md 渲染点 `<MarkdownText text={...} columns={...} />` 全部换 `<Text>{renderMd(text, columns)}</Text>`（闭合 md 段 Static 条目 + 动态预览尾段两处）；删 MarkdownText import，加 `import { renderMd } from '../md-ansi'`。结构行（CallRow/ResultRow/ThinkRow/输入带）不动。

ChildTranscript.tsx：`TranscriptSegView` 的 `seg.kind === 'md'` 分支换 `<Text>{renderMd(seg.text, Math.max(16, columns))}</Text>`。

- [ ] **Step 4: 跑测试（含归档回看/旧档套件）** — Run: `pnpm build 2>&1 | tail -2 && node --test dist/tui/components/ChildInspector.test.js dist/tui/components/ChildTranscript.test.js dist/tui/components/App.spawn-browse.test.js dist/tui/components/App.inspect.test.js 2>&1 | grep -E "ℹ (pass|fail)"`，Expected PASS（旧断言里 MarkdownText 特有形态如 `**bold**` 星号断言按 markdansi 输出改写）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/ChildInspector.tsx src/tui/components/ChildTranscript.tsx src/tui/components/ChildInspector.test.tsx
git commit -m "feat(tui): 子代理转录渲染统一 renderMd——运行视图 md 段/尾段预览、归档回看 TranscriptSegView 换 markdansi 出口（与主链观感一致）；transcript/detail 序列化零变更（存源 markdown）"
```

---

### Task 5: 退役自研链（reply-flusher/LiveArea reply 分支/App envelope 链）

**Files:**
- Delete: `src/tui/reply-flusher.ts`、`src/tui/reply-flusher.test.ts`
- Modify: `src/tui/components/LiveArea.tsx`（删 reply 分支与 tailReplyPreview/markdownRowCount 依赖）、`src/tui/components/LiveArea.test.tsx`（删 reply 用例）、`src/tui/components/App.tsx`（删 previewCap/envelope/onPreviewUsed/previewEnvelope 链与 previewMaxRows 透传）、`src/tui/components/MessageList.tsx`（删 previewMaxRows/envelope/onPreviewUsed props）、`src/tui/session.ts`（删 `import { openFenceOpener, stableReplySegment } from './reply-flusher'` 与 LiveBlock 的 fenceOpener/committedLen 字段消费——字段保留兼容旧 journal 回放，只删写入端）
- Test: 全量套件

- [ ] **Step 1: 删除与清理**（上述文件；LiveArea 仅剩 thinking 6 行窗；App 删 envelope 块与 MessageList 相关 props；use-input.esc/ChildPanel 等无关文件不动）

- [ ] **Step 2: 全量测试修复口径**

受影响断言清单（逐一改写）：
- `LiveArea.test.tsx`：reply/预览窗用例删除；thinking 用例保留。
- `session.stream.test.ts`/`session.test.ts`：flushReply/committedLen/fenceOpener 相关断言改 streamer 口径（Task 2 已改大半，此处清尾）。
- `App.test`/`App.tab-tail.test`：envelope 相关（若断言 previewMaxRows 透传）删除对应行。

Run: `pnpm build 2>&1 | tail -2 && pnpm test 2>&1 | tail -8`
Expected: fail 0（约 1414 例基线上删 reply-flusher 15 例、LiveArea reply 数例，新增 md-ansi/session/MessageList/ChildInspector 数例）。

- [ ] **Step 3: 提交**

```bash
git add -A src/tui && git commit -m "refactor(tui): 退役自研正文流式链——reply-flusher 整文件（切块/结构守候/兜底）、LiveArea reply 分支与 tailReplyPreview、App envelope/previewCap 链；思考流 6 行窗保留，fenceOpener/committedLen 字段保留兼容旧 journal 回放（只删写入端）"
```

---

### Task 6: 全量门禁 + 真机验证清单

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-markdansi-body-rendering-design.md`（尾部追加「实施记录」行）

- [ ] **Step 1: 全量门禁** — Run: `pnpm build && pnpm test`，Expected: fail 0。
- [ ] **Step 2: selfcheck** — Run: `pnpm selfcheck 2>&1 | tail -5`，Expected: OK。
- [ ] **Step 3: 真机验证清单**（追加到 spec 尾部并提交）：

```markdown
## 九、实施记录与真机验证清单（实施后回填）

- [ ] 逐行打字机：流式正文行级上屏、随滚动缓冲上推
- [ ] 表格：缓冲期表头/数据行原文可见，闭合瞬间整块框线（含全角分隔行变体）
- [ ] 围栏：闭合整块；生成期预览为原文（已裁降级）；超长代码行折行
- [ ] 无闪频/不跳中间：动态区仅未完结构预览 + chrome
- [ ] 子代理视图/归档回看/SPAWN 展开转录与主链表格、围栏、列表形态一致
- [ ] 20 万列无空格行不崩；旧会话 /resume 回放零回归（含 cont/非 ansi 混排）
```

- [ ] **Step 4: 提交** — `git add docs/superpowers/specs/2026-09-30-markdansi-body-rendering-design.md && git commit -m "docs(tui): markdansi 替换批次实施记录与真机验证清单（spec §九）"`

---

## Self-Review 记录

- Spec 覆盖：§三架构（Task 1–3）、子代理统一（Task 4）、退役清单（Task 5）、验收/真机（Task 6）✓；§五风险 1（finish 形态）已由计划前探针定形并写入 Global Constraints ✓
- 类型一致：`renderMd/wrapAnsiLines/ansiLineCount/tailPartial/normalizeCjkLine/isFenceLine` 跨任务签名一致；`ChatItem.ansi` Task 2 定义、Task 3 消费 ✓
- 无占位：所有步骤含具体代码/命令/期望 ✓
