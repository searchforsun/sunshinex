# 模型驱动压缩摘要（Model-Driven Compaction Summary）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 压缩摘要由当前会话模型按六要素模板（Goal/Constraints/Progress/Verified/Open/Rationale）一次 complete() 生成，模型失败自动回退现有确定性截断；reactor 自动压缩与 TUI `/compact` 共用压缩协调单点，`/compact` 补链参与并对齐折链语义。

**Architecture:** 方案 A——确定性选块（`window.compact`）零改动保留为回退底线，摘要生成换引擎：新增 summarizer 接缝（六要素双语 prompt + 一次 complete + 预算二分截断 + provider 门禁），`applyCompaction` 内消化「模型成功→模型正文；失败/未传→确定性 join」分叉；`runCompaction` 收敛「选块 → 摘要 → 重注入 → 折链」序列供两入口共用；模型经既有 `deps.model`（reactor 侧为 run 内已路由 adapter，精确「当前会话模型」）与 `harness.model`（/compact 侧）流动，零新装配面。

**Tech Stack:** TypeScript strict + node:test（CommonJS）；零新第三方依赖。

## Global Constraints

- checksum 锚定选中块输入（`sha256(JSON.stringify(chunks))` 前 16 hex）；`[Compacted summary checksum=…]` 头格式逐字节不变（zh 为 `[压缩摘要 checksum=…]`，pick 双语）
- 失败语义：模型抛错/空输出/超预算截断后为空 → 一律 null → 回退确定性 join；压缩永不因摘要失败而失败；replay 幂等重放不发起模型调用、不重复注入、不折链
- A5 护栏：门禁关闭（provider 非 `'openai'` 或未传 `summaryModel`）时输出与今日逐字节一致——全部既有测试断言不得改动
- 前缀缓存：压缩块落定后冻结；既有「相邻步前缀稳定」「压缩后链/压缩块不双份」用例保持绿
- i18n：模型侧文案 `pick()` 就地成对（en 缺省）；界面文案 `t()`；测试内 `setLanguage` 后必须 finally 还原
- TypeScript strict 禁无理由 any；零新第三方依赖；路径一律 `path.join`；临时目录 `fs.mkdtempSync` + finally `rmSync`
- 每任务收尾 commit；最终门禁 `pnpm build` + `pnpm test` + `pnpm selfcheck` 全绿（基线全量 602/602，本计划新增 19 用例 → 预期约 621，以实际为准）
- 提交粒度：按任务提交、不推送（推送待用户指令）

## File Structure

```text
src/harness/context/summarizer.ts        # 新增：provider 门禁 + 六要素 prompt + summarizeWithModel + 预算二分截断
src/harness/context/summarizer.test.ts   # 新增：接缝单测（en/zh 模板、成功/空/抛错/超预算、门禁）
src/harness/context/window.ts            # 修改：summarize/reinject 增可选 summaryBody（头不变、正文整体替换）
src/harness/context/index.ts             # 修改：applyCompaction 摘要分叉（调用点参数 + 返回 via）+ runCompaction + chainToHistoryItems
src/harness/reactor.ts                   # 修改：压缩收敛环接 runCompaction（summarizeModel=run 内已路由 adapter）；toHistory 复用同源转换
src/tui/session.ts                       # 修改：/compact 补链参与（chainView→history 条目）并接 runCompaction（summarizeModel=harness.model）
TUI-MANUAL.md                            # 修改：/compact 命令表行口径
docs/superpowers/specs/2026-09-16-model-compaction-design.md  # 修改：§4.2/§4.4 决策点口径对齐实现
测试增补：src/harness/context/summarizer.test.ts（新）、window.test.ts、compaction.test.ts、src/harness/reactor.test.ts、src/tui/session.test.ts
```

---

### Task 1: summarizer 接缝模块

**Files:**
- Create: `src/harness/context/summarizer.ts`
- Test: `src/harness/context/summarizer.test.ts`

**Interfaces:**
- Consumes: `ContextChunk`/`estimateTokens`（window.ts 既有导出）、`pick`（i18n）、`ModelAdapter`（类型）
- Produces（后续任务依赖的精确签名）:
  - `isModelSummarizer(model: ModelAdapter | undefined): boolean`
  - `buildSummaryPrompt(chunks: ContextChunk[], budgetTokens: number): string`（en 文案恒含标记串 `handoff summary`，测试桩据此区分压缩调用）
  - `trimToTokenBudget(text: string, budgetTokens: number): string`
  - `summarizeWithModel(model: ModelAdapter, chunks: ContextChunk[], budgetTokens: number): Promise<string | null>`

- [ ] **Step 1: 写失败测试**（新建 `src/harness/context/summarizer.test.ts`）

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, setLanguage } from '../../i18n';
import { ContextChunk, estimateTokens } from './window';
import { buildSummaryPrompt, isModelSummarizer, summarizeWithModel, trimToTokenBudget } from './summarizer';

