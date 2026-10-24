# 权限档重构与 plan 模式重造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 权限档改名对齐业界（`read-only | acceptEdits | full-access`）+ plan 退为流程：共享 planFlow 模块（只读调研 → 计划书 + todo_write 步骤 → 批准/反馈驳回环 → 注入链落 acceptEdits 逐项执行），TUI/GUI 同一实现。

**Architecture:** 三阶段递进，每阶段独立可交付：①类型与判定面改名+别名回放；②`src/harness/plan-flow.ts` 纯流程编排模块（接缝注入，harness 不依赖 tui/gui/serve）+ TUI 接入；③serve plan-arm 提交通道 + GUI 确认卡。enforcement 收口点不变：全量工具恒下发，模式只改 guard/chain 判决。

**Tech Stack:** TypeScript（node:test + assert/strict）、React/ink（TUI）、React（GUI）、pnpm。

**Spec:** `docs/superpowers/specs/2026-10-24-plan-mode-redesign-design.md`（裁定记录六项与本计划任务一一对应）

## Global Constraints

- **执行前工作区必须干净**：当前 dev1 有未提交改动（`src/cli/commands/run-loop.ts`、`src/harness/security/guard.ts`、`src/runtime.ts`、未跟踪 `.zcode/`）——先由用户处置（提交或贮藏）再开始 Task 1。
- 全量测试：`pnpm test`（= clean-dist + tsc + 全部 dist 测试，基线约 1920 例；测试语言钉 en）。**每个任务完成必须全量绿再提交。**
- 定点测试模板（`<TEST>` 换成 dist 下目标文件路径，其余逐字照抄）：
  ```bash
  node scripts/clean-dist.js && tsc -p tsconfig.json && SUNSHINEX_LANGUAGE=en SUNSHINEX_DATA_DIR="$PWD/.data-test" SUNSHINEX_USER_SKILLS_DIR="$PWD/.data-test/user-skills" SUNSHINEX_GLOBAL_SUNSHINE="$PWD/.data-test/global-SUNSHINE.md" node --require scripts/test-env.cjs --test dist/<TEST> && rm -rf .data-test
  ```
- 依赖方向 graph→loop→harness 不破：`src/harness/**` 禁止 import `src/tui/**`、`src/serve/**`、`gui/**`。
- 依赖方向例外说明：`PLAN_TASK_LABEL` 从 `src/tui/chat-model.ts` **迁到** `src/harness/plan-flow.ts`，chat-model 改为 re-export（D10 单源纪律保持，依赖方向变为 tui→harness，合法）。
- 文案一律 i18n `t('en', 'zh')` 双语；安全链拒绝消息保持 `COMMAND_DENIED:` 机器面前缀（不出入 i18n）。
- 提交信息：中文、conventional 前缀、正文写实（随仓库既有风格）；每任务一提交，只 add 本任务文件。
- Node 22/24 兼容、LF 行尾（.gitattributes 契约）、禁 `shell: true` 与 `args` 并用（DEP0190）。
- 旧值兼容面只有**读路径别名**（meta/journal 回放），写路径恒写新值；CLI/端点对旧值报 invalid（fail-fast 纪律）。

---

### Task 1: 权限档类型与判定面改名（modes/guard/chain/worktree）

**Files:**
- Modify: `src/harness/security/modes.ts:7`（类型与档注释）
- Modify: `src/harness/security/guard.ts:15,44-86`（缺省档、plan→read-only 闸门、dontAsk→full-access、manual→acceptEdits 分支注释）
- Modify: `src/harness/security/chain.ts:229`（写分支档判定）
- Modify: `src/harness/worktree.ts:16`（注释同步）
- Test: 现有安全面测试翻新（`src/harness/assembly.permissions.test.ts` 等，见 Step 1 枚举命令）

**Interfaces:**
- Produces: `type PermissionMode = 'read-only' | 'acceptEdits' | 'full-access'`（后续所有任务消费）；read-only 拒绝消息常量文案（含出路提示）。

- [ ] **Step 1: 枚举并翻新测试期望（先红）**

枚举引用旧档名的测试文件：

```bash
grep -rln "'plan'\|'manual'\|'dontAsk'" src --include="*.test.ts"
```

对每个文件做机械替换（测试语义不变，只换档名）：`'plan'`→`'read-only'`、`'manual'`→`'acceptEdits'`、`'dontAsk'`→`'full-access'`；涉及 `plan mode allows read-only` 的断言改为匹配新文案。新增一例断言出路提示（判别力锚：换回旧文案即红）：

```ts
test('read-only 档拒绝消息带出路提示', async () => {
  const chain = makeChain({ mode: 'read-only' }); // 沿该测试文件既有构造帮手
  const r = await chain.run('Write', { path: `${root}/x.txt`, content: 'hi' });
  assert.equal(r.allowed, false);
  assert.match(r.reason ?? '', /read-only mode allows read-only operations only/);
  assert.match(r.reason ?? '', /switch permission modes/);
});
```

- [ ] **Step 2: 跑定点测试确认失败**

Run: Global Constraints 定点模板，`<TEST>` = Step 1 枚举出的首个文件（如 `dist/harness/assembly.permissions.test.js`）
Expected: FAIL（档名仍是旧值）

- [ ] **Step 3: 改实现**

`modes.ts:7`：

```ts
/**
 * 权限档（2026-10-24 重构，spec docs/superpowers/specs/2026-10-24-plan-mode-redesign-design.md §3.1）：
 * - read-only：仅非变异操作放行（Read/Grep/Glob + ask_question/todo_write/worktree list），拒绝消息带出路提示；
 * - acceptEdits：信任域内 Write/Edit 直放、域外写与命令类 ask（沿原 manual 语义，正名）；
 * - full-access：未 deny 一律自动放行（deny 规则与破坏性底线保留；沿原 dontAsk 语义，正名——
 *   CC 的 dontAsk=「该问不问直接拒」，勿再混用该词）。
 * plan 不是档：它是流程标记（planFlow），权限面由流程临时覆盖 read-only 承载。
 */
export type PermissionMode = 'read-only' | 'acceptEdits' | 'full-access';
```

`guard.ts`：构造缺省 `modeName: PermissionMode = 'acceptEdits'`；`preToolUse` 内——worktree 分支与只读闸门的 `this.modeName === 'plan'` 改 `'read-only'`，两处拒绝消息统一：

```ts
const READONLY_DENY = 'COMMAND_DENIED: read-only mode allows read-only operations only (ask the user to switch permission modes to make changes)';
```

`this.modeName === 'dontAsk'` 改 `'full-access'`；`manual` 相关注释与分支语义原样、只换名字（`manual`→`acceptEdits`）。`chain.ts:229` 同步：`if (mode === 'plan')` → `if (mode === 'read-only')`，reason 用同一 `READONLY_DENY` 文案（从 modes.ts export 供两处共用，防漂移）。`worktree.ts:16` 注释同步。

