# 归档保留期与缓存清理实施计划（Archive Retention & Cache Clear）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 归档会话按保留天数每日后台自动清理 + 缓存登记表三档口径识别/清理，设置页「存储」分组、搜索框与托盘三个入口共用同一端点。

**Architecture:** daemon 侧两个新模块（`retention.ts` 保留期清扫器、`cache-inventory.ts` 缓存登记表）+ `/cache` 端点族；壳侧 `shell:clear-cache` IPC（Chromium HTTP 缓存）与托盘项；GUI 侧 `StoragePane` + `SearchAction`/托盘动作共用 `clearCacheNow`。

**Tech Stack:** TypeScript strict（CommonJS）、node:test（主仓）、vitest（GUI/壳）、React 18、Electron。

**Spec:** `docs/superpowers/specs/2026-11-21-archive-retention-cache-clear-design.md`

## Global Constraints

- TS strict 禁 any；一文件一职责；测试与被测模块同目录 `*.test.ts`；`pnpm build` 零报错方可提交（CLAUDE.md §5/§7）。
- 提示词零接触（本特性不入上下文/提示词面，§11 前缀缓存不变量无关）；daemon 回执恒英文，GUI 双语 `t()` 渲染（§15）。
- 路径一律 `path.join/resolve`；目录缺席按空表/0 计（读侧零副作用，与 purgeSession 幂等纪律一致）。
- GUI 铁律：图标 ≥14px、图标钮 24px 命中盒（`.sx-iconbtn`）、悬浮提示走 `data-tip` 禁原生 `title`、双语渲染期 `t()` 求值（§13）。
- 提交只 add 本任务文件（禁 `git add -A`；工作区有并行会话的 channels 文档改动，勿触）。
- 测试数据经 per-file `.data-test` 钉目录（scripts/test-env.cjs：`SUNSHINEX_DATA_DIR`+`HOME` 已注入），用例内需更强隔离时自设 `SUNSHINEX_PROJECTS_DIR`/`SUNSHINEX_SUNX_DIR`/临时目录并 finally 还原。

---

### Task 1: 语义键 + 保留期清扫器（`src/serve/retention.ts`）

**Files:**
- Modify: `src/config/settings.ts:19-61`（SEMANTIC_KEYS 增一行）
- Modify: `src/serve/sessions-list-handlers.ts`（尾部导出 `listWorkspaceDataDirs`/`listSunxDataDirs` 帮手）
- Create: `src/serve/retention.ts`
- Test: `src/serve/retention.test.ts`

**Interfaces:**
- Consumes: `listSessions/purgeSession/purgeSideJournals`（`../tui/session-journal`，既有签名）；`projectsRoot/sunxContainerDir`（`../config/data-dir`）；`userConfigDir`（`../config/env`）。
- Produces（Task 3/6 消费）: `resolveRetentionDays(raw: string | undefined): number`；`selectExpiredArchived(rows: readonly ArchivedRowLite[], now: number, days: number): string[]`；`sweepArchivedExpired(deps?: SweepDeps): SweepResult`；`class RetentionSweeper { start(); stop(); runNow(): SweepResult }`；`readRetentionState(file?): RetentionState`；`retentionStateFile(): string`；`listWorkspaceDataDirs(): Array<{slug, dataDir}>`；`listSunxDataDirs(): Array<{slug, dataDir}>`。

- [ ] **Step 1: 写失败测试** `src/serve/retention.test.ts`：

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { purgeSession, writeSessionMeta, readSessionMeta } from '../tui/session-journal';
import { listSunxDataDirs, listWorkspaceDataDirs } from './sessions-list-handlers';
import { readRetentionState, resolveRetentionDays, RetentionSweeper, selectExpiredArchived, sweepArchivedExpired } from './retention';

const DAY = 86_400_000;
const mkSession = (dataDir: string, id: string, meta: Record<string, unknown>): void => {
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sessions', `${id}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dataDir, 'sessions', `${id}.meta.json`), JSON.stringify(meta));
};

describe('resolveRetentionDays', () => {
  it('未设/空/非数值 → 30；0/负值 → 0；正数取整', () => {
    assert.equal(resolveRetentionDays(undefined), 30);
    assert.equal(resolveRetentionDays(''), 30);
    assert.equal(resolveRetentionDays('abc'), 30);
    assert.equal(resolveRetentionDays('0'), 0);
    assert.equal(resolveRetentionDays('-5'), 0);
    assert.equal(resolveRetentionDays(' 15 '), 15);
    assert.equal(resolveRetentionDays('7.9'), 7);
  });
});

describe('selectExpiredArchived', () => {
  const rows = [
    { id: 'a', archived: true, archivedAt: 1_000 },
    { id: 'b', archived: true, archivedAt: 5_000 },
    { id: 'c', archived: true }, // archivedAt 缺失:跳过
    { id: 'd', archivedAt: 0 }, // 未归档:跳过
  ];
  it('严格大于边界;days<=0 全跳', () => {
    assert.deepEqual(selectExpiredArchived(rows, 4_000 + 3 * DAY, 3), ['a']); // 恰满 3 天不清
    assert.deepEqual(selectExpiredArchived(rows, 4_000 + 3 * DAY + 1, 3).sort(), ['a', 'b']);
    assert.deepEqual(selectExpiredArchived(rows, Number.MAX_SAFE_INTEGER, 0), []);
  });
});

describe('sweepArchivedExpired', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-retention-'));
  const dataDir = path.join(tmp, 'ws', 'data');
  const sunxDir = path.join(tmp, 'sunx-journal', 'data');
  before(() => {
    mkSession(dataDir, '20260101T000000Z-old', { archived: true, archivedAt: 0 });
    mkSession(dataDir, '20260102T000000Z-side', { side: true, sideOf: '20260101T000000Z-old' });
    mkSession(dataDir, '20260103T000000Z-keep', { archived: true, archivedAt: 40 * DAY });
    mkSession(sunxDir, '20260104T000000Z-sunx', { archived: true, archivedAt: 0 });
  });
  it('过期归档真清全家(side 级联),未过期/在座跳过', () => {
    const r = sweepArchivedExpired({
      now: () => 41 * DAY,
      days: 30,
      dataDirs: [
        { slug: 'ws', dataDir },
        { slug: 'sunx-journal', dataDir: sunxDir },
      ],
    });
    const purged = r.purged.map((p) => p.id).sort();
    assert.deepEqual(purged, ['20260101T000000Z-old', '20260104T000000Z-sunx']); // side 随父清,不单列
    assert.equal(fs.existsSync(path.join(dataDir, 'sessions', '20260101T000000Z-old.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'sessions', '20260102T000000Z-side.meta.json')), false);
    assert.equal(readSessionMeta(dataDir, '20260103T000000Z-keep').archived, true);
    assert.equal(r.failed, 0);
  });
  it('days=0 轮空;state 落盘 runNow', () => {
    assert.equal(sweepArchivedExpired({ days: 0, dataDirs: [{ slug: 'ws', dataDir }] }).purged.length, 0);
  });
  after(() => fs.rmSync(tmp, { force: true, recursive: true }));
});

describe('RetentionSweeper', () => {
  it('错过窗口(≥24h)即刻补扫并落 state;未过期 5 分钟首扫;stop 摘除', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-sweeper-'));
    const stateFile = path.join(tmp, 'retention-state.json');
    const arms: number[] = [];
    let handles: Array<{ fn: () => void }> = [];
    const setTimeoutImpl = (fn: () => void): unknown => { const h = { fn }; handles.push(h); return h; };
    const clearTimeoutImpl = (h: unknown): void => { handles = handles.filter((x) => x !== h); };
    // ① 上次清扫 25h 前:即刻补扫(state 落盘),下一轮 24h
    fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt: Date.now() - 25 * 60 * 60_000 }));
    const s1 = new RetentionSweeper({ stateFile, setTimeoutImpl: setTimeoutImpl as never, clearTimeoutImpl: clearTimeoutImpl as never });
    s1.start();
    assert.equal(readRetentionState(stateFile).lastRunAt !== undefined, true);
    assert.deepEqual(arms, [24 * 60 * 60_000]);
    s1.stop();
    // ② 上次刚扫过:5 分钟首扫
    arms.length = 0; handles = [];
    fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt: Date.now() - 1_000 }));
    const s2 = new RetentionSweeper({ stateFile, setTimeoutImpl: setTimeoutImpl as never, clearTimeoutImpl: clearTimeoutImpl as never });
    s2.start();
    assert.deepEqual(arms, [5 * 60_000]);
    // 到点触发:清一轮再布防 24h
    handles[0]!.fn();
    assert.deepEqual(arms, [5 * 60_000, 24 * 60 * 60_000]);
    s2.stop();
    assert.equal(handles.length, 0);
    fs.rmSync(tmp, { force: true, recursive: true });
  });
});

