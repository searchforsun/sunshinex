import type { SessionRow, SessionTaskRow, SnapshotResponse } from '../connection';
import { SESSION_KIND_SUNX } from '../connection';

/**
 * SUNX 总览页数据组装(sunx P2 Task 8,spec §17.3;2026-11-16 用户实测「数据不对」根修+「状态
 * 词汇/图标对齐既有体系」裁定):任务计数源改**后台任务账本**(conn.sessionTasks——dispatch_task
 * 的 spawn 即 kind:'subagent' 在册,与后台任务页签同源同数)并**并入团队板任务**(dispatch
 * target:'team' 走板通道,板任务有「等待」态)。状态五桶对齐既有体系:运行中/等待/完成/失败/
 * 已取消;「等待确认」=快照挂起段行数另计(ask/approval)。
 * 纯函数族:组件只管拉取编排(逐 live 行 sessionTasks+sessionSnapshot bumpSeq:false 只读通道),
 * 装配/分节/汇总全在此处可直测。最近活动=账本/板任务(endedAt??startedAt/updatedAt 最大)的
 * title/label 一行,无任务回落行 updatedAt。
 */

/** 团队板任务窄面(dispatch target:'team' 的板通道任务;结构面解耦 BoardTask 全形) */
export interface SunxBoardTaskLite {
  readonly title: string;
  readonly status: string;
  readonly updatedAt?: number;
}

/** 任务五态计数(后台任务账本+团队板任务并入;2026-11-16 用户裁定状态词汇对齐既有体系) */
export interface SunxTaskCounts {
  readonly running: number;
  readonly pending: number;
  readonly done: number;
  readonly failed: number;
  readonly cancelled: number;
}

/** 账本+板任务 → 五态计数:账本态 running/done/failed/stopped(后台任务语义,stopped=已取消);
 *  板任务态 pending/running/success/failed/cancelled(团队板语义,success=完成/pending=等待) */
export function taskCountsOf(ledger: readonly SessionTaskRow[], boardTasks: readonly SunxBoardTaskLite[]): SunxTaskCounts {
  const c = { running: 0, pending: 0, done: 0, failed: 0, cancelled: 0 };
  for (const t of ledger) {
    if (t.status === 'running') c.running += 1;
    else if (t.status === 'done') c.done += 1;
    else if (t.status === 'failed') c.failed += 1;
    else if (t.status === 'stopped') c.cancelled += 1;
  }
  for (const t of boardTasks) {
    if (t.status === 'running') c.running += 1;
    else if (t.status === 'pending') c.pending += 1;
    else if (t.status === 'success') c.done += 1;
    else if (t.status === 'failed') c.failed += 1;
    else if (t.status === 'cancelled') c.cancelled += 1;
  }
  return c;
}

const ZERO_COUNTS: SunxTaskCounts = { running: 0, pending: 0, done: 0, failed: 0, cancelled: 0 };

/** 快照+账本窄面(总览页只读消费):快照出板任务+挂起段,账本由组件经 sessionTasks 另拉合成 */
export interface SunxSnapSlice {
  readonly ledger: readonly SessionTaskRow[];
  readonly boardTasks: readonly SunxBoardTaskLite[];
  readonly pendingCount: number;
  /** 快照在场(2026-11-16 降级语义:快照拉取失败=账本计数照用,等待确认退行级 awaitingRow) */
  readonly awaitingKnown: boolean;
}

/** SnapshotResponse+账本行 → 窄面(挂起段可选防旧 daemon;缺席=0) */
export function sunxSnapOf(snap: Pick<SnapshotResponse, 'status' | 'board' | 'pending'>, ledger: readonly SessionTaskRow[]): SunxSnapSlice {
  const raw = (snap.board?.tasks ?? {}) as Record<string, { title?: unknown; status?: unknown; updatedAt?: unknown }>;
  return {
    ledger,
    boardTasks: Object.values(raw).map((t) => ({
      title: typeof t.title === 'string' ? t.title : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
      updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : undefined,
    })),
    pendingCount: snap.pending?.length ?? 0,
    awaitingKnown: true,
  };
}