- [ ] **Step 4: 跑定点测试 + 全量**

Run: 定点模板（Step 1 全部文件）+ `pnpm test`
Expected: 全绿。全量里尚未翻新的 Task 3/4 消费面（cli/entry/serve/gui）若编译报错属预期——本任务只动 harness 判定面与其测试；若 `pnpm test` 因下游编译失败，先跑 `tsc --noEmit -p tsconfig.json` 确认错误只落在下游消费面文件（下一任务修），harness 域内测试绿即可提交。

- [ ] **Step 5: Commit**

```bash
git add src/harness/security/modes.ts src/harness/security/guard.ts src/harness/security/chain.ts src/harness/worktree.ts src/harness/*.test.ts
git commit -m "refactor(security): 权限档改名第一刀——PermissionMode 改 read-only/acceptEdits/full-access(spec 阶段一§3.1):plan 从档除名退流程标记,只读闸门挂 read-only 且拒绝消息带出路提示(判别力锚);manual→acceptEdits 正名(信任域写直放+域外ask),dontAsk→full-access 正名(消除与 CC 同名反义);READONLY_DENY 单点 export 防 guard/chain 文案漂移;测试面同步翻新"
```

### Task 2: resolveModeAlias 别名回放单点

**Files:**
- Modify: `src/harness/security/modes.ts`（追加函数）
- Modify: `src/serve/daemon.ts:312-313`（回放消费）
- Test: Create `src/harness/security/modes.test.ts`

**Interfaces:**
- Produces: `resolveModeAlias(raw: string): PermissionMode | 'plan' | undefined`——读路径唯一入口；返回 `'plan'` 透传（流程标记，Task 3 起 SessionMode 合法值），映射规则：`manual→acceptEdits`、`dontAsk→full-access`、`plan→acceptEdits`（旧档安全落点，spec §3.3）、未知→`undefined`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModeAlias } from './modes';

test('resolveModeAlias：现值原样透传、旧档映射、plan→acceptEdits 安全落点、未知 undefined', () => {
  assert.equal(resolveModeAlias('read-only'), 'read-only');
  assert.equal(resolveModeAlias('acceptEdits'), 'acceptEdits');
  assert.equal(resolveModeAlias('full-access'), 'full-access');
  assert.equal(resolveModeAlias('manual'), 'acceptEdits');
  assert.equal(resolveModeAlias('dontAsk'), 'full-access');
  assert.equal(resolveModeAlias('plan'), 'acceptEdits', '旧 GUI plan 档真身 dontAsk,回放落全自动危险,统一落工作区编辑(spec §3.3)');
  assert.equal(resolveModeAlias(''), undefined);
  assert.equal(resolveModeAlias('typo'), undefined);
});
```

- [ ] **Step 2: 跑定点测试确认失败**

Run: 定点模板 `<TEST>` = `dist/harness/security/modes.test.js`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现**

`modes.ts` 追加：

```ts
/** 旧档/别名→现档单点（meta 旁车与 journal mode 行读路径共用;写路径恒写现值）。
 *  返回 'plan' 仅供 serve 流程标记透传(阶段三 plan-arm);权限档语义一律映射为三档之一——
 *  旧 plan 档(真身 dontAsk)安全落 acceptEdits,回放绝不落全自动。未知值 undefined,调用方回落缺省档+warn。 */
export function resolveModeAlias(raw: string): PermissionMode | 'plan' | undefined {
  if (raw === 'read-only' || raw === 'acceptEdits' || raw === 'full-access') return raw;
  if (raw === 'manual' || raw === 'plan') return 'acceptEdits';
  if (raw === 'dontAsk') return 'full-access';
  return undefined;
}
```

`daemon.ts:313` 消费：

```ts
const restored = resolveModeAlias(selMeta.mode ?? '');
if (restored !== undefined) session.setMode(restored);
else if (selMeta.mode !== undefined) console.error(t(`settings warning: unknown mode "${selMeta.mode}", default applied`, `settings 警告：未知权限档 "${selMeta.mode}"，已回落缺省`));
```

（import 从 `./security/modes` 即 `src/harness/security/modes`；`t` 沿文件既有 i18n import。）

- [ ] **Step 4: 跑定点 + 全量**

Run: 定点模板 + `pnpm test`
Expected: 绿

- [ ] **Step 5: Commit**

```bash
git add src/harness/security/modes.ts src/harness/security/modes.test.ts src/serve/daemon.ts
git commit -m "feat(security): resolveModeAlias 旧档回放单点(spec §3.3)——manual→acceptEdits/dontAsk→full-access/plan→acceptEdits(安全落点,绝不落全自动),现值透传,未知 undefined+warn;daemon 回放接入;读路径唯一入口,写路径恒写新值"
```

### Task 3: 后端全链改名（CLI/TUI 入口/serve 四值 SessionMode）

**Files:**
- Modify: `src/cli/index.ts:134,161,183`
- Modify: `src/tui/entry.ts:75`
- Modify: `src/harness/index.ts:140`（缺省 `'dontAsk'`→`'full-access'`）
- Modify: `src/session/runtime.ts:18`（createKernelRuntime opts.mode 类型改三档，内核永不接收 `'plan'`）
- Modify: `src/serve/session.ts:148-150,200,207,288`
- Modify: `src/serve/session-handlers.ts:366-371`
- Test: `src/cli/flag-validation.test.ts` 翻新 + serve mode 端点契约测试（既有文件内追加）

**Interfaces:**
- Produces: `type SessionMode = 'read-only' | 'acceptEdits' | 'full-access' | 'plan'`（`plan`=流程标记,阶段三启用;本任务起装配/legal 值即收口）；`SecurityGuard` 缺省档 `acceptEdits`（TUI 侧语义沿原 manual）。

- [ ] **Step 1: 翻新 CLI 校验测试（先红）**

`src/cli/flag-validation.test.ts` 中旧档名断言改新值；追加：

```ts
test('--mode 旧值报 invalid 且附改名指引', () => {
  for (const legacy of ['manual', 'dontAsk', 'plan']) {
    assert.throws(
      () => assertValidFlagValues({ flags: { mode: legacy }, positional: [] }),
      /acceptEdits|read-only|full-access/,
      `旧值 ${legacy} 应 fail-fast 并提示新档名`,
    );
  }
  for (const cur of ['read-only', 'acceptEdits', 'full-access']) {
    assert.doesNotThrow(() => assertValidFlagValues({ flags: { mode: cur }, positional: [] }));
  }
});
```

- [ ] **Step 2: 跑定点确认失败**

Run: 定点模板 `<TEST>` = `dist/cli/flag-validation.test.js`；Expected: FAIL

- [ ] **Step 3: 实现**

`cli/index.ts:183`：

```ts
if (mode !== undefined && mode !== 'read-only' && mode !== 'acceptEdits' && mode !== 'full-access')
  invalid.push(`--mode=${mode}(旧值 manual/dontAsk/plan 已退役:manual→acceptEdits、dontAsk→full-access、plan 已退为流程标记)`);