describe('dataDir 枚举帮手', () => {
  it('按 env 重定向枚举 projects slug 与 sunx 域', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-dirs-'));
    fs.mkdirSync(path.join(tmp, 'projects', 'slug-a', 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'sunx', 'dom-b', 'data'), { recursive: true });
    const prevP = process.env.SUNSHINEX_PROJECTS_DIR;
    const prevS = process.env.SUNSHINEX_SUNX_DIR;
    process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
    process.env.SUNSHINEX_SUNX_DIR = path.join(tmp, 'sunx');
    try {
      assert.deepEqual(listWorkspaceDataDirs(), [{ slug: 'slug-a', dataDir: path.join(tmp, 'projects', 'slug-a', 'data') }]);
      assert.deepEqual(listSunxDataDirs(), [{ slug: 'dom-b', dataDir: path.join(tmp, 'sunx', 'dom-b', 'data') }]);
    } finally {
      if (prevP === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR; else process.env.SUNSHINEX_PROJECTS_DIR = prevP;
      if (prevS === undefined) delete process.env.SUNSHINEX_SUNX_DIR; else process.env.SUNSHINEX_SUNX_DIR = prevS;
    }
    fs.rmSync(tmp, { force: true, recursive: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`node scripts/run-tests.js dist/serve/retention.test.js`（编译后）或 `pnpm test 2>&1 | grep retention`——预期 FAIL（模块不存在）。

- [ ] **Step 3: 实现**——

`src/config/settings.ts` SEMANTIC_KEYS 增（带裁定注释）：

```ts
  // 归档保留天数(2026-11-21 归档保留期 spec §4.1):归档超 N 天的会话由 daemon 每日清扫
  // (retention.ts 单点);两级语义——未设=30(缺省启用),0=显式永不清理
  archiveRetentionDays: 'SUNSHINEX_ARCHIVE_RETENTION_DAYS',
```

`src/serve/sessions-list-handlers.ts` 尾部导出：

```ts
/** dataDir 枚举帮手(2026-11-21 归档保留期/缓存面共用;D89 同构族的新成员自出生走本帮手,
 *  既有三组扫描不动):projectsRoot slug 枚举 + sunx 容器域枚举;目录不可读=空表 */
export function listWorkspaceDataDirs(): Array<{ slug: string; dataDir: string }> {
  const out: Array<{ slug: string; dataDir: string }> = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    out.push({ slug: ent.name, dataDir: path.join(projectsRoot(), ent.name, 'data') });
  }
  return out;
}

/** sunx 域枚举(容器缺席=空表;键=域名) */
export function listSunxDataDirs(): Array<{ slug: string; dataDir: string }> {
  const out: Array<{ slug: string; dataDir: string }> = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(sunxContainerDir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    out.push({ slug: ent.name, dataDir: path.join(sunxContainerDir(), ent.name, 'data') });
  }
  return out;
}
```

`src/serve/retention.ts` 全文：

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userConfigDir } from '../config/env';
import { purgeSession, purgeSideJournals, listSessions } from '../tui/session-journal';
import { listSunxDataDirs, listWorkspaceDataDirs } from './sessions-list-handlers';

/**
 * 归档保留期清扫器(2026-11-21 spec §4,docs/superpowers/specs/2026-11-21-archive-retention-
 * cache-clear-design.md):按语义键 archiveRetentionDays(SUNSHINEX_ARCHIVE_RETENTION_DAYS 槽)
 * 每日扫 projectsRoot 全 slug + sunx 容器全域,把 archived 超 N 天的会话走既有受控删除单点
 * purgeSession 真清(side 全家级联,与删除面同落点)。在座(runtime 表)跳过——后台面不做运行时
 * 回收,下轮再判。定时:启动错过窗口(≥24h 未扫)即刻补扫,否则 5 分钟首扫,此后每 24h;state 落
 * retention-state.json(schedules.json 同落位口径),GET /cache retentionInfo 透出。
 */

/** 保留天数解析(spec §4.1 两级语义):未设/空/非数值→30(缺省启用);0/负值→0(永不);正数向下取整 */
export function resolveRetentionDays(raw: string | undefined): number {
  const v = raw?.trim();
  if (v === undefined || v === '') return 30;
  const n = Number(v);
  if (!Number.isFinite(n)) return 30;
  return n <= 0 ? 0 : Math.floor(n);
}

/** 过期判定的最小行集(listSessions 行的子集,纯件测试零落盘) */
export interface ArchivedRowLite {
  id: string;
  archived?: boolean;
  archivedAt?: number;
}

/** 纯件:过期归档选择——archived===true 且 archivedAt 有限数且 now−archivedAt > days×86400e3
 *  (严格大于:恰满 N 天不清);days<=0 全跳 */
export function selectExpiredArchived(rows: readonly ArchivedRowLite[], now: number, days: number): string[] {
  if (days <= 0) return [];
  const horizon = days * 86_400_000;
  return rows
    .filter((r) => r.archived === true && typeof r.archivedAt === 'number' && Number.isFinite(r.archivedAt) && now - r.archivedAt > horizon)
    .map((r) => r.id);
}

export interface SweepResult {
  ranAt: number;
  days: number;
  scanned: number;
  purged: Array<{ slug: string; id: string }>;
  failed: number;
}

export interface SweepDeps {
  now?: () => number;
  days?: number;
  /** 在座谓词:daemon 注入 runtime 表反查(attachedJournalId 命中即跳过);缺省恒 false */
  isKnownSession?: (jid: string) => boolean;
  /** 扫描域注入(测试);缺省=projectsRoot 全 slug + sunx 容器全域 */
  dataDirs?: ReadonlyArray<{ slug: string; dataDir: string }>;
}

export function sweepArchivedExpired(deps: SweepDeps = {}): SweepResult {
  const now = deps.now ?? (() => Date.now());
  const days = deps.days ?? resolveRetentionDays(process.env.SUNSHINEX_ARCHIVE_RETENTION_DAYS);
  const dirs = deps.dataDirs ?? [...listWorkspaceDataDirs(), ...listSunxDataDirs()];
  const known = deps.isKnownSession ?? (() => false);
  const result: SweepResult = { ranAt: now(), days, scanned: 0, purged: [], failed: 0 };
  if (days <= 0) return result;
  for (const { slug, dataDir } of dirs) {
    let rows: ReturnType<typeof listSessions>;
    try {
      rows = listSessions(dataDir);
    } catch {
      continue; // 整库不可读:跳过该域
    }
    result.scanned += rows.length;
    for (const id of selectExpiredArchived(rows, now(), days)) {
      if (known(id)) continue; // 在座跳过:下轮再判
      try {
        purgeSideJournals(dataDir, id); // side 全家级联(与删除面同序)
        purgeSession(dataDir, id);
        result.purged.push({ slug, id });
      } catch {
        result.failed += 1; // 单会话失败不阻断整轮
      }
    }
  }
  return result;
}

/** state 文件落位(schedules.json 同口径:SUNSHINEX_DATA_DIR 开发/测试重定向,生产=userConfigDir) */
export function retentionStateFile(): string {
  const override = process.env.SUNSHINEX_DATA_DIR;
  return path.join(override !== undefined && override !== '' ? path.resolve(override) : userConfigDir(), 'retention-state.json');
}

export interface RetentionState {
  lastRunAt?: number;
  lastDays?: number;
  lastScanned?: number;
  lastPurgedCount?: number;
  lastPurged?: Array<{ slug: string; id: string }>;
  lastFailed?: number;
}

/** 坏档/缺席=空 state(补扫一次自愈,不炸启动) */
export function readRetentionState(file: string = retentionStateFile()): RetentionState {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RetentionState;
  } catch {
    return {};
  }
}

function writeRetentionState(state: RetentionState, file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    /* 尽力而为:state 丢失只影响补扫判定 */
  }
}

const FIRST_RUN_DELAY_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const OVERDUE_MS = 24 * 60 * 60_000;
const PURGED_LIST_CAP = 50;

export interface SweeperDeps extends SweepDeps {
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
  stateFile?: string;
}

/** daemon 布防面(ScheduleEngine 同款 DI 形态):start=补扫/首扫,runNow=手动+落 state,stop=摘除 */
export class RetentionSweeper {
  private readonly deps: SweepDeps;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (h: unknown) => void;
  private readonly stateFile: string;
  private timer: unknown = undefined;
  private started = false;

  constructor(deps: SweeperDeps = {}) {
    this.deps = deps;
    this.setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.stateFile = deps.stateFile ?? retentionStateFile();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const last = readRetentionState(this.stateFile).lastRunAt;
    if (typeof last === 'number' && Date.now() - last >= OVERDUE_MS) {
      this.runNow(); // 错过窗口即刻补扫(daemon 长期未启动后首启场景)
      this.arm(SWEEP_INTERVAL_MS);
      return;
    }
    this.arm(FIRST_RUN_DELAY_MS);
  }

  stop(): void {
    this.started = false;
    if (this.timer !== undefined) this.clearTimeoutImpl(this.timer);
    this.timer = undefined;
  }

  /** 手动/到点清扫:跑一轮+落 state(days<=0 轮空也落——当日已查过) */
  runNow(): SweepResult {
    const r = sweepArchivedExpired(this.deps);
    writeRetentionState(
      {
        lastRunAt: r.ranAt,
        lastDays: r.days,
        lastScanned: r.scanned,
        lastPurgedCount: r.purged.length,
        ...(r.purged.length > 0 ? { lastPurged: r.purged.slice(0, PURGED_LIST_CAP) } : {}),
        ...(r.failed > 0 ? { lastFailed: r.failed } : {}),
      },
      this.stateFile,
    );
    if (r.purged.length > 0 || r.failed > 0) console.log(`[retention] purged ${r.purged.length} archived session(s), ${r.failed} failed (retention ${r.days}d)`);
    return r;
  }

  private arm(ms: number): void {
    if (!this.started) return;
    if (this.timer !== undefined) this.clearTimeoutImpl(this.timer);
    this.timer = this.setTimeoutImpl(() => {
      this.timer = undefined;
      this.runNow();
      this.arm(SWEEP_INTERVAL_MS);
    }, ms);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**：`pnpm build && node scripts/run-tests.js dist/serve/retention.test.js`（run-tests.js 接受文件参数则单跑；否则 `pnpm test` 全量）→ PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config/settings.ts src/serve/sessions-list-handlers.ts src/serve/retention.ts src/serve/retention.test.ts
git commit -m "feat(storage): archiveRetentionDays 语义键+daemon 归档保留期清扫器——每日扫 projects/sunx 全域 purgeSession 真清过期归档,补扫/首扫 24h 节拍(state 落 retention-state.json)"
```

---

### Task 2: 缓存登记表 + handler（`cache-inventory.ts` / `cache-handlers.ts`）

**Files:**
- Create: `src/serve/cache-inventory.ts`
- Create: `src/serve/cache-handlers.ts`
- Test: `src/serve/cache-inventory.test.ts`

**Interfaces:**
- Consumes: `listWorkspaceDataDirs/listSunxDataDirs`（Task 1）、`userConfigDir`。
- Produces（Task 3 daemon 消费）: `CACHE_CATEGORIES: readonly CacheCategoryDef[]`（`{id, safe, scope, segments}`）；`resolveCacheDirs(): CacheDirs`（`{globalRoot, dataDirs}`）；`dirStats(dir): {size, files}`；`categoryDirs(id, dirs?): string[]`；`cacheStatus(dirs?): {total, categories}`；`clearCacheCategories(ids?: readonly string[], dirs?): CacheClearResult`（`{cleared:[{id,freed}], failed:[{id,error}]}`）；`CacheHandlerIo { send; readJson; status(); retentionInfo(); clear(ids?) }` + `handleCacheStatus(io, res)` + `handleCacheClear(io, req, res)`。

- [ ] **Step 1: 写失败测试** `src/serve/cache-inventory.test.ts`：

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cacheStatus, CACHE_CATEGORIES, clearCacheCategories, type CacheDirs } from './cache-inventory';

describe('cache-inventory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-cache-'));
  const dirs: CacheDirs = {
    globalRoot: path.join(tmp, 'global'),
    dataDirs: [path.join(tmp, 'ws', 'data'), path.join(tmp, 'sunx-dom', 'data')],
  };
  const mk = (p: string, content: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  before(() => {
    mk(path.join(dirs.globalRoot, 'pty-replay', 'r.txt'), '12345'); // 5B
    mk(path.join(dirs.globalRoot, 'gui', 'editor-icons', 'i.png'), '12345678'); // 8B
    mk(path.join(dirs.dataDirs[0]!, 'archives', 'c.jsonl'), '1234567890'); // 10B
    mk(path.join(dirs.dataDirs[1]!, 'archives', 'c2.jsonl'), '1'); // 1B
    mk(path.join(dirs.dataDirs[0]!, 'tool-outputs', 't.txt'), '123');
    mk(path.join(dirs.dataDirs[0]!, 'plugins', 'logs', 'mcp.log'), '1234567');
    mk(path.join(dirs.dataDirs[1]!, 'plugins', 'computer-use', 'screenshots', 's.png'), '123456');
    mk(path.join(dirs.dataDirs[0]!, 'images-cache', 'img.png'), '123456789');
  });
  it('登记表:id 全小写、safe 档不含 images-cache', () => {
    const ids = CACHE_CATEGORIES.map((c) => c.id);
    assert.equal(ids.includes('images-cache'), true);
    assert.equal(CACHE_CATEGORIES.find((c) => c.id === 'images-cache')!.safe, false);
    assert.equal(CACHE_CATEGORIES.filter((c) => c.safe).every((c) => c.id !== 'images-cache'), true);
  });
  it('cacheStatus 逐类计体积、跨工作区归并', () => {
    const st = cacheStatus(dirs);
    const byId = new Map(st.categories.map((c) => [c.id, c]));
    assert.equal(byId.get('pty-replay')!.size, 5);
    assert.equal(byId.get('editor-icons')!.size, 8);
    assert.equal(byId.get('compaction-archives')!.size, 11); // 两 dataDir 归并
    assert.equal(byId.get('images-cache')!.safe, false);
    assert.equal(st.total, [...byId.values()].reduce((a, c) => a + c.size, 0));
  });
  it('缺省清 safe 全档:images-cache 与用户数据族不动', () => {
    const r = clearCacheCategories(undefined, dirs);
    assert.equal(r.failed.length, 0);
    assert.equal(r.cleared.some((c) => c.id === 'images-cache'), false);
    assert.equal(fs.existsSync(path.join(dirs.dataDirs[0]!, 'archives')), false);
    assert.equal(fs.existsSync(path.join(dirs.globalRoot, 'pty-replay')), false);
    assert.equal(fs.existsSync(path.join(dirs.dataDirs[0]!, 'images-cache', 'img.png')), true);
    const wsJson = path.join(dirs.dataDirs[0]!, 'workspace.json');
    fs.writeFileSync(wsJson, '{}');
    assert.equal(fs.existsSync(wsJson), true); // 清理不波及 dataDir 根其他内容
  });
  it('显式 ids 清 unsafe 档带 freed 记账;未知 id 落 failed;幂等', () => {
    const r = clearCacheCategories(['images-cache', 'nope'], dirs);
    assert.deepEqual(r.cleared, [{ id: 'images-cache', freed: 9 }]);
    assert.deepEqual(r.failed, [{ id: 'nope', error: 'unknown cache category' }]);
    const again = clearCacheCategories(['images-cache'], dirs);
    assert.deepEqual(again.cleared, [{ id: 'images-cache', freed: 0 }]); // 目录已消:0 计
  });
  after(() => fs.rmSync(tmp, { force: true, recursive: true }));
});
```

- [ ] **Step 2: 确认失败**（模块不存在）。

- [ ] **Step 3: 实现**——

`src/serve/cache-inventory.ts` 全文：

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userConfigDir } from '../config/env';
import { listSunxDataDirs, listWorkspaceDataDirs } from './sessions-list-handlers';

/**
 * 缓存登记表单点(2026-11-21 spec §3,docs/superpowers/specs/2026-11-21-archive-retention-
 * cache-clear-design.md):「正确识别哪些是缓存」的唯一事实源——id/safe 档位/落点三元登记,
 * GET /cache 报体积、POST /cache/clear 受控清理;GUI 双语标签按 id 本地映射(id 稳定)。
 *
 * 三档口径:
 * - safe(一键清,可再生或纯暂存):pty-replay / editor-icons / compaction-archives(会话 jsonl
 *   逐字节权威仍在,归档仅安全镜像)/ tool-outputs(链上留预览)/ plugin-logs / computer-use-screenshots;
 *   http-cache(Chromium)不在本表——归壳 IPC shell:clear-cache,GUI 合成伪行。
 * - unsafe(引用型,仅设置页带警示单独清):images-cache(附件原图唯一副本)。
 * - 绝不触碰(用户数据,不在登记表):sessions/ memory/ skills/ kb/ teams/ tasks/ workspace.json
 *   serve-token settings.json mcp.json schedules.json retention-state.json gui/ui-state.json 族、
 *   plugins/browser-use/profile/(内置浏览器登录态)、webview 分区 cookie/localStorage。
 */

export interface CacheCategoryDef {
  readonly id: string;
  readonly safe: boolean;
  readonly scope: 'global' | 'per-data-dir';
  /** scope=global:userConfigDirRoot 下相对段;scope=per-data-dir:dataDir 下相对段 */
  readonly segments: readonly string[];
}

export const CACHE_CATEGORIES: readonly CacheCategoryDef[] = [
  { id: 'pty-replay', safe: true, scope: 'global', segments: ['pty-replay'] },
  { id: 'editor-icons', safe: true, scope: 'global', segments: ['gui', 'editor-icons'] },
  { id: 'compaction-archives', safe: true, scope: 'per-data-dir', segments: ['archives'] },
  { id: 'tool-outputs', safe: true, scope: 'per-data-dir', segments: ['tool-outputs'] },
  { id: 'plugin-logs', safe: true, scope: 'per-data-dir', segments: ['plugins', 'logs'] },
  { id: 'computer-use-screenshots', safe: true, scope: 'per-data-dir', segments: ['plugins', 'computer-use', 'screenshots'] },
  { id: 'images-cache', safe: false, scope: 'per-data-dir', segments: ['images-cache'] },
];

/** 扫描根(注入形):globalRoot=userConfigDir 等价根(DATA_DIR 重定向同 schedules.json 口径),
 *  dataDirs=projectsRoot 全 slug + sunx 容器全域的 data 目录 */
export interface CacheDirs {
  readonly globalRoot: string;
  readonly dataDirs: readonly string[];
}

export function resolveCacheDirs(): CacheDirs {
  const override = process.env.SUNSHINEX_DATA_DIR;
  const globalRoot = override !== undefined && override !== '' ? path.resolve(override) : userConfigDir();
  const dataDirs = [...listWorkspaceDataDirs(), ...listSunxDataDirs()].map((d) => d.dataDir);
  return { globalRoot, dataDirs };
}

/** 目录体积(递归;缺席/竞态消失按 0 计,读侧零副作用不建目录) */
export function dirStats(dir: string): { size: number; files: number } {
  let size = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          size += fs.statSync(p).size;
          files += 1;
        } catch {
          /* 枚举与 stat 间消失:按 0 计 */
        }
      }
    }
  };
  walk(dir);
  return { size, files };
}

