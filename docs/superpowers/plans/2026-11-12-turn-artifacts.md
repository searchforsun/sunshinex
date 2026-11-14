# 轮末产物卡与产物库（turn artifacts）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 助手本轮产出的非代码交付物（文档/图片/表格/演示/数据）在回复末尾以卡片呈现（打开 ▾ 可外部打开），并在右栏新增会话级「产物」页签聚合。

**Architecture:** 内核 `commitFileWrite` 单点声明（ArtifactCollector 注入）∪ run 收尾 bash 差集白名单兜底，并入 `RunMeta.artifacts` 随 journal 落档重放；GUI 侧轮末卡区与产物库 tab 是同一份 artifacts 的两个只读投影（不变量：渲染端零二次推导）。

**Tech Stack:** TypeScript（内核 node:test，编译后跑 `dist/`）+ React 18 SPA（gui/，vitest+jsdom）+ Node http 手写路由 daemon。

**Spec:** `docs/superpowers/specs/2026-11-12-turn-artifacts-design.md`（本计划从 spec 论证，执行者两份都读）

## Global Constraints

- 白名单（非代码交付物）：`md txt pdf rst | png jpg jpeg webp gif svg | xlsx xls csv tsv | pptx ppt docx doc | json yaml yml toml xml`，代码类一律不进（spec §3.2）。
- 单 run `artifacts` ≤ 64 条；声明集在先、bash 兜底补足至帽，溢出静默截断（spec §3.5）。
- 产物去重：同 run 同路径保末次；声明优先于 bash 兜底；产物库跨 run 保最新（spec §3.3/§6.2）。
- bash 兜底只收**新建**（status `added`/`untracked`）；修改类交付物只经 write/edit 声明进来（spec §3.4）。
- 渲染端零二次推导：卡片/产物库只读 `RunMeta.artifacts` 与 `GET /session/:id/artifacts`（spec §1）。
- 零新权限面；TUI 零改动；顶栏 `sx-open-split` 零改动（spec §7）。
- 文案中文硬编码（`t('En', '中')` 形态，gui/src/i18n），与现 GUI 一致。
- 测试命令：内核 `pnpm exec tsc -p tsconfig.json && node --test dist/<file>.test.js`（tsconfig outDir=dist/rootDir=src，src/artifacts.test.ts → dist/artifacts.test.js）；GUI `pnpm --dir gui exec vitest run src/<file>.test.ts`；类型检查 `pnpm --dir gui run typecheck`；全量 `pnpm test` + `pnpm --dir gui test`。
- 提交信息：仓库中文 conventional 风格（`feat(scope): 描述(裁定日期+依据)`），每 Task 一提交。
- CSS：卡片面 `var(--surface-elevated)` + `1px solid var(--border)` + `var(--radius-md)`（=22px）；轮内嵌区用 `var(--bubble-user)`；前景混色系 `color-mix(in srgb, var(--fg) N%, transparent)`。

---

### Task 1: 内核类型登记与白名单（`src/types.ts`）

**Files:**
- Modify: `src/types.ts`（`TurnFileChange` 接口闭合处 ~line 368 之后、`ApprovalKind` 之前落 `ArtifactFile`；文件任一导出区落 `isDeliverablePath`——建议紧跟 `ArtifactFile`）
- Test: `src/artifacts.test.ts`（新建）

**Interfaces:**
- Produces: `interface ArtifactFile { path: string; source: 'write' | 'edit' | 'bash'; callId?: string }`、`function isDeliverablePath(relPath: string): boolean` ——后续所有任务按此名引用。

- [ ] **Step 1: 写失败测试** `src/artifacts.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeliverablePath } from './types';

/** 轮次产物面(2026-11-12 spec):白名单单点 + sanitize + 落档/重放往返(Task 2 追加) */

test('isDeliverablePath:白名单命中(大小写不敏感/反斜杠/嵌套目录),代码与点开头顶格不认', () => {
  assert.equal(isDeliverablePath('docs/TECH-DEBT-LOG.md'), true);
  assert.equal(isDeliverablePath('报告.MD'), true);
  assert.equal(isDeliverablePath('mocks\\ui\\logo.svg'), true);
  assert.equal(isDeliverablePath('docs/data.Export.JSON'), true);
  assert.equal(isDeliverablePath('src/index.ts'), false);
  assert.equal(isDeliverablePath('src/app.py'), false);
  assert.equal(isDeliverablePath('README'), false);
  assert.equal(isDeliverablePath('dir/.hidden'), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/artifacts.test.js`
Expected: FAIL（`isDeliverablePath` 不存在，编译错误）

- [ ] **Step 3: 最小实现** `src/types.ts` 在 `TurnFileChange` 之后追加：

```ts
/** 轮次产物行（2026-11-12 spec §3.1；gui 侧另有同形局部声明不引——惯例同 ChangeFile）：
 *  内核写盘声明（write/edit 工具面）或 run 收尾 bash 差集兜底并入，随 RunMeta.artifacts
 *  落档重放；渲染端（轮末卡区/产物库）只读投影，零二次推导 */
export interface ArtifactFile {
  /** 项目根相对路径（/ 分隔） */
  path: string;
  /** 声明来源：write/edit=工具面写盘声明；bash=收尾差集兜底（callId 缺省） */
  source: 'write' | 'edit' | 'bash';
  /** 末次写入调用关联（未来 diff 寻址；bash 兜底无） */
  callId?: string;
}

/** 交付物扩展名白名单（2026-11-12 spec §3.2 非代码口径，用户裁定）：内核声明钩与 bash 兜底
 *  共用单点；GUI 侧类目标签副本在 gui/src/artifacts.ts */
const ARTIFACT_EXTS: ReadonlySet<string> = new Set([
  'md', 'txt', 'pdf', 'rst',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'xlsx', 'xls', 'csv', 'tsv',
  'pptx', 'ppt', 'docx', 'doc',
  'json', 'yaml', 'yml', 'toml', 'xml',
]);

/** 项目根相对路径是否交付物（基名扩展名判，大小写不敏感；点开头顶格不认） */
export function isDeliverablePath(relPath: string): boolean {
  const base = relPath.replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && ARTIFACT_EXTS.has(base.slice(dot + 1).toLowerCase());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/artifacts.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/artifacts.test.ts
git commit -m "feat(artifacts): 内核类型登记 ArtifactFile+交付物白名单单点(2026-11-12 spec §3.1-3.2,用户裁定非代码口径)"
```

---

### Task 2: RunMeta.artifacts + sanitize + seglog 两路落档 + 内核帧透传

**Files:**
- Modify: `src/session/entry.ts`（`RunMeta` 接口 ~line 18-34；`sanitizeTurn` ~line 213-234 之后落 `sanitizeArtifacts`；`case 'runmeta'` 分支 ~line 518-545；line 1 import 扩 `ArtifactFile`）
- Modify: `src/session/seglog.ts`（line 1 import 扩 `sanitizeArtifacts`；`kernelEventRows` runmeta 映射 ~line 31-37；`SegRowLike` ~line 89 加字段；`runMetaOf` ~line 137-153）
- Test: `src/artifacts.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `ArtifactFile`。
- Produces: `RunMeta.artifacts?: ArtifactFile[]`、`sanitizeArtifacts(raw: unknown): ArtifactFile[] | undefined`。journal 写路径两条（seglog `kernelEventRows` 行映射 + serve 直写 `journal.log`，后者在 Task 5）读路径 `runMetaOf` 一条。

- [ ] **Step 1: 追加失败测试** 到 `src/artifacts.test.ts`（import 行扩 `sanitizeArtifacts`，新增 `kernelEventRows`/`reduceSegRows`/`RunMeta` import）：

```ts
import { kernelEventRows, reduceSegRows } from './session/seglog';
import type { RunMeta } from './session/entry';
// 文件头追加 import { sanitizeArtifacts } from './session/entry';
```

```ts
test('sanitizeArtifacts:坏行弃/source 枚举收敛/path 去重保首现', () => {
  assert.deepEqual(
    sanitizeArtifacts([
      { path: 'a.md', source: 'write' },
      { path: '', source: 'write' },
      'junk',
      { path: 'b.png', source: 'hax' },
      { path: 'a.md', source: 'edit', callId: 'c9' },
    ]),
    [{ path: 'a.md', source: 'write' }],
  );
  assert.equal(sanitizeArtifacts(undefined), undefined);
  assert.equal(sanitizeArtifacts('x'), undefined);
  assert.equal(sanitizeArtifacts([]), undefined);
});