```

`cli/index.ts:134,161` 帮助文案 `--mode=manual|plan|dontAsk` → `--mode=read-only|acceptEdits|full-access`（缺省 acceptEdits）。

`entry.ts:75`：

```ts
const mode = modeFlag === 'read-only' || modeFlag === 'acceptEdits' || modeFlag === 'full-access' ? modeFlag : 'acceptEdits';
```

`session/runtime.ts:18`：`mode?: 'dontAsk' | 'manual' | 'plan'` → `mode?: PermissionMode`（import 自 `../harness/security/modes`；内核档位恒三档，`'plan'` 只存在于 serve SessionMode 层，装配映射后传入）。

`harness/index.ts:140`：`opts.mode ?? 'dontAsk'` → `opts.mode ?? 'full-access'`。

`serve/session.ts`：`:150` `SessionMode = 'read-only' | 'acceptEdits' | 'full-access' | 'plan'`（注释:plan=流程标记,阶段三 plan-arm;权限面恒三档）；`:207` 缺省 `'full-access'`；`:200` `isManual` 改名 `isAcceptEdits`、判定 `currentMode === 'acceptEdits'`（grep 全部消费点同步改名）；`:288` 装配映射：

```ts
mode: this.currentMode === 'plan' ? 'acceptEdits' : this.currentMode,
```

（注释:plan-arm 态内核闲置于 acceptEdits——替换旧 plan→dontAsk 假映射,spec §3.2。）

`session-handlers.ts:371`：合法值改四值 `'read-only' | 'acceptEdits' | 'full-access' | 'plan'`；`:366` 注释同步。

- [ ] **Step 4: serve 契约测试追加**

在 serve 既有 session/mode 测试文件内追加（沿该文件既有 HTTP 调用帮手）：

```ts
test('POST /session/:id/mode：新四值合法、旧值 400', async () => {
  for (const m of ['read-only', 'acceptEdits', 'full-access', 'plan']) {
    assert.equal((await postMode(id, m)).status, 200);
  }
  assert.equal((await postMode(id, 'dontAsk')).status, 400);
});
```

- [ ] **Step 5: 跑定点 + 全量**

Run: 定点模板（cli + serve 相关文件）+ `pnpm test`；Expected: 绿（GUI 消费面 Task 4 处理,若 gui/ 有独立构建门不在 pnpm test 内则不阻塞）

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts src/tui/entry.ts src/harness/index.ts src/serve/session.ts src/serve/session-handlers.ts src/serve/daemon.ts src/cli/flag-validation.test.ts src/serve/*.test.ts
git commit -m "refactor(mode): 后端全链权限档改名(spec §3.2)——CLI --mode 三新值+旧值 fail-fast 附指引;TUI 入口缺省 acceptEdits;harness 缺省 full-access(沿原 dontAsk 地位);serve SessionMode 四值(plan=流程标记,装配映射 plan→acceptEdits 替换旧 plan→dontAsk 假映射);isManual→isAcceptEdits(挂起表路由语义不变);mode 端点四值契约+旧值 400"
```

### Task 4: GUI 改名与四项菜单

**Files:**
- Modify: `gui/src/connection-types.ts:85`、`gui/src/connection.ts:57,320,437`
- Modify: `gui/src/pages/Chat.tsx:59-61,134`
- Modify: `gui/src/pages/chat/ComposerPills.tsx:47-71`
- Modify: `gui/src/pages/DirPicker.tsx:12-34,128-133`
- Test: `gui/src` 内引用旧档名的测试（Step 1 枚举）

**Interfaces:**
- Consumes: Task 3 的四值 SessionMode（GUI 与 serve 经 HTTP/WS 同步）。
- Produces: 菜单四项（计划模式置顶置灰 + 三档）；`ModeIcon` 值域四值。

- [ ] **Step 1: 枚举并翻新 GUI 测试**

```bash
grep -rln "'dontAsk'\|'manual'\|'plan'" gui/src --include="*.test.tsx" --include="*.test.ts"
```

同义替换 + 菜单结构断言（四项、计划模式 disabled）。

- [ ] **Step 2: 跑 GUI 测试确认失败**

Run: 沿 gui 既有测试命令（`cd gui && pnpm test`）
Expected: FAIL

- [ ] **Step 3: 实现**

`connection-types.ts:85` / `connection.ts:57,320`：mode 联合类型改四值；`connection.ts:437` `newSession(root, mode?: 'acceptEdits' | 'full-access')`。

`Chat.tsx:60-61`：

```tsx
export function ModeIcon({ mode, size = 13 }: { mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'; size?: number }): JSX.Element {
  const Icon = mode === 'plan' ? ListTodo : mode === 'read-only' ? Eye : mode === 'acceptEdits' ? ShieldCheck : Unlock;
```

（`Eye` 从 `lucide-react` import。）`:134` `useState<...>('full-access')`。

`ComposerPills.tsx:47-71`：pill 回显文案四态（`plan→t('Plan mode','计划模式')`、`read-only→t('Read-only','只读模式')`、`acceptEdits→t('Workspace edits','工作区编辑')`、`full-access→t('Full access','完全访问')`）；菜单行改四项两段（沿现 rows 数组形态）：

```tsx
{ m: 'plan' as const, label: t('Plan mode', '计划模式'), desc: t('Plan first — coming soon', '先规划后执行（即将可用）'), icon: <ListTodo size={15} strokeWidth={1.75} aria-hidden="true" />, disabled: true },
{ separator: true },
{ m: 'read-only' as const, label: t('Read-only', '只读模式'), desc: t('Read and analyze only — no changes', '只读取和分析，不改动任何文件'), icon: <Eye size={15} strokeWidth={1.75} aria-hidden="true" /> },
{ m: 'acceptEdits' as const, label: t('Workspace edits', '工作区编辑'), desc: t('Edits inside the workspace run directly; outside asks', '工作区内直接编辑，超出工作区的操作需确认'), icon: <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" /> },
{ m: 'full-access' as const, label: t('Full access', '完全访问'), desc: t('Everything auto-approved; destructive commands still blocked', '全部自动执行，仅拦截破坏性命令'), icon: <Unlock size={15} strokeWidth={1.75} aria-hidden="true" /> },
```

（`disabled` 行点击不派发 `setSessMode`/`setSessionMode`；分隔线沿菜单既有样式类渲染。）

`DirPicker.tsx`：manual 勾选改 `acceptEdits` 会话勾选，`onConfirm(path, mode: 'acceptEdits' | 'full-access')`，提示文案 `t('Workspace-edit session: approvals/questions wait for a human decision', '工作区编辑会话：审批/问询挂起等待人工裁决')`。

- [ ] **Step 4: 跑 GUI 测试 + 全量**