/** 某 id 的具体目录全集(global=1 个,per-data-dir=每工作区/域 1 个;未知 id=空表) */
export function categoryDirs(id: string, dirs: CacheDirs = resolveCacheDirs()): string[] {
  const def = CACHE_CATEGORIES.find((c) => c.id === id);
  if (def === undefined) return [];
  const roots = def.scope === 'global' ? [dirs.globalRoot] : dirs.dataDirs;
  return roots.map((r) => path.join(r, ...def.segments));
}

export interface CacheCategoryStatus {
  id: string;
  safe: boolean;
  size: number;
  files: number;
}

export function cacheStatus(dirs: CacheDirs = resolveCacheDirs()): { total: number; categories: CacheCategoryStatus[] } {
  const categories = CACHE_CATEGORIES.map((def) => {
    let size = 0;
    let files = 0;
    for (const d of categoryDirs(def.id, dirs)) {
      const s = dirStats(d);
      size += s.size;
      files += s.files;
    }
    return { id: def.id, safe: def.safe, size, files };
  });
  return { total: categories.reduce((a, c) => a + c.size, 0), categories };
}

export interface CacheClearResult {
  cleared: Array<{ id: string; freed: number }>;
  failed: Array<{ id: string; error: string }>;
}

/** 受控清理(spec §5):rm 目录本身(写面 mkdirSync recursive 惰性重建,幂等);ids 缺省=safe 全档;
 *  显式传 ids 照清(含 unsafe——警示责任在 UI,端点不二次拦截);逐项记账单项目失败不阻断 */
