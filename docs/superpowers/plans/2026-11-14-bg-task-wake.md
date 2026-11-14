# 后台任务唤醒（bg-wake）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台任务到终态时自动唤醒空闲会话续跑；run 行显示「后台任务 {任务名} 唤醒，运行中 N 秒」；任务名点击路由到对应页签。

**Architecture:** 唤醒是状态驱动的系统事件（任务终态 × 未 receipted × 空闲），判定收在 session 层 `WakeController`；模型输入 = 转录 notice 条（`wake` 元数据）+ 链尾 note 步，live 与恢复同构；两端宿主（daemon/TUI）在轮收束处各加一处续发分支；GUI/TUI 渲染层只在 run 行拼前缀。

**Tech Stack:** TypeScript（node:test 根包 + vitest GUI）、React 18（GUI）、ink（TUI）、JSONL 会话档（seglog）。

**Spec:** `docs/superpowers/specs/2026-11-09-bg-task-wake-design.md`（本文与 spec 矛盾处以 spec 为准；spec §10 各项按本 plan 落地时同步收口）。

## Global Constraints

- 唤醒不进等待队列（`SteerItem`/`steerEnqueue` 零改动）、不产 user 条目、不出气泡（不调 `broadcastUserEcho`）。
- 用户消息永远优先：轮收束时 steer 队列非空 → 走既有 G14.89，唤醒 pending 留存。
- spawn/exec/团队工具**描述**一字不改；只有后台分派**回执**追加 `WAKE_HINT` 一句（三道挂载闸见 Task 3）。
- 系统提示零改动（定性说明写在通知正文内），前缀缓存零击穿。
- 显示：一行前缀；不区分失败成功；多任务只显示第一个；无名整行无点击；「后台任务」「唤醒」字样恒静态；定位瞬跳无 flash（CLAUDE.md §13.1 规则 6）；GUI 悬浮提示用 `data-tip` 禁原生 `title`（§13.1 规则 2）。
- 每批完成即提交（conventional commits，中文说明，风格随 `git log`）；全量门禁 = `pnpm test`（根包）+ `pnpm --dir gui test`，最后一批加 `pnpm --dir gui run test:e2e`。
- 定向跑测命令（根包）：`node --require scripts/test-env.cjs --test dist/<路径>.test.js`（先 `pnpm exec tsc -p tsconfig.json`）。
- `gui/src/app.css` 当前有**另一会话的未提交改动**：Task 6 的 CSS 只允许**文件末尾追加**新段，不得触碰既有行。

---

### Task 1: session 数据面——WakeRef 类型、notice 归约、安静判定、seg 落档/恢复

**Files:**
- Modify: `src/session/entry.ts`（KernelEntry、notice case、isQuietNotice、parseWakeRefs）
- Modify: `src/session/seglog.ts`（kernelEventRows seg 行、reduceSegRows seg case、JournalEvent seg 变体）
- Test: `src/session/kernel.test.ts`（追加用例）、`src/session/seglog.test.ts`（追加用例）

**Interfaces:**
- Produces: `entry.ts` 导出 `interface WakeRef { id: string; name?: string; board?: true; boardRef?: string }` 与 `parseWakeRefs(raw: unknown): WakeRef[] | undefined`；`KernelEntry.wake?: WakeRef[]`（后续所有 Task 消费）。
- Produces: journal seg 行可选字段 `wake`（旧档无此字段 = 普通 notice，恢复面零变化）。

- [ ] **Step 1: 写失败测试（kernel.test.ts 追加）**

```ts
// 追加到 src/session/kernel.test.ts（与既有 notice 用例同 describe 或新 describe 'bg-wake'）
test('notice 事件携带合法 wake 载荷 → 条目回填 wake；非法载荷丢字段退化为普通 notice', () => {
  const k = new SessionKernel();
  k.pump({ type: 'notice', text: 'boot', ts: 1, payload: { wake: [{ id: 't1', name: '构建前端' }, { board: true }] } });
  const ok = k.state.entries.find((e) => e.kind === 'notice');
  assert.deepEqual(ok?.wake, [{ id: 't1', name: '构建前端' }]); // 非法条目({board:true} 无 id)被剔除，合法条目保留

  const k2 = new SessionKernel();
  k2.pump({ type: 'notice', text: 'boot', ts: 1, payload: { wake: 'nope' } });
  const bad = k2.state.entries.find((e) => e.kind === 'notice');
  assert.equal(bad?.wake, undefined);
});

test('唤醒通知属安静 notice（<task-notification> 开头），journal 审计面保留、显示面过滤', () => {
  assert.equal(isQuietNotice('<task-notification>\nAutomated notice'), true);
  assert.equal(isQuietNotice('ask p1 answered'), true); // 既有规则不回归
});
```

- [ ] **Step 2: 写失败测试（seglog.test.ts 追加——落档/恢复往返）**

```ts
test('wake notice 落档往返：kernelEventRows seg 行携带 wake，reduceSegRows 恢复逐字段恒等', () => {
  const entry: KernelEntry = { seq: 7, ts: 5, kind: 'notice', md: '<task-notification>x</task-notification>', wake: [{ id: 'a', name: 'n' }, { id: 'b', board: true, boardRef: 't3' }] };
  const rows = kernelEventRows({ t: 'seg-open', entry, open: false });
  const segRow = rows.find((r) => r.t === 'seg') as { t: 'seg'; wake?: unknown };
  assert.deepEqual(segRow.wake, entry.wake);
  const back = reduceSegRows([rows]); // 按该文件既有 reduce 入参形态装配（旧用例同款）
  const got = back.entries.find((e) => e.seq === 7);
  assert.deepEqual(got?.wake, entry.wake);
  // 旧档无 wake 字段 → 普通 notice
  const legacy = reduceSegRows([[{ t: 'seg', kind: 'notice', md: 'plain', ts: 1, seq: 8 }]]);
  assert.equal(legacy.entries.find((e) => e.seq === 8)?.wake, undefined);
});
```

（`reduceSegRows` 的入参分组形态以该测试文件既有用例写法为准——先读再抄形，断言面保持本用例语义。）

- [ ] **Step 3: 跑测确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --require scripts/test-env.cjs --test dist/session/kernel.test.js dist/session/seglog.test.js`
Expected: FAIL（`wake` 字段不存在 / isQuietNotice 未命中 `<task-notification>`）

- [ ] **Step 4: 实现 entry.ts**

```ts
// ① KernelEntry 附近新增（entry.ts，kind 联合同族区域）：
/** 唤醒引用（bg-wake spec §5.1）：id=账本寻址键；name=人读任务名（写入端解析一次，无业务含义缺省——
 *  exec 无 purpose、subagent 回退段、板上无 title）；board=板任务（点击路由团队管理页签，boardRef=板 id） */
export interface WakeRef {
  id: string;
  name?: string;
  board?: true;
  boardRef?: string;
}