Run: gui 测试 + `pnpm test`；Expected: 绿

- [ ] **Step 5: Commit**

```bash
git add gui/src
git commit -m "refactor(gui): 权限档改名对齐后端+四项菜单(spec §3.4/§6)——mode 类型四值同步;ModeIcon 增 read-only=Eye;菜单两段:计划模式置顶置灰(即将可用,阶段三接通)+只读/工作区编辑/完全访问;新会话勾选改 acceptEdits 语义;旧档名全退"
```

### Task 5: ChainAction 扩员 'plan'

**Files:**
- Modify: `src/types.ts:439-451`
- Modify: `src/harness/context/messages.ts`（buildMessages 动作分流处）
- Test: 既有 context 测试文件内追加

**Interfaces:**
- Produces: `ChainAction` 新成员 `'plan'`（计划书全文行）;messages 消费面与 `'task'` 同形态透出。

- [ ] **Step 1: 写失败测试**（沿既有 context 测试文件构造帮手）

```ts
test("ChainAction 'plan'：计划书行按 task 同等透出", () => {
  const ctx = makeContext(); // 沿该文件既有帮手
  ctx.appendChain([{ action: 'plan', observation: '# 计划书\n1. 步骤A' }]);
  const items = chainToHistoryItems(ctx.chainView());
  const assembled = ctx.assemble(items);
  assert.ok(assembled.some((m) => m.role === 'user' && m.content.includes('# 计划书')), '计划书应入消息视图');
});
```

- [ ] **Step 2: 跑定点确认失败**（`<TEST>` = 该 context 测试文件）；Expected: FAIL（'plan' 未登记/未透出）

- [ ] **Step 3: 实现**

`types.ts` 词汇表追加：`| 'plan' /* 计划书全文（planFlow 批准后注入,一次;messages 按 task 同形态透出） */`。`messages.ts` buildMessages 动作分流处把 `'plan'` 与 `'task'` 并列同一分支（找到 `case 'task'` 或等价 action 分流点,同一消息形态）。

- [ ] **Step 4: 跑定点 + 全量**；Expected: 绿

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/harness/context/messages.ts src/harness/context/*.test.ts
git commit -m "feat(context): ChainAction 扩员 'plan'(spec §4.4)——计划书全文行,批准后一次入链;messages 消费面按 task 同形态透出,水位膨胀由既有压缩面承载"
```

### Task 6: SecurityGuard 档位临时覆盖接缝

**Files:**
- Modify: `src/harness/security/guard.ts`（mode getter 与 override 字段）
- Test: 既有 guard 测试文件内追加

**Interfaces:**
- Produces: `enterModeOverride(mode: PermissionMode): void` / `exitModeOverride(): void`；`get mode()` 返回 `override ?? modeName`（Task 7/8/9 消费）。

- [ ] **Step 1: 写失败测试**

```ts
test('档位临时覆盖：覆盖期 read-only 拒写,exit 后恢复基档', () => {
  const guard = new SecurityGuard(new PolicyEngine(), 'full-access');
  guard.enterModeOverride('read-only');
  assert.equal(guard.mode, 'read-only');
  const r = guard.preToolUse('Write', { path: '/tmp/x.txt', content: 'hi' });
  assert.equal(r.allowed, false, '覆盖期写操作必须被只读闸门拒绝');
  guard.exitModeOverride();
  assert.equal(guard.mode, 'full-access');
  assert.equal(guard.preToolUse('Write', { path: '/tmp/x.txt', content: 'hi' }).allowed, true);
});
```

- [ ] **Step 2: 跑定点确认失败**；Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**

`guard.ts`（mode getter 处）：

```ts
/** 档位临时覆盖（planFlow 规划轮 read-only;enter/exit 配对,try/finally 由调用方保证）：
 *  判定面按覆盖值;轻量字段不重建 runtime,运行中模式切换本就 409/禁用,覆盖期无并发源（spec §4.1） */
