import * as fs from 'node:fs';
import * as path from 'node:path';
import { userConfigDir } from '../config/env';
import { listSessions, purgeSideJournals, purgeSession } from '../session/journal';
import { listScanDataDirs } from './sessions-list-handlers';

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
  const dirs = deps.dataDirs ?? listScanDataDirs(); // 扫描域单点（D110；channels 纳入随裁定）
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