/** 唤醒载荷净化（notice 事件 payload.wake → 条目字段）：非法形态整条剔除，全非法返回 undefined */
export function parseWakeRefs(raw: unknown): WakeRef[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: WakeRef[] = [];
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) continue;
    const r = it as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id === '') continue;
    out.push({
      id: r.id,
      ...(typeof r.name === 'string' && r.name !== '' ? { name: r.name } : {}),
      ...(r.board === true ? { board: true as const } : {}),
      ...(typeof r.boardRef === 'string' && r.boardRef !== '' ? { boardRef: r.boardRef } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}
```

```ts
// ② KernelEntry 增加可选字段（result 字段同族）：
  /** notice:后台任务唤醒引用（bg-wake spec §5.1；仅唤醒通知条携带——显示归 run 行前缀，本条不显示） */
  wake?: WakeRef[];
```

```ts
// ③ notice case（entry.ts ~376）改为：
    case 'notice': {
      const sealed = sealSeg(state, e.ts);
      const wake = parseWakeRefs(e.payload?.wake);
      return appendEntry(sealed, { ts: e.ts, kind: 'notice', md: e.text ?? '', ...(wake !== undefined ? { wake } : {}) });
    }
```

```ts
// ④ isQuietNotice 追加一条规则（保持单点，TUI/GUI 同源）：
export function isQuietNotice(md: string): boolean {
  return md.startsWith('<task-notification>') || /^ask p\S+ answered$/.test(md) || md.startsWith('[memory] index changed');
}
```

- [ ] **Step 5: 实现 seglog.ts**

- `JournalEvent` 的 `t: 'seg'` 变体加可选 `wake?: WakeRef[]`（import type 自 `./entry`）。
- `kernelEventRows` seg-open 分支的 seg 行字面量追加展开：`...(e.wake !== undefined ? { wake: e.wake } : {})`（与 images/callId 同族）。
- `reduceSegRows` seg case 的 entries.push 追加：`...(parseWakeRefs(row.wake) !== undefined ? { wake: parseWakeRefs(row.wake) } : {})`（parse 提为局部常量避免双算）。
- `entriesToChainSteps` **不改**：现行 `notice → note(observation=md)` 正是唤醒轮的恢复面口径（spec §5.3）。

- [ ] **Step 6: 跑测通过**

Run: 同 Step 3。Expected: PASS；再跑 `node --require scripts/test-env.cjs --test dist/session/seglog.images.test.js` 确认 seg 面无回归。

- [ ] **Step 7: 提交**

```bash
git add src/session/entry.ts src/session/seglog.ts src/session/kernel.test.ts src/session/seglog.test.ts
git commit -m "feat(session): bg-wake 批A——WakeRef 条目字段/notice 归约净化/isQuietNotice 唤醒规则/seg 行落档恢复往返"
```

---

### Task 2: wake.ts 纯函数面——配对推导、任务名解析、通知文、WakeController

**Files:**
- Create: `src/session/wake.ts`
- Test: `src/session/wake.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `KernelEntry.wake` / `WakeRef`。
- Consumes: `task-wait.ts` 的回执单点（Task 3 导出 `receiptBody`；本文件只依赖 `(id: string) => string` 形参，Task 4 接线时注入）。
- Produces: `wakeOfRun(entries, runIdx): WakeRef[] | undefined`；`resolveWakeName(t, boardDispatch, boardTitle?): string | undefined`；`toWakeRefs(tasks, boardTitleOf): WakeRef[]`；`buildWakeNotification(refs, receiptOf): string`；`WAKE_GOAL`；`class WakeController`（`fire` 接缝收 `WakeTaskInput[]`——板名解析在宿主侧，Task 4/5 宿主消费）。

- [ ] **Step 1: 写失败测试（新建 src/session/wake.test.ts）**

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { wakeOfRun, resolveWakeName, toWakeRefs, buildWakeNotification, WakeController, WAKE_GOAL } from './wake';
import type { WakeControllerOpts, WakeTaskInput } from './wake';
import type { KernelEntry } from './entry';

const run = (seq: number): KernelEntry => ({ seq, ts: 1, kind: 'run', md: '' });

describe('wakeOfRun', () => {
  const notice = (seq: number, wake?: KernelEntry['wake']): KernelEntry => ({ seq, ts: 1, kind: 'notice', md: 'x', ...(wake !== undefined ? { wake } : {}) });
  test('run 的直接前驱是唤醒 notice → 返回其 wake', () => {
    const refs = [{ id: 'a' }];
    assert.equal(wakeOfRun([notice(1, refs), run(2)], 1), refs);
  });
  test('前驱是普通 notice / 中间隔条目 / run 在首位 → undefined', () => {
    assert.equal(wakeOfRun([notice(1), run(2)], 1), undefined);
    assert.equal(wakeOfRun([notice(1, [{ id: 'a' }]), run(2), run(3)], 2), undefined);
    assert.equal(wakeOfRun([run(1)], 0), undefined);
  });
});

describe('resolveWakeName', () => {
  const t = { kind: 'exec' as const, label: 'pnpm build', title: undefined as string | undefined };
  test('exec：有 purpose 用 purpose，无 purpose 无名（label 是命令原文永不上屏）', () => {
    assert.equal(resolveWakeName({ ...t, title: '构建前端' }, false), '构建前端');
    assert.equal(resolveWakeName(t, false), undefined);
  });
  test('subagent：title ?? label；label 为回退段 subagent 视为无名', () => {
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'doc-writer', title: undefined }, false), 'doc-writer');
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'subagent', title: undefined }, false), undefined);
  });
  test('板任务：板名优先，无板名无名（label 是板 id 不是人读名）', () => {
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'task-t3', title: undefined }, true, '修复登录'), '修复登录');
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'task-t3', title: undefined }, true), undefined);
  });
});

describe('toWakeRefs', () => {
  test('多任务全量转 refs；板任务带 board+boardRef(label=dispatchTag 形态)', () => {
    const refs = toWakeRefs(
      [
        { id: 'x1', kind: 'exec', label: 'pnpm build', title: '构建前端' },
        { id: 'x2', kind: 'subagent', label: 'task-t3', boardDispatch: true },
      ],
      (id) => (id === 'x2' ? '修复登录' : undefined),
    );
    assert.deepEqual(refs, [
      { id: 'x1', name: '构建前端' },
      { id: 'x2', board: true, boardRef: 'task-t3', name: '修复登录' },
    ]);
  });
});

describe('buildWakeNotification', () => {
  test('通知文 = 标签定性 + 逐任务回执 + 收尾指令，包裹 task-notification', () => {
    const md = buildWakeNotification([{ id: 'a' }, { id: 'b' }], (id) => `receipt(${id})`);
    assert.match(md, /^<task-notification>\nAutomated notice, not a user message/);
    assert.match(md, /receipt\(a\)\nreceipt\(b\)/);
    assert.match(md, /Continue any work that was waiting on this result; if nothing remains, reply briefly\.\n<\/task-notification>$/);
    assert.ok(WAKE_GOAL.length > 0);
  });
});

