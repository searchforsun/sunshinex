import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionRuntime } from './session';
import type { Result } from '../result';
import { parseAskAnswer, type DaemonFrame } from './daemon-wire';
import type { AskUserAnswer } from '../types';
import type { ModelAdapter } from '../model/adapter';
import { createKernelRuntime } from '../session/runtime';

/** sidecar 问询墙钟上限（fork/ask 旁车一次性调用，与主链长任务预算解耦） */
const FORK_ABORT_TIMEOUT_MS = 180_000;

/** 旧 /session/new 裸软重置的迁移提示（G3 裸端点兼容裁定：无 root 的旧语义让位 /session/:id/reset） */
const ROOT_REQUIRED_HINT = 'root required — the old soft-reset moved to /session/:id/reset';
import { branchFrom, listAnchors, parseJournalFile, readSessionMeta, sessionsDir, writeSessionMeta } from '../tui/session-journal';
import { runCommand } from './session-commands';
import { contextBreakdown } from '../harness/context';
import { resolveRunWindow } from '../config/termination-config';
import { resolveDataDir } from '../config/data-dir';
import { validSessionId } from './session-id';

/** 会话控制面 HTTP 处理器（D31 批2 拆分自 daemon.ts 类）：submit/interrupt/steer 族/reset/snapshot/
 *  anchors/tier/effort/model/mode/command/tasks/context/board-review/rename/title/attach——类状态
 *  触点收敛于 io（send/readJson/sessionFor 会话寻址 + sessions 表 + denyPendingFor/broadcastFrame/
 *  pending 挂起面 + model 标题摘要 + attach 挂载）；路由表零改动，行为零变化（daemon.test 为锚）。
 */

/** 会话 id 安全面:叶子 session-id.ts 单点(serve 域拆分后防 require 环),原路径再导出 */
export { validSessionId } from './session-id';

export interface SessionHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  sessionFor(res: http.ServerResponse, id: string | undefined): SessionRuntime | undefined;
  sessions: Map<string, SessionRuntime>;
  denyPendingFor(sessionId: string): void;
  broadcastFrame(frame: DaemonFrame): void;
  model: ModelAdapter;
  attach(id: string, journalId: string): Result<{ sessionId: string }>;
  createSession(root: string, opts?: { mode?: 'dontAsk' | 'manual' }): Result<{ sessionId: string }>;
  defaultScratchRoot(): string;
  /** 挂起回执路由（P6 §4：表在会话）——daemon 迭代会话表寻址,命中 false 即 404 */
  resolveApproval(pid: string, decision: 'allow' | 'always' | 'deny'): boolean;
  resolveAsk(pid: string, answer: AskUserAnswer): boolean;
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
    stableSegment: session.runtime.harness.stableSegment(),
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

/** GET /session/:id/shadow-events(G14.2xx b 影子投影水合面):journal shadow 行(board/delegation/
 *  subagent)原始事件全量按序 + cut=读档时刻泵水位。GUI 刷新/重连后会话打开时拉取清零重放——
 *  WS 环窗(512)对长会话子智能体流必溢出且连接建立常先于会话 attach,影子投影恢复的唯一可靠入口。
 *  客户端在途缓冲帧按 seq>cut 重放补齐(零丢帧零重复,见 SessionRuntime.shadowJournalEvents)。 */
export function handleShadowEvents(io: SessionHandlerIo, res: http.ServerResponse, id: string): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  io.send(res, 200, session.shadowJournalEvents());
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


/** POST /session/:id/steer/edit {seq,text}(P5 spec §12.2):队列条目内联改写;text 空白串 400
 *  (与 handleSteer 的 trim-忽略口径一致前置拒),越界 400(与 cancel/move 同形) */
export async function handleSteerEdit(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const body = (parsed.body ?? {}) as { seq?: unknown; text?: unknown };
  if (typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < 0) return io.send(res, 400, { error: 'invalid seq' });
  if (typeof body.text !== 'string' || body.text.trim() === '') return io.send(res, 400, { error: 'text must be a non-empty string' });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  if (!session.steerEdit(body.seq, body.text)) return io.send(res, 400, { error: 'no such queued entry' });
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
/** 应用级指针档/置顶档/GUI 面私有态三族:D42 端点族拆分至 app-state-handlers.ts(行搬运零变化)——
 *  原路径再导出,daemon 路由与消费面零迁移 */
export { handleAppPinsGet, handleAppPinsPut, handleAppSeenGet, handleAppSeenPut, handleAppGuiStateGet, handleAppGuiStatePut, handleGuiStateGet, handleGuiStatePut } from './app-state-handlers';

/** 会话列表面+归档族:D42 端点族拆分至 sessions-list-handlers.ts(行搬运零变化)——
 *  原路径再导出,daemon 路由与 daemon.gui-state.test 消费零迁移 */
export { handleSessionsRecent, handleSessions, liveSessionByJournal, findJournalOwner, handleSessionArchive, handleSessionsArchived } from './sessions-list-handlers';
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
  // P6 §4:挂起段由会话自产（表下沉后快照合并零过滤）
  io.send(res, 200, { ...session.snapshotResponse(), pending: session.pendingSnapshot() });
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

export async function handleSessionNew(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const rootRaw = (parsed.body as { root?: unknown } | null)?.root;
  if (typeof rootRaw !== 'string' || rootRaw.length === 0) {
    io.send(res, 400, { error: ROOT_REQUIRED_HINT });
    return;
  }
  let root: string = rootRaw;
  // default 工作区语义(G10 用户裁定 + G14.10 B 方案):root='default' = 非文件类任务与对话的
  // 缺省落点——锚定专用临时目录 <tmp>/sunshinex-default(用户裁定:临时任务的文件不再落仓库);
  // 目录缺场即建,注册表扫描自然纳入
  if (root === 'default') {
    root = io.defaultScratchRoot();
    const sunshine = path.join(root, 'SUNSHINE.md');
    if (!fs.existsSync(sunshine)) {
      fs.writeFileSync(sunshine, '# default\n\nDefault workspace for non-file tasks and conversations.\n', 'utf8');
    }
  }
  const mode = (parsed.body as { mode?: unknown } | null)?.mode;
  // G5 白名单收紧：undefined|'dontAsk'|'manual' 之外一律 400 恒定文案（此前静默按 dontAsk 装配——
  //  传 mode:'auto' 的客户端拿到的是 dontAsk 会话，审批行为与预期不符且无提示）
  if (mode !== undefined && mode !== 'manual' && mode !== 'dontAsk') {
    io.send(res, 400, { error: 'invalid mode' });
    return;
  }
  const r = io.createSession(root, mode === 'manual' ? { mode: 'manual' } : undefined);
  if (!r.ok) {
    io.send(res, 400, { error: r.error.message });
    return;
  }
  io.send(res, 200, { ok: true, sessionId: r.value.sessionId });
}

export async function handleApprovalReply(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const decision = (parsed.body as { decision?: unknown } | null)?.decision;
  if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
    io.send(res, 400, { error: 'decision must be one of: allow, always, deny' });
    return;
  }
  // P6 §4:回执路由到会话表(命中 false=未知 pid/kind 错配/已回执删除 → 404);notice 入转录在会话面
  if (!io.resolveApproval(pid, decision)) {
    io.send(res, 404, { error: 'unknown pending approval' });
    return;
  }
  io.send(res, 200, { ok: true });
}