test('runmeta.artifacts 落档/重放往返:kernelEventRows 带出 → runMetaOf 绑回末个 run 条', () => {
  const artifacts = [
    { path: 'docs/report.md', source: 'write', callId: 'c1' },
    { path: 'shot.png', source: 'bash' },
  ];
  const meta: RunMeta = { seconds: 3, steps: 5, artifacts };
  const rows = kernelEventRows({ t: 'runmeta', entry: { seq: 7, ts: 1, kind: 'run', md: '', meta } });
  const replayed = reduceSegRows([{ t: 'run-open', ts: 1, seq: 7 }, ...rows]);
  const runEntry = replayed.find((e) => e.kind === 'run');
  assert.ok(runEntry);
  assert.deepEqual(runEntry.meta?.artifacts, artifacts);
  assert.equal(runEntry.meta?.steps, 5);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/artifacts.test.js`
Expected: FAIL（sanitizeArtifacts 不存在 / artifacts 字段不带出）

- [ ] **Step 3: 实现 entry.ts** 三处：

① line 1：`import type { ChangeFile, SessionEvent, TurnFileChange } from '../types';` → 加 `ArtifactFile`。
② `RunMeta` 接口（turn 字段之后）加：

```ts
  /** 轮次产物（2026-11-12 spec §3）：非代码交付物，声明+bash 兜底；落档重放同 turn */
  artifacts?: ArtifactFile[];
```

③ `sanitizeTurn` 之后落（同文件同模式）：

```ts
/** 轮次产物行净化（行面字段不予信任，同 sanitizeChanges 口径）：path 必带非空、source 枚举
 *  收敛、callId 严判非空串、path 去重保首现——坏行整条弃 */
export function sanitizeArtifacts(raw: unknown): ArtifactFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ArtifactFile[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    const o = (a ?? {}) as Partial<Record<keyof ArtifactFile, unknown>>;
    if (typeof o.path !== 'string' || o.path === '' || typeof o.source !== 'string') continue;
    if (o.source !== 'write' && o.source !== 'edit' && o.source !== 'bash') continue;
    if (seen.has(o.path)) continue;
    seen.add(o.path);
    const callId = typeof o.callId === 'string' && o.callId !== '' ? o.callId : undefined;
    out.push({ path: o.path, source: o.source, ...(callId !== undefined ? { callId } : {}) });
  }
  return out.length > 0 ? out : undefined;
}
```

④ `case 'runmeta':`（~line 532 `const turn = sanitizeTurn(p.turn);` 之后）加 `const artifacts = sanitizeArtifacts(p.artifacts);`；meta 对象里 `...(turn !== undefined && turn.length > 0 ? { turn } : {}),` 之后加 `...(artifacts !== undefined && artifacts.length > 0 ? { artifacts } : {}),`。

- [ ] **Step 4: 实现 seglog.ts** 四处：

① line 1：`import { sanitizeChanges, sanitizeTurn, ... } from './entry';` → 加 `sanitizeArtifacts`。
② `SegRowLike`（~line 89，`turn` 字段邻位）加 `artifacts?: unknown;`。
③ `kernelEventRows` runmeta 映射（~line 36 返回对象里 `...(m.turn !== undefined && m.turn.length > 0 ? { turn: m.turn } : {})` 之后）加 `...(m.artifacts !== undefined && m.artifacts.length > 0 ? { artifacts: m.artifacts } : {})`。
④ `runMetaOf`（~line 146 `const turn = sanitizeTurn(row.turn);` 之后）加 `const artifacts = sanitizeArtifacts(row.artifacts);`；返回对象里 turn spread 之后加 `...(artifacts !== undefined && artifacts.length > 0 ? { artifacts } : {}),`。

- [ ] **Step 5: 跑测试确认通过**（同 Step 2 命令）Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/session/entry.ts src/session/seglog.ts src/artifacts.test.ts
git commit -m "feat(artifacts): RunMeta.artifacts 一等字段+sanitize+seglog 两路落档+内核帧透传(2026-11-12 spec §3.1,turn 同构)"
```

---

### Task 3: ArtifactCollector 收集器

**Files:**
- Create: `src/harness/tools/artifact-collector.ts`
- Test: `src/harness/tools/artifact-collector.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ArtifactFile`/`isDeliverablePath`。
- Produces: `class ArtifactCollector { record(relPosix: string, source: 'write' | 'edit'): void; tagCall(relPosix: string, callId: string): void; drain(): ArtifactFile[] }` ——Task 4 注入 builtin、Task 5 drain。

- [ ] **Step 1: 写失败测试** `src/harness/tools/artifact-collector.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactCollector } from './artifact-collector';

/** 产物声明收集器(2026-11-12 spec §3.3;仿 WriteSnapshotCollector 注入模式):白名单过滤/
 *  tool-result 回标挂末尾未标条目/drain 按 path 保末次并清空 */

test('record:白名单过滤;同路径多刀 drain 保末次(含末个 source 与末次回标)', () => {
  const c = new ArtifactCollector();
  c.record('docs/a.md', 'write');
  c.record('src/index.ts', 'write'); // 代码不收
  c.tagCall('docs/a.md', 'c1');
  c.record('docs/a.md', 'edit'); // 第二刀
  c.tagCall('docs/a.md', 'c2');
  assert.deepEqual(c.drain(), [{ path: 'docs/a.md', source: 'edit', callId: 'c2' }]);
  assert.deepEqual(c.drain(), []); // drain 清空
});

test('tagCall:回标路径反斜杠归一比对;无匹配静默', () => {
  const c = new ArtifactCollector();
  c.record('docs/a.md', 'write');
  c.tagCall('docs\\a.md', 'c1');
  assert.deepEqual(c.drain(), [{ path: 'docs/a.md', source: 'write', callId: 'c1' }]);
  const c2 = new ArtifactCollector();
  c2.tagCall('ghost.md', 'c0'); // 无匹配不抛不记
  assert.deepEqual(c2.drain(), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/harness/tools/artifact-collector.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `src/harness/tools/artifact-collector.ts`：

```ts
import type { ArtifactFile } from '../../types';
import { isDeliverablePath } from '../../types';

/** 轮次产物声明收集器（2026-11-12 spec §3.3；仿 WriteSnapshotCollector 注入模式：内存清单、
 *  run 收口 drain、缺省不注入=无产物、零工具面变化）。callId 在声明时刻拿不到（调用 id 随
 *  tool-result 回执才现），与快照族同根因同解：回执时回标末尾未标条目 */
export class ArtifactCollector {
  private pending: ArtifactFile[] = [];

  /** write/edit 落盘声明（builtin.ts commitFileWrite 单点调钩）：白名单命中才记 */
  record(relPosix: string, source: 'write' | 'edit'): void {
    if (!isDeliverablePath(relPosix)) return;
    this.pending.push({ path: relPosix, source });
  }

  /** tool-result 回执回标（serve/session.ts 泵 tagCall 邻位）：挂该路径末尾未回标条目——
   *  多刀写同路径时末尾未标=本次调用产物；回标路径反斜杠归一比对 */
  tagCall(relPosix: string, callId: string): void {
    const want = relPosix.replaceAll('\\', '/');
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]!.path === want && this.pending[i]!.callId === undefined) {
        this.pending[i]!.callId = callId;
        return;
      }
    }
  }

  /** run 收口：按 path 去重保留末次（先 write 后 edit 视同一条），并清空清单 */
  drain(): ArtifactFile[] {
    if (this.pending.length === 0) return [];
    const byPath = new Map<string, ArtifactFile>();
    for (const a of this.pending) byPath.set(a.path, a);
    this.pending = [];
    return [...byPath.values()];
  }
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2）Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/harness/tools/artifact-collector.ts src/harness/tools/artifact-collector.test.ts
git commit -m "feat(artifacts): ArtifactCollector 声明收集器(白名单过滤/回执回标/drain 保末次,2026-11-12 spec §3.3)"
```

---

### Task 4: commitFileWrite 声明钩 + harness 注入

**Files:**
- Modify: `src/harness/tools/builtin.ts`（opts 类型 ~line 101-112 加 `artifacts`；解构 ~line 128 加 `artifacts`；`commitFileWrite` ~line 140-173 落盘段加钩）
- Modify: `src/harness/index.ts`（import；类字段 ~line 116 邻位；初始化 ~line 217 邻位；`builtinTools(...)` opts ~line 251-273 加传参）

**Interfaces:**
- Consumes: Task 3 的 `ArtifactCollector`。
- Produces: `runtimeImpl.harness.artifacts: ArtifactCollector`（serve 侧 Task 5 消费）；builtinTools opts 新键 `artifacts?: { record(relPosix: string, source: 'write' | 'edit'): void }`。

- [ ] **Step 1: builtin.ts opts 类型**（`writeSnapshot?: ...` 行之后）加：

```ts
    artifacts?: { record(relPosix: string, source: 'write' | 'edit'): void };
```

同函数体内解构行（`const { kb, webSearch, archive, ... } = opts;`）加 `artifacts`。

- [ ] **Step 2: commitFileWrite 落盘钩**——`writeSnapshot?.captureAfter(target, finalContent);` 之后插：

```ts
    // 产物声明钩（2026-11-12 spec §3.3）：落盘成功后白名单命中即记；relPosix 归一（canonical，
    // tagCall 侧同归一比对）；callId 由 serve 泵在 tool-result 回执时回标（ArtifactCollector.tagCall）
    artifacts?.record(path.relative(root, target).replaceAll('\\', '/'), verb === 'written' ? 'write' : 'edit');
