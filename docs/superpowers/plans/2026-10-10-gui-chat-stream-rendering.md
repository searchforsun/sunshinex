# GUI 会话流渲染升级 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话流渲染对标 Codex 二轮——run 状态行、工具/思考行展开与流动预览、Markdown 定靶样式、正文尾部操作条、用户气泡编辑卡、统一直观动效。

**Architecture:** 全部改动在 GUI 层三文件:`chat-reducer.ts` 增 run 边界条目(纯函数投影)、`Chat.tsx` 增渲染组件(RunEntryView/CodeBlock/MermaidBlock/RunFooter/编辑卡,数据全部来自既有事件载荷)、`app.css` 末尾追加 G11 样式段(走既有令牌)。daemon 零改动。

**Tech Stack:** React 19 + react-markdown/remark-gfm(既有)、highlight.js(既有全量包)、lucide-react(既有)、vitest + @testing-library/react(既有)。

**Spec:** `docs/superpowers/specs/2026-10-10-gui-chat-stream-rendering-design.md`(本文按其 §1-§11 逐条落地,行号引用以此为准)

## Global Constraints

- daemon 零改动;全部数据取自既有事件载荷(done `{steps, tokensUsed}`、tool-call/tool-result `payload.input`/`text`)。
- 样式全部归 `gui/src/app.css` 末尾「G11」追加段(单一 CSS 文件约束 U-D10);一律走既有令牌(`--surface-*`/`--fg-*`/`--border*`/`--radius-*`/`--dur-*`/`--ease-*`/`--syntax-*`),零新 CSS 变量、零新 npm 依赖。
- 双语文案一律 `t(en, zh)` 就地字面量(调用时求值);**测试环境语言为缺省 `en`,断言一律写英文文案**。
- 新按钮一律纯图标:`TipButton`(Task 2 定义)+ `aria-label`(英文,查询锚)+ `data-tip`;不用原生 `title`。
- TDD:每任务先写失败测试→跑红→最小实现→跑绿→commit;commit 信息沿用仓内惯例(`feat(gui): …`/`test(gui): …`)。
- 验证命令:单文件 `cd gui && npx vitest run src/<file>`;全量 `cd gui && npx tsc -p . --noEmit && npx vitest run`。
- 既有 DOM 契约保持:`.tool-summary` 文本含 verb/result、`.sx-stream-cursor` 进出场、`.entry-notice` 文本、`.user-bubble`;已知必改仅 Chat.test.tsx 三处 `title="Copy"` 查询(Task 2)。

---

### Task 1: reducer run 边界条目

**Files:**
- Modify: `gui/src/chat-reducer.ts`(ChatEntry 接口、model-start/done/error 三分支、新增 sealRun)
- Test: `gui/src/chat-reducer.test.ts`

**Interfaces:**
- Consumes: 既有 `ChatEntry`/`sealStreaming`/`sealThinking`/`replaceAt`。
- Produces: `ChatEntry.kind` 联合含 `'run'`;run 条目字段 `seconds?: number`、`steps?: number`、`tokens?: number`、`endedTs?: number`(后续 Task 3/10 渲染消费);key 形态 `run:<entries.length>`。

- [ ] **Step 1: 写失败测试**

在 `gui/src/chat-reducer.test.ts` 的 `describe('思考链聚合…')` 之前插入:

```ts
describe('run 边界条目(G11 状态行:idle→running 插入,done/error 封段计时)', () => {
  it('idle 态 model-start 插入 run 条目(streaming 标+ts);running 续轮不重复插', () => {
    let s = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'run', md: '', streaming: true, ts: 1_000 });
    s = applyChatEvent(s, { type: 'model-start', ts: 5_000 } as SessionEvent);
    expect(s.entries).toHaveLength(1);
  });

  it('done 封段:去 streaming 标、seconds 计 ts 差、steps/tokens 透传 done 载荷、endedTs 回填', () => {
    let s = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'token', text: '答', ts: 2_000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'done', text: '答', ts: 34_500, payload: { steps: 12, tokensUsed: 8400 } } as SessionEvent);
    const run = s.entries.find((e) => e.kind === 'run')!;
    expect(run).toMatchObject({ kind: 'run', streaming: undefined, seconds: 34, steps: 12, tokens: 8400, endedTs: 34_500 });
  });

  it('error 亦封段(seconds 回填,无统计载荷);无 ts 不计秒', () => {
    let s = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    s = applyChatEvent(s, { type: 'error', text: 'boom', ts: 4_000 } as SessionEvent);
    expect(s.entries[0]).toMatchObject({ kind: 'run', streaming: undefined, seconds: 3 });
    let s2 = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    s2 = applyChatEvent(s2, { type: 'done', text: 'x', ts: 2_000 } as SessionEvent);
    expect(s2.entries[0]).toMatchObject({ kind: 'run', streaming: undefined });
    expect(s2.entries[0]!.seconds).toBeUndefined();
  });

  it('done 无 run 条目(直答面)不补插;多轮 run 各自成段', () => {
    const s = fold([ev('done', 'direct')]);
    expect(s.entries.map((e) => e.kind)).toEqual(['assistant']);
    let s2 = applyChatEvent(initialChatState(), { type: 'model-start', ts: 1_000 } as SessionEvent);
    s2 = applyChatEvent(s2, { type: 'done', text: 'a', ts: 2_000 } as SessionEvent);
    s2 = applyChatEvent(s2, { type: 'model-start', ts: 10_000 } as SessionEvent);
    s2 = applyChatEvent(s2, { type: 'done', text: 'b', ts: 13_000 } as SessionEvent);
    expect(s2.entries.filter((e) => e.kind === 'run').map((r) => r.seconds)).toEqual([1, 3]);
  });

  it('seed 快照不产 run 条目(历史归档无 run 标)', () => {
    const s = seedChatFromSnapshot([{ seq: 1, ts: 1, kind: 'assistant', md: 'old' }], 'running');
    expect(s.entries.map((e) => e.kind)).toEqual(['assistant']);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `cd gui && npx vitest run src/chat-reducer.test.ts`
Expected: FAIL(kind 'run' 不在联合类型/断言失败)

- [ ] **Step 3: 最小实现**

`gui/src/chat-reducer.ts` 三处:

① `ChatEntry` 增字段与 kind:

```ts
export interface ChatEntry {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error' | 'thinking' | 'run';
  md: string;
  streaming?: boolean;
  /** thinking 专用:段耗时秒(封段时由首尾 ts 差计算;无 ts/不足 1s 省略) */
  seconds?: number;
  /** 条目时间(epoch ms;事件条透传 e.ts,种子条透传快照,本地回显/开条时刻就地取;无源可省) */
  ts?: number;
  /** run 专用(G11 状态行):封段统计——done 载荷 {steps, tokensUsed} 透传 */
  steps?: number;
  tokens?: number;
  /** run 专用:收段时刻(完成时间渲染源) */
  endedTs?: number;
}
```

② `sealThinking` 函数之后新增:

```ts
/** 封 run 段(G11 状态行):最后一条 streaming run 条去标并回填耗时/统计。
 *  seconds 首尾 ts 差取整;steps/tokens 透传 done 载荷;endedTs=收段事件 ts。无 run 条透传原数组 */