export function clearCacheCategories(ids?: readonly string[], dirs: CacheDirs = resolveCacheDirs()): CacheClearResult {
  const selected = ids === undefined ? CACHE_CATEGORIES.filter((c) => c.safe).map((c) => c.id) : [...ids];
  const out: CacheClearResult = { cleared: [], failed: [] };
  for (const id of selected) {
    if (!CACHE_CATEGORIES.some((c) => c.id === id)) {
      out.failed.push({ id, error: 'unknown cache category' });
      continue;
    }
    let freed = 0;
    let error: string | undefined;
    for (const d of categoryDirs(id, dirs)) {
      try {
        freed += dirStats(d).size;
        fs.rmSync(d, { force: true, recursive: true });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (error !== undefined) out.failed.push({ id, error });
    else out.cleared.push({ id, freed });
  }
  return out;
}
```

`src/serve/cache-handlers.ts` 全文（io 注入形——daemon 供真实现，测试供 tmp 实现）：

```ts
import type * as http from 'node:http';

/**
 * /cache 端点族 handler(2026-11-21 spec §5):io 注入形(SessionHandlerIo 同款薄接缝)——
 * status/clear/retentionInfo 由 daemon 供真实现(cache-inventory+retention state),测试可换
 * tmp 桩;daemon 回执恒英文(§15),双语标签由 GUI 按 id 映射。
 */

export interface CacheRetentionInfo {
  days: number;
  lastRunAt: number | null;
  lastPurged: number;
  lastFailed: number;
}

export interface CacheHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  status(): { total: number; categories: Array<{ id: string; safe: boolean; size: number; files: number }> };
  retentionInfo(): CacheRetentionInfo;
  clear(ids?: string[]): { cleared: Array<{ id: string; freed: number }>; failed: Array<{ id: string; error: string }> };
}

export function handleCacheStatus(io: CacheHandlerIo, res: http.ServerResponse): void {
  io.send(res, 200, { ...io.status(), retention: io.retentionInfo() });
}

export async function handleCacheClear(io: CacheHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const raw = (parsed.body as { categories?: unknown }).categories;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string'))) {
    return io.send(res, 400, { error: 'categories must be an array of strings' });
  }
  io.send(res, 200, io.clear(raw as string[] | undefined));
}
```

- [ ] **Step 4: 跑测试通过**：`pnpm build && node scripts/run-tests.js dist/serve/cache-inventory.test.js` → PASS。

- [ ] **Step 5: 提交**

```bash
git add src/serve/cache-inventory.ts src/serve/cache-inventory.test.ts src/serve/cache-handlers.ts
git commit -m "feat(storage): 缓存登记表单点——三档口径(id/safe 档位/落点)跨工作区体积清点与受控清理,/cache handler 注入形接缝"
```

---

### Task 3: daemon 接线（路由 + cacheIo + 清扫器布防）

**Files:**
- Modify: `src/serve/daemon.ts`（import 区、字段区、`start()` 尾部、`teardown()`、路由表 `/sessions/archived` 之后）

**Interfaces:**
- Consumes: Task 1 `RetentionSweeper/readRetentionState/resolveRetentionDays`、Task 2 `cache-handlers/cache-inventory`。
- Produces: `GET /cache` → `{total, categories, retention}`；`POST /cache/clear {categories?}` → `{cleared, failed}`。

- [ ] **Step 1: 实现**——daemon.ts 五处改动：

① import 区：

```ts
import { handleCacheClear, handleCacheStatus, type CacheHandlerIo } from './cache-handlers';
import { cacheStatus, clearCacheCategories } from './cache-inventory';
import { readRetentionState, resolveRetentionDays, RetentionSweeper } from './retention';
```

② schedules io 字段附近增 cacheIo（send/readJson 复用 daemon 单点；status/clear 供真实现）：

```ts
  /** 缓存面 handlers 触点面(2026-11-21 spec §5;send/readJson 复用 daemon 单点) */
  private readonly cacheIo: CacheHandlerIo = {
    send: (res, status, body) => this.send(res, status, body),
    readJson: (req) => this.readJson(req),
    status: () => cacheStatus(),
    clear: (ids) => clearCacheCategories(ids),
    retentionInfo: () => {
      const st = readRetentionState();
      return {
        days: resolveRetentionDays(process.env.SUNSHINEX_ARCHIVE_RETENTION_DAYS),
        lastRunAt: typeof st.lastRunAt === 'number' ? st.lastRunAt : null,
        lastPurged: typeof st.lastPurgedCount === 'number' ? st.lastPurgedCount : 0,
        lastFailed: typeof st.lastFailed === 'number' ? st.lastFailed : 0,
      };
    },
  };
  /** 归档保留期清扫器(start 布防/teardown 摘除;undefined=未布防——tests 直构 daemon 面可缺) */
  private retentionSweeper: RetentionSweeper | undefined;