describe('WakeController', () => {
  const task = (over: Partial<WakeTaskInput> = {}): WakeTaskInput => ({
    id: 't1', kind: 'exec', label: 'l', status: 'done', ownerRun: 'main', ...over,
  });
  const mk = (over: Partial<WakeControllerOpts> = {}) => {
    const fired: WakeTaskInput[][] = [];
    const c = new WakeController({ busy: () => false, receipted: () => false, fire: (ts) => { fired.push(ts); return true; }, batchMs: 10, ...over });
    return { c, fired };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('登记条件：stopped 不登记、fork 归属不登记、重复 id 去重；板任务纳入', async () => {
    const { c, fired } = mk();
    c.onTaskFinished(task({ status: 'stopped' }));
    c.onTaskFinished(task({ ownerRun: 'fork:x' }));
    c.onTaskFinished(task({ boardDispatch: true, ownerRun: 'fork:y' })); // 板任务纳入（三次裁定）
    c.onTaskFinished(task());
    c.onTaskFinished(task());
    await sleep(30);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]?.length, 2); // exec + board 各一
  });

  test('busy 时入 pending；轮收束取走起轮；interrupted 保留', () => {
    let busy = true;
    const { c, fired } = mk({ busy: () => busy });
    c.onTaskFinished(task());
    assert.equal(fired.length, 0);
    busy = false;
    assert.equal(c.onTurnEnded('done'), true);
    assert.equal(fired.length, 1);
    c.onTaskFinished(task({ id: 't2' }));
    assert.equal(c.onTurnEnded('interrupted'), false); // §10-1 默认保留
    assert.equal(fired.length, 1);
    assert.equal(c.onTurnEnded('done'), true);
    assert.equal(fired.length, 2);
  });

  test('receipted 剔除：全部已消费则不起轮', async () => {
    const seen = new Set(['t1']);
    const { c, fired } = mk({ receipted: (id) => seen.has(id) });
    c.onTaskFinished(task({ id: 't1' }));
    await sleep(30);
    assert.equal(fired.length, 0);
  });

  test('fire 未受理（false）回队，下次轮收束重试', async () => {
    let accept = false;
    const c = new WakeController({ busy: () => false, receipted: () => false, fire: () => accept, batchMs: 5 });
    c.onTaskFinished(task({ id: 'a' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), false); // 未受理，回队
    accept = true;
    assert.equal(c.onTurnEnded('done'), true); // 回队后受理
  });

  test('连续唤醒计满 onLimit 后丢弃；markUserActivity 重置计数', async () => {
    let limits = 0;
    const c = new WakeController({ busy: () => false, receipted: () => false, fire: () => true, batchMs: 5, maxChain: 1, onLimit: () => { limits += 1; } });
    c.onTaskFinished(task({ id: 'a' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), true); // chain=1
    c.onTaskFinished(task({ id: 'b' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), false); // 触顶丢弃
    assert.equal(limits, 1);
    c.markUserActivity(); // 用户消息插入 → 计数归零
    c.onTaskFinished(task({ id: 'c' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), true);
    assert.equal(limits, 1);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --require scripts/test-env.cjs --test dist/session/wake.test.js`
Expected: FAIL（./wake 不存在）

- [ ] **Step 3: 实现 src/session/wake.ts**

```ts
// bg-wake spec §5/§6：唤醒的纯函数面与控制器——判定=「终态×未 receipted×空闲」，零模型意图依赖。
// 本模块零 IO（timer 除外），宿主（daemon/tui）经 opts 注入 busy/receipted/fire 三个接缝。
import type { KernelEntry, WakeRef } from './entry';
// 回执单点不在本模块：宿主起轮处注入 receiptOf（=receiptBody(t, 'task_wait')，Task 3 导出）——
// wake.ts 对 harness 零依赖（session 层纯件，通知文形态由 receiptOf 抽象隔离）

/** 唤醒轮 runTask 的 goal：check 节点无内嵌段时 goal 即单一隐式判据（走模型判据）——文案与通知文收尾指令同义 */
export const WAKE_GOAL = 'Follow up on the finished background task(s) noted in the latest task-notification; when nothing remains, reply briefly.';

/** run 条目直接前驱为唤醒 notice → 返回其 wake 引用（写入顺序固定 notice→run，spec §5.3，配对零歧义） */
export function wakeOfRun(entries: readonly KernelEntry[], runIdx: number): WakeRef[] | undefined {
  const prev = entries[runIdx - 1];
  return prev !== undefined && prev.kind === 'notice' && prev.wake !== undefined ? prev.wake : undefined;
}

/** 任务名解析（spec §5.1）：exec=title 缺省无名（label 是命令原文永不上屏）；subagent=title??label
 *  （回退段 'subagent' 无名）；板任务（boardDispatch）=板名优先（label 是板 id） */
export function resolveWakeName(
  t: { kind: 'exec' | 'subagent'; label: string; title?: string },
  boardDispatch: boolean,
  boardTitle?: string,
): string | undefined {
  if (boardDispatch) return boardTitle !== undefined && boardTitle !== '' ? boardTitle : undefined;
  if (t.kind === 'exec') return t.title !== undefined && t.title !== '' ? t.title : undefined;
  if (t.title !== undefined && t.title !== '') return t.title;
  return t.label !== 'subagent' ? t.label : undefined;
}

/** 登记任务 → 唤醒引用（boardRef=label 的 dispatchTag 形态，TaskBoardTab 定位 norm 面直接命中） */
export function toWakeRefs(
  tasks: ReadonlyArray<{ id: string; kind: 'exec' | 'subagent'; label: string; title?: string; boardDispatch?: boolean }>,
  boardTitleOf: (ledgerId: string) => string | undefined,
): WakeRef[] {
  return tasks.map((t) => {
    if (t.boardDispatch === true) {
      const name = resolveWakeName(t, true, boardTitleOf(t.id));
      return { id: t.id, board: true as const, boardRef: t.label, ...(name !== undefined ? { name } : {}) };
    }
    const name = resolveWakeName(t, false);
    return { id: t.id, ...(name !== undefined ? { name } : {}) };
  });
}

/** 模型面通知文（spec §5.2）：定性说明在正文内、回执由 receiptOf 注入（=task_wait receiptBody 同构）、系统提示零改动 */
export function buildWakeNotification(refs: readonly WakeRef[], receiptOf: (id: string) => string): string {
  return [
    '<task-notification>',
    'Automated notice, not a user message: background work you started earlier has finished.',
    ...refs.map((r) => receiptOf(r.id)),
    'Continue any work that was waiting on this result; if nothing remains, reply briefly.',
    '</task-notification>',
  ].join('\n');
}

/** 唤醒登记输入（=bg-task 事件载荷超集：ownerRun/boardDispatch 供归属判定） */
export interface WakeTaskInput {
  id: string;
  kind: 'exec' | 'subagent';
  label: string;
  title?: string;
  status: string;
  ownerRun?: string;
  boardDispatch?: boolean;
}

export interface WakeControllerOpts {
  /** 宿主运行态：run 在途即 busy（空闲 false） */
  busy(): boolean;
  /** 任务是否已被 task_wait/agent_team_task_wait 回执消费（宿主接 TaskRegistry.isReceipted） */
  receipted(id: string): boolean;
  /** 起唤醒轮；入参=过筛后的登记任务（板名解析在宿主侧：宿主内 toWakeRefs 后起轮）；
   *  返回 false=宿主未受理（如 plan 武装态）→ 批次回队待下次轮收束 */
  fire(tasks: WakeTaskInput[]): boolean;
  /** 触达连续唤醒上限（中间无用户消息） */
  onLimit?(): void;
  /** 合批窗口 ms（缺省 1500，spec §10-3 缺省裁定） */
  batchMs?: number;
  /** 连续唤醒上限（缺省 10，spec §10-2 缺省裁定） */
  maxChain?: number;
}

/** 唤醒控制器（session 层单点，daemon/TUI 各一实例）：登记/合批/用户优先/复检/防循环。
 *  零 IO（timer 除外）；宿主 teardown 调 reset() 清 timer（防句柄泄漏） */
export class WakeController {
  private pending: WakeTaskInput[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain = 0;

  constructor(private readonly opts: WakeControllerOpts) {}

  /** 用户消息提交点调用（宿主 submit 用户路径）：连续唤醒计数归零 */
  markUserActivity(): void {
    this.chain = 0;
  }

  /** 任务终态入口（宿主接 harness opts.wake.onFinished）：非终态/非主链非板/重复登记一律忽略 */
  onTaskFinished(task: WakeTaskInput): void {
    if (task.status !== 'done' && task.status !== 'failed') return; // stopped=主动收口不唤醒（§3.1）
    if (task.ownerRun !== 'main' && task.boardDispatch !== true) return; // fork 名下由子智能体自己等待
    if (this.pending.some((p) => p.id === task.id)) return;
    this.pending.push(task);
    if (!this.opts.busy()) this.scheduleFire(); // 空闲即开合批窗；运行中留存待轮收束
  }

  /** 轮收束续跑口（宿主在 steer 优先分支之后调用）；interrupted 保留 pending（§10-1 缺省裁定） */
  onTurnEnded(stopReason?: string): boolean {
    if (stopReason === 'interrupted') return false;
    return this.tryFire();
  }

  private scheduleFire(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tryFire();
    }, this.opts.batchMs ?? 1500);
  }

  private tryFire(): boolean {
    if (this.opts.busy()) return false; // 计时器与用户提交竞态：busy 即本轮收束再取
    const batch = this.pending.filter((t) => !this.opts.receipted(t.id));
    this.pending = [];
    if (batch.length === 0) return false;
    if (this.chain >= (this.opts.maxChain ?? 10)) {
      this.opts.onLimit?.();
      return false;
    }
    const ok = this.opts.fire(batch);
    if (ok) this.chain += 1;
    else this.pending = batch; // 未受理回队
    return ok;
  }

  reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.chain = 0;
  }
}
```

- [ ] **Step 4: 跑测通过 + 提交**

Run: 同 Step 2。Expected: PASS。

```bash
git add src/session/wake.ts src/session/wake.test.ts
git commit -m "feat(session): bg-wake 批B——wakeOfRun 配对/resolveWakeName 任务名/toWakeRefs/通知文单点/WakeController(登记·合批·用户优先·receipted 复检·连续上限)"
```

---

### Task 3: harness 面——receipted 消费标记、onFinished 唤醒汇、wakeHint 分派提示

**Files:**
- Modify: `src/harness/tasks.ts`（receipted 字段、markReceipted/isReceipted/markBoardReceipted、wakeHint 面、WAKE_HINT/WAKE_HINT_RECEIPT_TOOL 常量、wakeHintSuffix）
- Modify: `src/harness/tools/task-wait.ts`（导出 receiptBody；两工具回执点置 receipted）
- Modify: `src/harness/index.ts`（HarnessOptions.wake、setOnChange 分流 onFinished、wakeHint 装配）
- Modify: `src/harness/tools/builtin.ts`（exec 两处转后台回执追加提示）
- Modify: `src/harness/subagent.ts`（spawn 后台回执追加提示）
- Modify: `src/harness/tools/taskboard-tools.ts`（create_agent_team_task 回执追加提示）
- Modify: `src/session/wake.ts`（WAKE_HINT_RECEIPT_TOOL 占位改从 tasks.ts 导入）
- Test: `src/harness/tools/task-wait.test.ts`（追加）、`src/harness/wake.test.ts`（新建）

**Interfaces:**
- Produces: `TaskRegistry.receipted?: boolean` 字段语义、`markReceipted(ids)` / `markBoardReceipted(boardIds)` / `isReceipted(id)`；`HarnessOptions.wake?: { onFinished(t: BackgroundTask): void; hint?: boolean }`；`TaskRegistry.wakeHint?: boolean`；`wakeHintSuffix(tasks): string`；`WAKE_HINT`；导出 `receiptBody`。
- 消费方（Task 4/5）：`runtime.ts` KernelRuntimeOpts 透传 `wake`；宿主以 `hint: true` 注入。

- [ ] **Step 1: 写失败测试（新建 src/harness/wake.test.ts）**

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildHarness } from '../runtime';
import { wakeHintSuffix, WAKE_HINT } from '../harness/tasks';

test('harness wake 接缝：终态分流 onFinished；stopped 不分流；wakeHint 装配', () => {
  const seen: Array<{ id: string; status: string }> = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgwake-'));
  const h = buildHarness(root, { wake: { onFinished: (t) => seen.push({ id: t.id, status: t.status }), hint: true } });
  const t1 = h.tasks.submit({ kind: 'exec', label: 'cmd', title: '构建', ownerRun: 'main' });
  h.tasks.finish(t1.id, 'done');
  const t2 = h.tasks.submit({ kind: 'exec', label: 'cmd2', ownerRun: 'main' });
  h.tasks.finish(t2.id, 'stopped', { marker: '[stopped: process exit]' });
  assert.deepEqual(seen, [{ id: t1.id, status: 'done' }]); // stopped 不分流
  assert.equal(h.tasks.wakeHint, true);
  assert.equal(wakeHintSuffix(h.tasks), WAKE_HINT); // currentOwner 缺省 main
});

test('未注入 wake（CLI 形态）：不分流、无提示', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgwake0-'));
  const h = buildHarness(root);
  const t = h.tasks.submit({ kind: 'exec', label: 'c', ownerRun: 'main' });
  h.tasks.finish(t.id, 'failed');
  assert.equal(h.tasks.wakeHint ?? false, false);
  assert.equal(wakeHintSuffix(h.tasks), '');
});

test('receipted：markReceipted/isReceipted/markBoardReceipted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgwake1-'));
  const h = buildHarness(root);
  const t = h.tasks.submit({ kind: 'subagent', label: 'task-t3', boardDispatch: true, ownerRun: 'fork:m1' });
  assert.equal(h.tasks.isReceipted(t.id), false);
  h.tasks.markBoardReceipted(['t3']); // 板 id → dispatchTag 标签匹配台账行
  assert.equal(h.tasks.isReceipted(t.id), true);
  const t2 = h.tasks.submit({ kind: 'exec', label: 'c', ownerRun: 'main' });
  h.tasks.markReceipted([t2.id]);
  assert.equal(h.tasks.isReceipted(t2.id), true);
});
```

- [ ] **Step 2: 追加失败测试（task-wait.test.ts）**

```ts
import { TaskRegistry } from '../tasks';
import { makeTaskWaitTool, makeAgentTeamTaskWaitTool } from './task-wait';

test('task_wait 终态回执即置 receipted；仍在跑的不置位（peek 形态）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
  const tasks = new TaskRegistry(dir); // 纯内存形态（ledgerPath 缺省）
  const tool = makeTaskWaitTool(tasks);
  const done = tasks.submit({ kind: 'exec', label: 'c1', ownerRun: 'main' });
  tasks.finish(done.id, 'done', { exitCode: 0 });
  const running = tasks.submit({ kind: 'exec', label: 'c2', ownerRun: 'main' });
  const r = await tool.executor({ taskIds: [done.id, running.id], timeoutSeconds: 0 } as never);
  assert.match(r.stdout, new RegExp(done.id));
  assert.equal(tasks.isReceipted(done.id), true);
  assert.equal(tasks.isReceipted(running.id), false); // still running 不置位
});

test('agent_team_task_wait 板终态回执 → markBoardReceipted 命中 dispatchTag 台账行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twb-'));
  const tasks = new TaskRegistry(dir);
  const ledger = tasks.submit({ kind: 'subagent', label: 'task-t3', boardDispatch: true, ownerRun: 'fork:m1' });
  const tool = makeAgentTeamTaskWaitTool(tasks, /* board: 随该文件既有板桩形态装配 */ undefined as never);
  // 板侧终态由既有板桩驱动（boardStatus 进入 terminal 集合）——断言面：
  // 回执含 't3 (board) success' 且 tasks.isReceipted(ledger.id) === true
});
```

（`executor` 入参形态/板桩构造以 `task-wait.test.ts` 既有用例为准——本步新增的断言语义只有一条：**终态回执返回 ⇒ 对应台账行 `isReceipted === true`，未终态不置位**；两个工具各覆盖一遍。）

- [ ] **Step 3: 跑测确认失败，然后实现 tasks.ts**

```ts
// ① BackgroundTask 增字段（boardDispatch 同族）：
  /** 已被 task_wait/agent_team_task_wait 终态回执消费（bg-wake spec §3.1）：只在内存 live 对象置位，
   *  不入账本——重启后 running 行孤儿标 stopped 本就不唤醒 */
  receipted?: boolean;

// ② TaskRegistry 增字段与方法（setOnChange 同族区域）：
  /** 唤醒提示装配开关（bg-wake spec §4.2 宿主闸①）：daemon/TUI 注入 true，CLI 缺省 false */
  wakeHint?: boolean;

  /** 终态回执消费标记：置 live 对象 receipted（账本零写入） */
  markReceipted(ids: readonly string[]): void {
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (t !== undefined) t.receipted = true;
    }
  }

  /** 板任务终态回执标记：板 id → dispatchTag 标签匹配 boardDispatch 台账行（teammate execute 登记口径） */
  markBoardReceipted(boardIds: readonly string[]): void {
    const tags = new Set(boardIds.flatMap((id) => [id, /^t\d+$/.test(id) ? `task-${id}` : id]));
    for (const t of this.tasks.values()) {
      if (t.boardDispatch === true && tags.has(t.label)) t.receipted = true;
    }
  }

  isReceipted(id: string): boolean {
    return this.tasks.get(id)?.receipted === true;
  }

// ③ 常量与后缀（文件尾导出）：
/** 分派回执唤醒提示（bg-wake spec §4.2，已裁定）：可选出路非指令——不否定 task_wait，只告知「提前收轮等唤醒」 */
export const WAKE_HINT =
  ' You need not wait for it within this turn: if nothing else depends on it right now, finish your current work, reply, and end the turn — you will be woken automatically when it completes.';

/** task_wait 回执再引工具名（宿主起轮处 receiptBody 调用复用，避免裸串漂移） */
export const WAKE_HINT_RECEIPT_TOOL = 'task_wait';

/** 回执提示后缀（三道挂载闸合成点）：宿主闸① wakeHint 装配 × 闸② 主链归属；板任务分派点恒主链天然满足 */
export function wakeHintSuffix(tasks: TaskRegistry): string {
  return tasks.wakeHint === true && tasks.currentOwner() === 'main' ? WAKE_HINT : '';
}
```

- [ ] **Step 4: 实现 harness/index.ts 分流与 wakeHint 装配**

```ts
// HarnessOptions 增（onEvent 同族）：
  /** bg-wake 接缝（spec §3.1）：后台任务终态分流（在 boardDispatch 显示过滤**之前**——板任务也纳入唤醒，
   *  GUI bg-task 帧与后台任务页签的 11-03 显示裁定不受影响）；hint=true 时后台分派回执追加唤醒提示 */
  wake?: { onFinished(t: BackgroundTask): void; hint?: boolean };
```

```ts
// setOnChange 回调（index.ts ~226）改为：
      this.tasks.setOnChange((task) => {
        if ((task.status === 'done' || task.status === 'failed') && opts.wake !== undefined) {
          opts.wake.onFinished(task); // 唤醒汇：终态全量（含板任务），过滤归 WakeController（§3.1）
        }
        if (task.boardDispatch === true) return; // 既有 GUI 显示过滤（11-03 裁定）原样保留
        emit({ ... });
      });
// 装配区（this.tasks = new TaskRegistry(...) 之后）：
    if (opts.wake?.hint === true) this.tasks.wakeHint = true;
```

- [ ] **Step 5: 实现 task-wait.ts**

- `function receiptBody` 前加 `export`（wake.ts 通知文复用单点）。
- 两个工具 executor 的返回点（`return formatReceipt(...)`）前置一行：

```ts
      const doneIds = result.tasks.filter((x) => x.status !== 'running').map((x) => x.id);
      if (doneIds.length > 0) tasks.markReceipted(doneIds);
```

- `makeAgentTeamTaskWaitTool` 的终态回执点同置：`tasks.markBoardReceipted(<该次回执内终态板 id 列表>)`（板 id 从回执组装处的 board snapshot 终态集合取；ledger 侧若同批有台账 id 走 markReceipted）。

- [ ] **Step 6: 实现三处分派回执提示**

```ts
// builtin.ts:215 与 :236（exec 两处转后台回执，模板字符串尾部追加）：
return execOut(`task ${task.id} started (output: ${task.outputFilePath}); poll that file (it ends with [exit N] when the command finishes) or block with task_wait${wakeHintSuffix(tasks)}`);
// 超时转后台行同理（r.value.child 分支既有回执串尾 + wakeHintSuffix(tasks)）
```

```ts
// subagent.ts:673（spawn 工具后台分支）：
const started = runner.spawnBackground(spec);
return { exitCode: 0, stdout: `task ${started.taskId} started (output: ${started.outputFilePath})${started.wakeHint ?? ''}`, stderr: '', timedOut: false };
// spawnBackground（subagent.ts:414）返回值加 hint：
    return { taskId: task.id, outputFilePath: task.outputFilePath, ...(ledger !== undefined && ledger.wakeHint === true && ledger.currentOwner() === 'main' ? { wakeHint: WAKE_HINT } : {}) };
// 返回类型 { taskId: string; outputFilePath: string } 加可选 wakeHint?: string；import WAKE_HINT 自 './tasks'
```

```ts
// taskboard-tools.ts:134（create_agent_team_task 回执）：
        `task ${titleBit} created (id=${r.value.taskId}); wait with agent_team_task_wait taskIds=["${r.value.taskId}"] (or other board ids)${tasks !== undefined ? wakeHintSuffix(tasks) : ''}`,
// 若该工厂未持有 TaskRegistry：给工厂加可选末参 tasks?: TaskRegistry，index.ts 装配调用点传 this.tasks（闸②恒满足：lead 分派运行在主链）
```

- [ ] **Step 7: 常量接线**

- Task 2 Step 3 中 wake.ts 顶部若有 `WAKE_HINT_RECEIPT_TOOL` 占位导入则删除（wake.ts 对 harness 零依赖，receiptOf 由宿主注入）。
- Task 4/5 宿主起轮处的 `receiptBody(t, WAKE_HINT_RECEIPT_TOOL)` 从 `../harness/tasks` 导入常量。

- [ ] **Step 8: 跑测通过 + 提交**

Run: `pnpm exec tsc -p tsconfig.json && node --require scripts/test-env.cjs --test dist/harness/wake.test.js dist/harness/tools/task-wait.test.js dist/session/wake.test.js`
Expected: PASS。

```bash
git add src/harness src/session/wake.ts
git commit -m "feat(harness): bg-wake 批C——receipted 消费标记(task_wait/团队 wait 回执点)/wake 终态分流汇(boardDispatch 过滤前)/分派回执 WAKE_HINT(exec×2·spawn·板任务,宿主闸+主链闸)"
```

---

### Task 4: daemon 宿主——assemble 注入、submit 双态、finally 续发

**Files:**
- Modify: `src/session/runtime.ts`（KernelRuntimeOpts.wake 透传 buildHarness）
- Modify: `src/serve/session.ts`（WakeController 实例、assemble 注入、submit 双态、finally 分支、dispose reset）
- Test: `src/serve/session.wake.test.ts`（新建，控制器级——不起 HTTP）

**Interfaces:**
- Consumes: Task 2 `WakeController`；Task 3 `receiptBody`（导出）+ `WAKE_HINT_RECEIPT_TOOL`。
- Produces: `SessionController.submitWake(tasks: WakeTaskInput[]): boolean`（TUI 同名同契约，Task 5 消费）。

- [ ] **Step 1: runtime.ts 透传**

```ts
// KernelRuntimeOpts 增（onTodos 同族；import type { BackgroundTask } from '../harness/tasks'）：
  /** bg-wake 接缝透传（spec §3.1）：daemon/TUI 注入，CLI buildDeps 不注入＝无唤醒 */
  wake?: { onFinished(t: BackgroundTask): void; hint?: boolean };
// createKernelRuntime 的 buildHarness 调用 opts 对象追加：...(opts.wake !== undefined ? { wake: opts.wake } : {}),
```

- [ ] **Step 2: 写失败测试（新建 src/serve/session.wake.test.ts）**

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { SessionEvent } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 控制器级 bg-wake 端到端（spec §9 宿主集成）：第一轮模型后台 exec 后收轮 → 任务完成 → 唤醒轮自动起跑，
 *  转录序 notice(wake)→run、无 user 条、模型输入含 <task-notification> */
test('daemon 唤醒：空闲合批起轮 + 转录序 + 无 user 条', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wakedaemon-'));
  // 第一轮：模型先 exec(background) 再收轮；第二轮（唤醒轮）：正文收束
  const model = new ScriptedAdapter([
    { content: '', toolCalls: [{ name: 'exec', args: { command: 'node -e "setTimeout(()=>process.exit(0),150)"', kind: 'executes', background: true, purpose: 'ping' } }] },
    { content: 'first done', toolCalls: [] },
    { content: 'woken reply', toolCalls: [] },
  ]);
  const events: SessionEvent[] = [];
  const ctl = new SessionController({
    id: 's1', root, model,
    onEvent: (e) => events.push(e),
    broadcast: () => {}, // SessionRuntimeOpts 若无此字段则删行（以类型定义为准）
  } as ConstructorParameters<typeof SessionController>[0]);
  const sub = ctl.submit('kick off bg work');
  assert.equal(sub.ok, true);
  await ctl.current?.done; // 第一轮收束（模型已收轮，exec 后台在跑）
  await sleep(2200); // exec 150ms 内退出 + 1.5s 合批窗
  // 唤醒轮自动起跑并收束
  await sleep(300);
  await ctl.current?.done;
  const entries = ctl.kernel.state.entries; // kernel 公开面以 SessionKernel 实际读口为准（transcriptCount/快照同族）
  const idx = entries.findIndex((e) => e.kind === 'notice' && e.wake !== undefined);
  assert.ok(idx > 0, '存在唤醒 notice 条');
  assert.equal(entries[idx + 1]?.kind, 'run'); // 转录序 notice→run
  const md = entries[idx]?.md ?? '';
  assert.match(md, /<task-notification>/);
  assert.match(md, /ping/); // 回执含任务名（receiptBody 的 label 列）
  assert.equal(entries.some((e) => e.kind === 'user' && e.ts >= (entries[idx]?.ts ?? 0) && (entries[idx + 1]?.ts ?? 0) >= e.ts), false, '唤醒轮无 user 条');
});
```

（`ctl.kernel.state` / `ctl.current` 的可见性以 serve/session.ts 实际公开面为准——`current`/`transcriptCount()` 已确认公开；kernel 不公开时改用 `onEvent` 收集的 seg 帧断言，语义不变。）

- [ ] **Step 3: 跑测确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --require scripts/test-env.cjs --test dist/serve/session.wake.test.js`
Expected: FAIL（唤醒轮未起跑 / wake 透传不存在）

- [ ] **Step 4: 实现 serve/session.ts**

```ts
// ① 字段区（current 同族；import { WakeController, wakeOfRun 无关——此处 WakeTaskInput/toWakeRefs 自 '../session/wake'）：
  /** 唤醒控制器（bg-wake spec §3）：登记/合批/续发单点；receipted 查 harness live 面（换铸后新实例同账本对象） */
  private readonly wake = new WakeController({
    busy: () => this.current !== undefined,
    receipted: (id) => this.runtimeImpl?.harness.tasks.isReceipted(id) ?? false,
    fire: (tasks) => this.submitWake(tasks),
    onLimit: () => this.pump({ type: 'notice', text: 'auto-wake limit reached (no user message in between)', ts: Date.now() }),
  });

  /** 板任务名解析（daemon 侧板投影）：台账 label(dispatchTag) → 板 id → 板存储 title；缺省 undefined=无名 */
  private boardTaskTitle(ledgerId: string): string | undefined {
    const m = /^task-(t\d+)$/.exec(ledgerId);
    const boardId = m !== null ? m[1]! : ledgerId;
    return this.board.tasks[boardId]?.title;
  }

  /** 唤醒轮入口（fire 接缝）：plan 武装态不受理（批次回队）；真 submit 双态收口，快照/统计/续发全共用 */
  private submitWake(tasks: WakeTaskInput[]): boolean {
    if (this.planArmed()) return false;
    return this.submit(WAKE_GOAL, undefined, { tasks }).ok;
  }
```

```ts
  submit(goal: string, images?: string[], wake?: { tasks: WakeTaskInput[] }): SessionSubmitResult {
    if (this.current) return { ok: false, status: 409, error: 'run in progress' };
    if (wake === undefined) this.wake.markUserActivity(); // 用户路径：连续唤醒计数归零（唤醒路径不重置）
    images = wake === undefined ? spillImages(this.root, images) : undefined;
    const armed = wake === undefined && this.planArmed();
    ... // abort/runSignal/基线/runUsage 原样
    const runSeq = this.kernel.openRun();
    if (wake !== undefined) {
      // 唤醒轮（spec §5.3）：通知 notice 条 + 链尾 note——无 user 条、无指令行；模型输入与恢复面同构
      const refs = toWakeRefs(wake.tasks, (ledgerId) => this.boardTaskTitle(ledgerId));
      const md = buildWakeNotification(refs, (id) => {
        const t = this.runtimeImpl.harness.tasks.get(id);
        return t !== undefined ? receiptBody(t, WAKE_HINT_RECEIPT_TOOL) : `${id} (ledger) finished`;
      });
      this.kernel.pump({ type: 'notice', text: md, payload: { wake: refs }, ts: Date.now() });
      this.runtimeImpl.harness.context.appendChain([{ action: 'note', observation: md }]);
    } else {
      this.kernel.submit(goal, images);
      this.runtimeImpl.harness.context.appendInstructionLine(goal, hasImages ? images : undefined);
    }
    void runSeq; // 既有 checkpoint 寻址键两态共用（原 const 位置上移）
    ... // runTask/.then/.finally 原样
```

```ts
// ③ finally 续发块（~1188）：steer 空时问唤醒：
        if (runOutcome?.stopReason !== 'interrupted') {
          const pending = this.kernel.steerTakePending();
          if (pending.length > 0) {
            ... // 既有 G14.89 原样
          } else {
            this.wake.onTurnEnded(runOutcome?.stopReason);
          }
        }
```

```ts
// ④ assemble() 的 createKernelRuntime 调用追加：
      wake: { onFinished: (t) => this.wake.onTaskFinished(t), hint: true },
// ⑤ 收口步骤 3-5（~1343 stopAllTasks 同区）追加：this.wake.reset();
```

- [ ] **Step 5: 跑测通过 + 提交**

Run: 同 Step 3 + `node --require scripts/test-env.cjs --test dist/serve/daemon.contract.test.js`（收口/续跑既有面回归）。
Expected: PASS。

```bash
git add src/session/runtime.ts src/serve/session.ts src/serve/session.wake.test.ts
git commit -m "feat(serve): bg-wake 批D——daemon 宿主接线(WakeController 装配/submit 双态 notice+note/finally 续发 steer 优先/dispose reset)＋控制器级端到端"
```

---

### Task 5: TUI 宿主——runTaskFlow 双态、drainQueue 尾注、Spinner 前缀

**Files:**
- Modify: `src/tui/session.ts`（wake 字段、assemble/createKernelRuntime 注入、runTaskFlow wake 分支、drainQueue 尾注、wakePrefix 状态）
- Modify: `src/tui/components/Spinner.tsx`（prefix 前缀段）
- Modify: `src/tui/components/App.tsx`（透传 prefix）
- Test: `src/tui/session.wake.test.ts`（新建，形态随 `session.steer.test.ts`）

**Interfaces:**
- Consumes: Task 2/3/4 同批接口；`SessionOpts.runtime` 可注入（既有接缝）——测试直接构造。
- Produces: `TuiState.wakePrefix?: string`（Spinner 消费）；`submitWake(refs): boolean`。

- [ ] **Step 1: 写失败测试（src/tui/session.wake.test.ts，装配段照抄 `session.steer.test.ts` 的 ctrl 构造与驱动形态——该文件演示的 steerEnqueue→收束补跑链正是本批插入点）**

```ts
// 核心用例（断言体直接落码；构造段 mkCtrl/提交驱动口随既有文件）：
test('TUI 唤醒：空闲合批起轮 + 转录序 notice(wake)→run + 无 user 行', async () => {
  const model = new ScriptedAdapter([
    { content: '', toolCalls: [{ name: 'exec', args: { command: 'node -e "setTimeout(()=>process.exit(0),150)"', kind: 'executes', background: true, purpose: 'ping' } }] },
    { content: 'first done', toolCalls: [] },
    { content: 'woken reply', toolCalls: [] },
  ]);
  const ctrl = mkCtrl(model); // session.steer.test.ts 既有构造形态
  await submitViaExistingDriver(ctrl, 'kick off bg work'); // 该文件既有提交驱动口
  await waitFor(() => ctrl.state.status === 'idle'); // 第一轮收束（后台 exec 在跑）
  await waitFor(() => ctrl.state.status === 'running'); // 唤醒轮起跑（合批窗）
  await waitFor(() => ctrl.state.status === 'idle'); // 唤醒轮收束
  const entries = ctrl.kernel.state.entries; // kernel 读口随既有测试面（快照/steer 测试同源）
  const idx = entries.findIndex((e) => e.kind === 'notice' && e.wake !== undefined);
  assert.ok(idx > 0);
  assert.equal(entries[idx + 1]?.kind, 'run');
  assert.equal(entries.filter((e) => e.kind === 'user' && e.seq > (entries[idx - 1]?.seq ?? 0) && e.seq < (entries[idx + 1]?.seq ?? 0)).length, 0);
});

test('用户优先：唤醒 pending 在场时排队用户消息先跑', async () => {
  // 第一轮同上；唤醒轮在途时经既有驱动口入队一条 steer → 轮收束 drainQueue 先发用户行；
  // 断言：转录 user 条先于第二个 wake notice 条出现。
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --require scripts/test-env.cjs --test dist/tui/session.wake.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 tui/session.ts**

```ts
// ① 字段（kernel 同族）：
  /** 唤醒控制器（bg-wake spec §3；与 daemon 同构——busy=运行态、fire=runWakeFlow、receipted=live 账本） */
  private readonly wake = new WakeController({
    busy: () => this.state.status === 'running',
    receipted: (id) => this.runtime.harness.tasks.isReceipted(id),
    fire: (tasks) => {
      if (this.state.status === 'running' || this.planArmed) return false;
      void this.runWakeFlow(tasks);
      return true;
    },
    onLimit: () => this.pushMsg('system', t('auto-wake limit reached (no user message in between)', '连续唤醒已达上限（期间无用户消息）')),
  });
  /** 唤醒轮标（Spinner 前缀，spec §6.5）：runWakeFlow 置位、closeTask 清空 */
  private wakeLabel?: string;
```

```ts
// ② runtime 构造（ctor 的 createKernelRuntime 调用）追加：
      wake: { onFinished: (t) => this.wake.onTaskFinished(t), hint: true },
```

```ts
// ③ runTaskFlow 双态（opts 加 wakeTasks?: WakeTaskInput[]；字段声明 private lastStopReason?: string）：
    // 主链任务分支内：
      if (opts?.wakeTasks !== undefined) {
        // 唤醒轮（spec §5.3）：notice 条 + 链尾 note，无 user 行、无指令行（live 与恢复同构）
        const refs = toWakeRefs(opts.wakeTasks, (ledgerId) => this.boardTaskTitle(ledgerId));
        const md = buildWakeNotification(refs, (id) => {
          const t2 = this.runtime.harness.tasks.get(id);
          return t2 !== undefined ? receiptBody(t2, WAKE_HINT_RECEIPT_TOOL) : `${id} (ledger) finished`;
        });
        this.kernel.pump({ type: 'notice', text: md, payload: { wake: refs }, ts: Date.now() });
        this.kernel.openRun();
        this.wakeLabel = wakePrefixOf(refs); // '后台任务 {n} 唤醒' / en 同构；undefined=无名通用形态
        this.runtime.harness.context.appendChain([{ action: 'note', observation: md }]);
      } else {
        ctx.appendInstructionLine(`Current instruction: ${goal}`, imgs);
      }
      const r = await this.runtime.runTask(goal, {...}); // 既有
      ... // 既有收尾
```

```ts
// ④ runWakeFlow + drainQueue 尾注：
  /** 唤醒轮入口（fire 接缝）：状态机 running 面复用 runTaskFlow，收束后 drainQueue 接力（steer 优先） */
  private async runWakeFlow(tasks: WakeTaskInput[]): Promise<void> {
    this.lastStopReason = undefined;
    await this.runTaskFlow(WAKE_GOAL, { wakeTasks: tasks });
    this.wakeLabel = undefined;
    await this.drainQueue(); // 唤醒轮收束：排队消息/下一批唤醒接力（连续上限在控制器）
  }

  // drainQueue 末尾（for 循环之后）追加：
    this.wake.onTurnEnded(this.lastStopReason);
  // lastStopReason: runTaskFlow 内 runTask 返回处记录（this.lastStopReason = r.stopReason）
```

```ts
// ⑤ 用户提交点（既有 submit 的 kernel.submit 处，~573 区）：this.wake.markUserActivity();
// ⑥ TuiState 增 wakePrefix?: string（notify 投影：this.state = {...this.state, wakePrefix: this.wakeLabel}——
//    跟随既有 notify 面字段装载点）；Spinner 调用处（components/App.tsx:596）透传 prefix={state.wakePrefix}；
//    软重置/会话换新清 wakeLabel（softResetToNewSession 的清零区）。
```

```ts
// ⑦ Spinner.tsx：props 加 prefix?: string；主行在最前渲染：
  {prefix !== undefined && <Text>{prefix}</Text>}
// 前缀文案（wakePrefixOf，tui/session.ts 私有）：有名 `t('Woken by background task', '后台任务') + ' {' + name + '} ' + t('wake','唤醒')`；无名 `t('Woken by background task','后台任务唤醒')`（zh 通用形态单串）
```

- [ ] **Step 4: 跑测通过 + 提交**

Run: 同 Step 2 + `node --require scripts/test-env.cjs --test dist/tui/session.steer.test.js dist/tui/session.queue.test.ts 2>/dev/null || node --require scripts/test-env.cjs --test dist/tui/session.steer.test.js`（队列既有面回归）。

```bash
git add src/tui
git commit -m "feat(tui): bg-wake 批E——TUI 宿主接线(runTaskFlow 双态/drainQueue 尾注续发/Spinner 唤醒前缀)＋session.wake 端到端"
```

---

### Task 6: GUI 渲染——过滤唤醒 notice、run 行前缀、任务名点击路由

**Files:**
- Modify: `gui/src/chat-reducer.ts`（显示过滤追加 wake notice）
- Modify: `gui/src/pages/chat/MessageList.tsx`（run 分支传 wake/onOpenTask）
- Modify: `gui/src/pages/chat/EntryViews.tsx`（RunEntryView 前缀段 + 点击）
- Modify: `gui/src/app.css`（**文件末尾追加** .wake-name 段——文件有他 session 未提交改动，禁止触碰既有行）
- Test: `gui/src/pages/chat/RunEntryView.wake.test.tsx`（新建）

**Interfaces:**
- Consumes: `KernelEntry.wake`（chat-reducer 直通 GUI，帧序列化原生携带）；MessageList 既有 `onOpenTask(ref)` 路由（`bg:<账本id>` → 后台任务页签；`task-…`/`t…` → 团队页签板行，App.tsx `openTaskFocus` 既有分流）。
- Produces: RunEntryView 新可选 props `wake?: WakeRef[]; onOpenTask?: (ref: string) => void`。

- [ ] **Step 1: 写失败测试（新建 RunEntryView.wake.test.tsx，随 RunChangesBar.test.tsx 渲染形态）**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { RunEntryView } from './EntryViews';

const base = { seq: 3, ts: Date.now(), kind: 'run' as const, md: '', key: 'k3' };

describe('RunEntryView 唤醒前缀（bg-wake spec §6）', () => {
  it('有名：前缀「后台任务 {构建前端} 唤醒」+ 既有 sealed 文案；点任务名发 bg 路由且不触发折叠', () => {
    const onToggle = vi.fn();
    const onOpenTask = vi.fn();
    const { getByText } = render(
      <RunEntryView
        entry={{ ...base, seconds: 12 }}
        wake={[{ id: 'x1', name: '构建前端' }]}
        onToggle={onToggle}
        onOpenTask={onOpenTask}
      />,
    );
    expect(getByText('后台任务')).toBeTruthy();
    const name = getByText('{构建前端}');
    fireEvent.click(name);
    expect(onOpenTask).toHaveBeenCalledWith('bg:x1');
    expect(onToggle).not.toHaveBeenCalled(); // stopPropagation 不触发折叠
    expect(getByText(/已运行/)).toBeTruthy();
  });

  it('板任务名点击走板路由', () => {
    const onOpenTask = vi.fn();
    const { getByText } = render(
      <RunEntryView entry={{ ...base, seconds: 3 }} wake={[{ id: 'l1', name: '修复登录', board: true, boardRef: 'task-t3' }]} onOpenTask={onOpenTask} />,
    );
    fireEvent.click(getByText('{修复登录}'));
    expect(onOpenTask).toHaveBeenCalledWith('task-t3');
  });

  it('无名：通用形态整行无点击元素；「后台任务」恒为纯文本', () => {
    const onOpenTask = vi.fn();
    const { getByText, queryByRole } = render(<RunEntryView entry={{ ...base, seconds: 5 }} wake={[{ id: 'x2' }]} onOpenTask={onOpenTask} />);
    expect(getByText('后台任务唤醒')).toBeTruthy();
    expect(queryByRole('button', { name: '后台任务' })).toBeNull();
  });

  it('live 态：前缀 + 既有「运行中」拼接', () => {
    const { getByText } = render(<RunEntryView entry={{ ...base, streaming: true }} wake={[{ id: 'x1', name: '构建前端' }]} />);
    expect(getByText(/运行中/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `pnpm --dir gui exec vitest run src/pages/chat/RunEntryView.wake.test.tsx`
Expected: FAIL（props 不存在）。

- [ ] **Step 3: 实现 EntryViews.tsx（RunEntryView）**

```tsx
// props 追加（onToggle 同族）：wake?: WakeRef[]; onOpenTask?: (ref: string) => void;
// import type { WakeRef } from '../../../src/session/entry';
// import { t } from '../../i18n';（该文件既有 i18n 口径为准）

// sealed 分支（`if (!streaming)` 的 <span> 内）与 live 分支（`运行中` 行）统一拼前缀：
  const first = wake?.[0];
  const nameEl = first !== undefined && first.name !== undefined ? (
    <span
      className="wake-name"
      data-tip={first.name}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onOpenTask?.(first.board === true ? (first.boardRef ?? first.id) : `bg:${first.id}`);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onOpenTask?.(first.board === true ? (first.boardRef ?? first.id) : `bg:${first.id}`);
        }
      }}
    >
      {'{' + first.name + '}'}
    </span>
  ) : undefined;
  const wakePrefix = first !== undefined ? (
    <>
      {first.name !== undefined ? t('Woken by background task', '后台任务') : t('Woken by background task', '后台任务唤醒')}
      {nameEl}
      {first.name !== undefined ? <> {t('wake', '唤醒')}</> : null}
    </>
  ) : undefined;
// sealed：<span>{wakePrefix}{wakePrefix !== undefined ? t(', ', '，') : null}{既有文案}</span>
// live：状态行同构拼接（前缀 + '，' + 既有「运行中」段），转圈/计时元素不动
```

- [ ] **Step 4: 实现 MessageList.tsx run 分支**

```tsx
// run 分支（~233）：
      if (entry.kind === 'run') {
        const wake = wakeOfRun(entries, i); // import { wakeOfRun } from '../../../src/session/wake';
        nodes.push(
          <RunEntryView key={entry.key} entry={entry} wake={wake} onOpenTask={onOpenTask} collapsed={...} onToggle={toggleRun} />,
        );
```

（`entries`/`i` 为该渲染闭包既有作用域变量——run 分支所在 map 已带下标；若该处无下标则由 `entries.indexOf(entry)` 取。）

- [ ] **Step 5: 实现 chat-reducer.ts 过滤**

```ts
// ~205 行：
    if (e.kind === 'notice' && (isQuietNotice(e.md) || e.wake !== undefined)) continue; // 唤醒通知不单独显示（归 run 行前缀）
```

- [ ] **Step 6: app.css 末尾追加**

```css
/* ===== bg-wake 唤醒前缀（bg-wake spec §6）：run 行内任务名可点段；定位瞬跳无闪光（CLAUDE.md §13.1 规则 6）；
   悬浮提示 data-tip（§13.1 规则 2，禁原生 title） ===== */
.wake-name { color: var(--fg-secondary); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; display: inline-block; vertical-align: bottom; max-width: 16em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wake-name:hover { color: var(--accent); }
```

- [ ] **Step 7: 跑测通过 + 提交**

Run: `pnpm --dir gui exec vitest run src/pages/chat/RunEntryView.wake.test.tsx src/pages/chat/images-flow.test.tsx`（images-flow 为 MessageList 既有面抽样回归）。

```bash
git add gui/src/chat-reducer.ts gui/src/pages/chat/MessageList.tsx gui/src/pages/chat/EntryViews.tsx gui/src/app.css gui/src/pages/chat/RunEntryView.wake.test.tsx
git commit -m "feat(gui): bg-wake 批F——run 行唤醒前缀(只有任务名可点,bg:/板路由,stopPropagation 不折叠,无名整行静态)/唤醒 notice 不单独显示/.wake-name 样式(data-tip+省略)"
```

---

### Task 7: spec 收口与全量回归

**Files:**
- Modify: `docs/superpowers/specs/2026-11-09-bg-task-wake-design.md`

- [ ] **Step 1: spec §10 收口**——§10-5 改「已核（批D 实现）：live 注入 = 链尾 note 步（`appendChain`），恢复面 `entriesToChainSteps` notice→note 同构，零双注（恢复只走转录派生链）；runTask goal=隐式判据标签 `WAKE_GOAL`」；状态行改「已裁定（落地记录见 plans/2026-11-14-bg-task-wake.md）」。

- [ ] **Step 2: 全量门禁**

Run: `pnpm test && pnpm --dir gui test && pnpm --dir gui run test:e2e`
Expected: 全绿；`tsc` 零错。

- [ ] **Step 3: 手工验收（GUI dev 面）**——后台跑一条 `purpose: 构建前端` 的长 exec，模型收轮后等唤醒：观察 run 行前缀、点任务名瞬跳后台任务页签对应行（无闪光）、团队板任务点开智能体团队页签。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-11-09-bg-task-wake-design.md
git commit -m "docs(spec): bg-wake 收口——§10 五项裁定落定(步型=链尾 note/goal=隐式判据),状态改已裁定"
```
