import * as http from 'node:http';
import * as path from 'node:path';
import type { SessionRuntime } from './session';
import type { SnapshotPendingRow } from './session';
import type { Result } from '../result';
import type { DaemonFrame, PendingEntry } from './daemon-wire';
import type { ModelAdapter } from '../model/adapter';
import { listAnchors, parseJournalFile, readSessionMeta, sessionsDir, writeSessionMeta } from '../tui/session-journal';
import { runCommand } from './session-commands';
import { contextBreakdown } from '../harness/context';
import { resolveRunWindow } from '../config/termination-config';
import { resolveDataDir } from '../config/data-dir';

/** 会话控制面 HTTP 处理器（D31 批2 拆分自 daemon.ts 类）：submit/interrupt/steer 族/reset/snapshot/
 *  anchors/tier/effort/model/mode/command/tasks/context/board-review/rename/title/attach——类状态
 *  触点收敛于 io（send/readJson/sessionFor 会话寻址 + sessions 表 + denyPendingFor/broadcastFrame/
 *  pending 挂起面 + model 标题摘要 + attach 挂载）；路由表零改动，行为零变化（daemon.test 为锚）。
 */

/** 会话 id 安全面（单点）：id 寻址会话注册表与 journal 文件名——形态收紧为
 *  [A-Za-z0-9_-]{1,128}（session-handlers 与 daemon 装配点共用） */
export function validSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export interface SessionHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  sessionFor(res: http.ServerResponse, id: string | undefined): SessionRuntime | undefined;
  sessions: Map<string, SessionRuntime>;
  denyPendingFor(sessionId: string): void;
  broadcastFrame(frame: DaemonFrame): void;
  pending: ReadonlyMap<string, PendingEntry>;
  model: ModelAdapter;
  attach(id: string, journalId: string): Result<{ sessionId: string }>;
}