function chunk(summary: string, type = 'history'): ContextChunk {
  return { id: summary.slice(0, 8), summary, type, priority: 1 };
}

const SIX_HEADINGS = ['## Goal', '## Constraints', '## Progress', '## Verified', '## Open', '## Rationale'];
const MARKER = 'handoff summary';

test('buildSummaryPrompt：六节标题 + 材料行 + 预算约束（en 缺省）', () => {
  const p = buildSummaryPrompt([chunk('旧上下文要点 a b c'), chunk('工具结果 x y z', 'result')], 2000);
  for (const h of SIX_HEADINGS) assert.ok(p.includes(h), `缺节标题 ${h}`);
  assert.ok(p.includes('- [history] 旧上下文要点 a b c'), '材料行应含类型与摘要');
  assert.ok(p.includes('- [result] 工具结果 x y z'));
  assert.ok(p.includes('2000'), '预算约束应注入目标 token 数');
  assert.ok(p.includes(MARKER), '固定标记供测试桩区分压缩调用');
});

test('buildSummaryPrompt：zh 语言下模板中文、节名恒定英文', () => {
  const prev = getLanguage();
  setLanguage('zh');
  try {
    const p = buildSummaryPrompt([chunk('材料')], 500);
    assert.ok(p.includes(MARKER));
    assert.ok(p.includes('交接摘要'));
    assert.ok(p.includes('红线'));
    for (const h of SIX_HEADINGS) assert.ok(p.includes(h), '节名恒定英文（解析锚点）');
  } finally {
    setLanguage(prev);
  }
});

test('trimToTokenBudget：预算内原样返回；超预算二分截断至预算内且确定性', () => {
  assert.equal(trimToTokenBudget('abcd', 10), 'abcd');
  const long = 'x'.repeat(400); // ≈100 tokens
  const out = trimToTokenBudget(long, 50);
  assert.equal(out.length, 200, 'ASCII 4:1 → 50 tokens 恰 200 字符');
  assert.equal(out, trimToTokenBudget(long, 50), '同输入同输出（确定性）');
});

test('summarizeWithModel：成功返回模型正文，prompt 含模板与材料', async () => {
  let seen = '';
  const model = { provider: 'openai', complete: async (p: string) => { seen = p; return '## Goal\n完成压缩\n## Open\n待验收'; } };
  const out = await summarizeWithModel(model, [chunk('材料 abc def')], 2000);
  assert.equal(out, '## Goal\n完成压缩\n## Open\n待验收');
  assert.ok(seen.includes('## Rationale') && seen.includes('材料 abc def'));
});

test('summarizeWithModel：空输出与抛错一律 null（回退信号）', async () => {
  assert.equal(await summarizeWithModel({ provider: 'openai', complete: async () => '   ' }, [chunk('a b c d')], 100), null);
  assert.equal(
    await summarizeWithModel({ provider: 'openai', complete: async () => { throw new Error('boom'); } }, [chunk('a b c d')], 100),
    null,
  );
});

test('summarizeWithModel：超预算正文确定性截断至预算内', async () => {
  const model = { provider: 'openai', complete: async () => 'y'.repeat(400) };
  const out = await summarizeWithModel(model, [chunk('a b c d')], 50);
  assert.ok(out !== null && out.length <= 200);
  assert.ok(estimateTokens(out) <= 50);
});

test('summarizeWithModel：空选中块零模型调用直接 null', async () => {
  let calls = 0;
  const model = { provider: 'openai', complete: async () => { calls++; return 'x'; } };
  assert.equal(await summarizeWithModel(model, [], 100), null);
  assert.equal(calls, 0);
});

