import type { SessionRow, SnapshotResponse } from '../connection';
import type { Delegation } from '../projection';

/**
 * SUNX 总览页数据组装(sunx P2 Task 8,spec §17.3「数据面零新增」):卡片字段全部来自既有面——
 * /sessions 行 kind 过滤 + 快照委派投影计数 + 挂起段计数,前端推导聚合条,零新增后端。
 * 纯函数族:组件只管拉取编排(逐 live 行 sessionSnapshot bumpSeq:false 只读通道),装配/分节/
 * 汇总全在此处可直测。语义裁定(controller ruling 3):在飞=委派投影未终态条数(running/paused);
 * 完成=done 严格计(failed/skipped 不计);待裁决=挂起段行数(快照缺席=未知,不进聚合);
 * 最近活动=最近委派(endedAt??startedAt 最大)的 title/label 一行,无委派回落行 updatedAt。
 */

/** 快照窄面(总览页只读消费;SnapshotResponse 全形只取三段,组件拉取后经 sunxSnapOf 落此形) */
export interface SunxSnapSlice {
  readonly status: 'idle' | 'running';
  readonly delegations: readonly Delegation[];
  readonly pendingCount: number;
}

/** SnapshotResponse → 窄面(挂起段可选防旧 daemon;缺席=0) */
export function sunxSnapOf(snap: Pick<SnapshotResponse, 'status' | 'delegations' | 'pending'>): SunxSnapSlice {
  return { status: snap.status, delegations: snap.delegations, pendingCount: snap.pending?.length ?? 0 };
}

/** 实例卡(spec §17.3:姓名+状态点+任务进度+最近活动+待裁决的数据体) */
export interface SunxCard {
  readonly journalId: string;
  readonly root: string;
  readonly slug: string;
  /** title ?? firstUser ?? ''(空串=组件回落「未命名 Sunx」) */
  readonly name: string;
  /** 行 liveSessionId 在场=daemon 标注运行中(状态点绿;快照也只对 live 行可拉) */
  readonly live: boolean;
  /** 行级待确认标注(快照缺席时的徽标兜底) */
  readonly awaiting: boolean;
  readonly updatedAt: number;
  readonly inFlight: number;
  readonly done: number;
  /** 挂起段行数(快照缺席=0) */
  readonly pending: number;
  /** 快照在场=true(缺席时徽标退行级 awaiting 布尔,聚合不计未知) */
  readonly pendingKnown: boolean;
  /** 最近活动一行(ts+label;无委派 label='' ts=行 updatedAt) */
  readonly lastActivity: { readonly ts: number; readonly label: string };
}

/** 委派终态集(running/paused=在飞;done 之外终态不算完成) */
const TERMINAL: ReadonlySet<Delegation['status']> = new Set<Delegation['status']>(['done', 'failed', 'skipped']);

/** /sessions 行 kind 过滤 + updatedAt 新→旧(卡片网格行序=R10 组内序) */
export function sunxRowsOf(rows: ReadonlyArray<SessionRow & { root?: string; slug?: string }>): Array<SessionRow & { root: string; slug: string }> {
  return rows
    .filter((r): r is SessionRow & { root: string; slug: string } => r.kind === 'sunx' && typeof r.root === 'string' && r.root !== '' && typeof r.slug === 'string')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 行+快照窄面 → 卡片(快照缺席=null:未挂载行降级零计数,待裁决退行级 awaiting) */
export function sunxCardOf(row: SessionRow & { root: string; slug: string }, snap: SunxSnapSlice | null): SunxCard {
  let inFlight = 0;
  let done = 0;
  let lastTs = row.updatedAt;
  let lastLabel = '';
  if (snap !== null) {
    for (const d of snap.delegations) {
      if (!TERMINAL.has(d.status)) inFlight += 1;
      else if (d.status === 'done') done += 1;
      const t = d.endedAt ?? d.startedAt;
      if (t > lastTs) {
        lastTs = t;
        lastLabel = d.title ?? d.label;
      }
    }
  }
  return {
    journalId: row.id,
    root: row.root,
    slug: row.slug,
    name: row.title ?? row.firstUser ?? '',
    live: row.liveSessionId !== undefined,
    awaiting: row.awaiting === true,
    updatedAt: row.updatedAt,
    inFlight,
    done,
    pending: snap?.pendingCount ?? 0,
    pendingKnown: snap !== null,
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

/** 顶部全局聚合条(spec §17.3:运行中实例 n/在飞任务 n/待裁决 n)——卡片数据汇总,前端推导 */
export interface SunxAggregate {
  readonly running: number;
  readonly inFlight: number;
  readonly pending: number;
}

export function aggregateSunxCards(cards: readonly SunxCard[]): SunxAggregate {
  let inFlight = 0;
  let pending = 0;
  let running = 0;
  for (const c of cards) {
    if (c.live) running += 1;
    inFlight += c.inFlight;
    if (c.pendingKnown) pending += c.pending;
  }
  return { running, inFlight, pending };
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