```

③ `start()` 尾部（`this.scheduleEngine.start();` 之后、`return` 之前）：

```ts
    // 归档保留期清扫器(2026-11-21 spec §4):布防在 schedule 引擎之后——错过窗口(≥24h 未扫)
    // 即刻补扫,否则 5 分钟首扫;在座会话跳过(runtime 表按 attachedJournalId 反查)
    this.retentionSweeper = new RetentionSweeper({
      isKnownSession: (jid) => [...this.sessions.values()].some((s) => s.attachedJournalId === jid),
    });
    this.retentionSweeper.start();
```

④ `teardown()`（`this.scheduleEngine.stop();` 同段）：

```ts
    this.retentionSweeper?.stop();
    this.retentionSweeper = undefined;
```

⑤ 路由表 `{ method: 'GET', path: '/sessions/archived', ... }` 之后：

```ts
    // 缓存面(2026-11-21 spec §5):登记表三档口径——GET 报体积/保留期信息,POST 受控清理
    // (ids 缺省=safe 全档;http-cache 归壳 IPC,不经本端点)
    { method: 'GET', path: '/cache', auth: true, run: async (_req, res) => handleCacheStatus(this.cacheIo, res) },
    { method: 'POST', path: '/cache/clear', auth: true, run: async (req, res) => handleCacheClear(this.cacheIo, req, res) },
```

- [ ] **Step 2: 验证**：`pnpm build`（strict 零报错）+ `pnpm selfcheck`（dist 可启动性）→ 双过。

- [ ] **Step 3: 提交**

```bash
git add src/serve/daemon.ts
git commit -m "feat(storage): daemon 接线——GET/POST /cache 端点族+保留期清扫器布防(start 补扫/teardown 摘除,cacheIo 注入形)"
```

---

### Task 4: 壳托盘项（lifecycle + 测试）

**Files:**
- Modify: `shell/src/lib/lifecycle.ts:8-13,68-71,76-94`
- Test: `shell/src/lib/lifecycle.test.ts`（既有菜单形状用例补新项）

**Interfaces:**
- Produces: `TrayAction` 增 `{ kind: 'clear-cache' }`（preload/gui env-global.d.ts 镜像同步在 Task 5/6）；`trayMenu()` ②组四项。

- [ ] **Step 1: 更新测试**——读 `shell/src/lib/lifecycle.test.ts`，在菜单形状用例中断言：②组含「clear-cache」项、位置在 shortcuts 之后 separator 之前；`TRAY_LABELS` 双语（en 'Clear cache' / zh '清理缓存'）。运行 `pnpm --filter sunshinex-shell run test` → FAIL。

- [ ] **Step 2: 实现** lifecycle.ts：

```ts
/** 托盘动作(主进程 → 渲染层 tray:action 下发;show/quit 主进程自理不下发) */
export type TrayAction =
  | { kind: 'open-session'; root: string; journalId: string }
  | { kind: 'new-chat' }
  | { kind: 'settings' }
  | { kind: 'shortcuts' }
  | { kind: 'clear-cache' };
```

TRAY_LABELS 类型与值增 `clearCache: { en: 'Clear cache', zh: '清理缓存' }`；`trayMenu()` ②组（注释改「②新对话/设置/快捷键/清理缓存」）：

```ts
    { type: 'action', label: l.newChat, action: { kind: 'new-chat' } },
    { type: 'action', label: l.settings, action: { kind: 'settings' } },
    { type: 'action', label: l.shortcuts, action: { kind: 'shortcuts' } },
    { type: 'action', label: l.clearCache, action: { kind: 'clear-cache' } },
```

- [ ] **Step 3: 测试通过** → **Step 4: 提交**

```bash
git add shell/src/lib/lifecycle.ts shell/src/lib/lifecycle.test.ts
git commit -m "feat(shell): 托盘菜单②组增「清理缓存」项——TrayAction 增 clear-cache,双语标签入 TRAY_LABELS"
```

---

### Task 5: 壳缓存 IPC + preload 桥 + GUI 桥声明

**Files:**
- Modify: `shell/src/main.ts`（import `session`；win 创建后分区登记；ipcMain.handle 区）
- Modify: `shell/src/preload.ts`（sunshinexWindow 增 `clearHttpCache`）
- Modify: `gui/src/env-global.d.ts`（`SxTrayAction` + `clearHttpCache` 声明）

**Interfaces:**
- Produces: `window.sunshinexWindow?.clearHttpCache?.(): Promise<{ ok: boolean; partitions?: number }>`（Task 6 消费）。

- [ ] **Step 1: 实现** main.ts：

① electron import 增 `session`。② `const win = new BrowserWindow({...})` 之后：

```ts
    // Web 标签持久分区登记(2026-11-21 缓存清理):will-attach-webview 收集 persist:sx-* 分区名,
    // shell:clear-cache 逐分区 clearCache——cookie/localStorage(登录态)不动,只清 HTTP cache
    const webviewPartitions = new Set<string>();
    win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
      const p = typeof webPreferences.partition === 'string' && webPreferences.partition !== '' ? webPreferences.partition : params.partition;
      if (typeof p === 'string' && p.startsWith('persist:')) webviewPartitions.add(p);
    });
```

③ `ipcMain.handle('shell:pick-folder'|'shell:pick-file')` 附近：

```ts
    // 缓存清理(2026-11-21):主窗 session + 已登记 webview 持久分区逐个 clearCache;
    // 单分区失败不阻断(逐项记账),返回清到的分区数供 GUI 提示
    ipcMain.handle('shell:clear-cache', async () => {
      let partitions = 0;
      for (const name of webviewPartitions) {
        try {
          await session.fromPartition(name).clearCache();
          partitions += 1;
        } catch (err) {
          console.error(`[shell] clearCache(${name}) failed:`, err);
        }
      }
      try {
        await win.webContents.session.clearCache();
      } catch (err) {
        console.error('[shell] main session clearCache failed:', err);
      }
      return { ok: true, partitions };
    });
```

- [ ] **Step 2: preload.ts** sunshinexWindow 对象内（onMaximizedChange 之前）：

```ts
  /** 缓存清理(2026-11-21):主窗+已登记 webview 持久分区 HTTP cache;登录态 cookie 不动。
   *  旧壳缺席(?. 容忍)——浏览器态本就无 Chromium 缓存面 */
  clearHttpCache: (): Promise<{ ok: boolean; partitions?: number }> => ipcRenderer.invoke('shell:clear-cache'),
```

- [ ] **Step 3: env-global.d.ts**——`SxTrayAction` 增 `| { kind: 'clear-cache' }`；`sunshinexWindow` 增：

```ts
    /** 缓存清理(2026-11-21):主窗+webview 持久分区 HTTP cache;登录态 cookie 不动。旧壳缺席 ?. 跳过 */
    clearHttpCache?: () => Promise<{ ok: boolean; partitions?: number }>;
```

- [ ] **Step 4: 验证**：`pnpm --filter sunshinex-shell run test`（vitest 含 typecheck 面）+ `pnpm --dir gui run typecheck` → 过。

- [ ] **Step 5: 提交**

```bash
git add shell/src/main.ts shell/src/preload.ts gui/src/env-global.d.ts
git commit -m "feat(shell): shell:clear-cache IPC——主窗+will-attach-webview 登记的 persist:sx-* 分区 clearCache(登录态不动),preload 桥出 clearHttpCache"
```

---

### Task 6: GUI 数据面（connection 方法 + toast 扩展 + App 动作）

**Files:**
- Modify: `gui/src/connection-types.ts`（/cache 响应类型族）
- Modify: `gui/src/connection.ts`（`cacheStatus`/`clearCache` 方法）
- Modify: `gui/src/ui-util.ts`（`fmtBytes`）
- Modify: `gui/src/use-op-error.ts`（`showOpMessage` 共槽正反两用）
- Modify: `gui/src/App.tsx`（`clearCacheNow` 稳定回调 + `searchActions` 条目 + `trayActionRef` 分支）

**Interfaces:**
- Consumes: Task 3 端点、Task 5 桥。
- Produces（Task 7 StoragePane 消费）: `CacheStatusResp/CacheClearResp/CacheCategoryStatus/CacheRetentionInfo`（connection-types）；`Connection.cacheStatus()/clearCache(categories?)`；`fmtBytes(n): string`；`useOpError().showOpMessage(msg)`；`App` 内 `clearCacheNow`（不导出,Task 7 独立于它）。

- [ ] **Step 1: connection-types.ts** 尾部（设置面类型段之后）：

```ts
// ---------- 存储面(2026-11-21 缓存清理;字段形与 daemon /cache 应答同形;不引服务端类型) ----------

