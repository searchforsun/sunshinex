# 会话档生命周期快照冻结（ctx-snap）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一会话档的前缀快照字节跨运行时重建逐位稳定——attach/resume/setMode 换铸复用落档快照，离场变更以链尾 notice 追尾进入。

**Architecture:** journal 新增 `ctx-snap` 行（快照条目+漂移基线签名，出生写/reloadContext 后追加、末行为准）；`ContextManager.snapshotExport()/restoreSnapshot()` 回种面；daemon attach、TUI resume、serve setMode 三处换铸口统一改走回种；fork 零基线推进钉死。

**Tech Stack:** TypeScript、`node --test --test-force-exit`、无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-31-session-snapshot-freeze-design.md`（执行者须同读）。

## Global Constraints

- journal v3 零兼容口径不变：新增行型不 bump 版本号（旧读面 switch 落 default 忽略未知行，双向兼容）。
- 提示词面文案恒英文单语（CLAUDE.md §15）；代码注释中文、声明「用户裁定/约束」而非「改动说明」。
- 每个文件类任务提交用 **path-limited commit**（`git commit -m "..." -- <paths>`）：工作树常有用户并行在途修改，禁 `git add -A`/`git add .`。
- 测试命令：`timeout 120 node --test --test-force-exit --require "$PWD/scripts/test-env.cjs" <file>`（Git Bash 下 require 必须绝对路径 `$PWD/...`；TUI/daemon 测试退出挂起靠 force-exit）。
- 恢复路径铁律：坏档/缺行**永不阻断恢复**——回退磁盘重读 + 出生写新行。
- fork 零基线推进（spec §5）：子链装配不触 `appendInstructionLine`、不消费 drift、不改基线。

---

### Task 1: journal `ctx-snap` 行型 + 归约（末行为准）

**Files:**
- Modify: `src/tui/session-journal.ts`（JournalEvent 联合、JournalReplay、reduceJournal）
- Test: `src/tui/session-journal.test.ts`（已存在则追加；否则新建）

**Interfaces:**
- Produces: `export interface CtxSnapshot { items: Array<{ part: 'instructions' | 'skills' | 'memory'; kind: string; content: string }>; sig: { skills: string; memory: string; sunshinex: string | null; globalSunshine: string | null } }`；`JournalReplay.snapshot?: CtxSnapshot`（归约取**末条**合法行；载荷不合法的行视同不存在）。

- [ ] **Step 1: 写失败测试**

```ts
// session-journal.test.ts 追加
import { reduceJournal, type JournalEvent } from './session-journal';

const snapRow = (seq: number, content: string): JournalEvent => ({
  t: 'ctx-snap',
  items: [{ part: 'skills', kind: 'system', content }],
  sig: { skills: 'a', memory: '', sunshinex: null, globalSunshine: null },
});

test('reduceJournal: ctx-snap 末行为准', () => {
  const r = reduceJournal([{ t: 'header', v: 3, id: 'x', createdAt: 'c' } as unknown as JournalEvent, snapRow(1, 'old'), snapRow(2, 'new')]);
  assert.equal(r.snapshot?.items[0]?.content, 'new');
});