function sealRun(entries: readonly ChatEntry[], now: number | undefined, stat?: { steps?: number; tokens?: number }): ChatEntry[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.kind === 'run' && e.streaming === true) {
      const seconds = now !== undefined && typeof e.ts === 'number' && now > e.ts ? Math.round((now - e.ts) / 1000) : undefined;
      return replaceAt(entries, i, {
        ...e,
        streaming: undefined,
        ...(seconds !== undefined ? { seconds } : {}),
        ...(stat?.steps !== undefined ? { steps: stat.steps } : {}),
        ...(stat?.tokens !== undefined ? { tokens: stat.tokens } : {}),
        ...(now !== undefined ? { endedTs: now } : {}),
      });
    }
  }
  return entries as ChatEntry[];
}
```

③ `onDone`/`onError` 整体替换、`model-start` 分支替换(`sealStreaming` 返回的 `sealedIdx` 指向 assistant 条;`sealRun` 只改 run 条、不位移索引,故在其结果上继续用 `base.sealedIdx` 是安全的):

```ts
function onDone(s: ChatState, e: SessionEvent): ChatState {
  const base = sealStreaming(sealThinking(s.entries, e.ts));
  const entries = sealRun(base.entries, e.ts, {
    steps: typeof e.payload?.steps === 'number' ? e.payload.steps : undefined,
    tokens: typeof e.payload?.tokensUsed === 'number' ? e.payload.tokensUsed : undefined,
  });
  const text = e.text ?? '';
  if (base.sealedIdx < 0) {
    return { ...s, status: 'idle', entries: [...entries, { key: `a${entries.length}`, kind: 'assistant', md: text, ts: e.ts }] };
  }
  const sealed = entries[base.sealedIdx]!;
  return { ...s, status: 'idle', entries: replaceAt(entries, base.sealedIdx, { ...sealed, md: mergeFinal(sealed.md, text) }) };
}

function onError(s: ChatState, e: SessionEvent): ChatState {
  const base = sealStreaming(sealThinking(s.entries, e.ts));
  const entries = sealRun(base.entries, e.ts);
  return { ...s, status: 'idle', entries: [...entries, { key: `e${entries.length}`, kind: 'error', md: e.text ?? 'error', ts: e.ts }] };
}
```

`applyChatEvent` 的 `model-start` 分支:

```ts
case 'model-start': {
  const { entries } = sealStreaming(sealThinking(s.entries, e.ts));
  if (s.status !== 'idle') return { ...s, entries, status: 'running' }; // run 内续轮:不重插 run 条、不重置水位
  return {
    ...s,
    entries: [...entries, { key: `run:${entries.length}`, kind: 'run' as const, md: '', streaming: true as const, ts: e.ts }],
    status: 'running',
    turnTokensBase: 0,
  };
}
```

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/chat-reducer.test.ts`
Expected: PASS(含既有用例零回归)

- [ ] **Step 5: Commit**

```bash
git add gui/src/chat-reducer.ts gui/src/chat-reducer.test.ts
git commit -m "feat(gui): chat reducer run 边界条目——model-start 插入/done·error 封段计秒与统计透传(G11 §1.1)"
```

---

### Task 2: TipButton 基元 + 用户气泡钮图标化(含既有断言迁移)

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(TipButton 组件、UserEntryView 两钮图标化)
- Modify: `gui/src/app.css`(G11 段起步:`.sx-tip` Tooltip)
- Test: `gui/src/pages/Chat.test.tsx`(三处 title 查询迁移 + 注释更新)

**Interfaces:**
- Produces: `TipButton({ tip, label, icon, onClick, className }: { tip: string; label: string; icon: ReactNode; onClick?: () => void; className?: string }): JSX.Element`——Task 7/9/10/11 全部操作钮的唯一基元;CSS 类 `.sx-tip`(修饰类 `.sx-tip-right` 右对齐 Tooltip)。

- [ ] **Step 1: 迁移既有断言(先改测试,跑红)**

`gui/src/pages/Chat.test.tsx`:

① 文件头注释第 12 行 `.user-action[title=复制]` 改为 `.user-action[aria-label=Copy]`。
② `'用户条目渲染右胶囊'` 用例:`expect(entry.querySelector('button[title="Copy"]')).toBeTruthy();` → `expect(entry.querySelector('button[aria-label="Copy"]')).toBeTruthy();`
③ `'复制钮写入剪贴板…'` 用例:

```tsx
fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
expect(navigator.clipboard.writeText).toHaveBeenCalledWith('你好');
await waitFor(() => expect(document.querySelector('.entry-user .user-actions .sx-tip')?.getAttribute('data-tip')).toBe('Copied'));
```

(import 行补 `waitFor`。)

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: FAIL(aria-label 查询找不到——现钮是 title+文字)

- [ ] **Step 2: 实现 TipButton + 图标化**

`gui/src/pages/Chat.tsx`:

① import 补 `Check`, `History`(History 已有)、`X`(Task 11 用,此处一并)、`GitFork`、`Info`、`MessageSquare`、`AlertCircle`、`Brain`、`Maximize2` 中本任务用到的:`Check`。`import type { MutableRefObject, ReactNode }` 已有。

② `ToolIcon` 定义之后新增:

```tsx
/** 统一图标钮(G11 §8):纯图标 + data-tip Tooltip(视觉层)+ aria-label(可达性/查询锚)。
 *  不用原生 title;复制成功反馈由调用面换 icon/tip,本组件无状态 */
function TipButton({ tip, label, icon, onClick, className }: { tip: string; label: string; icon: ReactNode; onClick?: () => void; className?: string }): JSX.Element {
  return (
    <button
      type="button"
      className={className !== undefined ? `sx-tip ${className}` : 'sx-tip'}
      aria-label={label}
      data-tip={tip}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
```

③ `UserEntryView` 内,`user-actions` 两钮替换为(文字标签全部去掉,成功反馈=图标切 ✓ + data-tip 换文案):

```tsx
<div className="user-actions">
  <TipButton
    className="user-action"
    tip={copied === 'ok' ? t('Copied', '已复制') : copied === 'fail' ? t('Not copied', '未复制') : t('Copy', '复制')}
    label="Copy"
    icon={copied === 'ok' ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
    onClick={copy}
  />
  {fetchAnchors !== undefined && onRewind !== undefined && (
    <TipButton
      className="user-action"
      tip={t('Rewind to this turn', '回到此轮')}
      label="Rewind"
      icon={<History size={12} strokeWidth={1.75} aria-hidden="true" />}
      onClick={() => setRewindOpen((v) => !v)}
    />
  )}
</div>
```

(原 `user-action` 文字钮删除;`.user-actions` 容器结构不变。)

- [ ] **Step 3: CSS(app.css 末尾追加 G11 段)**

```css
/* ===== G11 会话流渲染升级(spec docs/superpowers/specs/2026-10-10-gui-chat-stream-rendering-design.md) ===== */
/* 统一图标钮+Tooltip(data-tip 视觉层,::after 浮现;0.3s 延迟防掠过闪现) */
.sx-tip { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: none; border-radius: var(--radius-sm); color: var(--fg-tertiary); }
.sx-tip:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 6%, transparent); }
.sx-tip::after {
  content: attr(data-tip);
  position: absolute; bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%);
  padding: 3px 8px; border-radius: var(--radius-sm);
  background: var(--surface-elevated); box-shadow: var(--elev-prominent);
  color: var(--fg-secondary); font-size: 11px; line-height: 1.4; white-space: nowrap;
  opacity: 0; pointer-events: none; z-index: 30;
  transition: opacity var(--dur-basic) var(--ease-enter) 0.3s;
}
.sx-tip:hover::after { opacity: 1; }
.sx-tip-right::after { left: auto; right: 0; transform: none; } /* 贴右缘钮(code-head/mermaid-actions)防裁切 */
```

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): 统一图标钮 TipButton+系统 Tooltip,user 气泡钮图标化(G11 §8)"
```

---

### Task 3: RunEntryView 状态行

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(RunEntryView + 条目分流接入)
- Modify: `gui/src/app.css`(G11 段追加 `.entry-run`)
- Test: `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 run 条目字段(`streaming`/`ts`/`seconds`);`chat.tokens`(既有 ChatState)。
- Produces: `runElapsed(seconds: number): string`、`fmtTokens(n: number): string`(Task 10 RunFooter 复用);测试助手 `flushed()`/`fire(e)`(本任务落,后续 GUI 测试复用)。

- [ ] **Step 1: 写失败测试**

`gui/src/pages/Chat.test.tsx`:import 行补 `act`(自 `@testing-library/react`)与 `import type { SessionEvent } from '../../../src/types';`;模块级(`mountChat` 旁)加助手:

```tsx
/** 播种落定:冲微任务使 sessionSnapshot 应答处理完毕(seeding 门开,后继 fire 直投 reducer) */
async function flushed(): Promise<void> {
  await act(async () => {});
}
/** 投递本会话帧(seq 恒 1——页面不过滤 seq,连接层职责) */
function fire(e: SessionEvent): void {
  act(() => sinkRef.current!.on(e, 1));
}
```

新增 describe:

```tsx
describe('run 状态行(G11 §1)', () => {
  it('model-start 后 .entry-run.live 显示 Working;done 封段后 .entry-run.sealed 显示 Worked for', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    expect(document.querySelector('.entry-run.live')?.textContent).toContain('Working');
    fire({ type: 'token', text: '答', ts: Date.now() });
    fire({ type: 'done', text: '答', ts: Date.now() + 34_000 });
    expect(document.querySelector('.entry-run.sealed')?.textContent).toContain('Worked for 34s');
  });

  it('live 行显示会话 tokens(usage 载荷续推,k 格式)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'usage', payload: { turnTotal: 8400 }, ts: Date.now() });
    expect(document.querySelector('.entry-run.live')?.textContent).toContain('8.4k tokens');
  });
});
```

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: FAIL(.entry-run 不存在)

- [ ] **Step 2: 实现 RunEntryView**

`gui/src/pages/Chat.tsx`,import 补 `Check`。`ToolIcon` 之后新增:

```tsx
/** 秒数格式:<60s 「34s」,≥60s 「2m 5s」(状态行/尾条共用) */
function runElapsed(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** tokens 格式:8400 → 8.4k tokens;840 → 840 tokens */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/** run 状态行(G11 §1.2):streaming=Working(旋转环+1s tick+会话 tokens;不经 memo——tick 自驱动);
 *  封段=✓ Worked for Xs 淡灰保留。种子历史无 run 条,重连后自下一轮 model-start 恢复(spec §0) */
function RunEntryView({ entry, tokens }: { entry: ChatEntry; tokens: number }): JSX.Element {
  const [, setTick] = useState(0);
  const streaming = entry.streaming === true;
  useEffect(() => {
    if (!streaming) return;
    const h = setInterval(() => setTick((v) => v + 1), 1_000);
    return () => clearInterval(h);
  }, [streaming]);
  if (!streaming) {
    return (
      <div className="entry entry-run sealed" aria-label="run summary">
        <Check size={12} strokeWidth={1.75} aria-hidden="true" />
        <span>{entry.seconds !== undefined ? t(`Worked for ${runElapsed(entry.seconds)}`, `已运行 ${runElapsed(entry.seconds)}`) : t('Worked', '已运行')}</span>
      </div>
    );
  }
  const elapsed = entry.ts !== undefined ? Math.max(0, Math.round((Date.now() - entry.ts) / 1000)) : 0;
  return (
    <div className="entry entry-run live" role="status" aria-label="run status">
      <span className="run-spinner" aria-hidden="true" />
      <span>{t('Working', '运行中')}</span>
      <span className="run-meta">{runElapsed(elapsed)}</span>
      <span className="run-meta">{fmtTokens(tokens)}</span>
    </div>
  );
}
```

条目分流(Chat 主组件渲染面),在 `entry.kind === 'tool'` 分支之前插:

```tsx
entry.kind === 'run' ? (
  <RunEntryView key={entry.key} entry={entry} tokens={chat.tokens} />
) : entry.kind === 'tool' ? (
```

- [ ] **Step 3: CSS(G11 段追加)**

```css
/* run 状态行(§1):live=spinner+运行中+耗时+tokens;sealed=✓ Worked for(子树替换即淡入) */
.entry-run { display: flex; align-items: center; gap: 6px; padding: 2px 8px; font-size: 12px; color: var(--fg-tertiary); }
.entry-run.live { color: var(--fg-secondary); }
.entry-run .run-meta { color: var(--fg-tertiary); font-variant-numeric: tabular-nums; }
.run-spinner { width: 10px; height: 10px; flex: none; border-radius: 50%; border: 1.5px solid var(--fg-tertiary); border-top-color: var(--fg); animation: sx-spin 1s linear infinite; }
@keyframes sx-fade-in { from { opacity: 0; } }
.entry-run.sealed svg, .entry-run.sealed span { animation: sx-fade-in var(--dur-relaxed) var(--ease-enter); }
```

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): run 状态行——Working 实时计时/Worked for 封段保留(G11 §1.2)"
```

---

### Task 4: 工具行 Input/Output 展开 + result 全文暂存 + 左对齐

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(`ToolCallInfo.result`、sink.on 两分支、ToolEntryView 展开面、grid 折叠壳)
- Modify: `gui/src/app.css`(G11 段追加)
- Test: `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: Task 2 `TipButton`(本任务未用钮,不引);既有 `ToolCallInfo`/`toolInfoOf`。
- Produces: `ToolCallInfo.result?: string`(Task 10 无关,仅为展开面数据);CSS 类 `.tool-body`/`.tool-body-inner`/`.tool-io`/`.io-label`/`.tool-io-pre`(Task 5 think-body 同构复用公式)。

- [ ] **Step 1: 写失败测试**

```tsx
describe('工具行展开 Input/Output(G11 §2)', () => {
  it('展开显示 input JSON 与 result 全文(md 只含首行)', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-call', text: 'exec', ts: Date.now(), payload: { callId: 'c1', input: { command: 'ls -la' } } });
    fire({ type: 'tool-result', text: 'file1\nfile2', ts: Date.now(), payload: { callId: 'c1' } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    const io = document.querySelector('.tool-io');
    expect(io?.textContent).toContain('"command"');
    expect(io?.textContent).toContain('file2');
  });

  it('result 先到 call 后到(乱序)同样配对全文', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'tool-result', text: 'out1\nout2', ts: Date.now(), payload: { callId: 'c9' } });
    fire({ type: 'tool-call', text: 'read', ts: Date.now(), payload: { callId: 'c9', input: { path: 'a.ts' } } });
    fireEvent.click(document.querySelector('.tool-summary')!);
    expect(document.querySelector('.tool-io')?.textContent).toContain('out2');
  });
});
```

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: FAIL(.tool-io 不存在)

- [ ] **Step 2: 实现**

① `ToolCallInfo` 增字段:

```ts
interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  /** tool-result 全文(sink.on 旁路暂存;乱序双到达合并;种子条无槽回落 md 首行) */
  result?: string;
}
```

② sink.on 的 `tool-call` 分支改(保留先到 result)与 `tool-result` 分支新增:

```ts
if (e.type === 'tool-call') {
  const cid = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
  if (cid !== '') {
    const raw = e.payload?.input;
    const input = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    setToolInputs((m) => ({ ...m, [cid]: { name: e.text ?? '', input, result: m[cid]?.result } }));
  }
}
if (e.type === 'tool-result') {
  const cid = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
  if (cid !== '') {
    const tool = typeof e.payload?.tool === 'string' ? e.payload.tool : '';
    setToolInputs((m) => ({
      ...m,
      [cid]: { name: m[cid]?.name ?? tool, input: m[cid]?.input ?? {}, result: e.text ?? '' },
    }));
  }
}
```

③ `ToolEntryView` 展开面重排(折叠壳 grid 化;write 分支原样包进壳;非 write 换 Input/Output 双段)。返回 JSX 整体替换为:

```tsx
return (
  <div className={`entry entry-tool${expanded ? ' open' : ''}`}>
    <button type="button" className="tool-summary" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
      <ToolIcon verb={verb} />
      <span className="tool-verb">{target !== undefined ? `${verb} ${target}` : verb}</span>
      {result !== '' && <span className="tool-result-inline"> · {result}</span>}
    </button>
    <div className={`tool-body${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
      <div className="tool-body-inner">
        {isWrite && info !== undefined ? (
          <div className="tool-detail">
            {/* path 钮与 diff 面原逻辑原样搬入(G8d 分流不变) */}
            {(onOpenDiff !== undefined || onOpenFile !== undefined) && (
              <button
                type="button"
                className="tool-path"
                title={onOpenDiff !== undefined && callId !== undefined ? '打开 diff 标签' : '在文件标签预览'}
                onClick={() => {
                  if (onOpenDiff !== undefined && callId !== undefined) onOpenDiff(callId, target!);
                  else onOpenFile?.(target!);
                }}
              >
                {target}
              </button>
            )}
            {diff !== undefined && diff !== null ? (
              <DiffPanel oldStr={diff.oldContent} newStr={diff.newContent} />
            ) : diff === null ? (
              <DiffPanel newStr={fallbackNew} />
            ) : (
              <>
                <div className="diff-loading" role="status">diff 加载中…</div>
                <DiffPanel newStr={fallbackNew} />
              </>
            )}
          </div>
        ) : (
          <div className="tool-io">
            {info !== undefined && Object.keys(info.input).length > 0 && (
              <>
                <div className="io-label">{t('Input', '输入')}</div>
                <pre className="tool-io-pre">{JSON.stringify(info.input, null, 2)}</pre>
              </>
            )}
            <div className="io-label">{t('Output', '输出')}</div>
            <pre className="tool-io-pre">{fullResult !== '' ? fullResult : t('(no result)', '(无结果)')}</pre>
          </div>
        )}
      </div>
    </div>
  </div>
);
```

组件体内补:`const fullResult = info?.result ?? result;`(seed 条 info 缺省回落 md 首行)。

- [ ] **Step 3: CSS(G11 段追加;含 §2 左对齐统一)**

```css
/* 条目左对齐统一(§2):正文/工具/思考同一 x 起点 */
.entry { padding: 4px 8px; }
.entry-tool { padding: 2px 8px; }
/* 工具行折叠壳:grid-rows 0fr→1fr 丝滑生长(§8) */
.tool-body { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--dur-relaxed) var(--ease-enter), opacity var(--dur-relaxed) var(--ease-enter); }
.entry-tool.open .tool-body { grid-template-rows: 1fr; opacity: 1; }
.tool-body-inner { min-height: 0; overflow: hidden; }
/* Input/Output 双段(§2):段头小标+各段 280px 内滚 */
.tool-io { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 2px; padding: 8px 10px; background: var(--surface-code); border-radius: var(--radius-md); }
.io-label { font-size: 11px; letter-spacing: 0.4px; text-transform: uppercase; color: var(--fg-tertiary); }
.tool-io-pre { margin: 0; max-height: 280px; overflow: auto; font: 12px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
/* write diff 面同加内滚(§2) */
.entry-tool .tool-detail .diff-cols { max-height: 280px; overflow: auto; }
```

- [ ] **Step 4: 跑绿(含 App.test.tsx 既有 tool 断言)**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx src/App.test.tsx`
Expected: PASS(App.test `.tool-summary` 含 read/ok 断言不受折叠壳影响——summary 行结构未动)

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): 工具行展开 Input/Output 双段内滚+result 全文暂存+条目左对齐(G11 §2)"
```

---

### Task 5: 思考行内联流动预览 + 展开吸底

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(ThinkingEntryView 重写)
- Modify: `gui/src/app.css`(G11 段追加)
- Test: `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 grid 折叠壳公式;既有 reasoning 事件投影(thinking 条)。
- Produces: CSS 类 `.thinking-preview`/`.think-body`/`.think-body-inner`/`.thinking-scroll`;无新导出。

- [ ] **Step 1: 写失败测试**

```tsx
describe('思考行(G11 §3)', () => {
  it('折叠预览示末个非空行;展开有 open 类与内滚容器', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'reasoning', text: '第一行\n第二行', ts: Date.now() });
    expect(document.querySelector('.thinking-preview')?.textContent).toBe('第二行');
    expect(document.querySelector('.think-body')).not.toBeNull();
    fireEvent.click(document.querySelector('.thinking-summary')!);
    expect(document.querySelector('.entry-thinking.open')).not.toBeNull();
    expect(document.querySelector('.thinking-scroll')).not.toBeNull();
    expect(document.querySelector('.thinking-detail')?.textContent).toContain('第一行');
  });

  it('Brain 图标在场', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'reasoning', text: '想', ts: Date.now() });
    expect(document.querySelector('.entry-thinking .thinking-summary svg')).not.toBeNull();
  });
});
```

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: FAIL(现实现无 preview/think-body/图标)

- [ ] **Step 2: 实现(ThinkingEntryView 整体替换)**

import 补 `Brain`。组件替换为:

```tsx
/** 思考链折叠行(G11 §3):折叠=Brain 图标+「思考中…/思考 Ns」+末行内联预览(尾锚定,新内容自右
 *  推入旧文左流=「往前流动」,左缘 mask 渐隐);展开=全文内滚容器(streaming 时 effect 逐帧吸底,
 *  直设 scrollTop 不平滑——逐 token 跟手)。展开/折叠 grid-rows 过渡(同工具行公式) */
const ThinkingEntryView = memo(function ThinkingEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streaming = entry.streaming === true;
  const lastLine = entry.md.split('\n').filter((l) => l.trim() !== '').at(-1) ?? '';
  useEffect(() => {
    if (open && streaming && scrollRef.current !== null) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [open, streaming, entry.md]);
  return (
    <div className={`entry entry-thinking${open ? ' open' : ''}`}>
      <button type="button" className="thinking-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronDown className="think-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
        <Brain size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="thinking-label">
          {streaming ? t('Thinking…', '思考中…') : entry.seconds !== undefined ? t(`Thought for ${entry.seconds}s`, `思考 ${entry.seconds}s`) : t('Thought', '思考')}
        </span>
        {!open && lastLine !== '' && <span className="thinking-preview">{lastLine}</span>}
      </button>
      <div className="think-body">
        <div className="think-body-inner">
          <div className="thinking-scroll" ref={scrollRef}>
            <pre className="thinking-detail">{entry.md}</pre>
          </div>
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 3: CSS(G11 段追加;`.entry-thinking` 左对齐已由 Task 4 的 padding 规则覆盖一半,此处覆盖旧版 `padding: 0 8px`)**

```css
/* 思考行(§3):预览尾锚定(direction:rtl 流动)+左缘渐隐;展开 grid-rows+320px 内滚吸底 */
.entry-thinking { padding: 2px 8px; }
.thinking-summary { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; text-align: left; padding: 2px 6px; border-radius: var(--radius-sm); color: var(--fg-tertiary); font-size: 12px; }
.thinking-summary:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); color: var(--fg-secondary); }
.think-chevron { flex: none; transition: transform var(--dur-basic) var(--ease-enter); }
.entry-thinking.open .think-chevron { transform: rotate(180deg); }
.thinking-label { flex: none; }
.thinking-preview { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; direction: rtl; text-align: left; -webkit-mask-image: linear-gradient(90deg, transparent, #000 28px); mask-image: linear-gradient(90deg, transparent, #000 28px); }
.think-body { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--dur-relaxed) var(--ease-enter), opacity var(--dur-relaxed) var(--ease-enter); }
.entry-thinking.open .think-body { grid-template-rows: 1fr; opacity: 1; }
.think-body-inner { min-height: 0; overflow: hidden; }
.thinking-scroll { max-height: 320px; overflow-y: auto; margin-top: 4px; }
.thinking-scroll .thinking-detail { margin: 0; }
```

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx src/App.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): 思考行内联流动预览+展开吸底内滚+Brain 图标(G11 §3)"
```

---

### Task 6: notice/error 系统行图标

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(systemIconOf + ChatEntryView 结构化)
- Modify: `gui/src/app.css`(G11 段追加)
- Test: `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: lucide `Info`/`Bot`/`MessageSquare`/`AlertCircle`(Task 2 已并入 import 清单则免重复)。
- Produces: `systemIconOf(entry: ChatEntry): ReactNode`(null=无图标);`ChatEntryView({ entry, footer? })`——footer 参数本任务预留(Task 10 消费);CSS 类 `.entry-md`/`.entry-icon`。

- [ ] **Step 1: 写失败测试**

```tsx
describe('系统行图标(G11 §4)', () => {
  it('notice 通用=Info/委派 ✻=Bot/agent 消息=MessageSquare,error=AlertCircle——均 .entry-icon 前置', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'notice', text: 'hello', ts: Date.now() });
    expect(document.querySelector('.entry-notice .entry-icon svg')).not.toBeNull();
    expect(document.querySelector('.entry-notice')?.textContent).toContain('hello');
    fire({ type: 'delegation-started', payload: { label: 'dev', delegationId: 'd1' }, ts: Date.now() });
    expect(document.querySelectorAll('.entry-notice .entry-icon').length).toBe(2);
    fire({ type: 'agent-message', payload: { from: 'boss', to: 'dev', text: 'hi' }, ts: Date.now() });
    expect(document.querySelectorAll('.entry-notice .entry-icon').length).toBe(3);
    fire({ type: 'error', text: 'boom', ts: Date.now() });
    expect(document.querySelector('.entry-error .entry-icon svg')).not.toBeNull();
  });
});
```

(委派/agent 与 Info 图标同尺寸同位,类名无差别——以数量断言三种 notice 均有图标;形状差异由 systemIconOf 分支保证,不按 svg 名断言。)

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx`
Expected: FAIL(.entry-icon 不存在)