export interface CacheCategoryStatus {
  id: string;
  safe: boolean;
  size: number;
  files: number;
}

export interface CacheRetentionInfo {
  days: number;
  lastRunAt: number | null;
  lastPurged: number;
  lastFailed: number;
}

export interface CacheStatusResp {
  total: number;
  categories: CacheCategoryStatus[];
  retention: CacheRetentionInfo;
}

export interface CacheClearResp {
  cleared: Array<{ id: string; freed: number }>;
  failed: Array<{ id: string; error: string }>;
}
```

- [ ] **Step 2: connection.ts**——import type 增上列四型；`archivedSessions()` 方法后：

```ts
    cacheStatus(): Promise<CacheStatusResp> {
      return getJson<CacheStatusResp>('/cache');
    },
    clearCache(categories?: string[]): Promise<CacheClearResp> {
      // categories 缺省=daemon safe 全档;http-cache 归壳侧(clearHttpCache 桥),不经本端点
      return postJson<CacheClearResp>('/cache/clear', { ...(categories === undefined ? {} : { categories }) });
    },
```

- [ ] **Step 3: ui-util.ts** 增：

```ts
/** 字节量双语共用格式化(存储页体积/toast):B 直显,KB 起一位小数(≥100 取整) */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? String(Math.round(v)) : v.toFixed(1)} ${units[i]}`;
}
```

- [ ] **Step 4: use-op-error.ts**——`showOpError` 改经 `showOpMessage` 复用同槽（身份恒定不变）：

```ts
export function useOpError(): { opError: string; showOpError: (err: unknown) => void; showOpMessage: (msg: string) => void } {
  const [opError, setOpError] = useState('');
  const opErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 正反两用同槽:正向提示(缓存清理释放量等)与失败提示同一 toast 位,3s 自隐 */
  const showOpMessage = useCallback((msg: string): void => {
    setOpError(msg);
    if (opErrorTimer.current !== null) clearTimeout(opErrorTimer.current);
    opErrorTimer.current = setTimeout(() => setOpError(''), 3_000);
  }, []);
  const showOpError = useCallback((err: unknown): void => showOpMessage(errText(err)), [showOpMessage]);
  return { opError, showOpError, showOpMessage };
}
```

（import `errText` 自 `./ui-util`；原 `err instanceof Error ? message : String(err)` 行为由 errText 承接——实现时核 errText 语义等价，不等价则 showOpError 保留原逻辑只共享槽位。）

- [ ] **Step 5: App.tsx** 三处：

① `const { opError, showOpError } = useOpError();` 改取 `showOpMessage`；其下（trayActionRef 之前）：

```ts
  /** 缓存清理(2026-11-21):daemon safe 档+壳浏览器 HTTP 缓存并行;toast 回显释放量——
   *  搜索框 Actions 与托盘 clear-cache 同走此稳定回调,不另造旁路语义 */
  const clearCacheNow = useStableCallback((): void => {
    const conn = connRef.current;
    if (conn === null) return;
    const http = window.sunshinexWindow?.clearHttpCache?.().catch(() => undefined);
    void conn
      .clearCache()
      .then(() => http)
      .then(() => {
        void http;
      })
      .catch(showOpError);
  });
```

——注意 freed 量要在 clearCache 应答里取：改为

```ts
  const clearCacheNow = useStableCallback((): void => {
    const conn = connRef.current;
    if (conn === null) return;
    const http = window.sunshinexWindow?.clearHttpCache?.().catch(() => undefined);
    void conn
      .clearCache()
      .then(async (r) => {
        await http;
        const freed = r.cleared.reduce((a, c) => a + c.freed, 0);
        if (r.failed.length > 0) showOpMessage(t(`${r.failed.length} cache item(s) failed to clear`, `${r.failed.length} 项缓存清理失败`));
        else if (freed > 0) showOpMessage(t(`Cache cleared — freed ${fmtBytes(freed)}`, `已清理缓存，释放 ${fmtBytes(freed)}`));
        else showOpMessage(t('Cache is already clean', '缓存本来就很干净'));
      })
      .catch(showOpError);
  });
```

② `trayActionRef.current` 分支（`closeMenuDrawer()` 之后、settings 分支之前）：

```ts
    if (a.kind === 'clear-cache') {
      clearCacheNow();
      return;
    }
```

③ `searchActions` 数组增（`toggle-sidebar` 之前）：

```ts
      { id: 'clear-cache', en: 'Clear cache', zh: '清理缓存', run: clearCacheNow },
```

deps 数组增 `clearCacheNow`。import 增 `fmtBytes`（ui-util）。

- [ ] **Step 6: 验证**：`pnpm --dir gui run typecheck` → 过。

- [ ] **Step 7: 提交**

```bash
git add gui/src/connection-types.ts gui/src/connection.ts gui/src/ui-util.ts gui/src/use-op-error.ts gui/src/App.tsx
git commit -m "feat(gui): /cache 数据面接线——cacheStatus/clearCache 方法+clearCacheNow 稳定回调(搜索框/托盘共用)+fmtBytes+toast 正反同槽"
```

---

### Task 7: 设置页「存储」分组（StoragePane + 导航 + 搜索索引）

**Files:**
- Modify: `gui/src/settings/settings-groups.ts`（Basics 增 storage 项）
- Modify: `gui/src/settings/SettingsShell.tsx`（renderPane 增 case）
- Modify: `gui/src/settings/SettingsForm.tsx`（KEY_DESCRIPTIONS 增 archiveRetentionDays）
- Modify: `gui/src/settings/settings-search.ts`（静态行条目两条）
- Modify: `gui/src/app.css`（`.sx-storage-btn` 族，圆角/字号走 token）
- Create: `gui/src/settings/StoragePane.tsx`

**Interfaces:**
- Consumes: Task 6 connection 方法/类型、KEY_DESCRIPTIONS。
- Produces: `StoragePaneConn { settings; putSettings; cacheStatus; clearCache }`；导航 id `'storage'`；行锚 `data-setting-key="archiveRetentionDays"` / `"cache"`。

- [ ] **Step 1: settings-groups.ts** Basics items 增（providers 之后）：

```ts
      { id: 'storage', title: { en: 'Storage', zh: '存储' } },
```

- [ ] **Step 2: SettingsForm.tsx** KEY_DESCRIPTIONS 增：

```ts
  archiveRetentionDays: {
    label: { en: 'Archive retention', zh: '归档保留天数' },
    en: 'Archived sessions older than this many days are purged daily (0 = never; default 30)',
    zh: '归档超过该天数的会话每日自动清理（0 = 永不清理，缺省 30 天）',
  },
```

- [ ] **Step 3: SettingsShell.tsx** renderPane switch 增：

```tsx
      case 'storage':
        return <StoragePane key="storage" conn={conn} root={root} />;
```

（import `StoragePane` 与 `type StoragePaneConn`；`SettingsShellConn` 交叉类型自动满足 StoragePaneConn——Connection 已含新方法。）

- [ ] **Step 4: StoragePane.tsx** 全文（结构复用 sx-card/sx-setting-row 既有语言；行锚 data-setting-key 供搜索跳转）：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { CacheClearResp, CacheStatusResp, SettingsKeyRow, SettingsView } from '../connection-types';
import { t } from '../i18n';
import { errText, fmtBytes, relTime } from '../ui-util';
import { KEY_DESCRIPTIONS } from './SettingsForm';

/**
 * 存储面板(2026-11-21 归档保留期/缓存清理 spec §7.1):两卡——①归档会话保留天数(语义键
 * archiveRetentionDays,读写走 settings/putSettings,引擎语义同 SettingsForm 自动保存轮;
 * 行锚 data-setting-key=键名)②缓存清点(GET /cache 逐类体积+单独清理钮;主按钮=一键清 safe
 * 全档+壳侧浏览器 HTTP 缓存;images-cache 引用型带警示、行内二次确认(3.5s 内再点执行))。
 * 分类双语标签本表单点,id 与 daemon CACHE_CATEGORIES 人工同源;http-cache=壳侧伪行
 * (sunshinexWindow 缺席即省略——浏览器态无 Chromium 缓存面)。
 */

export interface StoragePaneConn {
  settings(root?: string): Promise<SettingsView>;
  putSettings(scope: 'project' | 'global', root: string | undefined, updates: Record<string, string | number | null>): Promise<void>;
  cacheStatus(): Promise<CacheStatusResp>;
  clearCache(categories?: string[]): Promise<CacheClearResp>;
}