private override: PermissionMode | undefined;
enterModeOverride(mode: PermissionMode): void { this.override = mode; }
exitModeOverride(): void { this.override = undefined; }
get mode(): PermissionMode { return this.override ?? this.modeName; }
```

- [ ] **Step 4: 跑定点 + 全量**；Expected: 绿
- [ ] **Step 5: Commit**

```bash
git add src/harness/security/guard.ts src/harness/security/*.test.ts
git commit -m "feat(security): SecurityGuard 档位临时覆盖接缝(spec §4.1)——enterModeOverride/exitModeOverride 配对,mode getter 按覆盖值判定;planFlow 规划轮只读的结构性承载,不重建 runtime"
```

### Task 7: planFlow 共享模块

**Files:**
- Create: `src/harness/plan-flow.ts`
- Modify: `src/tui/chat-model.ts:305-306`（PLAN_TASK_LABEL 迁出改 re-export）
- Test: Create `src/harness/plan-flow.test.ts`

**Interfaces:**
- Produces（Task 8/9 消费,签名逐字）:
  - `interface PlanStep { text: string; status: 'pending' | 'in_progress' | 'completed' }`
  - `type PlanFlowEvent = { type: 'planning'; round: number } | { type: 'awaiting-approval'; doc: string; items: string[] } | { type: 'revising'; round: number } | { type: 'approved'; doc: string; items: string[] } | { type: 'aborted'; reason: 'interrupted' | 'exhausted' | 'empty' }`
  - `interface PlanDecision { approved: boolean; feedback?: string }`
  - `interface PlanFlowSeams { runPlanningTask(prompt: string, signal?: AbortSignal): Promise<{ done: boolean; stopReason?: string; reply?: string }>; enterReadOnly(): void; exitReadOnly(): void; todosSnapshot(): PlanStep[]; chainAppendPlan(doc: string): void; emit(e: PlanFlowEvent): void; awaitApproval(doc: string, items: string[]): Promise<PlanDecision>; signal?: AbortSignal }`
  - `const PLAN_MAX_ROUNDS = 3`、`const PLAN_TASK_LABEL = 'Produce an investigation-backed plan document'`
  - `runPlanFlow(goal: string, seams: PlanFlowSeams, feedback?: string): Promise<{ doc: string; items: string[] } | null>`——批准返回产物；中断/超限/无产物返回 null（宿主如实回执）。
  - `parseNumberedSteps(text: string): string[]`（现 session.ts 解析逻辑迁入,兜底共用）

- [ ] **Step 1: 写失败测试**（全 mock 接缝,六例）

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanFlow, parseNumberedSteps, PLAN_TASK_LABEL, PlanStep } from './plan-flow';

function mockSeams(over: Partial<Parameters<typeof runPlanFlow>[1]> = {}) {
  const events: string[] = [];
  let readonly_ = false;
  const seams = {
    events, readonlyOn: () => { readonly_ = true; }, readonlyOff: () => { readonly_ = false; },
    runPlanningTask: async () => ({ done: true, reply: '# 计划\n1. A\n2. B' }),
    enterReadOnly: () => seams.readonlyOn(), exitReadOnly: () => seams.readonlyOff(),
    todosSnapshot: (): PlanStep[] => [],
    chainAppendPlan: () => {},
    emit: (e: { type: string }) => events.push(e.type),
    awaitApproval: async () => ({ approved: true }),
  ...over } as Parameters<typeof runPlanFlow>[1] & { events: string[]; readonlyOn(): boolean };
  return seams;
}

test('主路径：规划→批准→返回产物,read-only 覆盖成对进出', async () => {
  const s = mockSeams();
  const r = await runPlanFlow('做一件事', s);
  assert.deepEqual(r, { doc: '# 计划\n1. A\n2. B', items: ['A', 'B'] });
  assert.deepEqual(s.events, ['planning', 'awaiting-approval', 'approved']);
  assert.ok(s.readonlyOn() === false, 'exit 后覆盖应已解除');
});

test('判别力锚：规划轮进入 read-only 覆盖（漏掉 enter 即红）', async () => {
  let entered = false;
  const s = mockSeams({ enterReadOnly: () => { entered = true; } });
  await runPlanFlow('g', s);
  assert.ok(entered, '规划轮必须 enter read-only');
});

test('todos 权威：todo_write 步骤优先于正文解析', async () => {
  const s = mockSeams({ todosSnapshot: () => [{ text: 'T1', status: 'pending' }, { text: 'T2', status: 'pending' }] });
  const r = await runPlanFlow('g', s);
  assert.deepEqual(r?.items, ['T1', 'T2'], 'items 应来自 todos 而非正文编号行');
});

test('todos 空 → 正文编号行兜底；正文也无步骤 → aborted empty', async () => {
  const s1 = mockSeams();
  assert.deepEqual((await runPlanFlow('g', s1))?.items, ['A', 'B']);
  const s2 = mockSeams({ runPlanningTask: async () => ({ done: true, reply: '没有步骤' }) });
  assert.equal(await runPlanFlow('g', s2), null);
  assert.ok(s2.events.includes('aborted'));
});

test('拒绝+反馈 → revising 重入;3 轮超限 → aborted exhausted 不自动执行', async () => {
  let n = 0;
  const s = mockSeams({ awaitApproval: async () => ({ approved: false, feedback: `fb${++n}` }) });
  assert.equal(await runPlanFlow('g', s), null);
  assert.equal(n, 3, '含首轮共 3 份计划书');
  assert.ok(s.events.filter((e) => e === 'revising').length === 2 && s.events.at(-1) === 'aborted');
});

test('规划段中断 → aborted interrupted;批准走 chainAppendPlan', async () => {
  const s1 = mockSeams({ runPlanningTask: async () => ({ done: false, stopReason: 'interrupted' }) });
  assert.equal(await runPlanFlow('g', s1), null);
  assert.ok(s1.events.at(-1) === 'aborted');
  const s2 = mockSeams();
  await runPlanFlow('g', s2);
  assert.ok((s2 as unknown as { chainAppendPlan: () => void }).chainAppendPlan, 'seams 暴露注入点');
});
```

（最后一例的注入断言并入主路径亦可——实现后以实际调用计;`chainAppendPlan` 必须在批准路径被调,测试以 spy 计数断言 `called === 1`。）

- [ ] **Step 2: 跑定点确认失败**（`<TEST>` = `dist/harness/plan-flow.test.js`）；Expected: FAIL

- [ ] **Step 3: 实现 `src/harness/plan-flow.ts`**

```ts
/** planFlow 共享模块（spec 2026-10-24-plan-mode-redesign §4）：计划流程编排单点,TUI/serve 薄壳消费。
 *  纯流程零 IO 政策——规划任务/待办面/档位覆盖/链注入/审批全部走接缝;状态机:
 *  planning → awaiting-approval →(批准)approved |(拒绝+反馈)revising → planning;
 *  中断/超限/无产物 aborted。依赖方向:harness 内自洽,宿主(tui/serve)注入接缝。 */

export interface PlanStep { text: string; status: 'pending' | 'in_progress' | 'completed' }
export type PlanFlowEvent =
  | { type: 'planning'; round: number }
  | { type: 'awaiting-approval'; doc: string; items: string[] }
  | { type: 'revising'; round: number }
  | { type: 'approved'; doc: string; items: string[] }
  | { type: 'aborted'; reason: 'interrupted' | 'exhausted' | 'empty' };
export interface PlanDecision { approved: boolean; feedback?: string }
export interface PlanFlowSeams {
  runPlanningTask(prompt: string, signal?: AbortSignal): Promise<{ done: boolean; stopReason?: string; reply?: string }>;
  enterReadOnly(): void;
  exitReadOnly(): void;
  todosSnapshot(): PlanStep[];
  chainAppendPlan(doc: string): void;
  emit(e: PlanFlowEvent): void;
  awaitApproval(doc: string, items: string[]): Promise<PlanDecision>;
  signal?: AbortSignal;
}
export const PLAN_MAX_ROUNDS = 3;
/** /plan 规划轮任务标签（D10:规划提示词与宿主任务标签共用单源;自 chat-model 迁入,tui re-export） */
export const PLAN_TASK_LABEL = 'Produce an investigation-backed plan document';

function planPrompt(goal: string, feedback?: string): string {
  return (
    `${PLAN_TASK_LABEL} for the goal below. First investigate the relevant code with Read/Grep/Glob (the session is temporarily read-only). ` +
    `Then reply with the full plan document in markdown — sections: Background, Approach, Files, Steps (numbered "1. ..."), Risks, Verification. ` +
    `Also call todo_write once with the full step list (every item pending), one todo per step, matching the Steps section.` +
    (feedback ? `\nThe previous plan was rejected with this feedback — revise the plan accordingly:\n${feedback}` : '') +
    `\nGoal: ${goal}`
  );
}