- [ ] **Step 2: 实现**

① `ChatEntryView` 之前新增:

```tsx
/** 系统行图标(G11 §4):error=AlertCircle;notice 按 md 形态分流(委派 ✻=Bot/agent 消息 [a → b]
 *  =MessageSquare/通用=Info)。md 原文不动,纯前置装饰 */
function systemIconOf(entry: ChatEntry): ReactNode {
  if (entry.kind === 'error') return <AlertCircle size={12} strokeWidth={1.75} aria-hidden="true" />;
  if (entry.kind !== 'notice') return null;
  if (entry.md.startsWith('✻')) return <Bot size={12} strokeWidth={1.75} aria-hidden="true" />;
  if (/^\[[^\]]+ → [^\]]+\]/.test(entry.md)) return <MessageSquare size={12} strokeWidth={1.75} aria-hidden="true" />;
  return <Info size={12} strokeWidth={1.75} aria-hidden="true" />;
}
```

② `ChatEntryView` 替换(footer 预留;光标移入 .entry-md 保内联):

```tsx
const ChatEntryView = memo(function ChatEntryView({ entry, footer }: { entry: ChatEntry; footer?: ReactNode }): JSX.Element {
  const icon = systemIconOf(entry);
  return (
    <div className={`entry entry-${entry.kind}${entry.streaming === true ? ' streaming' : ''}`}>
      <div className={`entry-md${icon !== null ? ' has-icon' : ''}`}>
        {icon !== null && <span className="entry-icon">{icon}</span>}
        <div className="entry-md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{entry.md}</ReactMarkdown>
          {entry.streaming === true && <span className="sx-stream-cursor" aria-hidden="true" />}
        </div>
      </div>
      {footer}
    </div>
  );
});
```

- [ ] **Step 3: CSS(G11 段追加)**

```css
/* 系统行图标(§4):图标前置列+md 体;末元素 margin 收口随之内移一层 */
.entry-md.has-icon { display: flex; align-items: flex-start; gap: 6px; }
.entry-icon { flex: none; margin-top: 2px; color: var(--fg-tertiary); }
.entry-md-body { min-width: 0; flex: 1; }
.entry-md-body > :last-child { margin-bottom: 0; }
```

同时**修改既有规则**:`.entry > :last-child { margin-bottom: 0; }`(G8d 段,约 388 行)改为仅对非结构化条目生效——直接追加覆盖即可(G11 段内):`.entry > .entry-md:last-child > .entry-md-body > :last-child { margin-bottom: 0; }`,并保留原规则不动(无冲突)。

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx src/App.test.tsx src/e2e.test.ts`
Expected: PASS(App.test `.sx-stream-cursor` 断言为后代查询,光标移层不影响;`.entry-notice` 文本断言不受图标影响)

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): notice/error 系统行前置图标(委派/agent 消息分流)(G11 §4)"
```

---

### Task 7: CodeBlock(hljs 高亮 + 头部复制)

**Files:**
- Modify: `gui/src/highlight.ts`(导出 `highlightByLang`)
- Create: `gui/src/highlight.test.ts`
- Modify: `gui/src/pages/Chat.tsx`(CodeBlock 组件 + mdComponents.pre 分流)
- Modify: `gui/src/app.css`(G11 段追加 + hljs 令牌选择器泛化)
- Test: `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: Task 2 `TipButton`;highlight.js 既有依赖。
- Produces: `highlightByLang(code: string, lang?: string): string`(异常回落转义原文);`CodeBlock({ code, lang }: { code: string; lang?: string })`(memo);Task 9 将 mdComponents 的 mermaid 分支换为 MermaidBlock。

- [ ] **Step 1: highlight.ts 失败测试**

Create `gui/src/highlight.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { highlightByLang } from './highlight';

/** G11 §5.2:围栏语言直给 hljs;未知语言/异常回落转义原文(注入面纪律) */