/** 实例卡(spec §17.3;2026-11-16 状态五桶化):姓名+状态点+任务五态计数+等待确认+最近活动 */
export interface SunxCard {
  readonly journalId: string;
  readonly root: string;
  readonly slug: string;
  /** title ?? firstUser ?? ''(空串=组件回落「未命名 Sunx」) */
  readonly name: string;
  /** 行 liveSessionId 在场=daemon 标注运行中(状态点=tb-status-dot 家族:live=转动环) */
  readonly live: boolean;
  /** 行级待确认标注(快照缺席时的徽标兜底) */
  readonly awaitingRow: boolean;
  readonly updatedAt: number;
  /** 任务五态计数(账本+板任务并入;快照/账本双缺=零值) */
  readonly tasks: SunxTaskCounts;
  /** 等待确认数(快照挂起段行数;快照缺席退行级 awaitingRow?1:0) */
  readonly awaiting: number;
  /** 快照在场=true(缺席时等待确认退行级布尔,聚合不计未知) */
  readonly awaitingKnown: boolean;
  /** 最近活动一行(ts+label;无委派 label='' ts=行 updatedAt) */
  readonly lastActivity: { readonly ts: number; readonly label: string };
}

/** /sessions 行 kind 过滤 + updatedAt 新→旧(卡片网格行序=R10 组内序) */
export function sunxRowsOf(rows: ReadonlyArray<SessionRow & { root?: string; slug?: string }>): Array<SessionRow & { root: string; slug: string }> {
  return rows
    .filter((r): r is SessionRow & { root: string; slug: string } => r.kind === SESSION_KIND_SUNX && typeof r.root === 'string' && r.root !== '' && typeof r.slug === 'string')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 行+快照账本窄面 → 卡片(snap=null:未挂载行降级零计数,等待确认退行级 awaitingRow) */
export function sunxCardOf(row: SessionRow & { root: string; slug: string }, snap: SunxSnapSlice | null): SunxCard {
  let lastTs = row.updatedAt;
  let lastLabel = '';
  if (snap !== null) {
    for (const t of snap.ledger) {
      const ts = t.endedAt ?? t.startedAt;
      if (ts > lastTs) {
        lastTs = ts;
        lastLabel = t.title ?? t.label;
      }
    }
    for (const t of snap.boardTasks) {
      if (t.updatedAt !== undefined && t.updatedAt > lastTs) {
        lastTs = t.updatedAt;
        lastLabel = t.title;
      }
    }
  }
  return {
    journalId: row.id,
    root: row.root,
    slug: row.slug,
    name: row.title ?? row.firstUser ?? '',
    live: row.liveSessionId !== undefined,
    awaitingRow: row.awaiting === true,
    updatedAt: row.updatedAt,
    tasks: snap !== null ? taskCountsOf(snap.ledger, snap.boardTasks) : ZERO_COUNTS,
    awaiting: snap !== null && snap.awaitingKnown ? snap.pendingCount : row.awaiting === true ? 1 : 0,
    awaitingKnown: snap !== null && snap.awaitingKnown,
    lastActivity: { ts: lastTs, label: lastLabel },
  };
}

/** 组装单点:行序(kind 过滤+新→旧)逐行取快照(仅 live 行有键;组件从拉取编排落 Map) */
export function assembleSunxCards(
  rows: ReadonlyArray<SessionRow & { root?: string; slug?: string }>,
  snapOf: (liveSessionId: string) => SunxSnapSlice | null,
): SunxCard[] {
  return sunxRowsOf(rows).map((row) => sunxCardOf(row, row.liveSessionId !== undefined ? snapOf(row.liveSessionId) : null));
}

/** 顶部全局聚合条:运行中实例 n+任务五态汇总+等待确认 n(等待确认只计快照在场行)——卡片数据汇总 */
export interface SunxAggregate {
  readonly running: number;
  readonly tasks: SunxTaskCounts;
  readonly awaiting: number;
}

export function aggregateSunxCards(cards: readonly SunxCard[]): SunxAggregate {
  const tasks = { ...ZERO_COUNTS };
  let running = 0;
  let awaiting = 0;
  for (const c of cards) {
    if (c.live) running += 1;
    tasks.running += c.tasks.running;
    tasks.pending += c.tasks.pending;
    tasks.done += c.tasks.done;
    tasks.failed += c.tasks.failed;
    tasks.cancelled += c.tasks.cancelled;
    if (c.awaitingKnown) awaiting += c.awaiting;
  }
  return { running, tasks, awaiting };
}

/** 按工作区分节(R10):slug 首现保序(行序=updatedAt 新→旧),组内即卡片序 */
export interface SunxSection {
  readonly slug: string;
  readonly root: string;
  readonly cards: readonly SunxCard[];
}

export function sunxSectionsOf(cards: readonly SunxCard[]): SunxSection[] {
  const bySlug = new Map<string, { slug: string; root: string; cards: SunxCard[] }>();
  for (const c of cards) {
    const sec = bySlug.get(c.slug);
    if (sec === undefined) bySlug.set(c.slug, { slug: c.slug, root: c.root, cards: [c] });
    else sec.cards.push(c);
  }
  return [...bySlug.values()];
}