/** 正文编号行解析（todos 兜底路径;**逐字迁移** src/tui/session.ts:620-624 现实现——split→trim→去编号前缀→滤空,行为等价勿加戏） */
export function parseNumberedSteps(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
    .filter((l) => l.length > 0);
}
```

```ts
export async function runPlanFlow(goal: string, seams: PlanFlowSeams, feedback?: string): Promise<{ doc: string; items: string[] } | null> {
  for (let round = 1; round <= PLAN_MAX_ROUNDS; round++) {
    if (seams.signal?.aborted) { seams.emit({ type: 'aborted', reason: 'interrupted' }); return null; }
    seams.emit(round === 1 ? { type: 'planning', round } : { type: 'revising', round });
    seams.enterReadOnly();
    let out: { done: boolean; stopReason?: string; reply?: string };
    try {
      out = await seams.runPlanningTask(planPrompt(goal, round === 1 ? feedback : undefined), seams.signal);
    } finally {
      seams.exitReadOnly();
    }
    if (!out.done || out.stopReason === 'interrupted' || seams.signal?.aborted) {
      seams.emit({ type: 'aborted', reason: 'interrupted' });
      return null;
    }
    const doc = out.reply ?? '';
    const items = seams.todosSnapshot().map((t) => t.text).filter((t) => t.trim() !== '');
    const finalItems = items.length > 0 ? items : parseNumberedSteps(doc);
    if (finalItems.length === 0) {
      seams.emit({ type: 'aborted', reason: 'empty' });
      return null;
    }
    seams.emit({ type: 'awaiting-approval', doc, items: finalItems });
    const d = await seams.awaitApproval(doc, finalItems);
    if (d.approved) {
      seams.chainAppendPlan(doc);
      seams.emit({ type: 'approved', doc, items: finalItems });
      return { doc, items: finalItems };
    }
    feedback = d.feedback;
  }
  seams.emit({ type: 'aborted', reason: 'exhausted' });
  return null;
}
```

`src/tui/chat-model.ts:305-306`：删除本地定义,改 `export { PLAN_TASK_LABEL } from '../harness/plan-flow';`（全部既有 import 不断）。

- [ ] **Step 4: 跑定点 + 全量**；Expected: 绿
- [ ] **Step 5: Commit**

```bash
git add src/harness/plan-flow.ts src/harness/plan-flow.test.ts src/tui/chat-model.ts
git commit -m "feat(plan): planFlow 共享模块(spec §4.1-4.3)——纯流程编排零 IO 政策,接缝具名单对象(规划任务/read-only 覆盖/todos 快照/链注入/审批挂起/事件);状态机 planning→awaiting-approval→approved|revising,3 轮上限,todos 权威+正文编号行兜底,中断/超限/无产物 aborted 如实;PLAN_TASK_LABEL 迁 harness 单源(chat-model re-export,D10 保持);判别力锚=规划轮必须 enter read-only"
```

### Task 8: TUI 接入 planFlow（重造 /plan）

**Files:**
- Modify: `src/tui/session.ts:305-306,360-361,560-580,582-640,643+`（startPlanFlow/confirmPlan/pendingPlan/runPlanItems 步骤源）
- Modify: `src/tui/components/use-approval-keys.ts:60-80`（计划卡键位：n=反馈输入）
- Modify: `src/tui/components/App.tsx:66,369`（提示文案）
- Test: Rewrite `src/tui/session.plan.test.ts`

**Interfaces:**
- Consumes: Task 5 `'plan'` 入链、Task 6 override、Task 7 `runPlanFlow` 全套签名。
- Produces: `confirmPlan(yes: boolean, feedback?: string): Promise<void>`（GUI 阶段同语义）；`pendingPlan?: { doc: string; items: string[] }`。

- [ ] **Step 1: 翻新 session.plan.test.ts（先红）**

核心改造（沿既有 SessionController+ScriptedAdapter 形态）：规划轮回包改计划书形态；新增五例——①计划书入链断言（`ctrl` 暴露的链账本含 `action: 'plan'` 行且正文完整）;②规划轮调 Write 被拒（判别力锚,见下）;③拒绝附反馈 → 二轮规划（ScriptedAdapter 多包:第一轮计划书、第二轮修订计划书）→ 批准执行;④3 轮拒绝超限回 idle 不执行;⑤批准后档位落 acceptEdits（`ctrl` 读 guard.mode）。

判别力锚例（规划轮模型执意写文件 → 拒绝回执进规划上下文,计划照常产出）：

```ts
test('/plan：规划轮挂 read-only——模型调 Write 被拒且不影响规划产出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-ro-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool_calls":[{"name":"Write","arguments":{"path":"pwned.txt","content":"x"}}]}',
        '{"done":true,"reply":"# 计划\\n背景…\\n1. 唯一步骤"}',
        '{"done":true,"reply":"完成"}',
      ]),
    });
    await ctrl.submit('/plan 写个文件');
    await ctrl.confirmPlan(true);
    await ctrl.waitIdle();
    assert.ok(!fs.existsSync(path.join(tmp, 'pwned.txt')), '规划轮绝不能产生文件副作用');
    const todos = ctrl.getState().todos;
    assert.equal(todos.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑定点确认失败**（`<TEST>` = `dist/tui/session.plan.test.js`）；Expected: FAIL

- [ ] **Step 3: 实现 session.ts**

`pendingPlan` 改形：`pendingPlan?: { doc: string; items: string[] }`；决策回执单点：

```ts
private planDecide?: (d: { approved: boolean; feedback?: string }) => void;
private planFlowRunning = false;
async confirmPlan(yes: boolean, feedback?: string): Promise<void> {
  const pending = this.pendingPlan;
  if (!pending) return;
  this.pendingPlan = undefined;
  const decide = this.planDecide;
  this.planDecide = undefined;
  decide?.({ approved: yes, feedback });
  if (yes || !this.planFlowRunning) {
    // 批准（或流程不在途的旧式放弃）：状态出清与回执沿现 confirmPlan 路径
    if (!yes) {
      this.state = { ...this.state, status: 'idle', pauseConfirm: undefined };
      this.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
      return;
    }
    // 批准:常量漂移探测沿现路径前移至此,然后 runPlanItems(pending.items)
    const notices = this.runtime.harness.context.checkConstantsDrift();
    for (const n of notices) this.runtime.harness.context.appendChain([{ action: 'notice', observation: n }]);
    await this.runPlanItems(pending.items);
  }
  // 拒绝且流程在途:planFlow 自行重入规划/超限收尾,这里不清状态
}
```

`startPlanFlow` 重写为 planFlow 消费壳：

```ts
private async startPlanFlow(goal: string): Promise<void> {
  /* 状态置 running/统计/abort 沿现实现 */
  this.planFlowRunning = true;
  try {
    const r = await runPlanFlow(goal, {
      runPlanningTask: (prompt) => this.runInternalTask(prompt, PLAN_TASK_LABEL), // 中断信号沿 runInternalTask 既有的 taskAbort 透传,无需改签名
      enterReadOnly: () => this.runtime.harness.security.enterModeOverride('read-only'),
      exitReadOnly: () => this.runtime.harness.security.exitModeOverride(),
      todosSnapshot: () => this.getState().todos.map((t) => ({ text: t.text, status: t.status })),
      chainAppendPlan: (doc) => {
        const ctx = this.runtime.harness.context;
        ctx.appendChain([{ action: 'plan', observation: doc }]);
      },
      emit: (e) => {
        if (e.type === 'awaiting-approval') {
          this.pendingPlan = { doc: e.doc, items: e.items };
          const card = [
            t('Plan confirmation (/plan)', '计划确认卡（/plan）'),
            e.doc,
            '---',
            ...e.items.map((item, i) => `${i + 1}. ${item}`),
            t(`${e.items.length} items; y approve / n reject with feedback / Esc discard`, `${e.items.length} 项；y 批准 / n 拒绝（附反馈）/ Esc 放弃`),
          ].join('\n');
          this.pushMsg('system', card);
          this.state = { ...this.state, status: 'awaiting-plan' };
          this.notify();
          return;
        }
        if (e.type === 'revising') {
          this.pushMsg('system', t(`Revising plan with your feedback (round ${e.round}/${PLAN_MAX_ROUNDS})`, `按反馈修订计划中（第 ${e.round}/${PLAN_MAX_ROUNDS} 轮）`));
          return;
        }
        if (e.type === 'aborted') {
          const why = e.reason === 'interrupted'
            ? t('Planning interrupted', '规划已中断')
            : e.reason === 'exhausted'
              ? t('Plan rejected 3 times — stopped, nothing executed', '计划已被拒 3 轮——已停止，未执行任何步骤')
              : t('Planning produced no steps — cancelled', '规划未产出步骤——已取消');
          this.pushMsg('system', why, { level: 'warn' });
          this.closeTask();
        }
        // planning: 状态置 running 沿 startPlanFlow 现实现
      },
      awaitApproval: (doc, items) => new Promise((resolve) => { this.planDecide = resolve; }),
      signal: this.taskAbort?.signal,
    });
    if (r) {
      // 批准:漂移探测(现 confirmPlan 内逻辑前移至此)→ 落 acceptEdits(pill/状态回执) → runPlanItems(r.items)
    } else {
      /* aborted:如实回执(中断/超限/无产物三分支文案),closeTask */
    }
  } finally {
    this.planFlowRunning = false;
    this.planDecide = undefined;
  }
}
```

`runInternalTask` 增第三参 `signal?` 透传（现签名 `(prompt, label)`）。`runPlanItems` 签名不变（items 从 planFlow 产物来）;批准后的 `landAcceptEdits` 在 TUI 侧=会话档本就 acceptEdits 缺省时无操作、否则回执提示「已切换到工作区编辑档」（TUI 无 serve 的 runtime 重建问题,guard.modeName 由宿主沿既有 /mode 命令面改写,若无该面则仅回执——**以最小实现为准:TUI 侧档位切换沿既有模式命令通道,planFlow 不直改 modeName**）。

`use-approval-keys.ts` 计划卡分支：`n` 不再直接 `confirmPlan(false)`,改进入反馈输入态（控制器新增 `planFeedbackMode?: boolean`;反馈输入复用 composer 输入,Enter 提交 `confirmPlan(false, text)`,空文本/Esc=`confirmPlan(false)`）;`App.tsx:66` 提示改 `'Plan awaiting confirmation: y approve / n reject with feedback / Esc discard'`。

- [ ] **Step 4: 跑定点 + 全量**

Run: 定点模板（`dist/tui/session.plan.test.js` + `dist/tui/session.incomplete.test.js`）+ `pnpm test`
Expected: 绿

- [ ] **Step 5: Commit**

```bash
git add src/tui/session.ts src/tui/components/use-approval-keys.ts src/tui/components/App.tsx src/tui/session.plan.test.ts src/tui/session.incomplete.test.ts
git commit -m "feat(tui): /plan 重造接入 planFlow(spec §4.2-4.4)——规划轮 read-only 覆盖(判别力锚:规划轮 Write 落盘即红);计划书=reply 正文权威+todos 权威/正文兜底;确认卡计划书全文+拒绝反馈输入(n→反馈,Esc 放弃);批准后 ChainAction 'plan' 注入链+落 acceptEdits 回执+逐项执行;3 轮驳回环;中断/超限如实回执"
```

### Task 9: serve plan-arm 提交通道 + plan 审批挂起

**Files:**
- Modify: `src/serve/session.ts`（submit 拦截+planFlow 接缝+挂起类型）
- Modify: `src/serve/session-commands.ts:16`（COMMAND_SUPPORT 扩 `/plan` + 分支）
- Modify: `src/serve/session-handlers.ts`（挂起决策路由 payload 扩展,沿既有审批路由）
- Test: Create `src/serve/plan-flow.e2e.test.ts`

**Interfaces:**
- Consumes: Task 7 `runPlanFlow`;Task 3 SessionMode `'plan'` 标记。
- Produces: 挂起类型 `kind: 'plan-approval'`（payload `{ doc, items }`,决策 `{ approved, feedback? }`）;arm 语义——批准/切档解除,拒绝保持 armed。

- [ ] **Step 1: 写失败 e2e（先红）**

沿 `src/serve` 既有 session 测试文件的构造帮手（与 Task 3 mode 契约测试同源;内核档恒三档——arm 在 serve 包装层,构造时 `mode: 'plan'` 传给 **serve 会话**,装配映射自动落到内核 acceptEdits）：

```ts
test('serve plan-arm：提交→规划(read-only)→挂起卡→批准→acceptEdits→执行', async () => {
  const s = makeServeSession(tmp, {
    mode: 'plan',
    model: new ScriptedAdapter([
      '{"done":true,"reply":"# 计划\\n1. 唯一步骤"}',            // 规划包(todos 空→正文兜底)
      '{"done":true,"reply":"唯一步骤 完成"}',                    // 执行包
    ]),
  });
  assert.equal(s.submit('做一件事').ok, true);
  const approval = await s.snapshotPending();                   // 沿该测试文件既有挂起快照帮手
  assert.equal(approval?.kind, 'plan-approval');
  assert.match(approval?.payload?.doc ?? '', /# 计划/);
  await s.decidePending({ approved: true });                    // 沿既有决策回执通道
  await s.waitIdle();
  assert.equal(s.snapshotResponse().mode, 'acceptEdits', '批准后档位自动落工作区编辑(arm 解除)');
  assert.ok(s.chainView().some((st) => st.action === 'plan'), '计划书应入链');
});

test('serve plan-arm：拒绝附反馈→revising→3 轮超限保持 armed', async () => {
  const s = makeServeSession(tmp, { mode: 'plan', model: new ScriptedAdapter([/* 三个规划包 */]) });
  s.submit('g');
  for (let i = 0; i < 3; i++) {
    await s.snapshotPending();
    await s.decidePending({ approved: false, feedback: `fb${i}` });
    await s.waitIdle();
  }
  assert.equal(s.snapshotResponse().mode, 'plan', '拒绝不解除 arm');
  assert.ok(s.chainView().every((st) => st.action !== 'task' || !st.observation.includes('执行')), '超限不执行任何步骤');
});
```

（`makeServeSession`/`snapshotPending`/`decidePending` 以该测试文件既有帮手实名为准——若不存在则沿同目录既有 session 测试的装配函数直构，断言目标不变。）

- [ ] **Step 2: 跑定点确认失败**；Expected: FAIL

- [ ] **Step 3: 实现**

`serve/session.ts`：

```ts
/** plan-arm（spec §5.1）：mode==='plan' 即 armed——下条 submit 经 planFlow;批准落 acceptEdits 自动解除,
 *  手动切档解除,拒绝保持 armed。装配映射恒 acceptEdits(Task 3),此处只管流程。 */
private planArmed(): boolean { return this.currentMode === 'plan'; }
private planDecide?: (d: { approved: boolean; feedback?: string }) => void;
```

`submit(goal): SessionSubmitResult`（:546）入口拦截：

```ts
if (this.planArmed() && this.status() === 'idle') {
  void this.runPlanArm(goal);
  return { ok: true };
}
```

`runPlanArm(goal)`：接缝实现——`runPlanningTask` 走 `this.runtime.runTask(label, { scope: 'fork', seedHistory: [...链视图, task 行], signal })`（沿 TUI runInternalTask 同构）;`enterReadOnly/exitReadOnly` 走 guard override;`todosSnapshot` 走快照 todos;`chainAppendPlan` 走 context.appendChain;`emit` 走 pump(notice/事件行);`awaitApproval` 走**挂起表新增 plan 类型**：

```ts
private awaitPlanApproval(doc: string, items: string[]): Promise<{ approved: boolean; feedback?: string }> {
  return new Promise((resolve) => {
    this.suspendPlanApproval({ doc, items, resolve }); // 挂起表注册→WS 广播 plan-approval 卡;回执路由在 handlers
  });
}
```

决策落地：`approved` → `this.setMode('acceptEdits')`（idle 时刻合法）→ `runPlanItems` 同构逐项执行（沿 TUI 语义:每步 runtime.runTask+todo 勾选,失败宁停）;`!approved` → 保持 armed,revising 回执。

回放语义（spec §5.2，跨重启不恢复 arm）：`persistSelection` 照写 `mode:'plan'`，但 attach 回放走 `resolveModeAlias`（Task 2）——`plan→acceptEdits`，armed 天然不跨重启；已批准的计划书随链（`'plan'` 行）回放。无需新增旁车键。`session-commands.ts:16` `COMMAND_SUPPORT` 追加 `'/plan'`,分支 `runCommand` 内 `s.setMode('plan')` + `s.submit(其余参数)`（等价于单选后提交）。

- [ ] **Step 4: 跑定点 + 全量**；Expected: 绿
- [ ] **Step 5: Commit**

```bash
git add src/serve/session.ts src/serve/session-commands.ts src/serve/session-handlers.ts src/serve/plan-flow.e2e.test.ts
git commit -m "feat(serve): plan-arm 提交通道+plan 审批挂起(spec §5.1)——mode='plan' 即 armed,submit 入口拦截转 planFlow(接缝同构 TUI);挂起表新增 kind='plan-approval'(payload 计划书+items,决策带 feedback);批准落 acceptEdits 自动解除/拒绝保持 armed/手动切档解除;/plan 命令入 COMMAND_SUPPORT;e2e 两例(批准主路径/拒绝超限保持 armed)"
```

### Task 10: GUI 计划卡与置灰解除

**Files:**
- Modify: `gui/src/pages/chat/ComposerPills.tsx`（计划模式 `disabled: true` 移除,desc 改正式文案）
- Create: `gui/src/pages/chat/PlanCard.tsx`（计划书 markdown 渲染+步骤+批准/反馈输入）
- Modify: `gui/src` 聊天视图挂载点（沿既有审批卡挂载形态接 PlanCard）
- Modify: `gui/src/connection.ts`（plan-approval 挂起订阅+决策回执 API,沿既有 approval 决策通道扩展）
- Test: `gui/src` 组件测试（PlanCard 批准/反馈两路径）

**Interfaces:**
- Consumes: Task 9 `kind: 'plan-approval'` 挂起 payload/决策协议。

- [ ] **Step 1: 写失败组件测试**

```tsx
test('PlanCard：批准按钮回执 approved;反馈输入+提交回执 approved=false+feedback', async () => {
  const decisions: Array<{ approved: boolean; feedback?: string }> = [];
  render(<PlanCard doc="# 计划" items={['A', 'B']} onDecide={(d) => decisions.push(d)} />);
  fireEvent.click(screen.getByText(/Approve|批准/));
  assert.deepEqual(decisions, [{ approved: true }]);
  fireEvent.click(screen.getByText(/Reject|拒绝/));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '第二步拆细' } });
  fireEvent.click(screen.getByText(/Send|提交/));
  assert.deepEqual(decisions[1], { approved: false, feedback: '第二步拆细' });
});
```

- [ ] **Step 2: 跑 GUI 测试确认失败**；Expected: FAIL

- [ ] **Step 3: 实现**

PlanCard 组件（markdown 渲染沿 GUI 既有 markdown 通道;步骤列表只读;批准/拒绝两按钮+拒绝展开反馈输入框）;挂载点：GUI 聊天视图既有审批卡（approval/question 挂起卡）的条件渲染处并列一分支——WS 快照/事件带 `kind: 'plan-approval'` 挂起即渲染 PlanCard、回执经 `connection.ts` 决策 API（沿既有 approval 回执 API 加 kind 分支,决策体 `{ approved, feedback? }`）;ComposerPills 计划模式行 `disabled` 移除、desc 改 `t('Plan first — approve before execution', '先规划，批准后执行')`。

- [ ] **Step 4: 跑 GUI 测试 + 全量**；Expected: 绿
- [ ] **Step 5: Commit**

```bash
git add gui/src
git commit -m "feat(gui): 计划确认卡+计划模式置灰解除(spec §5.2)——PlanCard(计划书 markdown+步骤+批准/拒绝反馈输入);plan-approval 挂起订阅与决策回执;计划模式单选正式开放(arm 语义:批准落工作区编辑,拒绝保持)"
```

### Task 11: 文档同步与收尾门禁

**Files:**
- Modify: `CLAUDE.md`（权限模式描述处与本地测试面提及旧档名处）
- Modify: `docs/HARNESS-BACKLOG.md`（若权限模式/plan 相关债项在册,翻转并补注记;无则跳过）

- [ ] **Step 1: 枚举旧档名残留**

```bash
grep -rn "dontAsk\|'manual'\|manual 会话\|plan mode" CLAUDE.md docs/*.md MANUAL-GUI.md 2>/dev/null | grep -v superpowers
```

逐处更新为新档名/新语义（含 GUI/CLI 帮助截图类文档若有）;`CLAUDE.md` 目录树/权限模式段落补 `plan-flow.ts` 一行。

- [ ] **Step 2: 全量门禁**

Run: `pnpm test && pnpm selfcheck`
Expected: 全绿 + selfcheck 0

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/HARNESS-BACKLOG.md
git commit -m "docs: 权限档重构与 plan 重造收尾——CLAUDE.md 档名/planFlow 登记,旧档名残留清零;三阶段落地与 spec 对账(2026-10-24-plan-mode-redesign)"
```
