import type * as http from 'node:http';
import { jobView, validateDraft } from './model';
import type { ScheduleJob, ScheduleJobView } from './model';
import { nextRunAt } from './recurrence';
import type { ScheduleEngine } from './engine';

/** HTTP 面触点（daemon 单点注入 send/readJson；engine 单例；defaultModel 供 GUI 模型 pill） */
export interface SchedulesHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  engine: ScheduleEngine;
  defaultModel(): string;
  /** 删除回收判据：daemon 当前 active 会话（用户正在看的运行时不得被回收） */
  activeSessionId(): string | undefined;
  /** 任务删除时回收最近一条带会话 run 的运行时（journal/meta 留盘，点记录可重建） */
  releaseSession(id: string): void;
}

function viewOf(job: ScheduleJob): ScheduleJobView {
  return jobView(job);
}

/** 列表读口径（spec §8）：enabled 且存量 nextRunAt 已过期时按 now 重算展示值——定时器在途/引擎
 *  停摆窗内 GET 也给出未来时刻；越过 until 与引擎同口径回 null+ended。只读：不落盘（引擎是
 *  nextRunAt 唯一写者，GET 不得改写存储）。 */
function listViewOf(job: ScheduleJob, now: number): ScheduleJobView {
  const view = viewOf(job);
  if (!job.enabled || job.nextRunAt === null || job.nextRunAt > now) return view;
  const next = nextRunAt(job.recurrence, job.startAt, Math.max(now, job.nextRunAt), job.until);
  return next === null ? { ...view, nextRunAt: null, ended: true } : { ...view, nextRunAt: next };
}

export function handleSchedulesList(io: SchedulesHandlerIo, res: http.ServerResponse): void {
  const now = Date.now();
  io.send(res, 200, { now, defaultModel: io.defaultModel(), jobs: io.engine.list().map((job) => listViewOf(job, now)) });
}

export async function handleSchedulesCreate(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const draft = validateDraft(parsed.body, Date.now());
  if (!draft.ok) return io.send(res, 400, { error: draft.error });
  io.send(res, 200, viewOf(io.engine.create(draft.value)));
}

export async function handleSchedulesUpdate(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const draft = validateDraft(parsed.body, Date.now());
  if (!draft.ok) return io.send(res, 400, { error: draft.error });
  const job = io.engine.update(id, draft.value);
  if (job === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  io.send(res, 200, viewOf(job));
}

export function handleSchedulesDelete(io: SchedulesHandlerIo, res: http.ServerResponse, id: string): void {
  const job = io.engine.get(id);
  if (job === undefined || !io.engine.remove(id)) return io.send(res, 404, { error: 'unknown schedule' });
  // runs 新→旧：取**最新一条带 sessionId 的 run**（最近记录可能在建席失败时无会话）；若是用户
  // 正在看的 active 运行时则跳过回收（拆掉观感中的会话不可接受，journal 留盘可重开）
  const sessionId = job.runs.find((r) => r.sessionId !== undefined)?.sessionId;
  if (sessionId !== undefined && sessionId !== io.activeSessionId()) {
    try {
      io.releaseSession(sessionId);
    } catch {
      /* 尽力回收：运行时触点异常不得挡任务删除 */
    }
  }
  io.send(res, 200, { ok: true });
}

export function handleSchedulesRun(io: SchedulesHandlerIo, res: http.ServerResponse, id: string): void {
  const runId = io.engine.runNow(id);
  if (runId === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  io.send(res, 200, { ok: true, runId });
}

export async function handleSchedulesEnabled(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const enabled = (parsed.body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') return io.send(res, 400, { error: 'enabled boolean required' });
  const job = io.engine.setEnabled(id, enabled);
  if (job === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  io.send(res, 200, viewOf(job));
}

export function handleSchedulesRuns(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  const job = io.engine.get(id);
  if (job === undefined) return io.send(res, 404, { error: 'unknown schedule' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const raw = Number(url.searchParams.get('limit') ?? '200');
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 200) : 200;
  io.send(res, 200, { runs: job.runs.slice(0, limit) });
}

export async function handleSchedulesPreview(io: SchedulesHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const body = parsed.body as { recurrence?: unknown; startAt?: unknown; until?: unknown } | null;
  const startAt = typeof body?.startAt === 'number' ? body.startAt : NaN;
  const until = typeof body?.until === 'number' ? body.until : undefined;
  const draft = validateDraft({ name: 'preview', prompt: 'preview', root: 'default', effort: 'medium', mode: 'full-access', recurrence: body?.recurrence, startAt, ...(until !== undefined ? { until } : {}) }, Date.now());
  if (!draft.ok) return io.send(res, 400, { error: draft.error });
  const next: number[] = [];
  let cursor = Date.now() - 1;
  for (let i = 0; i < 3; i++) {
    const t = nextRunAt(draft.value.recurrence, draft.value.startAt, cursor, draft.value.until);
    if (t === null) break;
    next.push(t);
    cursor = t;
  }
  io.send(res, 200, { next });
}