describe('highlightByLang', () => {
  it('已知语言产出 hljs 令牌 span', () => {
    const html = highlightByLang('const a = 1;', 'ts');
    expect(html).toContain('hljs-keyword');
  });

  it('未知语言回落 plaintext(无注入面:HTML 原文被转义)', () => {
    const html = highlightByLang('<script>alert(1)</script>', 'nope-lang');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('lang 缺省 plaintext;异常安全(不抛)', () => {
    expect(() => highlightByLang('x')).not.toThrow();
    expect(highlightByLang('x')).toBe('x');
  });
});
```

Run: `cd gui && npx vitest run src/highlight.test.ts`
Expected: FAIL(highlightByLang 未导出)

- [ ] **Step 2: 实现 highlightByLang**

`gui/src/highlight.ts` 末尾追加:

```ts
/** 围栏语言 → 高亮 HTML(G11 §5.2,Chat CodeBlock 消费):语言名直查(hljs 全量包,表外/未注册
 *  回落 plaintext);异常防御性回落转义原文——与 highlightCode 同注入面纪律 */
export function highlightByLang(code: string, lang?: string): string {
  try {
    const name = lang !== undefined && hljs.getLanguage(lang) !== undefined ? lang : 'plaintext';
    return hljs.highlight(code, { language: name }).value;
  } catch {
    return escapeHtml(code);
  }
}
```

Run: `cd gui && npx vitest run src/highlight.test.ts` — Expected: PASS

- [ ] **Step 3: Chat 层失败测试**

`gui/src/pages/Chat.test.tsx`:

```tsx
describe('代码块 CodeBlock(G11 §5.2)', () => {
  it('围栏代码卡:语言标+hljs 高亮+复制写剪贴板', async () => {
    mountChat([{ seq: 1, ts: DAY1, kind: 'assistant', md: ['```ts', 'const a = 1;', '```'].join('\n') }]);
    await waitFor(() => expect(document.querySelector('.code-block')).not.toBeNull());
    expect(document.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(document.querySelector('.code-block code .hljs-keyword')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'copy code' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1;');
  });
});
```

(import 补 `waitFor`——Task 2 已补则免。)

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx` — Expected: FAIL

- [ ] **Step 4: 实现 CodeBlock + pre 分流**

`gui/src/pages/Chat.tsx`:

① import 补:`import { highlightByLang } from '../highlight';` 与 lucide `Check`(Task 2 已加)。

② `mdComponents` 整体替换(mermaid 分支暂维持现 `<Mermaid>` 直连,Task 9 换 MermaidBlock):

```tsx
/** markdown 渲染组件面(G11 §5):pre 分流——mermaid 围栏→Mermaid(懒加载/失败回落,Task 9 起
 *  带放大/复制);其余围栏→CodeBlock(hljs+头部);table→横滚容器(§5.3) */
const mdComponents = {
  pre(props: { children?: ReactNode }) {
    const child = Array.isArray(props.children) ? props.children[0] : props.children;
    const el = child as { props?: { className?: string; children?: unknown } } | null;
    const cls = el?.props?.className ?? '';
    const raw = el?.props?.children;
    const code = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(String).join('') : String(raw ?? '');
    if (cls.includes('language-mermaid')) return <Mermaid chart={code} />;
    const m = /language-([\w-]+)/.exec(cls);
    return <CodeBlock code={code} lang={m?.[1]} />;
  },
  table(props: { children?: ReactNode }) {
    return (
      <div className="table-wrap">
        <table>{props.children}</table>
      </div>
    );
  },
} as const;

/** 代码块卡(G11 §5.2):surface-code 面+头部栏(语言名+复制钮 hover 浮现)+hljs 高亮;
 *  代码禁折行(white-space:pre+横滚)——排版错乱主因即旧版强折行。memo 按 code+lang,
 *  流式增量帧仅末块重算 */
const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const html = useMemo(() => highlightByLang(code, lang), [code, lang]);
  const copy = (): void => {
    navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => undefined,
    );
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang ?? ''}</span>
        <TipButton
          className="sx-tip-right"
          tip={copied ? t('Copied', '已复制') : t('Copy', '复制')}
          label="copy code"
          icon={copied ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
          onClick={copy}
        />
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
});
```

(`useMemo` 需入 react import;`TipButton`/`Check` 来自 Task 2。)

- [ ] **Step 5: CSS**

G11 段追加:

```css
/* 代码块卡(§5.2):禁折行横滚+头部栏;复制钮 hover 浮现 */
.code-block { margin: 8px 0; background: var(--surface-code); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow: hidden; }
.code-head { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 6px 0 12px; }
.code-lang { font-family: var(--font-mono); font-size: 11px; color: var(--fg-tertiary); }
.code-head .sx-tip { opacity: 0; transition: opacity var(--dur-basic) var(--ease-enter); }
.code-block:hover .code-head .sx-tip, .code-head .sx-tip:focus-visible { opacity: 1; }
.code-block pre { margin: 0; padding: 12px 14px; background: transparent; border: none; border-radius: 0; overflow-x: auto; }
.code-block pre code { display: block; font: 12.5px/1.7 var(--font-mono); white-space: pre; overflow-wrap: normal; }
/* hljs 令牌泛化(原 .files-view 前缀收敛为全局——hljs 类只在代码上下文出现) */
```

同文件**修改既有规则**(约 487-491 行):`.files-view .hljs-keyword, …` 五行选择器去掉 `.files-view ` 前缀(变全局 `.hljs-keyword, .hljs-selector-tag, .hljs-built_in { … }` 等)。

- [ ] **Step 6: 跑绿**

Run: `cd gui && npx vitest run src/highlight.test.ts src/pages/Chat.test.tsx src/App.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add gui/src/highlight.ts gui/src/highlight.test.ts gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): CodeBlock 代码卡——hljs 高亮/语言标/复制钮,禁折行横滚(G11 §5.2)"
```

---

### Task 8: 表格容器 + 正文排版定靶

**Files:**
- Modify: `gui/src/app.css`(G11 段追加排版规则;覆盖 G9-B3c 旧规则)
- Test: `gui/src/pages/Chat.test.tsx`(table 组件已在 Task 7 落——此处补容器断言;排版为纯 CSS,以样式规则落码,DOM 断言仅 wrap 容器)

**Interfaces:**
- Consumes: Task 7 `mdComponents.table`(已产 `.table-wrap`)。
- Produces: CSS 类 `.table-wrap` 及 §5.1 排版规则;无 TS 导出。

- [ ] **Step 1: 写失败测试**

```tsx
describe('表格容器(G11 §5.3)', () => {
  it('md 表格包进 .table-wrap 横滚容器', async () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    mountChat([{ seq: 1, ts: DAY1, kind: 'assistant', md }]);
    await waitFor(() => expect(document.querySelector('.table-wrap table')).not.toBeNull());
  });
});
```

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx` — Expected: FAIL(Task 7 已落 table 组件则此步绿——若绿,直接进 Step 3 补 CSS;组件与断言在 Task 7 已对齐,此处以 CSS 为交付物)

- [ ] **Step 2: (组件面无改——table 分流已随 Task 7;此步为 CSS 交付)**

G11 段追加:

```css
/* 正文排版定靶(§5.1):行距/标题阶梯/行内码/列表/hr/链接/图片 */
.entry { line-height: 1.65; }
.entry h1 { font-size: 17px; }
.entry h2 { font-size: 15.5px; }
.entry h3 { font-size: 14px; }
.entry h4 { font-size: 13px; }
.entry h1, .entry h2, .entry h3, .entry h4 { line-height: 1.4; font-weight: 600; margin: 16px 0 8px; }
.entry :not(pre) > code { font-size: 12px; background: color-mix(in srgb, var(--fg) 6%, transparent); border-radius: var(--radius-xs); padding: 1px 5px; }
.entry li { margin: 3px 0; }
.entry li::marker { color: var(--fg-secondary); }
.entry hr { border: none; border-top: 1px solid var(--border-subtle); margin: 12px 0; }
.entry img { max-width: 100%; border-radius: var(--radius-md); }
/* 表格(§5.3):横滚圆角容器+表头底+只留横线+斑马纹 */
.table-wrap { margin: 8px 0; overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.table-wrap table { margin: 0; width: max-content; min-width: 50%; border-collapse: collapse; font-size: 12px; }
.table-wrap th { background: var(--surface-soft); font-weight: 600; text-align: left; }
.table-wrap th, .table-wrap td { padding: 6px 12px; border: none; border-bottom: 1px solid var(--border-subtle); }
.table-wrap tr:last-child td { border-bottom: none; }
.table-wrap tbody tr:nth-child(even) { background: color-mix(in srgb, var(--fg) 2%, transparent); }
```

- [ ] **Step 3: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx` — Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): 正文排版定靶+表格横滚容器样式(G11 §5.1/§5.3)"
```

---

### Task 9: MermaidBlock(放大/复制/lightbox)

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(MermaidBlock 组件;mdComponents.pre mermaid 分支换接)
- Modify: `gui/src/app.css`(G11 段追加)
- Test: `gui/src/pages/Chat.test.tsx`(该文件 mermaid 已 mock 为加载失败——走回落态,钮与 lightbox 仍可断言,契合降级纪律)

**Interfaces:**
- Consumes: 既有 `Mermaid` 组件(懒加载/5s 竞速/回落原文);Task 2 `TipButton`。
- Produces: `MermaidBlock({ chart }: { chart: string })`。

- [ ] **Step 1: 写失败测试**

```tsx
describe('MermaidBlock(G11 §5.4)', () => {
  it('容器带放大/复制钮;放大开 lightbox,Esc 关闭', async () => {
    mountChat([{ seq: 2, ts: DAY1, kind: 'assistant', md: ['图:', '', '```mermaid', 'graph TD; A-->B', '```'].join('\n') }]);
    await screen.findByText(/graph TD; A-->/, {}, { timeout: 5_000 });
    fireEvent.click(screen.getByRole('button', { name: 'zoom mermaid' }));
    expect(document.querySelector('.mermaid-lightbox')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.mermaid-lightbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'copy mermaid' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('graph TD; A-->B');
  });
});
```

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx` — Expected: FAIL(zoom mermaid 钮不存在)

- [ ] **Step 2: 实现**

`gui/src/pages/Chat.tsx`(import 已有 Mermaid;补 `Maximize2`):

```tsx
/** Mermaid 容器(G11 §5.4):hover 显放大/复制钮;放大=lightbox(遮罩 contain 居中,点击/Esc 关,
 *  Esc 监听随开关挂卸);复制=源码。回落态(fallback/pending)两钮同样在场——降级不失功能 */
function MermaidBlock({ chart }: { chart: string }): JSX.Element {
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setZoom(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [zoom]);
  return (
    <div className="mermaid-block">
      <Mermaid chart={chart} />
      <div className="mermaid-actions">
        <TipButton className="sx-tip-right" tip={t('Zoom', '放大')} label="zoom mermaid" icon={<Maximize2 size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setZoom(true)} />
        <TipButton
          className="sx-tip-right"
          tip={t('Copy', '复制')}
          label="copy mermaid"
          icon={<Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => {
            navigator.clipboard?.writeText(chart).then(() => undefined, () => undefined);
          }}
        />
      </div>
      {zoom && (
        <div className="mermaid-lightbox" role="dialog" aria-label={t('Mermaid preview', 'Mermaid 预览')} onClick={() => setZoom(false)}>
          <div className="mermaid-lightbox-body" onClick={(e) => e.stopPropagation()}>
            <Mermaid chart={chart} />
          </div>
        </div>
      )}
    </div>
  );
}
```

`mdComponents.pre` 的 mermaid 分支:`return <Mermaid chart={code} />;` → `return <MermaidBlock chart={code} />;`

- [ ] **Step 3: CSS(G11 段追加)**

```css
/* mermaid 容器(§5.4):hover 浮现钮;lightbox 淡入+轻缩放,contain 居中 */
.mermaid-block { position: relative; }
.mermaid-actions { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; opacity: 0; transition: opacity var(--dur-basic) var(--ease-enter); }
.mermaid-block:hover .mermaid-actions, .mermaid-actions:focus-within { opacity: 1; }
.mermaid-lightbox { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.65); display: flex; align-items: center; justify-content: center; animation: sx-fade-in var(--dur-basic) var(--ease-enter); cursor: zoom-out; }
.mermaid-lightbox-body { max-width: 92vw; max-height: 92vh; overflow: auto; padding: 16px; background: var(--surface-elevated); border-radius: var(--radius-lg); box-shadow: var(--elev-prominent); cursor: default; }
@keyframes sx-zoom-in { from { opacity: 0; transform: scale(0.96); } }
.mermaid-lightbox-body { animation: sx-zoom-in var(--dur-relaxed) var(--ease-enter); }
```

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): MermaidBlock 放大 lightbox/复制源码,hover 浮现钮(G11 §5.4)"
```

---

### Task 10: run 尾部操作条(复制/分叉 + steps/tokens/完成时间)

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(RunFooter 组件、末条投影、ChatEntryView footer 接入)
- Modify: `gui/src/app.css`(G11 段追加)
- Test: `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: Task 1 run 条目字段(`steps`/`tokens`/`endedTs`);Task 2 `TipButton`;Task 3 `fmtTokens`;Task 6 `ChatEntryView` 的 `footer` 参数;既有 `onFork` prop。
- Produces: `RunFooter({ text, run, onFork }: { text: string; run: ChatEntry | undefined; onFork?: () => void })`;lucide `GitFork` import。

- [ ] **Step 1: 写失败测试**

```tsx
describe('run 尾部操作条(G11 §6)', () => {
  it('末条正文下挂条:复制/fork 钮与 steps/tokens/时间', async () => {
    const onFork = vi.fn();
    render(<Chat conn={connOf([])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} onFork={onFork} />);
    await flushed();
    const now = Date.now();
    fire({ type: 'model-start', ts: now });
    fire({ type: 'token', text: '答', ts: now });
    fire({ type: 'done', text: '答', ts: now, payload: { steps: 12, tokensUsed: 8400 } });
    const footer = document.querySelector('.run-footer');
    expect(footer?.textContent).toContain('12 steps');
    expect(footer?.textContent).toContain('8.4k tokens');
    fireEvent.click(screen.getByRole('button', { name: 'fork session' }));
    expect(onFork).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'copy reply' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('答');
  });

  it('run 仍在跑(流尾 streaming)不挂条', async () => {
    mountChat([]);
    await flushed();
    fire({ type: 'model-start', ts: Date.now() });
    fire({ type: 'token', text: '写一半', ts: Date.now() });
    expect(document.querySelector('.run-footer')).toBeNull();
  });
});
```

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx` — Expected: FAIL

- [ ] **Step 2: 实现**

① import 补 lucide `GitFork`。

② `ChatEntryView` 之后新增:

```tsx
/** run 尾部操作条(G11 §6,对标 Codex 回复工具行):复制该条 md/fork 新会话 + 封段统计
 *  (steps·tokens·HH:mm,数据缺省逐项省略)。常显淡灰(截图裁定),钮 hover 提亮 */
function RunFooter({ text, run, onFork }: { text: string; run: ChatEntry | undefined; onFork?: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  const time = run?.endedTs !== undefined ? new Date(run.endedTs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : undefined;
  return (
    <div className="run-footer">
      <TipButton
        tip={copied ? t('Copied', '已复制') : t('Copy', '复制')}
        label="copy reply"
        icon={copied ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
        onClick={copy}
      />
      {onFork !== undefined && <TipButton tip={t('Fork', '分叉')} label="fork session" icon={<GitFork size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={onFork} />}
      <span className="run-stats">
        {run?.steps !== undefined && <span>{`${run.steps} steps`}</span>}
        {run?.tokens !== undefined && <span>{fmtTokens(run.tokens)}</span>}
        {time !== undefined && <span>{time}</span>}
      </span>
    </div>
  );
}
```

③ 末条投影(Chat 主组件,`groupEntriesByDay` 调用之前):

```tsx
/** §6 末条投影:assistant 条目其后最近的 run 条目已封段 → 该条挂操作条(run 条目在活动之前,
 *  元数据向后取);流尾 assistant 且 status=idle 亦挂(防御面,run 条缺失时元数据缺省省略)。
 *  memo 纪律:仅 run 末条携带 footer prop,其余条目 footer=undefined 恒稳定——流式零额外重渲染 */
const runFooterByEntry = new Map<string, ChatEntry>();
let lastSealedAssistant: ChatEntry | null = null;
for (const e of chat.entries) {
  if (e.kind === 'assistant' && e.streaming !== true) lastSealedAssistant = e;
  else if (e.kind === 'run' && e.streaming !== true && lastSealedAssistant !== null) {
    runFooterByEntry.set(lastSealedAssistant.key, e);
    lastSealedAssistant = null;
  }
}
if (lastSealedAssistant !== null && chat.status === 'idle') runFooterByEntry.set(lastSealedAssistant.key, lastSealedAssistant);
```

④ 分流中 assistant 分支替换:

```tsx
) : entry.kind === 'assistant' || entry.kind === 'notice' || entry.kind === 'error' ? (
  <ChatEntryView
    key={entry.key}
    entry={entry}
    footer={runFooterByEntry.has(entry.key) ? <RunFooter text={entry.md} run={runFooterByEntry.get(entry.key)} onFork={onFork} /> : undefined}
  />
) : (
```

(原 else 分支 `ChatEntryView` 兜底改为 assistant/notice/error 显式分支——run/user/tool/thinking 已各有分支。)

- [ ] **Step 3: CSS(G11 段追加)**

```css
/* run 尾部操作条(§6):常显淡灰,钮 hover 提亮;统计 tabular-nums 右靠 */
.run-footer { display: flex; align-items: center; gap: 2px; margin-top: 4px; }
.run-footer .sx-tip { color: var(--fg-tertiary); }
.run-stats { display: inline-flex; gap: 10px; margin-left: auto; font-size: 11px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
```

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx src/App.test.tsx`
Expected: PASS(footer 仅挂 run 末条,其余条目 footer undefined——memo 不破)

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): run 尾部操作条——复制/分叉钮+steps·tokens·完成时间(G11 §6)"
```

---

### Task 11: 用户气泡编辑卡

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(submitText 抽取;UserEntryView 编辑态 + `onSend` prop)
- Modify: `gui/src/app.css`(G11 段追加)
- Test: `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: 既有 `appendUserMessage`/`conn.sessionSteer`/`conn.runCommand`/`conn.sessionSubmit`;Task 2 `TipButton`;lucide `X`/`ArrowUp`(ArrowUp 已 import)。
- Produces: `submitText(text: string): void`(Chat 内 useCallback;composer `send()` 改经它);`UserEntryView` 新 prop `onSend?: (text: string) => void`;aria-label 锚:`Edit`/`edit message`/`cancel edit`/`send edit`。

- [ ] **Step 1: 写失败测试**

```tsx
describe('用户气泡编辑卡(G11 §7)', () => {
  it('编辑:预填原文;发送=新消息(sessionSubmit+新回显条);Esc 取消回气泡', async () => {
    const sessionSubmit = vi.fn(() => Promise.resolve());
    const conn = connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '> 你好' }]);
    (conn as unknown as Record<string, unknown>).sessionSubmit = sessionSubmit;
    render(<Chat conn={conn} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await screen.findByText('你好');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'edit message' }) as HTMLTextAreaElement;
    expect(box.value).toBe('你好');
    fireEvent.change(box, { target: { value: '你好,再来一次' } });
    fireEvent.click(screen.getByRole('button', { name: 'send edit' }));
    expect(sessionSubmit).toHaveBeenCalledWith('s1', '你好,再来一次');
    await screen.findAllByText('你好,再来一次');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'edit message' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'edit message' })).toBeNull();
  });
});
```

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx` — Expected: FAIL(Edit 钮不存在)

- [ ] **Step 2: 实现**

① Chat 主组件,`send` 抽取(`send` 改薄壳):

```tsx
/** §7 提交路径单点(idle→submit/running→steer/plan→/plan):composer 与编辑卡共用。
 *  本地回显新条,失败倒 error 条;空文本忽略 */
const submitText = useCallback(
  (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    setChat((c) => appendUserMessage(c, trimmed));
    let req: Promise<void>;
    if (running) req = conn.sessionSteer(sessionId, trimmed);
    else if (sessMode === 'plan') req = conn.runCommand(sessionId, `/plan ${trimmed}`);
    else req = conn.sessionSubmit(sessionId, trimmed);
    void req.catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  },
  [conn, sessionId, running, sessMode],
);

/** Enter 分流:idle 提交 / running 插话;本地 user 回显(`> text`),失败倒 error 条 */
const send = (): void => {
  const text = input.trim();
  if (text === '') return;
  setInput('');
  submitText(text);
};
```

② 渲染面 user 分支配 `onSend`:

```tsx
<UserEntryView key={entry.key} entry={entry} onSend={submitText} />
```

③ `UserEntryView`:props 增 `onSend?: (text: string) => void`;组件体内:

```tsx
const [editing, setEditing] = useState(false);
const [draft, setDraft] = useState('');
const openEdit = (): void => {
  setDraft(entry.md.replace(/^> ?/gm, ''));
  setEditing(true);
};
const sendEdit = (): void => {
  const text = draft.trim();
  setEditing(false);
  if (text !== '') onSend?.(text);
};
```

返回 JSX:`editing === true` 时整卡替换(气泡与 actions 不渲染):

```tsx
if (editing) {
  return (
    <div className="entry entry-user">
      <div className="user-edit-card">
        <textarea
          aria-label="edit message"
          className="user-edit-input"
          autoFocus
          value={draft}
          rows={Math.min(6, Math.max(1, (draft.match(/\n/g) ?? []).length + 1))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendEdit();
            }
          }}
        />
        <div className="user-edit-foot">
          <TipButton tip={t('Cancel', '取消')} label="cancel edit" icon={<X size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setEditing(false)} />
          <button type="button" className="user-edit-send" aria-label="send edit" title={t('Send', '发送')} onClick={sendEdit}>
            <ArrowUp size={14} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

气泡分支 `user-actions` 内追加编辑钮(复制钮之后):

```tsx
{onSend !== undefined && (
  <TipButton className="user-action" tip={t('Edit', '编辑')} label="Edit" icon={<PenLine size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={openEdit} />
)}
```

(PenLine 已在 import 清单。)

- [ ] **Step 3: CSS(G11 段追加)**

```css
/* 用户编辑卡(§7):composer 同款浮卡(elevated+radius-composer+海拔),占满流区宽 */
.user-edit-card { display: flex; flex-direction: column; gap: 6px; width: 100%; background: var(--surface-elevated); border-radius: var(--radius-composer); box-shadow: var(--elev-composer); padding: 12px 14px 10px; animation: sx-fade-in var(--dur-basic) var(--ease-enter); }
.user-edit-input { width: 100%; min-height: 44px; background: transparent; border: none; outline: none; color: var(--fg); font: inherit; resize: none; }
.user-edit-input::placeholder { color: var(--fg-tertiary); opacity: 0.6; }
.user-edit-foot { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.user-edit-send { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; padding: 0; border: none; border-radius: 9999px; background: var(--fg); color: var(--fg-on-solid); transition: background var(--dur-basic) var(--ease-enter); }
.user-edit-send:hover { background: color-mix(in srgb, var(--fg) 88%, var(--surface)); }
```

- [ ] **Step 4: 跑绿**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx src/App.test.tsx`
Expected: PASS(App.test composer 提交路径用例不受抽取影响——行为等价)

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): 用户气泡编辑卡——composer 同款浮卡/发送=新消息/Esc 取消(G11 §7)"
```

---

### Task 12: 动效收口 + 全量验收

**Files:**
- Modify: `gui/src/app.css`(G11 段收尾:入场动效等)
- Test: 全量(无新测试文件;回归验证)

**Interfaces:**
- Consumes: 前序全部任务的类名与 `sx-fade-in`/`sx-zoom-in` keyframes。
- Produces: 无新类;`.chat .entry` 入场动画与 reduced-motion 复核。

- [ ] **Step 1: CSS 收尾(G11 段追加)**

```css
/* 新条目入场(§8):淡入+4px 上移,每条目挂载一次(key 稳定,流式更新不重触发) */
@keyframes sx-entry-in { from { opacity: 0; transform: translateY(4px); } }
.chat .entry { animation: sx-entry-in 0.2s var(--ease-enter); }
/* 状态行/工具行等已各自带过渡;此处收口:动效一律走 token 曲线,无额外 JS */
```

(reduced-motion 由既有全局 `@media (prefers-reduced-motion: reduce)` 覆盖——不新增代码,复核即可。)

- [ ] **Step 2: 既有契约回归扫描**

Run: `cd gui && grep -n 'title="Copy"' src/pages/Chat.test.tsx`
Expected: 无输出(title 查询已全部迁移)

- [ ] **Step 3: 全量验证**

Run: `cd gui && npx tsc -p . --noEmit && npx vitest run`
Expected: tsc 零错误;vitest 全绿(Chat/Chat-reducer/highlight/App/e2e 全部)

- [ ] **Step 4: 手动双主题抽查(spec §10)**

Run: `npm run dev`(gui)后浏览器过一遍:`npm run dev` 启 daemon+gui,核对 §5 定靶表(代码块横滚/表格斑马/标题阶梯)、暗/亮主题各一遍、思考预览流动、lightbox、编辑卡。

- [ ] **Step 5: Commit**

```bash
git add gui/src/app.css
git commit -m "feat(gui): 新条目入场动效收口,G11 全量验收通过(G11 §8/§10)"
```

---

## 自审记录(writing-plans §Self-Review)

- **Spec 覆盖**:§1.1→Task1;§1.2→Task3;§2→Task4;§3→Task5;§4→Task6;§5.1/5.3→Task8;§5.2→Task7;§5.4→Task9;§6→Task10;§7→Task11;§8→Task2(CSS)+各任务 CSS+Task12;§9 降级→Task7(escapeHtml 回落)/Task9(mermaid 回落态钮在场);§10→Task12;§11 批序=任务序 1-12。无缺口。
- **占位符扫描**:无 TBD/TODO/「类似 Task N」;全部代码步骤含可执行代码,Task 1 Step 3 仅有最终实现(无弃用占位)。
- **类型一致性**:`ChatEntry` 新字段(steps/tokens/endedTs)Task1 定义=Task3/10 消费;`TipButton` 签名 Task2 定义=7/9/10/11 调用;`fmtTokens`/`runElapsed` Task3 定义=Task10 复用;`highlightByLang` Task7 定义与调用一致;`footer` 参数 Task6 预留=Task10 消费;aria-label 锚(Edit/edit message/cancel edit/send edit/copy code/copy reply/fork session/zoom mermaid/copy mermaid)定义与断言一一对应。