export async function handleSubmit(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const goal = (parsed.body as { goal?: unknown } | null)?.goal;
  if (typeof goal !== 'string' || goal.length === 0) {
    io.send(res, 400, { error: 'goal must be a non-empty string' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const r = session.submit(goal);
  if (!r.ok) {
    io.send(res, r.status, { error: r.error });
    return;
  }
  io.send(res, 202, { ok: true });
}

export function handleInterrupt(io: SessionHandlerIo, res: http.ServerResponse, id: string | undefined): void {
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const r = session.interrupt();
  if (!r.ok) {
    io.send(res, 409, { error: r.error });
    return;
  }
  io.denyPendingFor(session.id);
  io.send(res, 200, { ok: true });
}

export async function handleSteer(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const text = (parsed.body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    io.send(res, 400, { error: 'text must be a non-empty string' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  session.steer(text);
  io.send(res, 200, { ok: true });
}

export async function handleReset(io: SessionHandlerIo, res: http.ServerResponse, id: string | undefined): Promise<void> {
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  io.denyPendingFor(session.id);
  await session.reset();
  io.broadcastFrame({ kind: 'reset', sessionId: session.id });
  io.send(res, 200, { ok: true });
}

export async function handleSessionTitle(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, _id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const text = (parsed.body as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim() === '') return io.send(res, 400, { error: 'invalid text' });
  // 真实模型门禁(J2 能力位):Stub/Scripted 桩不消耗脚本队列(e2e 断言不漂移),503 由客户端静默降级
  if (io.model.capabilities?.chat !== true) {
    return io.send(res, 503, { error: 'model not wired — title summarization unavailable' });
  }
  try {
    const r = await io.model.chat({
      messages: [
        {
          role: 'user',
          content: `为下面的会话内容生成一个不超过20字的简短标题。只输出标题本身,不要引号、句号或任何前后缀:\n${text.slice(0, 600)}`,
        },
      ],
    });
    const cleaned = r.content.trim().replace(/^["'「『]+|["'」』.。!！?？]+$/g, '');
    const title = cleaned === '' ? text.trim().slice(0, 20) : cleaned.slice(0, 24);
    io.send(res, 200, { ok: true, title });
  } catch (err) {
    io.send(res, 503, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleSessionRename(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  if (!validSessionId(id)) return io.send(res, 400, { error: 'invalid session id' });
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const raw = (parsed.body as { title?: unknown }).title;
  if (typeof raw !== 'string' || raw.trim() === '') return io.send(res, 400, { error: 'invalid title' });
  const title = raw.trim().slice(0, 80);
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const journalId = session.attachedJournalId;
  if (journalId === undefined) return io.send(res, 409, { error: 'no journaled session' });
  writeSessionMeta(resolveDataDir(session.root), journalId, { title });
  io.send(res, 200, { ok: true, title });
}

export function handleSessionTitleGet(io: SessionHandlerIo, res: http.ServerResponse, id: string): void {
  if (!validSessionId(id)) return io.send(res, 400, { error: 'invalid session id' });
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const journalId = session.attachedJournalId;
  if (journalId === undefined) return io.send(res, 200, {});
  io.send(res, 200, { title: readSessionMeta(resolveDataDir(session.root), journalId).title });
}


/** POST /session/:id/command {line}(G10-C1c):TUI 斜杠命令 daemon 直跑;输出走既有事件流 */
export async function handleSessionCommand(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const line = (parsed.body as { line?: unknown }).line;
  if (typeof line !== 'string' || !line.startsWith('/')) return io.send(res, 400, { error: 'invalid command line' });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const r = await runCommand(session, line);
  if (r === 'unsupported') return io.send(res, 400, { error: 'unsupported command' });
  if (r === 'busy') return io.send(res, 409, { error: 'session is running' });
  io.send(res, 200, { ok: true });
}


/** GET /session/:id/tasks(G10-C6 后台任务面板):账本行(脱敏——stop 句柄/文件路径不出端点) */
export function handleSessionTasks(io: SessionHandlerIo, res: http.ServerResponse, id: string): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const rows = session.runtime.harness.tasks.list().map((t2) => ({
    id: t2.id, kind: t2.kind, label: t2.label, status: t2.status, startedAt: t2.startedAt, ...(t2.exitCode !== undefined ? { exitCode: t2.exitCode } : {}),
  }));
  io.send(res, 200, rows);
}


/** GET /session/:id/context(G10-C6 上下文面板):分段构成结构化面(parts/total/window/free) */
export function handleSessionContext(io: SessionHandlerIo, res: http.ServerResponse, id: string): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const ctx = session.runtime.harness.context;
  const parts = ctx.snapshotPartsView();
  const b = contextBreakdown({
    stableSegment: session.runtime.harness.reactor.stableSegment(),
    instructions: parts.instructions,
    skills: parts.skills,
    memory: parts.memory,
    compacted: ctx.compactedView(),
    chain: ctx.chainView(),
    skill: ctx.peekSkill(),
    window: resolveRunWindow(session.runtime.harness.model),
    chainFrom: ctx.chainFromView(),
  });
  io.send(res, 200, b);
}


/** GET /session/:id/anchors(G10-C1d):任务轮锚点列表(rewind/fork 的 turn 寻址面,1-based) */
export function handleAnchors(io: SessionHandlerIo, res: http.ServerResponse, id: string): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const srcId = session.attachedJournalId;
  if (srcId === undefined) return io.send(res, 409, { error: 'no journaled session' });
  const parsed = parseJournalFile(path.join(sessionsDir(resolveDataDir(session.root)), srcId + '.jsonl'));
  const anchors = listAnchors(parsed).map((x, i) => ({ turn: i + 1, text: x.text.length > 96 ? x.text.slice(0, 96) + '…' : x.text }));
  io.send(res, 200, { anchors });
}


/** POST /session/:id/steer/cancel {seq}(G10-C1d):撤回排队插话;越界 400 */
/** POST /session/:id/steer/move {from,to}(G14.83 拖拽排序) */
export async function handleSteerMove(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const { from, to } = (parsed.body ?? {}) as { from?: unknown; to?: unknown };
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to)) {
    return io.send(res, 400, { error: 'from/to must be integers' });
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (!session.steerMove(from, to)) return io.send(res, 400, { error: 'no such queued entry' });
  io.send(res, 200, { ok: true });
}


/** POST /session/:id/steer/front {seq}(G14.83 插入发送=置首) */
export async function handleSteerFront(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const seq = (parsed.body as { seq?: unknown } | null)?.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return io.send(res, 400, { error: 'invalid seq' });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (!session.steerFront(seq)) return io.send(res, 400, { error: 'no such queued entry' });
  io.send(res, 200, { ok: true });
}


export async function handleSteerCancel(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const seq = (parsed.body as { seq?: unknown }).seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return io.send(res, 400, { error: 'invalid seq' });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (!session.cancelSteer(seq)) return io.send(res, 400, { error: 'no such queued entry' });
  io.send(res, 200, { ok: true });
}

export async function handleSessionTierEffort(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string, kind: 'tier' | 'effort'): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const raw = (parsed.body as Record<string, unknown>)[kind];
  if (raw !== undefined && raw !== 'default' && typeof raw !== 'string') return io.send(res, 400, { error: `invalid ${kind}` });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const value = raw === undefined || raw === 'default' ? undefined : (raw as string);
  const ok = kind === 'tier' ? (value === undefined ? (session.clearTier(), true) : session.setTier(value))
                             : (value === undefined ? (session.clearEffort(), true) : session.setEffort(value));
  if (!ok) return io.send(res, 400, { error: `invalid ${kind}` });
  const snap = session.snapshotResponse();
  io.send(res, 200, { ok: true, [kind]: kind === 'tier' ? snap.tier : snap.effort });
}


/** GET /session/:id/model(G10-C4 模型 pill 数据源):当前选择 + 可选清单(choices 空=不可切) */
export function handleSessionModelGet(io: SessionHandlerIo, res: http.ServerResponse, id: string): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const sw = session.modelSwitcher;
  if (sw === null) return io.send(res, 200, { current: undefined, choices: [], explicitDefault: false });
  // current 回退(SUNSHINEX_MODEL 显式档):切换器未选时 default 内芯即 env 模型——回其名供 GUI
  // pill 显示具体模型(Codex 同形),而非「默认模型」占位
  const envDefault = (process.env.SUNSHINEX_MODEL ?? '').trim();
  io.send(res, 200, {
    current: sw.currentId() ?? (envDefault !== '' ? envDefault : undefined),
    explicitDefault: sw.hasExplicitDefault(),
    choices: sw.choices().map((c) => ({ id: c.id, model: c.model, baseUrl: c.baseUrl, effort: c.reasoningEffort, contextWindow: c.contextWindow })),
  });
}

export async function handleSessionModel(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const body = parsed.body as { model?: unknown };
  if (body.model !== undefined && typeof body.model !== 'string') return io.send(res, 400, { error: 'invalid model' });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (session.modelSwitcher === null) return io.send(res, 409, { error: 'model not switchable' });
  if (!session.setModel(body.model === undefined ? undefined : (body.model === '' ? undefined : body.model))) {
    return io.send(res, 400, { error: 'unknown model' });
  }
  io.send(res, 200, { ok: true, model: session.snapshotResponse().model });
}


/** POST /session/:id/mode {mode}(G10-C1b):dontAsk/manual/plan;运行中 409 busy */
export async function handleSessionMode(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const mode = (parsed.body as { mode?: unknown }).mode;
  if (mode !== 'dontAsk' && mode !== 'manual' && mode !== 'plan') return io.send(res, 400, { error: 'invalid mode' });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (session.setMode(mode) === 'busy') return io.send(res, 409, { error: 'session is running' });
  io.send(res, 200, { ok: true, mode });
}


export function handleSnapshot(io: SessionHandlerIo, res: http.ServerResponse, id: string | undefined): void {
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const pending: SnapshotPendingRow[] = [...io.pending.entries()]
    .filter(([, entry]) => entry.sessionId === session.id)
    .map(([pid, entry]) => ({ pid, kind: entry.kind, req: entry.req }));
  io.send(res, 200, { ...session.snapshotResponse(), pending });
}

export async function handleBoardReview(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.body as { taskId?: unknown; approved?: unknown } | null;
  if (typeof body?.taskId !== 'string' || body.taskId.length === 0 || typeof body.approved !== 'boolean') {
    io.send(res, 400, { error: 'taskId must be a non-empty string and approved must be a boolean' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const r = session.runtime.harness.taskboard.review(body.taskId, { approved: body.approved });
  if (!r.ok) {
    io.send(res, 400, { error: r.error.message });
    return;
  }
  io.send(res, 200, { ok: true });
}

export async function handleAttach(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const journalId = (parsed.body as { journalId?: unknown } | null)?.journalId;
  if (typeof journalId !== 'string' || journalId.length === 0) {
    io.send(res, 400, { error: 'journalId must be a non-empty string' });
    return;
  }
  if (io.sessions.get(id) === undefined) {
    io.send(res, 404, { error: 'unknown session' });
    return;
  }
  const r = io.attach(id, journalId);
  if (!r.ok) {
    io.send(res, r.error.code === 'INVALID_STATE' ? 409 : 400, { error: r.error.message });
    return;
  }
  io.send(res, 200, { ok: true, sessionId: r.value.sessionId });
}