```

- [ ] **Step 3: harness/index.ts 注入** 三处：

① import 区加 `import { ArtifactCollector } from './tools/artifact-collector';`
② 类字段（`readonly writeSnapshot: ...` ~line 116 邻位）加 `readonly artifacts: ArtifactCollector;`
③ 初始化（`this.writeSnapshot = makeWriteSnapshotSink(...)` ~line 217 邻位）加 `this.artifacts = new ArtifactCollector();`
④ `builtinTools(this.safety, base, { ... })` 调用（~line 251-273，`writeSnapshot: this.writeSnapshot,` 之后）加 `artifacts: this.artifacts,`

- [ ] **Step 4: 编译+全量回归**（本任务无新测试面——行为由 Task 3 单测 + Task 5 集成面覆盖；此处验注入不破既有工具面）

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/harness/tools/ 2>&1 | tail -5`
Expected: PASS（编译零错；既有工具测试不红）

- [ ] **Step 5: 提交**

```bash
git add src/harness/tools/builtin.ts src/harness/index.ts
git commit -m "feat(artifacts): commitFileWrite 单点声明钩+ArtifactCollector 注入(2026-11-12 spec §3.3,write-snapshot 同模式)"
```

---

### Task 5: serve 接线——tagCall 回标 + bash 兜底纯函数 + run 收尾并入 + journal/pump/内存表

**Files:**
- Create: `src/serve/artifacts-handlers.ts`（本任务先落 `mergeRunArtifacts` 纯函数；Task 7 同文件扩 scan）
- Test: `src/serve/artifacts-handlers.test.ts`（新建）
- Modify: `src/serve/session.ts`（pump 回标分支 ~line 957-975；`turnChanges` 字段 ~line 779 邻位加 `runArtifacts`；run 收尾块 ~line 1098-1159 四处）

**Interfaces:**
- Consumes: Task 2 的 `sanitizeArtifacts`（间接）；Task 4 的 `runtimeImpl.harness.artifacts`。
- Produces: `mergeRunArtifacts(declared: ArtifactFile[], gitExtra: ChangeFile[]): ArtifactFile[]`（声明∪bash 兜底、声明优先去重、64 帽——Task 7 同文件扩 scan）；runmeta journal 行/帧带 `artifacts`；`this.runArtifacts: Map<number, ArtifactFile[]>`（Task 7 端点当轮面消费）。

- [ ] **Step 1: 写失败测试** `src/serve/artifacts-handlers.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunArtifacts } from './artifacts-handlers';
import type { ArtifactFile, ChangeFile } from '../types';

/** 产物并入面(2026-11-12 spec §3.4-3.5):声明∪bash 兜底(差集中白名单新建),声明优先去重,64 帽 */

test('mergeRunArtifacts:声明∪bash 新建,声明优先去重,64 帽声明集在先', () => {
  const declared: ArtifactFile[] = [
    { path: 'docs/a.md', source: 'write', callId: 'c1' },
    { path: 'shot.png', source: 'edit' },
  ];
  const gitExtra: ChangeFile[] = [
    { path: 'docs/a.md', status: 'untracked', added: 1, deleted: null }, // 声明已有 → 覆弃
    { path: 'out\\csv\\data.csv', status: 'added', added: 9, deleted: null }, // bash 兜底收(反斜杠归一)
    { path: 'src/gen.ts', status: 'untracked', added: 2, deleted: null }, // 白名单外不收
    { path: 'docs/b.md', status: 'modified', added: 1, deleted: 1 }, // 修改类不经兜底(spec §3.4)
  ];
  assert.deepEqual(mergeRunArtifacts(declared, gitExtra), [
    { path: 'docs/a.md', source: 'write', callId: 'c1' },
    { path: 'shot.png', source: 'edit' },
    { path: 'out/csv/data.csv', source: 'bash' },
  ]);
  const flood: ArtifactFile[] = Array.from({ length: 64 }, (_, i) => ({ path: `f${String(i).padStart(2, '0')}.md`, source: 'write' as const }));
  const merged = mergeRunArtifacts(flood, [{ path: 'extra.md', status: 'added', added: 1, deleted: null }]);
  assert.equal(merged.length, 64); // 帽截断:声明集在先,兜底被挤出
  assert.equal(merged.some((a) => a.path === 'extra.md'), false);
});

test('mergeRunArtifacts:双空面=空', () => {
  assert.deepEqual(mergeRunArtifacts([], []), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/serve/artifacts-handlers.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `src/serve/artifacts-handlers.ts`（Task 7 将在同文件扩 scan）：

```ts
import type { ArtifactFile, ChangeFile } from '../types';
import { isDeliverablePath } from '../types';

/** 轮次产物并入（2026-11-12 spec §3.4-3.5）：声明面（write/edit，已保末次）∪ bash 兜底（收尾
 *  差集中白名单**新建**——skill 脚本产件通道；修改类不经兜底，差集无前后像语义），按 path
 *  去重声明优先，64 帽（声明集在先，溢出静默截断） */
export const ARTIFACTS_CAP = 64;