export async function handleAskReply(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const answer = parseAskAnswer((parsed.body as { answer?: unknown } | null)?.answer);
  if (answer === null) {
    io.send(res, 400, { error: 'invalid answer: expected {type:"selected",labels} | {type:"custom",text} | {type:"dismissed"}' });
    return;
  }
  if (!io.resolveAsk(pid, answer)) {
    io.send(res, 404, { error: 'unknown pending ask' });
    return;
  }
  io.send(res, 200, { ok: true });
}

export async function handleSessionBtw(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  if (!validSessionId(id)) return io.send(res, 400, { error: 'invalid session id' });
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const question = (parsed.body as { question?: unknown }).question;
  if (typeof question !== 'string' || question.trim() === '') return io.send(res, 400, { error: 'invalid question' });
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const srcId = session.attachedJournalId;
  if (srcId === undefined) return io.send(res, 409, { error: 'no journaled session' });
  const dataDir = resolveDataDir(session.root);
  let forkId: string;
  try {
    const journal = parseJournalFile(path.join(sessionsDir(dataDir), srcId + '.jsonl'));
    forkId = branchFrom(dataDir, srcId, journal.lines.length, 'fork');
  } catch (err) {
    return io.send(res, 500, { error: 'fork failed: ' + String((err as Error).message) });
  }
  writeSessionMeta(dataDir, forkId, { side: true });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FORK_ABORT_TIMEOUT_MS);
  const rt = createKernelRuntime({ root: session.root, model: io.model, onEvent: () => {} });
  try {
    rt.harness.context.appendInstructionLine(question);
    const outcome = await rt.runTask(question, { signal: abort.signal });
    io.send(res, 200, { ok: true, reply: outcome?.reply ?? '', sessionId: forkId });
  } catch (err) {
    io.send(res, 503, { error: err instanceof Error ? err.message : String(err), sessionId: forkId });
  } finally {
    clearTimeout(timer);
    void rt.harness.mcpClose?.().catch(() => undefined);
  }
}

export async function handleBranch(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string, kind: 'rewind' | 'fork'): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const turn = (parsed.body as { turn?: unknown }).turn;
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) return io.send(res, 400, { error: 'invalid turn' });
  const side = (parsed.body as { side?: unknown }).side === true; // G14.29:辅助会话标记(列表滤除)
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  if (session.status() === 'running') return io.send(res, 409, { error: 'session is running' });
  const srcId = session.attachedJournalId;
  if (srcId === undefined) return io.send(res, 409, { error: 'no journaled session' });
  const dataDir = resolveDataDir(session.root);
  let cutLine: number;
  if (side) {
    // G14.29 辅助 fork:整档继承(上下文完整),turn 不参与寻址
    cutLine = parseJournalFile(path.join(sessionsDir(dataDir), srcId + '.jsonl')).lines.length;
  } else {
    const anchors = listAnchors(parseJournalFile(path.join(sessionsDir(dataDir), srcId + '.jsonl')));
    const anchor = anchors[turn - 1];
    if (anchor === undefined) return io.send(res, 400, { error: 'no such turn' });
    cutLine = anchor.line - 1; // 锚点行不进新档(规格 §5.2)
  }
  let newId: string;
  try {
    newId = branchFrom(dataDir, srcId, cutLine, kind);
  } catch (err) {
    return io.send(res, 500, { error: 'branch failed: ' + String((err as Error).message) });
  }
  if (kind === 'fork') {
    if (side) writeSessionMeta(dataDir, newId, { side: true });
    const created = io.createSession(session.root);
    if (!created.ok) return io.send(res, 500, { error: created.error.message });
    const ar = io.attach(created.value.sessionId, newId);
    if (!ar.ok) return io.send(res, 500, { error: ar.error.message });
    return io.send(res, 200, { ok: true, sessionId: created.value.sessionId, turn });
  }
  const rr = io.attach(id, newId);
  if (!rr.ok) return io.send(res, 500, { error: rr.error.message });
  io.send(res, 200, { ok: true, sessionId: id, turn });
}