test('reduceJournal: ctx-snap 载荷不合法视同不存在（坏档不炸归约）', () => {
  const bad = { t: 'ctx-snap', items: 'nope', sig: null } as unknown as JournalEvent;
  const r = reduceJournal([{ t: 'header', v: 3, id: 'x', createdAt: 'c' } as unknown as JournalEvent, bad, snapRow(1, 'ok')]);
  assert.equal(r.snapshot?.items[0]?.content, 'ok');
  const r2 = reduceJournal([{ t: 'header', v: 3, id: 'x', createdAt: 'c' } as unknown as JournalEvent, bad]);
  assert.equal(r2.snapshot, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui 2>/dev/null; cd .. ; timeout 120 node --test --test-force-exit src/tui/session-journal.test.ts`
Expected: FAIL（`ctx-snap` 未建模 / snapshot 字段不存在）

- [ ] **Step 3: 最小实现**

`session-journal.ts`：

```ts
/** 会话前缀快照落档行（2026-10-31 spec：会话档生命周期快照冻结）——items=快照条目（part 三段标注，
 *  /context 分段面板还原用）；sig=漂移基线签名（恢复面基线随快照走）。末行为准；载荷不合法视同不存在 */
export interface CtxSnapshot {
  items: Array<{ part: 'instructions' | 'skills' | 'memory'; kind: string; content: string }>;
  sig: { skills: string; memory: string; sunshinex: string | null; globalSunshine: string | null };
}

// JournalEvent 联合追加：
  | { t: 'ctx-snap'; items: unknown; sig: unknown }
```

`JournalReplay` 接口加 `snapshot?: CtxSnapshot`。`reduceJournal` 初值加 `snapshot: undefined`，switch 追加 case：

```ts
      case 'ctx-snap': {
        const snap = normalizeCtxSnap(e.items, e.sig);
        if (snap !== undefined) r.snapshot = snap; // 末行为准；不合法行视同不存在
        break;
      }
```

模块级净化单点（行面字段不予信任——journal 既有口径）：

```ts
function normalizeCtxSnap(items: unknown, sig: unknown): CtxSnapshot | undefined {
  if (!Array.isArray(items) || typeof sig !== 'object' || sig === null) return undefined;
  const out: CtxSnapshot['items'] = [];
  for (const it of items) {
    const o = (it ?? {}) as { part?: unknown; kind?: unknown; content?: unknown };
    if ((o.part !== 'instructions' && o.part !== 'skills' && o.part !== 'memory') || typeof o.kind !== 'string' || typeof o.content !== 'string') return undefined;
    out.push({ part: o.part, kind: o.kind, content: o.content });
  }
  const s = sig as Record<string, unknown>;
  if (typeof s.skills !== 'string' || typeof s.memory !== 'string' || !(s.sunshinex === null || typeof s.sunshinex === 'string') || !(s.globalSunshine === null || typeof s.globalSunshine === 'string')) return undefined;
  return { items: out, sig: { skills: s.skills, memory: s.memory, sunshinex: s.sunshinex as string | null, globalSunshine: s.globalSunshine as string | null } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS（含既有测试零回归）。

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(journal): ctx-snap 行型+归约——会话前缀快照落档(part 三段标注+漂移基线签名),末行为准,载荷不合法视同不存在(v3 零兼容,未知行双向可忽略)" -- src/tui/session-journal.ts src/tui/session-journal.test.ts
```

---

### Task 2: DriftDetector 基线导出/回种

**Files:**
- Modify: `src/harness/context/drift-detector.ts`
- Test: `src/harness/context/drift-detector.test.ts`（已存在则追加，否则新建——先 `ls src/harness/context/` 确认测试文件名）

**Interfaces:**
- Consumes: Task 1 的 `CtxSnapshot['sig']` 形态。
- Produces: `exportSig(): CtxSnapshot['sig']`（四基线现值）；`restoreBaselines(sig: CtxSnapshot['sig']): void`（四基线直置）。

- [ ] **Step 1: 写失败测试**

```ts
test('exportSig/restoreBaselines: 基线随快照走——回种后 detect 不报漂移,磁盘变更才报', () => {
  // deps 桩:readSunshinex 可变
  let disk = 'v1';
  const d = new DriftDetector({ root: '/r', readGlobalSunshine: () => null, readSunshinex: () => disk, globalPath: '/g', readMemoryIndex: () => '' });
  assert.deepEqual(d.detect(), []); // 构造基线=磁盘,无漂移
  disk = 'v2';
  assert.equal(d.detect().length, 1); // 变更检出,基线前进
  assert.deepEqual(d.detect(), []);
  d.restoreBaselines({ skills: '', memory: '', sunshinex: 'v1', globalSunshine: null }); // 回种旧基线
  assert.deepEqual(d.detect().map((s) => s.startsWith('SUNSHINE.md changed')), [true]); // 旧基线 vs 新磁盘 → 再报一次(追尾语义)
  assert.equal(d.exportSig().sunshinex, 'v2'); // 基线已随比对前进
});
```

- [ ] **Step 2: 跑测试确认失败**（`exportSig`/`restoreBaselines` 不存在）

- [ ] **Step 3: 最小实现**（drift-detector.ts 类内追加）

```ts
  /** 基线导出（ctx-snap 落档面）：四基线现值随快照同出生/同更新 */
  exportSig(): { skills: string; memory: string; sunshinex: string | null; globalSunshine: string | null } {
    return { skills: this.skillsBaseline, memory: this.memoryBaseline, sunshinex: this.sunshinexBaseline, globalSunshine: this.globalSunshineBaseline };
  }

  /** 基线回种（恢复面，spec §3）：落档签名直置——基线随快照走而非随磁盘（attach/resume 换铸时
   *  磁盘可能已变，重取即把变更烘进快照基线、绕过追尾）。回种后首次 detect 检出磁盘 diff 即追尾 */
  restoreBaselines(sig: { skills: string; memory: string; sunshinex: string | null; globalSunshine: string | null }): void {
    this.skillsBaseline = sig.skills;
    this.memoryBaseline = sig.memory;
    this.sunshinexBaseline = sig.sunshinex;
    this.globalSunshineBaseline = sig.globalSunshine;
  }
```

- [ ] **Step 4: 跑测试确认通过**（全文件）
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(drift): 基线导出/回种双面——exportSig 落档随快照,restoreBaselines 恢复面基线随快照走而非随磁盘(attach 换铸磁盘变更走追尾不烘前缀)" -- src/harness/context/drift-detector.ts src/harness/context/drift-detector.test.ts
```

---

### Task 3: ContextManager 快照导出/回种 + reloadContext `snap` 事件

**Files:**
- Modify: `src/harness/context/index.ts`（CtxSnapshot 再导出、snapshotExport、restoreSnapshot、reloadContext 事件）、`src/types.ts` 无需动（ContextItem 已有）
- Test: `src/harness/context/index.snapshot.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `CtxSnapshot`、Task 2 `exportSig/restoreBaselines`。
- Produces:
  - `snapshotExport(): CtxSnapshot`（三段 items 逐条 part 标注 + drift.exportSig()）
  - `restoreSnapshot(s: CtxSnapshot): void`（直注入 snapshotParts/contextSnapshot + drift.restoreBaselines；不触发订阅）
  - `ContextChange` 联合新增 `{ kind: 'snap' }`（reloadContext 发出；订阅面据此落 ctx-snap 行）

- [ ] **Step 1: 写失败测试**

```ts
import { ContextManager } from './index';
import type { CtxSnapshot } from './session-journal-ish'; // 实际从 '../tui/session-journal' import——见 Step 3 说明
// CtxSnapshot 类型定义位置裁定：定义在 src/harness/context/index.ts（上下文域单一事实源），
// session-journal.ts **import 类型**（type-only）——journal 是持久化层,类型属上下文域,防反向依赖。
// 本测试从 './index' import。

test('snapshotExport/restoreSnapshot: 字节级往返', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const snap = cm.snapshotExport();
  const cm2 = new ContextManager('/nonexistent-root', fakeStore);
  cm2.restoreSnapshot(snap);
  // 字节级不变量：装配快照逐位相等
  assert.equal(JSON.stringify(cm2.snapshotExport()), JSON.stringify(snap));
});

test('restoreSnapshot 不触发订阅（重放零双写）', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  let events = 0;
  cm.onContextChange(() => { events++; });
  cm.restoreSnapshot(cm.snapshotExport());
  assert.equal(events, 0);
});

test('reloadContext 发出 snap 事件（压缩/显式刷新后的落档信号）', () => {
  const cm = new ContextManager('/nonexistent-root', fakeStore);
  const kinds: string[] = [];
  cm.onContextChange((c) => kinds.push(c.kind));
  cm.reloadContext();
  assert.deepEqual(kinds, ['snap']);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 最小实现**

`src/harness/context/index.ts`：

```ts
/** 会话前缀快照落档形态（类型单一事实源在本域，journal 层 type-only import——持久化层不反向定义上下文域类型） */
export interface CtxSnapshot {
  items: Array<{ part: 'instructions' | 'skills' | 'memory'; kind: string; content: string }>;
  sig: { skills: string; memory: string; sunshinex: string | null; globalSunshine: string | null };
}
```

`ContextChange` 联合追加 `| { kind: 'snap' }`（头注释补一句：snap=快照翻新信号，压缩/显式刷新后由订阅面落 ctx-snap 行）。

类内追加（`reloadContext` 改发事件）：

```ts
  /** 快照落档导出（ctx-snap 出生/翻新写的数据面）：三段条目 part 标注 + 漂移基线签名同出——
   *  恢复面基线随快照走（spec §3），两半必须同源同拍 */
  snapshotExport(): CtxSnapshot {
    const items: CtxSnapshot['items'] = [];
    for (const [part, list] of Object.entries(this.snapshotParts) as Array<[keyof ContextManager['snapshotParts'], ContextItem[]]>) {
      for (const it of list) items.push({ part, kind: it.kind, content: it.content });
    }
    return { items, sig: this.drift.exportSig() };
  }

  /** 快照回种（attach/resume/setMode 换铸面，spec §4）：落档快照直注入替代磁盘重读——前缀字节跨
   *  重建逐位稳定；基线同拍回种（磁盘 diff 留给首次 appendInstructionLine 追尾）。直注入不触发
   *  订阅（restoreSession 同族：回种期日志是读方）。载荷不合法（条目形态坏）整包拒收返回 false，
   *  调用方回退磁盘现读（坏档永不阻断恢复） */
  restoreSnapshot(s: CtxSnapshot): boolean {
    const parts: ContextManager['snapshotParts'] = { instructions: [], skills: [], memory: [] };
    for (const it of s.items) {
      if (it.kind !== 'system' && it.kind !== 'instruction') return false;
      (parts[it.part] as ContextItem[]).push({ kind: it.kind as 'system' | 'instruction', content: it.content });
    }
    this.snapshotParts = parts;
    this.contextSnapshot = [...parts.instructions, ...parts.skills, ...parts.memory];
    this.drift.restoreBaselines(s.sig);
    return true;
  }
```

`reloadContext()` 末尾追加 `this.changeSink?.({ kind: 'snap' });`。

`src/tui/session-journal.ts` 顶部改：`import type { CtxSnapshot } from '../harness/context/index';` 并删除本地重复定义（Task 1 先放在 journal 侧的类型平移到本任务落位——若 Task 1 已提交，本任务把类型搬家，journal 侧 re-export `export type { CtxSnapshot };` 保消费方零改动）。

- [ ] **Step 4: 跑测试确认通过**（`index.snapshot.test.ts` + Task 1 测试零回归——type 搬家后 journal 测试仍绿）
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(context): 快照导出/回种+snap 事件——snapshotExport 三段标注+基线同源同拍,restoreSnapshot 直注入字节级稳定(坏包拒收回退),reloadContext 发 snap 信号由订阅面落 ctx-snap 行" -- src/harness/context/index.ts src/tui/session-journal.ts src/harness/context/index.snapshot.test.ts
```

---

### Task 4: serve 侧接线——出生写 + attach 回种 + `snap` 事件落行

**Files:**
- Modify: `src/serve/session.ts`（hookJournalSink 加 snap 分支 + `persistSnapshotRow()`）、`src/serve/session-lifecycle.ts`（createSessionIn 出生写、attachSessionIn 回种/回退出生写）
- Test: `src/serve/daemon.ctx-snap.test.ts`（新建，参照 `daemon.workspace.test.ts` 的 io 装配形态）

**Interfaces:**
- Consumes: Task 3 `snapshotExport/restoreSnapshot`、Task 1 `reduceJournal().snapshot`。
- Produces: `SessionRuntime.persistSnapshotRow(): void`（journal 未建档则先 start(3)，落 ctx-snap 行；无 journal no-op）。

- [ ] **Step 1: 写失败测试**

```ts
// daemon.ctx-snap.test.ts 核心断言（io 装配照抄 daemon.workspace.test.ts 的既有 rig）：
test('出生会话落 ctx-snap 行；attach 回种旧快照不重读磁盘；离场变更首条提交追尾', async () => {
  // 1) createSession → journal 文件已建档且含 ctx-snap 行
  // 2) 改磁盘：<root>/SUNSHINE.md 追加内容 + 建 .sunshinex/skills/new-skill/SKILL.md
  // 3) newSession + attach 旧 id → context.snapshotExport() 与落档行逐位相等（不重读磁盘）
  // 4) 提交一条消息 → 链尾出 'SUNSHINE.md changed' 与 '[skills] added' notice 行（各一次）
  // 5) 再提交一条 → 不再重复（基线已前进）
});
test('旧档无 ctx-snap 行：attach 回退磁盘重读 + 出生写新行', async () => {
  // 手工造 v3 档（header+chain 行,无 ctx-snap）→ attach → snapshotExport() 含磁盘新内容且 journal 尾部有 ctx-snap 行
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 最小实现**

`session.ts` `hookJournalSink` 改：

```ts
  private hookJournalSink(): void {
    this.runtimeImpl.harness.context.onContextChange((c) => {
      if (c.kind === 'append') {
        if (this.journal !== undefined && this.journal.currentId === undefined) this.journal.start(3);
        this.journal?.log({ t: 'chain', steps: c.steps });
      } else if (c.kind === 'snap') {
        this.persistSnapshotRow(); // 快照翻新（压缩/显式刷新）：新行落档,末行为准
      } else {
        this.journal?.log({ t: 'compact', chainFrom: c.chainFrom, compacted: c.compacted });
      }
    });
  }

  /** 快照落档单点（2026-10-31 spec §2）：出生写与翻新写共用——journal 未建档则先建档（惰性建档
   *  口径不变,首行即 header+ctx-snap）;无 journal（理论不可达,守卫）no-op */
  persistSnapshotRow(): void {
    if (this.journal === undefined) return;
    if (this.journal.currentId === undefined) this.journal.start(3);
    this.journal.log({ t: 'ctx-snap', ...this.runtimeImpl.harness.context.snapshotExport() } as unknown as Parameters<SessionJournal['log']>[0]);
  }
```

`session-lifecycle.ts` `createSessionIn`：`session.attachJournal(...)` 后加 `session.persistSnapshotRow();`（出生写）。

`attachSessionIn`：`restoreSession(...)` 后加：

```ts
  // 快照回种（2026-10-31 spec §4）：落档快照直注入替代磁盘重读——前缀字节跨换铸逐位稳定;
  // 基线同拍回种,磁盘 diff 留给首条提交追尾。旧档无行/回种被拒（坏包）→ 回退磁盘现读 + 出生写
  // （坏档永不阻断恢复）。回种在 attachJournal 之前（context 已在,时序只要求 restoreSession 同段）
  if (replay.snapshot === undefined || !session.runtime.harness.context.restoreSnapshot(replay.snapshot)) {
    session.persistSnapshotRowAfterAttach = true; // 挂档后出生写（persistSnapshotRow 依赖 journal 实例）
  }
```

简化落法（避免新增字段）：把出生写放在 `attachSessionIn` 末尾 `session.attachJournal(journal)` 之后：

```ts
  if (replay.snapshot !== undefined) session.runtime.harness.context.restoreSnapshot(replay.snapshot);
  // ...既有 attachJournal...
  if (replay.snapshot === undefined) session.persistSnapshotRow(); // 旧档无行:磁盘现读即出生写
```

`restoreSnapshot` 返回 false（坏包）时同样走出生写——写成：

```ts
  const snapOk = replay.snapshot !== undefined && session.runtime.harness.context.restoreSnapshot(replay.snapshot);
  // ...attachJournal...
  if (!snapOk) session.persistSnapshotRow();
```

注意：`createSessionIn` 出生写同样放 `attachJournal` 之后一行。

- [ ] **Step 4: 跑测试确认通过**（`daemon.ctx-snap.test.ts` + `daemon.contract.test.ts`、`daemon.test.ts` 零回归）
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(serve): ctx-snap 接线——出生写(persistSnapshotRow)/attach 回种落档快照(旧档坏包回退磁盘+补出生写)/snap 事件翻新落行(压缩·/init)" -- src/serve/session.ts src/serve/session-lifecycle.ts src/serve/daemon.ctx-snap.test.ts
```

---

### Task 5: TUI 侧接线——resume 回种 + 出生写 + snap 落行

**Files:**
- Modify: `src/tui/session.ts`（onContextChange 加 snap 分支；ensureJournal 新建档时出生写）、`src/tui/commands-session.ts`（restoreFromSession 回种）
- Test: `src/tui/session.resume.test.ts`（追加用例；此文件退出挂起，必须 `timeout`+`--test-force-exit`）

**Interfaces:**
- Consumes: 同 Task 4。
- Produces: TUI 出生/恢复与 daemon 同语义（对等接线）。

- [ ] **Step 1: 写失败测试**

```ts
// session.resume.test.ts 追加（复用既有 writeJournalFile rig）：
test('resume 回种落档快照：快照不重读磁盘;档内无 ctx-snap 行回退磁盘并补出生写', () => {
  // 1) 造档含 ctx-snap 行（skills='old'）→ 改磁盘加技能 → resume →
  //    runtime.harness.context.snapshotExport().items 的 skills 段与落档行一致（不含新技能）
  // 2) 造档无 ctx-snap 行 → resume → snapshotExport 含磁盘新技能 且 journal 文件尾部有 ctx-snap 行
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 最小实现**

`session.ts` onContextChange（446 行处）分支改：

```ts
    this.runtime.harness.context.onContextChange((c) => {
      if (c.kind === 'append') this.journal?.log({ t: 'chain', steps: c.steps });
      else if (c.kind === 'snap') this.persistSnapshotRow();
      else { /* 既有 compact 分支原样 */ }
    });
```

类内加（与 serve 对等的单点）：

```ts
  /** 快照落档单点（2026-10-31 spec；与 serve persistSnapshotRow 同构对等） */
  persistSnapshotRow(): void {
    if (this.journal === undefined) return;
    if (this.journal.currentId === undefined) this.journal.start(3);
    this.journal.log({ t: 'ctx-snap', ...this.runtime.harness.context.snapshotExport() } as unknown as Parameters<SessionJournal['log']>[0]);
  }
```

`ensureJournal()`：新建档（`start` 发生处——读该方法确认新建分支）后调 `this.persistSnapshotRow()`。注意：resume 的 `attach` 路径**不**走这里（restoreFromSession 显式处理），`/new` 的 rotate 路径经 resetSession→reloadContext→snap 事件自然落行（rotate 后 journal 已挂新 id）。

`commands-session.ts` `restoreFromSession`：`restoreSession(...)` 后加：

```ts
  // 快照回种（2026-10-31 spec §4）：落档快照直注入;旧档无行/坏包回退磁盘现读并在 attach 后补出生写
  const snapOk = replay.snapshot !== undefined && ctrl.runtime.harness.context.restoreSnapshot(replay.snapshot);
  // ...（既有各面还原保持原位）...
  ctrl.ensureJournal().attach(meta.id);
  if (!snapOk) ctrl.persistSnapshotRow();
```

（`snapOk` 声明位置在 restoreSession 行旁，`persistSnapshotRow` 调用必须在 `attach(meta.id)` 之后——journal 有 id 才落行。）

- [ ] **Step 4: 跑测试确认通过**（session.resume.test.ts + session.test.ts 零回归；均需 timeout+force-exit）
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(tui): ctx-snap 接线对等 serve——resume 回种落档快照(旧档坏包回退+补出生写)/出生写(ensureJournal 新建)/snap 事件落行" -- src/tui/session.ts src/tui/commands-session.ts src/tui/session.resume.test.ts
```

---

### Task 6: serve setMode/planFlow 换铸快照内存直传

**Files:**
- Modify: `src/serve/session.ts`（所有 `restoreSession(carry)` 位点配对 `restoreSnapshot(prevContext.snapshotExport())`）
- Test: `src/serve/session.ctx-snap-setmode.test.ts`（新建或并入 Task 4 测试文件）

**Interfaces:**
- Consumes: Task 3 `snapshotExport/restoreSnapshot`。
- Produces: 同会话内换铸（setMode / plan 批准续段）前缀字节稳定。

- [ ] **Step 1: 写失败测试**

```ts
test('setMode 换铸：快照内存直传字节稳定,不重读磁盘', async () => {
  // 1) 建会话（出生快照含 skills='old'）→ 2) 改磁盘加新技能 →
  // 3) setMode('acceptEdits') → 4) runtime.harness.context.snapshotExport() 仍不含新技能（与换铸前逐位相等）
  // 5) planFlow 批准续段位点同断言（若有独立 rig 则并入）
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

先 `grep -n "restoreSession(" src/serve/session.ts` 定位全部位点（预期两处：setMode 换铸、planFlow 批准续段 ~910 行）。每个位点在**旧 runtime dispose 之前**捕快照、换新后回种：

```ts
  const prevCtx = oldRuntimeImpl.harness.context; // 换铸前
  const prevSnap = prevCtx.snapshotExport();
  // ...assemble() 换新...
  this.runtimeImpl.harness.context.restoreSession(carry);
  this.runtimeImpl.harness.context.restoreSnapshot(prevSnap); // 快照内存直传(不经 journal,同会话中途换铸字节稳定)
```

若位点已有 `const ctx = ...; const carry = {...}` 形态（如 905 行批准续段），在同一 `carry` 构造行旁加 `const prevSnap = ctx.snapshotExport();`，换新回种行旁加 `restoreSnapshot(prevSnap)`。**换新后不得触发 reloadContext/快照重读**——若 setMode 路径存在显式 reloadContext 调用则删除（它会发出 snap 事件落新行并重读磁盘，破坏字节稳定）。

- [ ] **Step 4: 跑测试确认通过**（+ daemon 全家零回归）
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(serve): setMode/planFlow 换铸快照内存直传——同会话中途换运行时前缀字节稳定,离场磁盘变更留给追尾" -- src/serve/session.ts src/serve/session.ctx-snap-setmode.test.ts
```

---

### Task 7: fork 零基线推进钉死 + 全量验证

**Files:**
- Test: `src/harness/subagent.ctx-snap.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2/3 全部。纯测试任务（钉死现状 + 新语义回归面），实现零改动——若测试红了才是 bug，按根因修。

- [ ] **Step 1: 写钉死测试**

```ts
test('fork 零基线推进：子链跑完父漂移基线不变、主链零 notice 污染', async () => {
  // 1) 建会话（基线=出生磁盘态）→ 2) 改磁盘（加技能+改 SUNSHINE.md）→
  // 3) spawn 子智能体跑一轮（seedHistory 装配）→
  // 4) 断言：harness.context.checkConstantsDrift() 仍报全部 diff（基线未被子链消费前进）；
  //    主链无子链引入的 [skills] notice 行;子链 transcript 无 drift notice（seedHistory 不含）
});
```

- [ ] **Step 2: 跑测试**——预期 PASS（现状即如此：子 Reactor 走 seedHistory，不触 appendInstructionLine）。若 FAIL，定位是哪条路径让子链触达了 drift，修后重跑。
- [ ] **Step 3: 全量验证**

```bash
# 定向全家（新增/触及面）：
timeout 240 node --test --test-force-exit --require "$PWD/scripts/test-env.cjs" src/tui/session-journal.test.ts src/harness/context/index.snapshot.test.ts src/harness/context/drift-detector.test.ts src/serve/daemon.ctx-snap.test.ts src/serve/session.ctx-snap-setmode.test.ts src/tui/session.resume.test.ts src/harness/subagent.ctx-snap.test.ts
# 宽回归（known-fail 基线对照——4 个 compaction 失败为用户并行在途既有,零新增即过）：
timeout 540 node --test --test-force-exit --require "$PWD/scripts/test-env.cjs" src/harness/reactor.test.ts src/serve/daemon.test.ts src/harness/reactor.chat.test.ts src/session/session.resume.test.ts 2>&1 | tail -20
```

判定：**零新增失败**（与 dev1 既有 known-fail 清单对照），typecheck `npx tsc --noEmit` 干净（并行在途错误除外，须与基线比对）。

- [ ] **Step 4: Commit**

```bash
git commit -m "test(harness): fork 零基线推进钉死——子链 seedHistory 装配不触 drift/不污染主链,ctx-snap 回归面固化" -- src/harness/subagent.ctx-snap.test.ts
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 行型→T1/T3；§3 基线→T2/T3；§4 三口子→T4(attach+出生)/T5(resume)/T6(setMode)；§5 fork/teammate/压缩//init→T7 钉死+T4 snap 事件（teammate 无 journal 维持内存态=现状，无任务）；§7 验证→T4/T5/T6/T7 各任务测试。无缺口。
- **占位符**：无 TBD；T6「预期两处位点」是定位指令非占位（给了 grep 命令与改法模板）。
- **类型一致性**：`CtxSnapshot` T1 定义、T3 搬家至 `harness/context/index.ts` 并 re-export（消费方零改动）——T1 执行者须知此后续搬迁，已写入 T3 Step 3；`persistSnapshotRow` serve/TUI 同名对等；`snapshotExport/restoreSnapshot` 全任务一致。