export function mergeRunArtifacts(declared: ArtifactFile[], gitExtra: ChangeFile[]): ArtifactFile[] {
  const seen = new Set(declared.map((a) => a.path));
  const bashArtifacts = gitExtra
    .filter((c) => c.status === 'added' || c.status === 'untracked')
    .map((c) => c.path.replaceAll('\\', '/'))
    .filter((p) => isDeliverablePath(p) && !seen.has(p))
    .map((p) => ({ path: p, source: 'bash' as const }));
  return [...declared, ...bashArtifacts].slice(0, ARTIFACTS_CAP);
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2）Expected: PASS

- [ ] **Step 5: session.ts 接线**四处：

① import 区：`import { mergeRunArtifacts } from './artifacts-handlers';`（`ArtifactFile` 加进既有 `../types` type import）。
② pump 回标——`this.runtimeImpl.harness.writeSnapshot.tagCall(rel, callId);`（~line 969）之后加：

```ts
            this.runtimeImpl.harness.artifacts.tagCall(rel, callId); // 产物回标(2026-11-12 spec §3.3,同守卫同位)
```

③ 内存表字段——`turnChanges` 声明行（~line 779）邻位加：

```ts
  private readonly runArtifacts = new Map<number, ArtifactFile[]>(); // 轮次产物(2026-11-12 spec §6.2 端点当轮面)
```

④ run 收尾并入——`if (runSeq >= 0 && turn.length > 0) this.turnChanges.set(runSeq, turn);`（~line 1126）之后插：

```ts
        // 产物并入（2026-11-12 spec §3.4-3.5）：声明∪bash 兜底（mergeRunArtifacts 纯函数,单测在案）
        const declared = this.runtimeImpl.harness.artifacts.drain();
        const artifacts = mergeRunArtifacts(declared, gitExtra);
        if (runSeq >= 0 && artifacts.length > 0) this.runArtifacts.set(runSeq, artifacts);
```

- [ ] **Step 6: journal 落档 + 帧广播**——run 收尾 `this.journal?.log({ t: 'runmeta', ... })` 对象里 `...(turn.length > 0 ? { turn } : {}),` 之后加：

```ts
          ...(artifacts.length > 0 ? { artifacts } : {}),
```

`this.pump({ type: 'runmeta', ts: endedTs, payload: { ... } })` 的 payload 里同位置加同一行 spread。

- [ ] **Step 7: 编译 + 既有回归**（runmeta 行多了字段，旧读侧按缺省不覆盖应零感知）

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/serve/turn-changes.test.js dist/serve/artifacts-handlers.test.js dist/artifacts.test.js dist/session/seglog.test.js 2>&1 | tail -6`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/serve/artifacts-handlers.ts src/serve/artifacts-handlers.test.ts src/serve/session.ts
git commit -m "feat(artifacts): serve run 收尾声明∪bash 兜底并入(mergeRunArtifacts 纯函数单测)+journal/pump 落档+内存表(2026-11-12 spec §3.4-3.5)"
```

---

### Task 6: /app/open 「系统默认」档 + 相对路径解析

**Files:**
- Modify: `src/serve/editors-handlers.ts`（新增导出 `defaultOpenCommand` 纯函数；`handleEditorsOpen` ~line 247-277 三处）
- Test: `src/serve/editors-default.test.ts`（新建）

**Interfaces:**
- Produces: `POST /app/open` 接受 `id: 'default'`（不必在已装名单）与可选 `root`（相对 path 的解析根）；`defaultOpenCommand(platform: NodeJS.Platform, target: string): { cmd: string; args: string[] }`（Task 10 经 `openInEditor(path, id, root)` 消费）。

- [ ] **Step 1: 写失败测试** `src/serve/editors-default.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultOpenCommand } from './editors-handlers';

/** 系统默认关联打开(2026-11-12 spec §5.3):explorer 对文件只定位不关联,须独立一档 */

test('defaultOpenCommand:三平台命令面(win32 start 空标题位/mac open/linux xdg-open)', () => {
  assert.deepEqual(defaultOpenCommand('win32', 'C:\\r\\a.md'), { cmd: 'cmd', args: ['/c', 'start', '', 'C:\\r\\a.md'] });
  assert.deepEqual(defaultOpenCommand('darwin', '/r/a.md'), { cmd: 'open', args: ['/r/a.md'] });
  assert.deepEqual(defaultOpenCommand('linux', '/r/a.md'), { cmd: 'xdg-open', args: ['/r/a.md'] });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/serve/editors-default.test.js`
Expected: FAIL（defaultOpenCommand 不存在）

- [ ] **Step 3: 实现**——`editors-handlers.ts` 顶部导出区（`editorCandidates` 之前）加：

```ts
/** 系统默认关联打开命令面（2026-11-12 spec §5.3）：win32 用 `start`（首个引号参是窗口标题位，
 *  故 '' 占位防路径被吞）；explorer.exe 对文件只定位不关联打开，故系统默认须独立一档 */
export function defaultOpenCommand(platform: NodeJS.Platform, target: string): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', target] };
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}
```

`handleEditorsOpen` 改四处：

① body 类型扩 `root?: unknown`：`const body = (parsed.body ?? {}) as { path?: unknown; id?: unknown; root?: unknown };`
② id 校验之后、已装名单查找之前插（`const list = editorsCache ?? ...` 之前）：

```ts
  // 相对路径解析（2026-11-12 spec §5）：产物行存项目根相对；/app/open 系 spawn 需要 abs——
  // GUI 带会话 root 时服务端解析（平台分隔符正确性归服务端；工作区打开传 abs 不受影响）
  let target = body.path as string;
  if (typeof body.root === 'string' && body.root !== '' && !path.isAbsolute(target)) {
    target = path.resolve(body.root, target);
  }
  // 系统默认关联打开：独立一档，不在已装名单内也放行
  if (body.id === 'default') {
    const { cmd, args } = defaultOpenCommand(process.platform, target);
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', (err: Error) => {
        console.error(`[app/open] spawn failed (default): ${err.message}`);
      });
      child.unref();
      io.send(res, 200, { ok: true });
    } catch {
      io.send(res, 500, { error: 'spawn failed' });
    }
    return;
  }
```

③ 既 `const editor = list.find((e) => e.id === body.id);` 分支不改；④ 既有 `spawn(editor.exe, [body.path], ...)` 改为 `spawn(editor.exe, [target], ...)`（相对路径同样受益）。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2）Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/serve/editors-handlers.ts src/serve/editors-default.test.ts
git commit -m "feat(artifacts): /app/open 系统默认档(defaultOpenCommand 三平台)+root 相对解析(2026-11-12 spec §5.3)"
```

---

### Task 7: GET /session/:id/artifacts 聚合端点

**Files:**
- Modify: `src/serve/artifacts-handlers.ts`（Task 5 已建，本任务加 `AggregatedArtifact` + `scanArtifactsJsonl`）
- Modify: `src/serve/session.ts`（`turnChangeFor` ~line 787 之后加 `artifactsAggregated()` 方法；import 区加 scan）
- Modify: `src/serve/daemon.ts`（路由表 `/session/:id/changes` 条目 ~line 697-703 之后加一条）
- Test: `src/serve/artifacts-handlers.test.ts`（追加 scan 用例）

**Interfaces:**
- Consumes: Task 2 的 `sanitizeArtifacts`/`ArtifactFile`；Task 5 的 `runArtifacts` 内存表与同文件。
- Produces: `scanArtifactsJsonl(text: string): AggregatedArtifact[]`、`interface AggregatedArtifact { path: string; source: 'write'|'edit'|'bash'; callId?: string; runSeq: number; endedTs?: number }`、`session.artifactsAggregated(): { items: AggregatedArtifact[] }`（Task 12 GUI `conn.artifacts` 消费）。

- [ ] **Step 1: 追加失败测试** 到 `src/serve/artifacts-handlers.test.ts`（import 行扩 `scanArtifactsJsonl`）：

```ts
import { scanArtifactsJsonl } from './artifacts-handlers';

/** 产物库聚合扫描(2026-11-12 spec §6.2):run-open 开轮记 seq,runmeta 绑轮,跨 run 去重保最新;
 *  journal 全量扫 → 子智能体 run 的 runmeta 行同样入池(含子 run) */

test('scanArtifactsJsonl:跨 run 同路径保最新 run,坏行跳过,runSeq 倒序', () => {
  const jsonl = [
    JSON.stringify({ t: 'run-open', seq: 1 }),
    JSON.stringify({ t: 'runmeta', artifacts: [{ path: 'a.md', source: 'write', callId: 'c1' }], endedTs: 100 }),
    JSON.stringify({ t: 'run-open', seq: 2 }),
    JSON.stringify({ t: 'runmeta', artifacts: [{ path: 'a.md', source: 'edit', callId: 'c2' }, { path: 'b.png', source: 'bash' }], endedTs: 200 }),
    'junk-line',
    JSON.stringify({ t: 'runmeta', changes: [] }), // 无 artifacts 行忽略
  ].join('\n');
  assert.deepEqual(scanArtifactsJsonl(jsonl), [
    { path: 'a.md', source: 'edit', callId: 'c2', runSeq: 2, endedTs: 200 },
    { path: 'b.png', source: 'bash', runSeq: 2, endedTs: 200 },
  ]);
});

test('scanArtifactsJsonl:空文本/无 run-open 前缀的 runmeta 不认', () => {
  assert.deepEqual(scanArtifactsJsonl(''), []);
  assert.deepEqual(scanArtifactsJsonl(JSON.stringify({ t: 'runmeta', artifacts: [{ path: 'x.md', source: 'write' }] })), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsc -p tsconfig.json && node --test dist/serve/artifacts-handlers.test.js`
Expected: FAIL（scanArtifactsJsonl 不存在）

- [ ] **Step 3: 实现**——`src/serve/artifacts-handlers.ts` 头部 import 区扩 `import { sanitizeArtifacts } from '../session/entry';`，`mergeRunArtifacts` 之后追加：

```ts
/** 产物库聚合行（2026-11-12 spec §6.2）：跨 run 按 path 去重保留最新 run（库语义），runSeq 倒序 */
export interface AggregatedArtifact {
  path: string;
  source: 'write' | 'edit' | 'bash';
  callId?: string;
  runSeq: number;
  endedTs?: number;
}

/** journal jsonl 行扫描 → 聚合（纯函数；内存当轮面由 session.artifactsAggregated 在其上合并）：
 *  run-open 行开轮记 seq，runmeta 行 artifacts 绑轮；坏行跳过（撕裂不阻断扫描） */
export function scanArtifactsJsonl(text: string): AggregatedArtifact[] {
  const best = new Map<string, AggregatedArtifact>();
  let openSeq = -1;
  for (const line of text.split('\n')) {
    if (!line.includes('"run-open"') && !line.includes('"runmeta"')) continue;
    try {
      const e = JSON.parse(line) as { t?: string; seq?: unknown; artifacts?: unknown; endedTs?: unknown };
      if (e.t === 'run-open') {
        openSeq = typeof e.seq === 'number' ? e.seq : openSeq;
        continue;
      }
      if (e.t !== 'runmeta' || e.seq !== undefined || openSeq < 0) continue;
      const artifacts = sanitizeArtifacts(e.artifacts);
      const endedTs = typeof e.endedTs === 'number' ? e.endedTs : undefined;
      if (artifacts === undefined) continue;
      for (const a of artifacts) {
        const prev = best.get(a.path);
        if (prev !== undefined && prev.runSeq >= openSeq) continue;
        best.set(a.path, {
          path: a.path,
          source: a.source,
          ...(a.callId !== undefined ? { callId: a.callId } : {}),
          runSeq: openSeq,
          ...(endedTs !== undefined ? { endedTs } : {}),
        });
      }
    } catch {
      // 坏行跳过（撕裂不阻断扫描,turnChangeFor 同款）
    }
  }
  return [...best.values()].sort((x, y) => y.runSeq - x.runSeq);
}
```

- [ ] **Step 4: session 方法**——`src/serve/session.ts` 的 `turnChangeFor`（~line 787-819）之后加（import 区把 Task 5 的 `import { mergeRunArtifacts } from './artifacts-handlers';` 扩为 `import { mergeRunArtifacts, scanArtifactsJsonl, type AggregatedArtifact } from './artifacts-handlers';`）：

```ts
  /** 产物库聚合（2026-11-12 spec §6.2）：内存当轮面 + journal 落档面合并，跨 run 按 path
   *  去重保留最新 run（库语义），runSeq 倒序；含子 run（journal 全量扫） */
  artifactsAggregated(): { items: AggregatedArtifact[] } {
    const best = new Map<string, AggregatedArtifact>();
    const consider = (row: AggregatedArtifact): void => {
      const prev = best.get(row.path);
      if (prev !== undefined && prev.runSeq >= row.runSeq) return;
      best.set(row.path, row);
    };
    for (const [runSeq, list] of this.runArtifacts) {
      for (const a of list) consider({ path: a.path, source: a.source, ...(a.callId !== undefined ? { callId: a.callId } : {}), runSeq });
    }
    const id = this.journal?.currentId;
    if (id !== undefined) {
      try {
        const file = path.join(resolveDataDir(this.root), 'sessions', `${id}.jsonl`);
        for (const row of scanArtifactsJsonl(fs.readFileSync(file, 'utf8'))) consider(row);
      } catch {
        // 无档/读失败=仅内存面
      }
    }
    return { items: [...best.values()].sort((x, y) => y.runSeq - x.runSeq) };
  }
```

- [ ] **Step 5: daemon 路由**——路由表 `/session/:id/changes` 条目（~line 697-703）之后加：

```ts
    { method: 'GET', path: '/session/:id/artifacts', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        this.send(res, 200, session.artifactsAggregated());
      } },
```

- [ ] **Step 6: 跑测试确认通过**（Step 2 命令 + `dist/serve/turn-changes.test.js` 回归）Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/serve/artifacts-handlers.ts src/serve/artifacts-handlers.test.ts src/serve/session.ts src/serve/daemon.ts
git commit -m "feat(artifacts): GET /session/:id/artifacts 聚合端点(跨 run 去重保最新含子 run,内存+journal 两面,2026-11-12 spec §6.2)"
```

---

### Task 8: GUI 共享面（分类器/标签）`gui/src/artifacts.ts`

**Files:**
- Create: `gui/src/artifacts.ts`
- Test: `gui/src/artifacts.test.ts`（新建）

**Interfaces:**
- Produces: `interface ArtifactFile { path: string; source: 'write'|'edit'|'bash'; callId?: string }`（内核同形）、`interface ArtifactRow extends ArtifactFile { runSeq: number; endedTs?: string|number... }`——**精确形**：`{ path: string; source: 'write'|'edit'|'bash'; callId?: string; runSeq: number; endedTs?: number }`、`extOf(relPath): string | undefined`、`isDeliverablePath(relPath): boolean`、`artifactKindLabel(relPath): string | undefined`（「文档 · MD」形态）——Task 9/11/12 按此引用。

- [ ] **Step 1: 写失败测试** `gui/src/artifacts.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { extOf, isDeliverablePath, artifactKindLabel } from './artifacts';

/** 产物共享面(2026-11-12 spec §3.2;内核同形副本,惯例同 ChangeFile 不引) */

describe('产物分类器与标签', () => {
  it('extOf:反斜杠/嵌套/点开头顶格', () => {
    expect(extOf('docs\\a\\b.md')).toBe('md');
    expect(extOf('报告.MD')).toBe('md');
    expect(extOf('dir/.hidden')).toBeUndefined();
    expect(extOf('README')).toBeUndefined();
  });
  it('isDeliverablePath 与内核白名单同形', () => {
    expect(isDeliverablePath('docs/a.md')).toBe(true);
    expect(isDeliverablePath('src/index.ts')).toBe(false);
  });
  it('artifactKindLabel:「类目 · 大写扩展名」,非产物 undefined', () => {
    expect(artifactKindLabel('docs/TECH-DEBT-LOG.md')).toBe('文档 · MD');
    expect(artifactKindLabel('shot.png')).toBe('图片 · PNG');
    expect(artifactKindLabel('数据.xlsx')).toBe('表格 · XLSX');
    expect(artifactKindLabel('deck.pptx')).toBe('演示 · PPTX');
    expect(artifactKindLabel('out.json')).toBe('数据 · JSON');
    expect(artifactKindLabel('docx 盘.docx')).toBe('文档 · DOCX');
    expect(artifactKindLabel('src/index.ts')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir gui exec vitest run src/artifacts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `gui/src/artifacts.ts`：

```ts
/** 产物共享面（2026-11-12 spec §3.2；内核登记点 src/types.ts ArtifactFile——惯例同 ChangeFile
 *  「gui 侧另有同形局部声明不引」）：扩展名→类目词标签 + 白名单同形判定 */

export interface ArtifactFile {
  path: string;
  source: 'write' | 'edit' | 'bash';
  callId?: string;
}

/** 产物库聚合行（GET /session/:id/artifacts items 直映） */
export interface ArtifactRow {
  path: string;
  source: 'write' | 'edit' | 'bash';
  callId?: string;
  runSeq: number;
  endedTs?: number;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  md: '文档', txt: '文档', pdf: '文档', rst: '文档', docx: '文档', doc: '文档',
  png: '图片', jpg: '图片', jpeg: '图片', webp: '图片', gif: '图片', svg: '图片',
  xlsx: '表格', xls: '表格', csv: '表格', tsv: '表格',
  pptx: '演示', ppt: '演示',
  json: '数据', yaml: '数据', yml: '数据', toml: '数据', xml: '数据',
};

export function extOf(relPath: string): string | undefined {
  const base = relPath.replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

export function isDeliverablePath(relPath: string): boolean {
  const ext = extOf(relPath);
  return ext !== undefined && ext in KIND_LABELS;
}

/** 「类目 · 大写扩展名」标签；非产物 undefined */
export function artifactKindLabel(relPath: string): string | undefined {
  const ext = extOf(relPath);
  if (ext === undefined) return undefined;
  const kind = KIND_LABELS[ext];
  return kind === undefined ? undefined : `${kind} · ${ext.toUpperCase()}`;
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm --dir gui exec vitest run src/artifacts.test.ts && pnpm --dir gui run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add gui/src/artifacts.ts gui/src/artifacts.test.ts
git commit -m "feat(artifacts): GUI 产物共享面(同形类型+分类器+「文档 · MD」标签,2026-11-12 spec §3.2)"
```

---

### Task 9: chat-reducer 摄入（活帧端到端）

**Files:**
- Modify: `gui/src/chat-reducer.ts`（`ChatEntry` ~line 61 `turn` 字段邻位加 `artifacts`；line 1 import 扩；`mapOne` run 分支 ~line 181-182 加一行）
- Test: `gui/src/chat-reducer.artifacts.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的内核透传（`applyChatEvent → applySubagentEvent(s.k, e) → entry.ts runmeta 分支 → KernelEntry.meta.artifacts`）。
- Produces: `ChatEntry.artifacts?: ArtifactFile[]`（Task 11 卡片区消费）。

- [ ] **Step 1: 写失败测试** `gui/src/chat-reducer.artifacts.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionEvent } from '../../src/types';
import { applyChatEvent, initialChatState } from './chat-reducer';
import { setLanguage } from './i18n';

/** runmeta.artifacts 摄入(2026-11-12 spec §4.4):内核 runmeta 帧透传→run 条直映;空/缺省不落字段 */

let ts = 0;
function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent {
  return { type, text, payload, ts: ++ts };
}
function fold(events: SessionEvent[], start = initialChatState()) {
  return events.reduce(applyChatEvent, start);
}

describe('runmeta.artifacts 摄入', () => {
  it('artifacts 直映 run 条;缺省不落字段', () => {
    const s = fold([
      ev('model-start'),
      ev('token', 'hi'),
      ev('done', 'hi'),
      ev('runmeta', undefined, { seconds: 2, artifacts: [{ path: 'docs/report.md', source: 'write', callId: 'c1' }] }),
    ]);
    const run = s.entries.find((e) => e.kind === 'run');
    expect(run?.artifacts).toEqual([{ path: 'docs/report.md', source: 'write', callId: 'c1' }]);

    const s2 = fold([ev('model-start'), ev('done', 'x'), ev('runmeta', undefined, { seconds: 1 })]);
    expect(s2.entries.find((e) => e.kind === 'run')?.artifacts).toBeUndefined();
  });
});
```

（事件序列若与 chat-reducer.test.ts 既有 run 条铸造惯例不同步，以该文件既有 runmeta/run 对位用例的事件序列为准调整本测试的前置事件——断言不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir gui exec vitest run src/chat-reducer.artifacts.test.ts`
Expected: FAIL（`artifacts` undefined）

- [ ] **Step 3: 实现**——`gui/src/chat-reducer.ts` 两处：

① line 1：`import { ... type TurnFileChange } from '../../src/types';` → 加 `type ArtifactFile`。
② `ChatEntry` 的 `turn?: TurnFileChange[];`（~line 61）之后加：

```ts
  /** 轮次产物(2026-11-12 spec §4):非代码交付物,runmeta.artifacts 直映——轮尾产物卡数据面 */
  artifacts?: ArtifactFile[];
```

③ `mapOne` run 分支（~line 182 `if (m.turn !== undefined && m.turn.length > 0) view.turn = m.turn;` 之后）加：

```ts
        if (m.artifacts !== undefined && m.artifacts.length > 0) view.artifacts = m.artifacts;
```

- [ ] **Step 4: 跑测试确认通过 + 全 reducer 回归**

Run: `pnpm --dir gui exec vitest run src/chat-reducer.artifacts.test.ts src/chat-reducer.test.ts && pnpm --dir gui run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add gui/src/chat-reducer.ts gui/src/chat-reducer.artifacts.test.ts
git commit -m "feat(artifacts): chat-reducer 摄入 artifacts(活帧端到端,内核透传单点生效,2026-11-12 spec §4.4)"
```

---

### Task 10: OpenSplit 共用件 + connection 扩参

**Files:**
- Create: `gui/src/pages/chat/OpenSplit.tsx`
- Modify: `gui/src/connection.ts`（interface ~line 136 `openInEditor` 加第三参；impl ~line 639 邻位同步）
- Modify: `gui/src/app.css`（文件尾追加样式块）

**Interfaces:**
- Consumes: `SessionRowMenu`（`gui/src/sidebar/session-row-menu.tsx`，items: `{id,label,icon?,tail?,active?,disabled?,divider?,keepOpen?,onSelect}`）、`editorIconCached/editorIconPut`（`gui/src/ui-util.ts:13-14`）、`Connection`。
- Produces: `function OpenSplit(props: { conn: Connection; onOpError?: (err: unknown) => void; onOpenDefault: () => void; onOpenWith: (id: string) => void; ariaLabel: string }): JSX.Element` ——Task 11/12 消费；`openInEditor(path, id, root?)`。

- [ ] **Step 1: connection 扩参**——interface（~line 136）：

```ts
  /** 以指定应用打开路径(POST /app/open;spawn detached,id 在已装名单或 'default';root=相对路径解析根) */
  openInEditor(path: string, id: string, root?: string): Promise<void>;
```

impl（~line 639）：

```ts
    async openInEditor(path: string, id: string, root?: string) {
      await post('/app/open', { path, id, ...(root !== undefined ? { root } : {}) });
    },
```

- [ ] **Step 2: 实现** `gui/src/pages/chat/OpenSplit.tsx`：

```tsx
import { useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { SessionRowMenu } from '../../sidebar/session-row-menu';
import { editorIconCached, editorIconPut } from '../../ui-util';
import { t } from '../../i18n';
import type { Connection } from '../../connection';

/** 编辑器清单模块级缓存:产物卡×N 只发一次 /app/editors(与 ChatTopbar 抖动根修同口径) */
let editorsCache: Array<{ id: string; name: string }> | null = null;
let editorsPromise: Promise<Array<{ id: string; name: string }>> | null = null;

async function loadEditors(conn: Connection): Promise<Array<{ id: string; name: string }>> {
  if (editorsCache !== null) return editorsCache;
  editorsPromise ??= conn
    .editorsList()
    .then((r) => {
      editorsCache = r.editors;
      return r.editors;
    });
  return editorsPromise;
}

const NATIVE_FALLBACK: Readonly<Record<string, string>> = { explorer: 'default-folder', vscode: 'file-type-vscode', cursor: 'folder-type-cursor' };

/** 「打开 ▾」分体钮共用件(2026-11-12 spec §5.4):主钮=调用方默认动作(产物卡/产物库=侧栏预览),
 *  ∨=已装应用+「系统默认」菜单;菜单项点击=立即以该目标打开(与顶栏「选中仅设默认」的反误触
 *  语义刻意区分——卡片菜单是单文件动作,spec §5.2) */
export function OpenSplit({ conn, onOpError, onOpenDefault, onOpenWith, ariaLabel }: {
  conn: Connection;
  onOpError?: (err: unknown) => void;
  onOpenDefault: () => void;
  onOpenWith: (id: string) => void;
  ariaLabel: string;
}): JSX.Element {
  const [editors, setEditors] = useState<Array<{ id: string; name: string }>>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const ensureEditors = (): void => {
    loadEditors(conn)
      .then((list) => {
        setEditors(list);
        for (const e of list) {
          if (icons[e.id] !== undefined) continue;
          conn
            .editorIcon(e.id)
            .then((r) => {
              const url = `data:${r.mime};base64,${r.data}`;
              editorIconPut(e.id, url);
              setIcons((prev) => ({ ...prev, [e.id]: url }));
            }, () => {})
            .catch(() => {});
        }
      })
      .catch((err: unknown) => onOpError?.(err));
  };

  const toggle = (anchor: HTMLElement): void => {
    if (menu !== null) {
      setMenu(null);
      return;
    }
    ensureEditors();
    const b = anchor.getBoundingClientRect();
    setMenu({ x: b.right, y: b.bottom + 2 });
  };

  const glyph = (id: string): JSX.Element => {
    const url = icons[id] ?? editorIconCached(id);
    if (url !== undefined) return <img src={url} alt="" style={{ width: 14, height: 14, display: 'block', objectFit: 'contain' }} />;
    const key = NATIVE_FALLBACK[id];
    if (key === undefined) return <ExternalLink size={14} strokeWidth={1.75} />;
    return <ExternalLink size={14} strokeWidth={1.75} />;
  };

  return (
    <span className="sx-artifacts-open">
      <button type="button" className="sx-artifacts-openbtn" aria-label={ariaLabel} onClick={onOpenDefault}>
        {t('Open', '打开')}
      </button>
      <button
        type="button"
        className="sx-artifacts-caret"
        aria-label="open with"
        data-tip={t('Open with', '打开方式')}
        onClick={(e) => toggle(e.currentTarget)}
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      {menu !== null && (
        <SessionRowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...editors.map((e) => ({
              id: e.id,
              label: e.name,
              icon: glyph(e.id),
              onSelect: () => {
                setMenu(null);
                onOpenWith(e.id);
              },
            })),
            { id: 'sx-divider', label: '', divider: true, onSelect: () => {} },
            {
              id: 'default',
              label: t('System default', '系统默认'),
              icon: <ExternalLink size={14} strokeWidth={1.75} />,
              onSelect: () => {
                setMenu(null);
                onOpenWith('default');
              },
            },
          ]}
        />
      )}
    </span>
  );
}
```

（`glyph` 内 `NATIVE_FALLBACK` 品牌字形回退留作后续——当前统一回落 ExternalLink，与 ChatTopbar 的 vscode-icons 注入链解耦以免复制 `dangerouslySetInnerHTML` 面；菜单主识别靠原生图标缓存。）

- [ ] **Step 3: CSS**——`gui/src/app.css` 文件尾追加：

```css
/* ===== 「打开 ▾」分体钮共用件(2026-11-12 spec §5.4):产物卡/产物库同用;主钮文本钮+caret 贴边 ===== */
.sx-artifacts-open { display: inline-flex; align-items: stretch; flex: none; }
.sx-artifacts-openbtn { border: 1px solid var(--border); border-right: none; background: transparent; color: var(--fg); font-size: calc(13px * var(--fz)); padding: 2px 10px; border-radius: var(--radius-sm) 0 0 var(--radius-sm); cursor: pointer; }
.sx-artifacts-openbtn:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.sx-artifacts-caret { border: 1px solid var(--border); background: transparent; color: var(--fg-secondary); padding: 2px 4px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0; cursor: pointer; display: inline-flex; align-items: center; }
.sx-artifacts-caret:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 8%, transparent); }
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `pnpm --dir gui run typecheck`
Expected: PASS

```bash
git add gui/src/pages/chat/OpenSplit.tsx gui/src/connection.ts gui/src/app.css
git commit -m "feat(artifacts): OpenSplit 分体钮共用件(编辑器清单模块缓存+系统默认档,菜单点击即开)+openInEditor root 扩参(2026-11-12 spec §5.2-5.4)"
```

---

### Task 11: ArtifactsStrip 轮末卡区 + 全链 props 接线

**Files:**
- Create: `gui/src/pages/chat/ArtifactsStrip.tsx`
- Modify: `gui/src/pages/chat/EntryViews.tsx`（`ChatEntryView` 签名 ~line 594 加 props；footer 区 ~line 775-791 在 RunChangesBar 块之前插渲染）
- Modify: `gui/src/pages/chat/MessageList.tsx`（`MessageListProps` ~line 34-70 加两 props；`ChatEntryView` 调用 ~line 264-281 传参）
- Modify: `gui/src/pages/Chat.tsx`（Chat props 接口加 `onOpenArtifacts`/`onOpError` 已有则复用——`onOpError` Chat 已有（~line 92 destructure），只加 `onOpenArtifacts`；`<MessageList>` 调用 ~line 1021 传参）
- Modify: `gui/src/App.tsx`（`openTabType` ~line 639 之后加 `openArtifactsTab` useCallback；渲染 Chat 处 ~line 1159-1173 传 `onOpenArtifacts`）
- Modify: `gui/src/app.css`（卡区样式块追加）

**Interfaces:**
- Consumes: Task 8 `ArtifactFile/artifactKindLabel`、Task 9 `ChatEntry.artifacts`、Task 10 `OpenSplit`。
- Produces: `function ArtifactsStrip(props: { artifacts; conn; sessionId; root?; onOpenFile?; onOpError?; }): JSX.Element | null`（`onOpenArtifacts` 链接属 Task 12）。

- [ ] **Step 1: 实现** `gui/src/pages/chat/ArtifactsStrip.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { FileIcon } from '../../file-icon';
import { OpenSplit } from './OpenSplit';
import { artifactKindLabel, type ArtifactFile } from '../../artifacts';
import { t } from '../../i18n';
import type { Connection } from '../../connection';

const FOLD_AT = 8;
/** 缩略图只认位图族(svg 走 FileIcon 字形——daemon 图片分支 mime 面不保证 svg) */
const THUMB_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/** 轮末产物卡区(2026-11-12 spec §4):助手正文之后、改动条之前;数据=runmeta.artifacts 只读投影。
 *  网格 auto-fit minmax(360px,1fr)——单卡整行/多卡宽处两列/窄处单列(auto-fit 折叠空轨道);
 *  >8 张折叠为前两行+「展开全部」(复用改动条折叠交互模式) */
export function ArtifactsStrip({ artifacts, conn, sessionId, root, onOpenFile, onOpError }: {
  artifacts: ReadonlyArray<ArtifactFile>;
  conn: Connection;
  sessionId: string;
  root?: string;
  onOpenFile?: (p: string) => void;
  onOpError?: (err: unknown) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    for (const a of artifacts) {
      const ext = a.path.split('.').pop()?.toLowerCase() ?? '';
      if (!THUMB_EXTS.has(ext) || thumbs[a.path] !== undefined) continue;
      const load = sessionId === '' ? conn.appFile(root ?? '', a.path) : conn.readFile(sessionId, a.path);
      load
        .then((f) => {
          if (alive && f.type === 'image' && typeof f.mime === 'string' && typeof f.data === 'string') {
            setThumbs((prev) => ({ ...prev, [a.path]: `data:${f.mime};base64,${f.data}` }));
          }
        }, () => {})
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [artifacts, conn, sessionId, root]); // thumbs 故意不入 deps:回填不重发请求

  const openWith = (p: string, id: string): void => {
    void conn.openInEditor(p, id, root).catch((err: unknown) => onOpError?.(err));
  };

  const visible = open ? artifacts : artifacts.slice(0, FOLD_AT);
  return (
    <div className="sx-artifacts">
      <div className="sx-artifacts-head">
        <span>{t('Artifacts this turn', '本轮产物')} ({artifacts.length})</span>
        {artifacts.length > FOLD_AT && (
          <button type="button" className="sx-artifacts-fold" onClick={() => setOpen((v) => !v)}>
            {open ? t('Collapse', '收起') : t('Show all', '展开全部')}
          </button>
        )}
      </div>
      <div className="sx-artifacts-grid">
        {visible.map((a) => {
          const name = a.path.split('/').pop() ?? a.path;
          const dir = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
          const label = artifactKindLabel(a.path);
          const thumb = thumbs[a.path];
          return (
            <div key={a.path} className="sx-artifacts-card">
              {thumb !== undefined ? (
                <img className="sx-artifacts-thumb" src={thumb} alt="" loading="lazy" decoding="async" />
              ) : (
                <span className="sx-artifacts-tile">
                  <FileIcon path={a.path} size={20} />
                </span>
              )}
              <span className="sx-artifacts-main">
                <span className="sx-artifacts-name" title={a.path}>{name}</span>
                {label !== undefined && <span className="sx-artifacts-kind">{label}</span>}
                {dir !== '' && <span className="sx-artifacts-dir">{dir}</span>}
              </span>
              <OpenSplit
                conn={conn}
                onOpError={onOpError}
                ariaLabel={`${t('Open', '打开')} ${name}`}
                onOpenDefault={() => onOpenFile?.(a.path)}
                onOpenWith={(id) => openWith(a.path, id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: EntryViews 接线**——`ChatEntryView` 签名（~line 594）的解构与类型加 `conn, sessionId, root, onOpError`（类型 `conn: Connection; sessionId: string; root?: string; onOpError?: (err: unknown) => void`，import `type { Connection }`）；footer 区（~line 775-791）在 `{footerRun !== undefined && footerRun.changes !== undefined && ...}` 块**之前**插：

```tsx
      {footerRun !== undefined && footerRun.artifacts !== undefined && footerRun.artifacts.length > 0 && (
        <ArtifactsStrip
          artifacts={footerRun.artifacts}
          conn={conn}
          sessionId={sessionId}
          root={root}
          onOpenFile={onOpenFile}
          onOpError={onOpError}
        />
      )}
```

（import 区加 `import { ArtifactsStrip } from './ArtifactsStrip';`。）

- [ ] **Step 3: MessageList 接线**——`MessageListProps`（~line 34-70，`readonly runFooterByEntry` 邻位）加：

```ts
  readonly onOpError?: (err: unknown) => void;
  readonly onOpenArtifacts?: () => void;
```

`ChatEntryView` 调用（~line 264-281，`sideChat={sideChat}` 之前）加 `conn={conn} sessionId={sessionId} root={root} onOpError={onOpError} onOpenArtifacts={onOpenArtifacts}` 五参（`conn/sessionId/root` MessageListProps 已有）。

- [ ] **Step 4: Chat 接线**——Chat props 接口加 `readonly onOpenArtifacts?: () => void;`；`<MessageList>` 调用（~line 1021，`root={root}` 之后）加 `onOpError={onOpError}` 与 `onOpenArtifacts={onOpenArtifacts}`。

- [ ] **Step 5: App 接线**——`openTabType`（~line 639）之后加：

```ts
  const openArtifactsTab = useCallback((): void => {
    openTabInSession('artifacts', {});
  }, [openTabInSession]);
```

（Task 12 才注册 `'artifacts'` 类型——本 Task 该回调已稳定但入口未接；App 渲染 Chat 处 `onOpenTab={openTabType}` 邻位（~line 1165）加 `onOpenArtifacts={openArtifactsTab}`。注意：Task 11 提交后点开产物入口尚无 tab 类型——`openArtifactsTab` 在 Task 12 前不被任何 UI 引用（strip 节头链接 Task 12 才加），无运行时面，提交安全。）

- [ ] **Step 6: CSS**——`gui/src/app.css` 追加：

```css
/* ===== 轮末产物卡区(2026-11-12 spec §4):单卡整行/多卡 auto-fit 两列(750 档),窄处单列 ===== */
.sx-artifacts { margin: 14px -6px 4px; background: var(--bubble-user); border-radius: var(--radius-md); padding: 2px 10px 10px; }
.sx-artifacts-head { display: flex; align-items: center; gap: 8px; padding: 6px 0 6px; font-size: calc(14px * var(--fz)); color: var(--fg-secondary); }
.sx-artifacts-fold { border: none; background: transparent; color: var(--fg-tertiary); cursor: pointer; font-size: calc(14px * var(--fz)); padding: 2px 6px; border-radius: var(--radius-sm); }
.sx-artifacts-fold:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 8%, transparent); }
.sx-artifacts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 8px; }
.sx-artifacts-card { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px; background: var(--surface-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); }
.sx-artifacts-tile { width: 32px; height: 32px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--surface-soft); border-radius: 8px; }
.sx-artifacts-thumb { width: 32px; height: 32px; flex: none; object-fit: cover; border-radius: 8px; }
.sx-artifacts-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.sx-artifacts-name { color: var(--fg); font-weight: 600; font-size: calc(14px * var(--fz)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sx-artifacts-kind { color: var(--fg-tertiary); font-size: calc(12px * var(--fz)); }
.sx-artifacts-dir { color: var(--fg-tertiary); font-size: calc(12px * var(--fz)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 7: 类型检查 + 提交**

Run: `pnpm --dir gui run typecheck && pnpm --dir gui exec vitest run src/chat-reducer.artifacts.test.ts`
Expected: PASS

```bash
git add gui/src/pages/chat/ArtifactsStrip.tsx gui/src/pages/chat/EntryViews.tsx gui/src/pages/chat/MessageList.tsx gui/src/pages/Chat.tsx gui/src/App.tsx gui/src/app.css
git commit -m "feat(artifacts): 轮末产物卡区 ArtifactsStrip+全链 props 接线(auto-fit 网格/缩略图/折叠,2026-11-12 spec §4)"
```

---

### Task 12: 产物库页签 + 「全部产物 →」入口

**Files:**
- Create: `gui/src/pages/Artifacts.tsx`
- Modify: `gui/src/tabs/tab-state.ts:21`（`TabTypeId` 联合加 `'artifacts'`）
- Modify: `gui/src/tabs/sidebar-refresh.ts`（`REFRESHABLE_TAB_TYPES` 加 `'artifacts'`）
- Modify: `gui/src/tabs/registry.tsx`（lucide import line 13 加 `Package`；lazy 区 ~line 19-30 加 `ArtifactsTab`；`TAB_ICONS` ~line 144-158 加 `artifacts: Package,`；`TAB_REGISTRY` ~line 184+ 加条目）
- Modify: `gui/src/connection.ts`（interface 加 `artifacts(sessionId)`；impl 加方法）
- Modify: `gui/src/pages/chat/ArtifactsStrip.tsx`（节头加「全部产物 →」链接，props 加 `onOpenArtifacts`）
- Modify: `gui/src/pages/chat/EntryViews.tsx`（strip 调用透传 `onOpenArtifacts`）
- Modify: `gui/src/app.css`（产物库页样式追加）

**Interfaces:**
- Consumes: Task 7 端点、Task 8 `ArtifactRow/artifactKindLabel`、Task 10 `OpenSplit`、Task 11 threading。
- Produces: tab 类型 `'artifacts'`（singleton，group `'content'`）；`connection.artifacts(sessionId): Promise<{ items: ArtifactRow[] }>`。

- [ ] **Step 1: 类型注册三件**——`tab-state.ts:21` `TabTypeId` 联合加 `'artifacts'`；`sidebar-refresh.ts` Set 加 `'artifacts',`；`registry.tsx` lucide import 加 `Package`、lazy 区加 `const ArtifactsTab = lazy(() => import('../pages/Artifacts').then((m) => ({ default: m.ArtifactsTab })));`、`TAB_ICONS` 加 `artifacts: Package, // 产物库(2026-11-12)`、`TAB_REGISTRY` 末尾加：

```tsx
  {
    id: 'artifacts',
    group: 'content',
    // 产物库页签(2026-11-12 spec §6):会话级聚合,跨 run 按 path 去重保留最新(含子 run);
    // 被动入口(轮末卡区节头链接)为主,「+」菜单不刻意推广
    title: () => t('Artifacts', '产物'),
    resolveKey: () => '',
    singleton: true,
    render: (p) => (
      <ArtifactsTab conn={p.conn} sessionId={p.sessionId} root={p.root} refreshNonce={p.panelRefreshNonce} onOpenFile={fileTabOf(p)} />
    ),
  },
```

- [ ] **Step 2: connection 加方法**——interface（`openInEditor` 之后）：

```ts
  /** GET /session/:id/artifacts(产物库聚合;跨 run 按 path 去重保最新,含子 run) */
  artifacts(sessionId: string): Promise<{ items: import('./artifacts').ArtifactRow[] }>;
```

impl（`readFile` 邻位 ~line 742）：

```ts
    artifacts(sessionId: string) {
      return getJson(`/session/${encodeURIComponent(sessionId)}/artifacts`);
    },
```

- [ ] **Step 3: 实现** `gui/src/pages/Artifacts.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { FileIcon } from '../file-icon';
import { OpenSplit } from './chat/OpenSplit';
import { artifactKindLabel, type ArtifactRow } from '../artifacts';
import { t } from '../i18n';
import type { Connection } from '../connection';

/** 产物库页签(2026-11-12 spec §6):会话级聚合(GET /session/:id/artifacts,跨 run 按 path
 *  去重保留最新,含子 run);行=图标+名称+类目+来源轮+打开分体钮;点行=侧栏预览 */
export function ArtifactsTab({ conn, sessionId, root, refreshNonce, onOpenFile }: {
  conn: Connection;
  sessionId: string;
  root?: string;
  refreshNonce?: number;
  onOpenFile?: (p: string) => void;
}): JSX.Element {
  const [items, setItems] = useState<ArtifactRow[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback((): void => {
    if (sessionId === '') {
      setItems([]);
      return;
    }
    conn
      .artifacts(sessionId)
      .then((r) => {
        setItems(r.items);
        setError('');
      }, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .catch(() => {});
  }, [conn, sessionId]);
  useEffect(() => {
    load();
  }, [load, refreshNonce]);

  const empty = items !== null && items.length === 0;
  return (
    <div className="sx-artifacts-page">
      {error !== '' && <div className="sx-artifacts-empty">{error}</div>}
      {error === '' && items === null && <div className="sx-artifacts-empty">{t('Loading…', '加载中…')}</div>}
      {empty && <div className="sx-artifacts-empty">{t('No artifacts yet — deliverables the assistant produces (docs, images, sheets) land here.', '暂无产物——助手产出的文档/图片/表格等交付物会出现在这里。')}</div>}
      {items !== null && items.length > 0 && (
        <div className="sx-artifacts-list">
          {items.map((a) => {
            const name = a.path.split('/').pop() ?? a.path;
            const dir = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
            const label = artifactKindLabel(a.path);
            return (
              <div key={`${a.path}:${a.runSeq}`} className="sx-artifacts-row">
                <FileIcon path={a.path} size={16} />
                <span
                  className="sx-artifacts-rowname"
                  title={a.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenFile?.(a.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenFile?.(a.path);
                    }
                  }}
                >
                  {name}
                </span>
                {label !== undefined && <span className="sx-artifacts-kind">{label}</span>}
                <span className="sx-artifacts-rowdir">{dir}</span>
                <span className="sx-artifacts-rowrun">#{a.runSeq}</span>
                <OpenSplit
                  conn={conn}
                  ariaLabel={`${t('Open', '打开')} ${name}`}
                  onOpenDefault={() => onOpenFile?.(a.path)}
                  onOpenWith={(id) => {
                    void conn.openInEditor(a.path, id, root).catch(() => {});
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 节头链接**——`ArtifactsStrip` props 加 `onOpenArtifacts?: () => void;`，节头 `<span>{t('Artifacts this turn', '本轮产物')} ({artifacts.length})</span>` 之后加：

```tsx
        {onOpenArtifacts !== undefined && (
          <button type="button" className="sx-artifacts-link" onClick={onOpenArtifacts}>
            {t('All artifacts →', '全部产物 →')}
          </button>
        )}
```

`EntryViews.tsx` 的 ArtifactsStrip 调用（Task 11 Step 2 块）加一行 `onOpenArtifacts={onOpenArtifacts}`（该 prop Task 11 已入 ChatEntryView 签名；若未入，同步补进 ChatEntryView props 类型）。

- [ ] **Step 5: CSS**——`gui/src/app.css` 追加：

```css
/* ===== 产物库页签(2026-11-12 spec §6):行式列表,Files 页同密度 ===== */
.sx-artifacts-page { height: 100%; overflow-y: auto; padding: 12px 14px; }
.sx-artifacts-empty { color: var(--fg-tertiary); font-size: calc(14px * var(--fz)); padding: 24px 4px; }
.sx-artifacts-link { border: none; background: transparent; color: var(--accent); cursor: pointer; font-size: calc(14px * var(--fz)); padding: 2px 6px; border-radius: var(--radius-sm); margin-left: auto; }
.sx-artifacts-link:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.sx-artifacts-list { display: flex; flex-direction: column; gap: 2px; }
.sx-artifacts-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: var(--radius-sm); }
.sx-artifacts-row:hover { background: color-mix(in srgb, var(--fg) 9%, transparent); }
.sx-artifacts-rowname { color: var(--fg); font-size: calc(14px * var(--fz)); cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sx-artifacts-rowname:hover { text-decoration: underline; }
.sx-artifacts-rowdir { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-tertiary); font-size: calc(14px * var(--fz)); }
.sx-artifacts-rowrun { color: var(--fg-tertiary); font: calc(12px * var(--fz)) var(--font-mono); flex: none; }
```

- [ ] **Step 6: 类型检查 + 手动冒烟 + 提交**

Run: `pnpm --dir gui run typecheck && pnpm --dir gui exec vitest run src/artifacts.test.ts src/chat-reducer.artifacts.test.ts`
Expected: PASS
冒烟：`pnpm --dir gui dev` 起面板（daemon 按 MANUAL.md 启动），任一会话让助手写一个 md → 轮尾出卡 →「全部产物 →」开页签见行。

```bash
git add gui/src/pages/Artifacts.tsx gui/src/tabs/tab-state.ts gui/src/tabs/sidebar-refresh.ts gui/src/tabs/registry.tsx gui/src/connection.ts gui/src/pages/chat/ArtifactsStrip.tsx gui/src/pages/chat/EntryViews.tsx gui/src/app.css
git commit -m "feat(artifacts): 产物库页签+「全部产物 →」入口(singleton tab/刷新集/conn.artifacts,2026-11-12 spec §6)"
```

---

### Task 13: MANUAL-GUI 小节 + 全量验证 + 手动验收

**Files:**
- Modify: `MANUAL-GUI.md`（GUI 功能小节，按现有小节结构落位——新增「产物」节）

- [ ] **Step 1: MANUAL-GUI 加节**（紧邻现有轮尾/审查相关小节）：

```markdown
### 产物（轮末卡片与产物库）

- 助手本轮写出的**非代码交付物**（文档/图片/表格/演示/数据；代码文件不进）在回复末尾显示「本轮产物」卡片：图标/缩略图 + 文件名 + 类型标签 + 「打开 ▾」——主钮在右栏预览，▾ 列已装应用与「系统默认」，点击即用该方式打开；超过 8 张折叠。skill 脚本经 bash 产出的新建交付物同样收进。
- 右栏「产物」页签 = 会话级产物库：跨轮去重保留最新（含子智能体），行尾标注来源轮 `#runSeq`；卡片节头「全部产物 →」直达。历史会话回放后卡片与产物库照常可读。
```

- [ ] **Step 2: 全量双套测试**

Run: `pnpm test 2>&1 | tail -8 && pnpm --dir gui test 2>&1 | tail -8`
Expected: 双套全绿（内核 node:test + GUI vitest）

- [ ] **Step 3: 手动验收清单**（启动方式按 MANUAL.md；逐条核对并记录）

1. 让助手 write 一个 md → 轮尾出「本轮产物 (1)」卡，单卡整行。
2. 助手一次写 3 个交付物（md/png 脚本产/csv）→ 卡区两列；其中脚本产的 png 的 source 为 bash（产物库行可见）。
3. 卡片主钮 → 右栏自动展开预览该文件（md 出格式化预览、png 出棋盘格图片）。
4. ▾ 菜单 → VS Code / Cursor（若装）立即打开；「系统默认」按关联程序打开；资源管理器定位到文件。
5. 助手写 10 个交付物 → 折叠为前两行，「展开全部/收起」可用。
6. 新会话回放上一历史会话 → 历史轮卡片照常渲染。
7. 「全部产物 →」→ 产物库页签；写第二个交付物轮次后同路径文件只留最新轮一行，`#runSeq` 更新。
8. 子智能体（如 teams/exec）产出交付物 → 主链轮尾无卡、产物库页签有行。
9. 窄窗口（拖窄主区）→ 卡区退单列；右栏 sidechat 不出产物卡（辅助会话正文无轮尾卡装配则自然无）。
10. 删除产物文件后点卡片主钮 → 右栏 404 错误面，不崩。

- [ ] **Step 4: 提交**

```bash
git add MANUAL-GUI.md
git commit -m "docs(manual-gui): 产物小节(轮末卡片/产物库/打开方式,2026-11-12 spec §4-§6 用户面)"
```