/** 分类双语标签(id 稳定;desc=行内说明;warn=引用型警示文案) */
const CACHE_LABELS: Record<string, { label: { en: string; zh: string }; desc: { en: string; zh: string } }> = {
  'pty-replay': { label: { en: 'Terminal replay buffers', zh: '终端回放缓存' }, desc: { en: 'PTY scrollback replay files', zh: '终端回滚缓冲的落盘副本' } },
  'editor-icons': { label: { en: 'Editor icon cache', zh: '编辑器图标缓存' }, desc: { en: 'Regenerated on demand', zh: '按需自动重新生成' } },
  'compaction-archives': { label: { en: 'Compaction archive mirrors', zh: '压缩归档镜像' }, desc: { en: 'Session journals stay the byte-exact authority', zh: '会话档为逐字节权威，镜像可清' } },
  'tool-outputs': { label: { en: 'Oversized tool outputs', zh: '超长工具输出存档' }, desc: { en: 'Previews stay in the chain; old recovery paths stop working', zh: '链上保留预览；旧恢复路径将失效' } },
  'plugin-logs': { label: { en: 'Plugin host logs', zh: '插件宿主日志' }, desc: { en: 'MCP host logs', zh: 'MCP 宿主运行日志' } },
  'computer-use-screenshots': { label: { en: 'Computer-use screenshots', zh: '电脑操作截图' }, desc: { en: 'Temporary screenshots from computer use', zh: '电脑操作过程的临时截图' } },
  'http-cache': { label: { en: 'Browser HTTP cache', zh: '浏览器 HTTP 缓存' }, desc: { en: 'Login states are not touched', zh: '登录态不受影响' } },
  'images-cache': { label: { en: 'Image attachment originals', zh: '图片附件原图' }, desc: { en: 'Only copy on disk — past images become unviewable after clearing', zh: '磁盘唯一副本——清理后历史消息中的图片将无法查看' } },
};

const CONFIRM_WINDOW_MS = 3_500;

