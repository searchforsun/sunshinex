import type * as http from 'node:http';
import { jobView, validateDraft } from './model';
import type { ScheduleJob } from './model';
import { nextRunAt } from './recurrence';
import type { ScheduleEngine } from './engine';

/** HTTP 面触点（daemon 单点注入 send/readJson；engine 单例；defaultModel 供 GUI 模型 pill） */
export interface SchedulesHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  engine: ScheduleEngine;
  defaultModel(): string;
  /** 任务删除时回收最近一次 run 的会话运行时（journal/meta 留盘，点记录可重建） */
  releaseSession(id: string): void;
}

function viewOf(job: ScheduleJob) {
  return jobView(job);
}

export function handleSchedulesList(io: SchedulesHandlerIo, res: http.ServerResponse): void {
  io.send(res, 200, { now: Date.now(), defaultModel: io.defaultModel(), jobs: io.engine.list().map(viewOf) });
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
  const sessionId = job.runs[0]?.sessionId;
  if (sessionId !== undefined) {
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