test('isModelSummarizer：仅 openai 通道视为真实模型', () => {
  assert.equal(isModelSummarizer(undefined), false);
  assert.equal(isModelSummarizer({ provider: 'stub', complete: async () => '' }), false);
  assert.equal(isModelSummarizer({ provider: 'scripted', complete: async () => '' }), false);
  assert.equal(isModelSummarizer({ provider: 'openai', complete: async () => '' }), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/context/summarizer.test.js`
Expected: FAIL（模块 `./summarizer` 不存在，编译报错）

- [ ] **Step 3: 最小实现**（新建 `src/harness/context/summarizer.ts`）

```ts
import { pick } from '../../i18n';
import type { ModelAdapter } from '../../model/adapter';
import { ContextChunk, estimateTokens } from './window';

/** 装配决策点（规格 §4.4 语义）：仅 'openai' 通道视为真实模型——stub/scripted/测试桩一律走确定性路径。
 *  模拟模型通道的测试经 provider:'openai' 的假适配器显式加入（complete 为注入桩，不发真实网络）。 */
export function isModelSummarizer(model: ModelAdapter | undefined): boolean {
  return !!model && model.provider === 'openai' && typeof model.complete === 'function';
}

/** 六要素交接摘要 prompt（模型侧文案 pick 就地成对；语言为启动期常量，前缀缓存安全）。
 *  'handoff summary' 为固定标记：测试桩据此区分压缩调用与主链调用。 */
export function buildSummaryPrompt(chunks: ContextChunk[], budgetTokens: number): string {
  const material = chunks.map((c) => `- [${c.type}] ${c.summary}`).join('\n');
  return pick(
    [
      'You are compressing the selected context of an engineering session into a handoff summary for a fresh context window.',
      'Write exactly six markdown sections with these exact headings, keeping only facts and conclusions:',
      '## Goal',
      '## Constraints',
      '## Progress',
      '## Verified',
      '## Open',
      '## Rationale',
      'Section semantics: Goal = what is being accomplished now, so a fresh window stays on track;',
      'Constraints = user requirements, boundaries and hard limits; Progress = what has been done and what artifacts exist;',
      'Verified = confirmed conclusions and trustworthy data; Open = blockers, gaps, next actions;',
      'Rationale = why the current approach was chosen, which approaches already failed and must not be repeated, and pointers to original records (files/locations).',
      `Rules: keep the whole summary under about ${budgetTokens} tokens; output only the summary text (no preamble, no code fences).`,
      'Selected context:',
      material,
    ].join('\n'),
    [
      '你正在把一次工程会话的选中上下文压缩为交接摘要（handoff summary），供全新上下文窗口接续使用。',
      '输出恰好六个 Markdown 小节，标题逐字使用以下英文节名，只保留事实与结论：',
      '## Goal',
      '## Constraints',
      '## Progress',
      '## Verified',
      '## Open',
      '## Rationale',
      '小节语义：Goal=当前要完成什么（防止新窗口跑偏）；Constraints=用户要求、边界条件与不可碰的红线；',
      'Progress=已推进到哪一步、已产出什么；Verified=已确认的结论与可信数据；Open=卡点、缺口与下一步动作；',
      'Rationale=为什么选当前路线、哪些方案已失败不要再重复、原始记录入口（文件/位置引用）。',
      `规则：全文控制在约 ${budgetTokens} tokens 以内；只输出摘要正文（无前言、无代码围栏）。`,
      '选中上下文：',
      material,
    ].join('\n'),
  );
}

/** 确定性预算截断（与 window.compact 兜底同款二分口径）：超预算时按字符二分最大可保留前缀 */
export function trimToTokenBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budgetTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** 模型摘要：一次 complete()；空输出/抛错/截断后为空一律 null（调用方回退确定性 join）——压缩永不因摘要失败而失败 */
export async function summarizeWithModel(model: ModelAdapter, chunks: ContextChunk[], budgetTokens: number): Promise<string | null> {
  if (chunks.length === 0) return null;
  try {
    const raw = await model.complete(buildSummaryPrompt(chunks, budgetTokens));
    const text = (raw ?? '').trim();
    if (!text) return null;
    const out = trimToTokenBudget(text, budgetTokens);
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/context/summarizer.test.js`
Expected: PASS（8 用例）

- [ ] **Step 5: Commit**

```bash
git add src/harness/context/summarizer.ts src/harness/context/summarizer.test.ts
git commit -m "feat(context): 压缩摘要模型接缝——六要素双语 prompt/预算二分截断/失败回退 null 契约/provider 门禁"
```

---

### Task 2: window 摘要体参数 + applyCompaction 摘要分叉

**Files:**
- Modify: `src/harness/context/window.ts`（summarize/reinject 增可选 `summaryBody`）
- Modify: `src/harness/context/index.ts`（applyCompaction 头部与摘要分叉）
- Test: `src/harness/context/window.test.ts`（追加 1 用例）、`src/harness/context/compaction.test.ts`（追加 4 用例）

**Interfaces:**
- Consumes: Task 1 全部导出
- Produces:
  - `window.summarize(chunks: ContextChunk[], summaryBody?: string): ContextItem`
  - `window.reinject(chunks: ContextChunk[], summaryBody?: string): ContextItem[]`
  - `cm.applyCompaction(chunks: ContextChunk[], opts?: { rereadTokenBudget?: number; summaryModel?: ModelAdapter; summaryTokenBudget?: number }): Promise<'model' | 'deterministic' | 'replay'>`

- [ ] **Step 1: 写失败测试**

`window.test.ts` 追加（需已导入 `ContextChunk`，若无则补 `import { ContextChunk } from '../../types';` 不必——ContextChunk 从 `./window` 导入）：

```ts
test('summarize 支持外部摘要体：checksum 头不变，正文整体替换', () => {
  const w = new ContextWindow();
  const chunks = [{ id: 'x', summary: 's', type: 'history', priority: 1 }];
  const a = w.summarize(chunks);
  const b = w.summarize(chunks, '自定义正文');
  assert.equal(a.content.split('\n')[0], b.content.split('\n')[0], 'checksum 头逐字节一致');
  assert.ok(b.content.endsWith('自定义正文'));
});
```

`compaction.test.ts` 追加（文件顶部补 `import { chainToHistoryItems, ContextManager, runCompaction } from './index';` 中本任务先用到的部分与 `import { ContextChunk } from './window';`——Task 3 再补其余导入）：

```ts
const MODEL_BODY = '## Goal\n压缩验证目标\n## Open\n无';

test('applyCompaction 摘要分叉：模型成功 → 正文为模型文本，checksum 头不变，重读机制不变', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'notes.md'), 'line1');
  cm.trackFile('notes.md');
  const chunks = await compactOf(cm, '很长的旧上下文 '.repeat(50));
  let calls = 0;
  const via = await cm.applyCompaction(chunks, {
    rereadTokenBudget: 2000,
    summaryTokenBudget: 2000,
    summaryModel: { provider: 'openai', complete: async () => { calls++; return MODEL_BODY; } },
  });
  assert.equal(via, 'model');
  const items = cm.assemble();
  const sum = items.find((i) => i.content.startsWith('[Compacted summary'));
  assert.ok(sum, '压缩块存在');
  assert.match(sum!.content, /^\[Compacted summary checksum=[0-9a-f]{16}\]\n## Goal/);
  assert.ok(sum!.content.includes(MODEL_BODY), '正文为模型文本');
  assert.ok(!sum!.content.includes('- [history] '), '确定性 join 行被替换');
  assert.ok(items.some((i) => i.content.startsWith('[重读] notes.md')), '重读条目机制不变');
  assert.equal(calls, 1, '模型恰好调用一次');
});

test('applyCompaction 摘要分叉：模型抛错/空输出 → 回退确定性 join（逐字节今日行为）', async () => {
  for (const complete of [async () => { throw new Error('boom'); }, async () => '   '] as const) {
    const { cm } = setup();
    const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
    const via = await cm.applyCompaction(chunks, { summaryModel: { provider: 'openai', complete } });
    assert.equal(via, 'deterministic');
    const sum = cm.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(sum && sum.content.includes('- [history] 旧上下文要点'), '回退体为 - [type] 摘要 行');
  }
});

test('applyCompaction replay 幂等：同一 chunks 二次应用不再发起模型调用', async () => {
  const { cm } = setup();
  let calls = 0;
  const model = { provider: 'openai', complete: async () => { calls++; return MODEL_BODY; } };
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  await cm.applyCompaction(chunks, { summaryModel: model });
  const via2 = await cm.applyCompaction(chunks, { summaryModel: model });
  assert.equal(via2, 'replay');
  assert.equal(calls, 1, 'replay 不发起模型调用');
  assert.equal(cm.assemble().filter((i) => i.content.startsWith('[Compacted summary')).length, 1, '不重复注入');
});

test('applyCompaction provider 门禁：非 openai 通道不走模型直接确定性', async () => {
  const { cm } = setup();
  let calls = 0;
  const chunks = await compactOf(cm, '旧上下文要点'.repeat(10));
  const via = await cm.applyCompaction(chunks, { summaryModel: { provider: 'stub', complete: async () => { calls++; return 'X'; } } });
  assert.equal(via, 'deterministic');
  assert.equal(calls, 0, 'stub 通道零模型调用');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/context/compaction.test.js dist/harness/context/window.test.js`
Expected: FAIL（`applyCompaction` 不接受 `summaryModel` 选项、返回 `undefined` ≠ `'model'`；window `summarize` 无第二参数）

- [ ] **Step 3: 实现**

`window.ts` 两个方法替换为（重读注释语义不变）：

```ts
  /** 压缩摘要条目（纯计算）：kept chunks 摘要拼接 + checksum 标记；summaryBody 提供时正文整体替换（模型摘要路径，头不变） */
  summarize(chunks: ContextChunk[], summaryBody?: string): ContextItem {
    const hash = crypto.createHash('sha256').update(JSON.stringify(chunks)).digest('hex').slice(0, 16);
    const text = summaryBody !== undefined ? summaryBody : chunks.map((c) => `- [${c.type}] ${c.summary}`).join('\n');
    return { kind: 'history', content: pick(`[Compacted summary checksum=${hash}]\n${text}`, `[压缩摘要 checksum=${hash}]\n${text}`) };
  }

  /** reinject 落地：由压缩 chunks 产出重注入条目（摘要；最近文件重读由 ContextManager 协调后追加） */
  reinject(chunks: ContextChunk[], summaryBody?: string): ContextItem[] {
    return [this.summarize(chunks, summaryBody)];
  }
```

`index.ts`：顶部补导入

```ts
import { isModelSummarizer, summarizeWithModel } from './summarizer';
import type { ModelAdapter } from '../../model/adapter';
```

`applyCompaction` 替换为（**重读段——for 循环、预算裁剪、`this.compacted = items`——以现行实现为准逐字保留零改动**，仅签名/头部/摘要分叉按下文变化）：

```ts
  /** 压缩重注入：checksum 门禁 → 摘要（模型六要素优先，未传/门禁关闭/失败回退确定性 join）→ 重读最近文件 → 注入块。
   *  返回摘要来源三态：model=模型正文生效；deterministic=确定性回退；replay=同一压缩事件幂等重放（不注入、不计数、不发起模型调用）。 */
  async applyCompaction(
    chunks: ContextChunk[],
    opts?: { rereadTokenBudget?: number; summaryModel?: ModelAdapter; summaryTokenBudget?: number },
  ): Promise<'model' | 'deterministic' | 'replay'> {
    const verdict = this.window.verifyChecksum(chunks);
    if (verdict === 'replay') return 'replay'; // 同一压缩事件幂等重放（规格 §8：不发起模型调用）
    this.compactions++;
    let summaryBody: string | undefined;
    if (opts?.summaryModel && isModelSummarizer(opts.summaryModel)) {
      const body = await summarizeWithModel(opts.summaryModel, chunks, opts.summaryTokenBudget ?? 2000);
      if (body !== null) summaryBody = body;
    }
    const items: ContextItem[] = [...this.window.reinject(chunks, summaryBody)];
    // ……（重读段零改动：for (const rel of this.recent) { … } + rereadTokenBudget 裁剪 + this.compacted = items）……
    return summaryBody !== undefined ? 'model' : 'deterministic';
  }
```

- [ ] **Step 4: 跑测试确认通过（含既有用例回归）**

Run: `pnpm build && node --test dist/harness/context/compaction.test.js dist/harness/context/window.test.js`
Expected: PASS（compaction 既有 6 + 新增 4；window 既有 + 新增 1）

- [ ] **Step 5: Commit**

```bash
git add src/harness/context/window.ts src/harness/context/index.ts src/harness/context/window.test.ts src/harness/context/compaction.test.ts
git commit -m "feat(context): applyCompaction 摘要分叉——模型正文优先、失败回退确定性 join、replay 不发起调用"
```

---

### Task 3: runCompaction 协调单点 + chainToHistoryItems

**Files:**
- Modify: `src/harness/context/index.ts`（文件尾新增两导出）
- Modify: `src/harness/reactor.ts`（toHistory 复用同源转换）
- Test: `src/harness/context/compaction.test.ts`（追加 3 用例）

**Interfaces:**
- Consumes: Task 2 的 applyCompaction 三态返回
- Produces:
  - `chainToHistoryItems(steps: HistoryStep[]): ContextItem[]`
  - `runCompaction(cm: ContextManager, items: ContextItem[], opts: { summaryTokenBudget: number; rereadTokenBudget: number; chainFoldedCount?: number; summaryModel?: ModelAdapter }): Promise<RunCompactionResult>`，`RunCompactionResult = { chunks: ContextChunk[]; via: 'model' | 'deterministic' | 'replay' }`

- [ ] **Step 1: 写失败测试**（`compaction.test.ts` 追加；顶部导入补全为 `import { chainToHistoryItems, ContextManager, runCompaction } from './index';`）

```ts
test('chainToHistoryItems：链行 → history 条目唯一格式（与 reactor toHistory 同源）', () => {
  const items = chainToHistoryItems([
    { step: 3, action: 'read', observation: 'o1' },
    { step: 4, observation: 'o2' },
  ]);
  assert.deepEqual(items.map((i) => i.content), ['3: read -> o1', '4:  -> o2']);
  assert.ok(items.every((i) => i.kind === 'history'));
});

test('runCompaction：协调单点——压缩、模型摘要、折链', async () => {
  const { cm } = setup();
  cm.appendChain([{ action: 'read', observation: 'Y'.repeat(800) }]);
  const items = cm.assemble(chainToHistoryItems(cm.chainView()));
  const r = await runCompaction(cm, items, {
    summaryTokenBudget: 2000,
    rereadTokenBudget: 2000,
    chainFoldedCount: 1,
    summaryModel: { provider: 'openai', complete: async () => MODEL_BODY },
  });
  assert.equal(r.via, 'model');
  assert.ok(r.chunks.length > 0);
  assert.equal(cm.chainView().length, 0, 'chainFoldedCount>0 时折链（压缩块与链不双份）');
  assert.ok(cm.assemble().some((i) => i.content.startsWith('[Compacted summary')));
});

test('runCompaction：replay 幂等——不再折链、不重复注入', async () => {
  const { cm } = setup();
  cm.appendChain([{ observation: 'Y'.repeat(50) }, { observation: 'Z'.repeat(50) }]);
  const items = cm.assemble(cm.chainView().map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` })));
  const r1 = await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 2000 });
  assert.notEqual(r1.via, 'replay');
  const r2 = await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 2000, chainFoldedCount: cm.chainView().length });
  assert.equal(r2.via, 'replay');
  assert.equal(cm.chainView().length, 2, 'replay 不折链（防重复推进水位）');
  assert.equal(cm.assemble().filter((i) => i.content.startsWith('[Compacted summary')).length, 1, '不重复注入');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/context/compaction.test.js`
Expected: FAIL（`runCompaction`/`chainToHistoryItems` 未导出）

- [ ] **Step 3: 实现**

`index.ts` 文件尾（class 外）新增：

```ts
/** 链行 → history 条目的唯一拼装格式（reactor toHistory 与 TUI /compact 补链共用，防两处漂移） */
export function chainToHistoryItems(steps: HistoryStep[]): ContextItem[] {
  return steps.map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` }));
}

export interface RunCompactionResult {
  chunks: ContextChunk[];
  /** 摘要来源三态（透传 applyCompaction）：model / deterministic / replay */
  via: 'model' | 'deterministic' | 'replay';
}

/** 压缩协调单点（规格 §4.2/D5）：确定性选块 → 摘要分叉（模型优先，失败回退）→ 门禁重注入 → 折叠链前缀。
 *  reactor 自动压缩与 TUI /compact 两入口只传参不各自拼装（防拼装漂移，memory 双写教训）；
 *  replay 幂等重放不折链（防重复推进水位）。 */
export async function runCompaction(
  cm: ContextManager,
  items: ContextItem[],
  opts: { summaryTokenBudget: number; rereadTokenBudget: number; chainFoldedCount?: number; summaryModel?: ModelAdapter },
): Promise<RunCompactionResult> {
  const chunks = await cm.window.compact(items, { summaryTokenBudget: opts.summaryTokenBudget });
  const via = await cm.applyCompaction(chunks, {
    rereadTokenBudget: opts.rereadTokenBudget,
    summaryTokenBudget: opts.summaryTokenBudget,
    ...(opts.summaryModel ? { summaryModel: opts.summaryModel } : {}),
  });
  if (via !== 'replay' && opts.chainFoldedCount !== undefined && opts.chainFoldedCount > 0) {
    cm.trimChainFront(opts.chainFoldedCount);
  }
  return { chunks, via };
}
```

`reactor.ts`：导入行改为 `import { chainToHistoryItems, ContextManager } from './context';`，`toHistory` 收敛为委托：

```ts
  private toHistory(steps: StepRecord[], fromStep: number): ContextItem[] {
    return chainToHistoryItems(steps.filter((s) => s.step > fromStep));
  }
```

- [ ] **Step 4: 跑测试确认通过（含 reactor 既有套件回归）**

Run: `pnpm build && node --test dist/harness/context/compaction.test.js dist/harness/reactor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/harness/context/index.ts src/harness/context/compaction.test.ts src/harness/reactor.ts
git commit -m "feat(context): runCompaction 压缩协调单点 + chainToHistoryItems 链行同源转换"
```

---

### Task 4: reactor 压缩收敛环接线

**Files:**
- Modify: `src/harness/reactor.ts`（收敛环 do-while 体 + 导入行补 `runCompaction`）
- Test: `src/harness/reactor.test.ts`（追加 1 端到端用例）

**Interfaces:**
- Consumes: Task 3 `runCompaction`
- Produces: reactor 压缩块走协调单点（无新导出）

- [ ] **Step 1: 写失败测试**（`reactor.test.ts` 追加，形态对齐既有「压缩闭环」用例：budget 4500/4100、手动装配安全链与注册表）

```ts
test('模型驱动压缩：压缩块正文为模型六节摘要，链折叠语义不变', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor9-'));
  fs.writeFileSync(path.join(tmp, 'big.txt'), 'X'.repeat(3000));
  try {
    const prompts: string[] = [];
    const replies = [
      '{"tool":"read","input":{"path":"big.txt"},"done":false}',
      '{"done":true,"reply":"ok"}',
    ];
    let call = 0;
    const SUMMARY = '## Goal\n读取 big.txt 验证压缩\n## Constraints\n只读\n## Progress\n已读\n## Verified\n内容确认为 X 重复\n## Open\n无\n## Rationale\n模型路径验证';
    const adapter = {
      provider: 'openai',
      complete: async (p: string) => {
        if (p.includes('handoff summary')) return SUMMARY;
        prompts.push(p);
        return replies[Math.min(call++, replies.length - 1)];
      },
    };
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, new FileStore(tmp));
    const reactor = new Reactor({ registry, safety, context, model: adapter });

    const r = await reactor.run({ goal: 'x' }, { maxSteps: 2, budget: { total: 4500, reserve: 4100 } });
    assert.equal(r.done, true);
    assert.ok(prompts[1].includes('[Compacted summary'), '压缩当轮生效（收敛环语义不变）');
    assert.ok(prompts[1].includes('## Rationale'), '压缩块正文为模型六节摘要');
    assert.ok(!prompts[1].includes('- [history] '), '确定性行列表被模型正文替换');
    assert.ok(!prompts[1].includes('\n1: read -> '), '折叠链前缀已裁出（模型路径同样不双份）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/reactor.test.js`
Expected: FAIL（prompts[1] 压缩块正文为 `- [history] …` 确定性形态，无 `## Rationale`）

- [ ] **Step 3: 实现**

`reactor.ts` 导入行补 `runCompaction`：`import { chainToHistoryItems, ContextManager, runCompaction } from './context';`

收敛环 do-while 体头部（现行「compact 两行 + compactedUpToStep + trimChainFront」四段）替换为：

```ts
          // 水位先算：折叠步骤号只依赖 steps/seed，与压缩结果无关（折链交由 runCompaction 统一执行）
          compactedUpToStep = steps.length > 0 ? steps[steps.length - 1].step : seedLastStep;
          // 压缩协调单点：确定性选块 → 摘要（当前 run 模型，失败回退确定性）→ 门禁重注入 → 折链（防「链+压缩块」双份）
          await runCompaction(this.deps.context, items, {
            summaryTokenBudget: Math.floor(budget.reserve / 2),
            rereadTokenBudget: Math.floor(budget.reserve / 2),
            chainFoldedCount: seed.filter((s) => s.step <= compactedUpToStep).length,
            summarizeModel: adapter,
          });
          lastCompactStep = step;
```

其后的 `items = this.deps.context.assemble(...)`、`est = ...`、`rounds++`、while 条件全部原样保留。

- [ ] **Step 4: 跑测试确认通过（reactor 全套既有用例回归——provider 门禁使既有 capture/scripted 用例行为逐字节不变）**

Run: `pnpm build && node --test dist/harness/reactor.test.js dist/harness/reactor.prefix.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/harness/reactor.ts src/harness/reactor.test.ts
git commit -m "feat(reactor): 自动压缩接线 runCompaction——摘要走当前 run 模型、失败回退；模型路径端到端用例"
```

---

### Task 5: TUI /compact 补链接线

**Files:**
- Modify: `src/tui/session.ts`（/compact 分支 + 导入）
- Test: `src/tui/session.test.ts`（追加 2 用例）

**Interfaces:**
- Consumes: Task 3 `runCompaction`/`chainToHistoryItems`
- Produces: /compact 补链语义（无新导出）

- [ ] **Step 1: 写失败测试**（`session.test.ts` 追加；`Harness`/`TuiRuntime` 已在既有导入中）

```ts
test('会话控制器：/compact 补链参与，链折叠且摘要来自会话模型', async () => {
  const tmp = tmpdir('sunshinex-sess-compact-');
  try {
    const SUMMARY = '## Goal\n压缩演示\n## Constraints\n只读\n## Progress\n已折叠\n## Verified\n回执一致\n## Open\n无\n## Rationale\n会话模型路径';
    const harness = new Harness({
      root: tmp,
      mode: 'dontAsk',
      model: { provider: 'openai', complete: async (p) => (p.includes('handoff summary') ? SUMMARY : '{"done":true,"reply":"ok"}') },
    });
    harness.context.appendChain([
      { action: 'read', observation: 'Y'.repeat(2000) },
      { action: 'read', observation: 'Z'.repeat(2000) },
    ]);
    const fake: TuiRuntime = {
      harness,
      runTask: async () => ({ done: true, reply: 'ok', tokensUsed: 0, stopReason: 'done' }),
      runLoop: async () => { throw new Error('runLoop not exercised in this suite'); },
    };
    const ctrl = new SessionController({ root: tmp, runtime: fake });
    await ctrl.submit('/compact');
    const texts = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    assert.match(texts, /Compressed: \d+ summary chunks re-injected/, '压缩回执上屏');
    assert.equal(harness.context.chainView().length, 0, '链前缀已折叠（/compact 补链语义）');
    const sum = harness.context.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(sum && sum.content.includes('## Rationale'), '压缩块正文为模型六节摘要');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/compact 非真实模型通道走确定性压缩（门禁关闭）', async () => {
  const tmp = tmpdir('sunshinex-sess-compact2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const ctx = ctrl.runtime.harness.context;
    ctx.appendChain([{ action: 'read', observation: 'Y'.repeat(2000) }]);
    await ctrl.submit('/compact');
    assert.equal(ctx.chainView().length, 0, '链前缀已折叠');
    const sum = ctx.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(sum && sum.content.includes('- [history] 1: read -> '), '确定性 join 回退');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tui/session.test.js`
Expected: FAIL（现行 /compact 不喂链不折链 → `chainView().length` ≠ 0；无模型摘要 → 无 `## Rationale`）

- [ ] **Step 3: 实现**

`session.ts` 顶部补导入：`import { chainToHistoryItems, runCompaction } from '../harness/context';`

`/compact` 分支整体替换为：

```ts
    if (cmd === '/compact') {
      // 压缩协调单点（与 Reactor 自动压缩同链路，规格 D5）：补链参与（chainView 转 history 条目）→ 压缩 → 摘要（会话模型，失败回退）→ 折链
      const ctx = this.runtime.harness.context;
      const chainItems = chainToHistoryItems(ctx.chainView());
      const items = ctx.assemble(chainItems);
      const before = ctx.window.estimate(items).used;
      const r = await runCompaction(ctx, items, {
        summaryTokenBudget: 2000,
        rereadTokenBudget: 2000,
        chainFoldedCount: chainItems.length,
        summarizeModel: this.runtime.harness.model,
      });
      const after = ctx.window.estimate(ctx.assemble()).used;
      this.state = { ...this.state, metrics: { ...this.state.metrics, ctxUsed: after } };
      this.pushMsg('system', t(`Compressed: ${r.chunks.length} summary chunks re-injected (ctx ${before} → ${after} tokens)`, `已压缩：${r.chunks.length} 个摘要块重注入（水位 ${before} → ${after} tokens）`));
      return;
    }
```

- [ ] **Step 4: 跑测试确认通过（session 全套回归）**

Run: `pnpm build && node --test dist/tui/session.test.js dist/tui/session.plan.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/session.ts src/tui/session.test.ts
git commit -m "feat(tui): /compact 补链参与并走会话模型摘要——chainView 转换条目入压缩、折链对齐自动压缩"
```

---

### Task 6: 文档与规格对齐 + 全量门禁

**Files:**
- Modify: `TUI-MANUAL.md`（/compact 命令表行）
- Modify: `docs/superpowers/specs/2026-09-16-model-compaction-design.md`（§4.2/§4.4/§7 决策点口径对齐实现）

**Interfaces:** 无代码接口；纯文档与门禁。

- [ ] **Step 1: TUI-MANUAL 命令表行更新**

`| \`/compact\` | 立即压缩上下文 |` → `| \`/compact\` | 立即压缩上下文（当前模型生成六要素交接摘要，模型失败自动回退） |`

- [ ] **Step 2: 规格 §4.2/§4.4/§7 口径对齐**（实现较规格草案更收敛：摘要器不驻留 ContextManager、无 buildSummarizer 新装配面，决策语义不变）

- §4.2 首条要点「构造注入可选 `summarizer`；`applyCompaction` async 化，内部：」替换为「摘要器不驻留 ContextManager：`applyCompaction` 增调用点参数 `summaryModel`/`summaryTokenBudget`，内部：」；其两枚举子条「summarizer 存在且…」「未注入 / 返回 null…」替换为「`isModelSummarizer(summaryModel)` 门禁开启且 `summarizeWithModel` 返回非空 → 摘要体 = 模型文本」「未传、门禁关闭或返回 null → 摘要体 = 现有确定性 join（逐字节今日行为）」；applyCompaction 返回三态说明补「'model' | 'deterministic' | 'replay'」。
- runCompaction 示意块返回行「返回 { applied, before/after 水位信息 }」替换为「返回 { chunks, via: 'model' | 'deterministic' | 'replay' }（via=replay 时不折链；回落水位由调用方各自重装配计算）」。
- §4.4 整节替换为：

```markdown
### 4.4 模型通道决策点（实现对齐）

不新增 buildSummarizer 装配面：`isModelSummarizer()`（summarizer.ts 单点）以 provider 门禁实现同一决策语义（D4）——仅 'openai' 通道启用模型摘要，Stub/Scripted/测试桩自然走确定性路径；模型经既有 `deps.model`（reactor 侧为 run 内已路由 adapter，精确「当前会话模型」，D2）与 `harness.model`（/compact 侧）字段流动，装配零改动。
```

- §7 落点表两行同步：「`src/runtime.ts` | +buildSummarizer 注入决策」→「`src/runtime.ts` | 不动（模型经既有 deps.model 流动，零装配改动）」；「`src/harness/context/index.ts` | …」中「+可选 summarizer 注入」→「+applyCompaction 摘要分叉（调用点参数）+导出 runCompaction/chainToHistoryItems」。

- [ ] **Step 3: 全量门禁**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: tsc 零报错；全量约 621/621（基线 602 + 新增 19，以实际为准）；selfcheck OK

- [ ] **Step 4: Commit**

```bash
git add TUI-MANUAL.md docs/superpowers/specs/2026-09-16-model-compaction-design.md
git commit -m "docs: TUI-MANUAL /compact 口径与压缩设计规格 §4 决策点对齐实现（模型经既有字段流动，零新装配面）"
```

---

## Self-Review（已执行）

- **规格覆盖**：A1→Task 2（模型成功正文+checksum 锚定）、A2/A3→Task 1+2（抛错/空回退）、A4→Task 1（超预算截断）、A5→Task 2 门禁用例+既有全量零断言改动、A6→Task 4（端到端+双份断言+既有 prefix 套件保持）、A7→Task 3+5（replay 不折链/不发起调用、/compact 补链+折链+回执）、A8→Task 1（en/zh）、A9→Task 6 门禁。D1–D5 全覆盖；D4 以 provider 门禁实现（Task 6 规格对齐）。
- **占位符扫描**：无 TBD/TODO；Task 2 applyCompaction 的重读段标注「以现行实现为准逐字保留零改动」属边界描述而非占位。
- **类型一致性**：`CompactionSummarizer` 未采用（最终为调用点 `summaryModel?: ModelAdapter`，与 Task 1/2/3 签名一致）；`runCompaction`/`chainToHistoryItems` 命名跨 Task 3/4/5 一致；`via` 三态贯穿 Task 2/3。