export function StoragePane({ conn, root }: { conn: StoragePaneConn; root: string }): JSX.Element {
  const [row, setRow] = useState<SettingsKeyRow | null>(null);
  const [value, setValue] = useState('');
  const [cache, setCache] = useState<CacheStatusResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bumpToast = (msg: string): void => {
    setToast(msg);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3_000);
  };
  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const load = useCallback((): void => {
    const r = root === '' ? undefined : root;
    conn.settings(r).then(
      (view) => {
        const k = view.keys.find((x) => x.key === 'archiveRetentionDays');
        if (k !== undefined) {
          setRow(k);
          setValue(k.value ?? '');
        }
      },
      () => setRow(null),
    );
    conn.cacheStatus().then(setCache, () => setCache(null));
  }, [conn, root]);
  useEffect(() => {
    load();
  }, [load]);

  /** 保留天数保存(引擎语义同 SettingsForm.persistField:变更才写/按 source 归桶/失败行内示出) */
  const persistRetention = (raw: string): void => {
    const k = row;
    if (k === null || k.envOverride) return;
    if (raw === (k.value ?? '')) return;
    const v = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
    if (raw !== '' && !Number.isFinite(v)) return;
    const isProject = k.source === 'project';
    setSaveError('');
    const put =
      isProject && root === ''
        ? Promise.reject(new Error(t('Project-level settings need a project context — open settings inside a project', '项目级配置需项目上下文——请在项目内打开设置再修改')))
        : isProject
          ? conn.putSettings('project', root, { archiveRetentionDays: v })
          : conn.putSettings('global', undefined, { archiveRetentionDays: v });
    void put
      .then(() => {
        bumpToast(t('Applied', '已生效'));
        load();
      })
      .catch((err: unknown) => setSaveError(errText(err)));
  };

  /** 缓存清理:ids 缺省=safe 全档(主按钮,附壳侧 http-cache);显式 ids=行级单独清 */
  const clear = (ids: string[] | undefined): void => {
    if (busy) return;
    setBusy(true);
    setConfirmId(null);
    const http = ids === undefined ? window.sunshinexWindow?.clearHttpCache?.().catch(() => undefined) : undefined;
    void conn
      .clearCache(ids)
      .then(async (r) => {
        await http;
        const freed = r.cleared.reduce((a, c) => a + c.freed, 0);
        if (r.failed.length > 0) bumpToast(t(`${r.failed.length} item(s) failed to clear`, `${r.failed.length} 项清理失败`));
        else if (ids === undefined && freed <= 0 && r.cleared.length === 0) bumpToast(t('Cache is already clean', '缓存本来就很干净'));
        else bumpToast(t(`Cleared — freed ${fmtBytes(freed)}`, `已清理，释放 ${fmtBytes(freed)}`));
        load();
      })
      .catch((err: unknown) => setSaveError(errText(err)))
      .finally(() => setBusy(false));
  };

  /** 引用型单清二次确认:首点置 confirmId(3.5s 复位),再点执行 */
  const clearWithConfirm = (id: string): void => {
    if (confirmId !== id) {
      setConfirmId(id);
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), CONFIRM_WINDOW_MS);
      return;
    }
    if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    clear([id]);
  };

  /** 浏览器 HTTP 缓存行(壳桥在场才显;单独清=只调壳桥) */
  const hasHttpCache = typeof window !== 'undefined' && window.sunshinexWindow?.clearHttpCache !== undefined;
  const desc = KEY_DESCRIPTIONS.archiveRetentionDays;
  const retention = cache?.retention;
  const categories = cache?.categories ?? [];

  return (
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane storage">
      <h2>{t('Storage', '存储')}</h2>
      <div className="sx-card sx-settings-card">
        <div className="sx-card-head">
          <span className="sx-card-title">{t('Archived sessions', '归档会话')}</span>
        </div>
        <div className="sx-card-rows">
          <div className="sx-setting-row" data-setting-key="archiveRetentionDays">
            <div className="sx-setting-main">
              <div className="sx-setting-title">
                <span className="sx-setting-label" data-tip="archiveRetentionDays">{desc !== undefined ? t(desc.label.en, desc.label.zh) : 'archiveRetentionDays'}</span>
              </div>
              {desc !== undefined && <p className="sx-setting-desc">{t(desc.en, desc.zh)}</p>}
            </div>
            <div className="sx-setting-ctl">
              <input
                type="number"
                className="sx-setting-input"
                aria-label="archiveRetentionDays"
                min={0}
                step={1}
                placeholder="30"
                value={value}
                disabled={row?.envOverride === true}
                title={row?.envOverride === true ? t('Overridden by env — read-only', 'env 覆盖中,改文件不生效') : undefined}
                onChange={(e) => setValue(e.target.value)}
                onBlur={(e) => persistRetention(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            </div>
          </div>
          <div className="sx-setting-row">
            <div className="sx-setting-main">
              <div className="sx-setting-title">
                <span className="sx-setting-label">{t('Last auto-clean', '上次自动清理')}</span>
              </div>
              <p className="sx-setting-desc">
                {retention === undefined
                  ? t('Loading…', '加载中…')
                  : retention.days <= 0
                    ? t('Auto-clean is off (0 = never)', '自动清理已关闭（0 = 永不）')
                    : retention.lastRunAt === null
                      ? t('Not run yet', '尚未运行')
                      : t(`${relTime(retention.lastRunAt)} · ${retention.lastPurged} session(s) purged`, `${relTime(retention.lastRunAt)} · 已清理 ${retention.lastPurged} 个会话`)}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="sx-card sx-settings-card">
        <div className="sx-card-head">
          <span className="sx-card-title" data-setting-key="cache">{t('Cache', '缓存')}</span>
          <button type="button" className="sx-storage-btn" disabled={busy} data-tip={t('Clear all safe caches + browser HTTP cache', '清理全部安全缓存与浏览器 HTTP 缓存')} onClick={() => clear(undefined)}>
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('Clear cache', '清理缓存')}
          </button>
        </div>
        <div className="sx-card-rows">
          {cache !== null && (
            <div className="sx-setting-row">
              <div className="sx-setting-main">
                <div className="sx-setting-title">
                  <span className="sx-setting-label">{t('Total cache size', '缓存总占用')}</span>
                </div>
              </div>
              <div className="sx-setting-ctl">
                <span className="sx-storage-size">{fmtBytes(cache.total)}</span>
              </div>
            </div>
          )}
          {categories.map((c) => {
            const l = CACHE_LABELS[c.id];
            return (
              <div key={c.id} className="sx-setting-row" data-setting-key={`cache:${c.id}`}>
                <div className="sx-setting-main">
                  <div className="sx-setting-title">
                    <span className="sx-setting-label">{l !== undefined ? t(l.label.en, l.label.zh) : c.id}</span>
                  </div>
                  {l !== undefined && <p className="sx-setting-desc">{t(l.desc.en, l.desc.zh)}</p>}
                </div>
                <div className="sx-setting-ctl sx-storage-rowctl">
                  <span className="sx-storage-size">{fmtBytes(c.size)}</span>
                  {c.safe ? (
                    <button type="button" className="sx-iconbtn" aria-label={`clear ${c.id}`} data-tip={t('Clear', '清理')} disabled={busy} onClick={() => clear([c.id])}>
                      <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  ) : (
                    <button type="button" className={`sx-storage-btn${confirmId === c.id ? ' danger' : ''}`} disabled={busy} data-tip={t('Click again within 3.5s to confirm', '3.5 秒内再次点击确认')} onClick={() => clearWithConfirm(c.id)}>
                      {confirmId === c.id ? t('Confirm clear?', '确认清理？') : t('Clear', '清理')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {hasHttpCache && (
            <div className="sx-setting-row" data-setting-key="cache:http-cache">
              <div className="sx-setting-main">
                <div className="sx-setting-title">
                  <span className="sx-setting-label">{t(CACHE_LABELS['http-cache']!.label.en, CACHE_LABELS['http-cache']!.label.zh)}</span>
                </div>
                <p className="sx-setting-desc">{t(CACHE_LABELS['http-cache']!.desc.en, CACHE_LABELS['http-cache']!.desc.zh)}</p>
              </div>
              <div className="sx-setting-ctl">
                <button type="button" className="sx-iconbtn" aria-label="clear http-cache" data-tip={t('Clear', '清理')} disabled={busy} onClick={() => {
                  setBusy(true);
                  void (window.sunshinexWindow?.clearHttpCache?.() ?? Promise.resolve({ ok: true }))
                    .catch(() => undefined)
                    .finally(() => {
                      setBusy(false);
                      bumpToast(t('Browser cache cleared', '浏览器缓存已清'));
                    });
                }}>
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
          {categories.length === 0 && cache === null && <p className="home-loading">{t('Loading cache info…', '加载缓存信息…')}</p>}
        </div>
      </div>
      {saveError !== '' && <p className="home-error" role="alert">{saveError}</p>}
      {toast !== '' && (
        <div className="sx-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}
```

（实现时按 SettingsForm 的既有 `sx-card-head` 结构核对——主按钮放卡头右侧如与现有 CSS 冲突则改放 `sx-card-rows` 顶行；以渲染结果不破版为准。）

- [ ] **Step 5: settings-search.ts** buildIndex() ②段之后增：

```ts
  // ②b 存储页行(StoragePane 自绘行,非 SETTINGS_PANES 字段;锚=data-setting-key)
  const storageTitle = PANE_TITLES.get('storage') ?? { en: 'Storage', zh: '存储' };
  const rd = KEY_DESCRIPTIONS.archiveRetentionDays;
  if (rd !== undefined) {
    out.push({ id: 'row:storage:archiveRetentionDays', pane: 'storage', paneTitle: storageTitle, row: 'archiveRetentionDays', label: rd.label, desc: { en: rd.en, zh: rd.zh } });
  }
  out.push({
    id: 'row:storage:cache',
    pane: 'storage',
    paneTitle: storageTitle,
    row: 'cache',
    label: { en: 'Clear cache', zh: '清理缓存' },
    desc: { en: 'Identified cache categories with sizes', zh: '已识别的缓存分类与占用' },
  });
```

- [ ] **Step 6: app.css** 增（圆角/字号走 token；图标钮沿用 .sx-iconbtn 基准形）：

```css
/* 存储页(2026-11-21):清理按钮/体积列/引用型警示态 */
.sx-storage-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); color: var(--fg); font-size: calc(14px * var(--fz)); transition: background var(--dur-basic) var(--ease-enter), color var(--dur-basic) var(--ease-enter); }
.sx-storage-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.sx-storage-btn:disabled { opacity: 0.5; cursor: default; }
.sx-storage-btn.danger { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
.sx-storage-size { color: var(--fg-secondary); font-size: calc(14px * var(--fz)); flex: none; }
.sx-storage-rowctl { display: inline-flex; align-items: center; gap: 8px; }
```

- [ ] **Step 7: 验证**：`pnpm --dir gui run typecheck` → 过；`pnpm gui:build` → 成功。

- [ ] **Step 8: 提交**

```bash
git add gui/src/settings/StoragePane.tsx gui/src/settings/settings-groups.ts gui/src/settings/SettingsShell.tsx gui/src/settings/SettingsForm.tsx gui/src/settings/settings-search.ts gui/src/app.css
git commit -m "feat(gui): 设置页「存储」分组——归档保留天数行+缓存三档清点(引用型行内二次确认)+一键清 safe 档+搜索索引直达行"
```

---

### Task 8: GUI 测试

**Files:**
- Create: `gui/src/settings/__tests__/StoragePane.test.tsx`
- Create: `gui/src/settings/__tests__/settings-search.storage.test.ts`

**Interfaces:**
- Consumes: Task 7 StoragePane/SETTINGS_SEARCH_ITEMS。

- [ ] **Step 1: 写测试**（先看 `gui/src/settings/__tests__/SettingsForm.filter.test.tsx` 的渲染/harness 约定，同形落笔）——断言：

StoragePane.test.tsx：
1. mock conn.settings 返回含 `{ key: 'archiveRetentionDays', value: '30', source: 'global', envOverride: false }` 的 view、conn.cacheStatus 返回 fixture（两类含 size）→ 渲染后能看到天数输入（value=30）、分类行双语标签与体积文本。
2. 改天数输入失焦 → `putSettings('global', undefined, { archiveRetentionDays: <n> })` 被调。
3. safe 行清理钮点击 → `clearCache(['pty-replay'])` 被调。
4. 引用型行（images-cache）首点只置确认态（未调 clearCache），3.5s 内再点 → `clearCache(['images-cache'])` 被调（vitest fake timer 推进或 stub CONFIRM_WINDOW_MS 场景——以同文件既有 fake timer 用法为准）。
5. 主「清理缓存」钮 → `clearCache()` 无参 + `clearHttpCache` 被调（stub window.sunshinexWindow）。

settings-search.storage.test.ts：
1. `SETTINGS_SEARCH_ITEMS` 含 `row:storage:archiveRetentionDays` 与 `row:storage:cache`（pane='storage'、row 锚正确）。
2. 面板级条目 `pane:storage` 存在。

- [ ] **Step 2: 跑测试通过**：`pnpm --dir gui run test`（vitest 全量，含既有面回归）。

- [ ] **Step 3: 提交**

```bash
git add gui/src/settings/__tests__/StoragePane.test.tsx gui/src/settings/__tests__/settings-search.storage.test.ts
git commit -m "test(gui): 存储面板/搜索索引用例——保留天数读写、safe/引用型清理路径、主按钮含壳桥、搜索直达行"
```

---

### Task 9: 全量验证

- [ ] **Step 1:** `pnpm build && pnpm test`（主仓全量，per-file .data-test 隔离）→ 过。
- [ ] **Step 2:** `pnpm --dir gui run test`（vitest + e2e 起 daemon）→ 过。
- [ ] **Step 3:** `pnpm --filter sunshinex-shell run test` → 过；`pnpm shell:smoke` → 过。
- [ ] **Step 4:** `pnpm selfcheck` → 过。
- [ ] **Step 5:** `pnpm gui:build`（dist-gui 产物刷新，daemon 静态面同源）。
- [ ] **Step 6:** 有失败逐个根修（禁补丁式 if），全绿后本任务无提交（各任务已提交）。

---

## Self-Review 记录

- **Spec coverage**：spec §3 登记表三档（Task 2）；§4 语义键/清扫器/定时补扫（Task 1、3）；§5 端点（Task 2、3）；§6 壳 IPC/托盘（Task 4、5）；§7.1 存储分组（Task 7）、§7.2 搜索框（Task 6）、§7.3 托盘分支（Task 6）；§8 错误处理（各任务实现内）；§9 测试（Task 1/2/4/8/9）。无缺口。
- **类型一致性**：`CacheDirs/CacheClearResult/CacheHandlerIo`、`SweepResult/RetentionState`、`CacheStatusResp/CacheClearResp`、`StoragePaneConn` 各任务间签名已逐一核对一致。
- **占位符**：无 TBD/「适当处理」类步骤；Task 8 测试断言以条目列出，具体渲染查询写测试时按既有 harness 约定落码（已给断言语义与场景清单）。
