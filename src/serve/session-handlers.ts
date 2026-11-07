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
import { branchFrom, copySessionStores, forkIncludeCut, journalDisplayTitle, listAnchors, parseJournalFile, pruneSideForkArchive, readSessionMeta, rewindCutOfTurn, rewindCutOfUser, rewindSessionStores, sessionsDir, writeSessionMeta, type RewindCut } from '../tui/session-journal';
import { repointPin } from './app-state-handlers';
import { t } from '../i18n';
import { applyRestorePlan, collectRestorePlan } from '../tui/session-snapshots';
import { runCommand } from './session-commands';
import { contextBreakdown } from '../harness/context';
import { resolveRunWindow } from '../config/termination-config';
import { resolveDataDir } from '../config/data-dir';
import { validSessionId } from './session-id';
import { abortLedger, stopBoardTask } from '../harness/tools/task-stop';

/** 会话控制面 HTTP 处理器（D31 批2 拆分自 daemon.ts 类）：submit/interrupt/steer 族/reset/snapshot/
 *  anchors/tier/effort/model/mode/command/tasks/context/board-stop/rename/title/attach——类状态
 *  触点收敛于 io（send/readJson/sessionFor 会话寻址 + sessions 表 + denyPendingFor/broadcastFrame/
 *  pending 挂起面 + model 标题摘要 + attach 挂载）；路由表零改动，行为零变化（daemon.test 为锚）。
 */

/** 会话 id 安全面:叶子 session-id.ts 单点(serve 域拆分后防 require 环),原路径再导出 */
export { validSessionId } from './session-id';

export interface SessionHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  /** cap=body 字节上限（缺省 1MB）；submit/steer 携图请求传 MAX_IMAGE_BODY_BYTES */
  readJson(req: http.IncomingMessage, cap?: number): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  sessionFor(res: http.ServerResponse, id: string | undefined): SessionRuntime | undefined;
  sessions: Map<string, SessionRuntime>;
  denyPendingFor(sessionId: string): void;
  broadcastFrame(frame: DaemonFrame): void;
  model: ModelAdapter;
  attach(id: string, journalId: string): Result<{ sessionId: string }>;
  createSession(root: string, opts?: { mode?: 'full-access' | 'acceptEdits' }): Result<{ sessionId: string }>;
  defaultScratchRoot(): string;
  /** 挂起回执路由（P6 §4：表在会话）——daemon 迭代会话表寻址,命中 false 即 404 */
  resolveApproval(pid: string, decision: 'allow' | 'always' | 'deny'): boolean;
  resolveAsk(pid: string, answer: AskUserAnswer): boolean;
  /** plan 审批回执路由（阶段三 spec §5.1,沿既有审批路由同形）：decision={approved,feedback?} */
  resolvePlanApproval(pid: string, decision: { approved: boolean; feedback?: string }): boolean;
}

/** 图片附件常量/校验单源在 src/images.ts（serve HTTP 面与 TUI 剪贴板面共用；本件只作消费方） */
import { parseImagesParam } from '../images';

/** submit/steer 携图请求的 body 上限：8 张 × 单张上限 × JSON 转义余量 */
export const MAX_IMAGE_BODY_BYTES = 32 * 1024 * 1024;

export async function handleSubmit(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
  const parsed = await io.readJson(req, MAX_IMAGE_BODY_BYTES);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = (parsed.body ?? {}) as { goal?: unknown; images?: unknown };
  const goal = body.goal;
  const imgs = parseImagesParam(body.images);
  if (!imgs.ok) {
    io.send(res, 400, { error: imgs.error });
    return;
  }
  if (typeof goal !== 'string' || (goal.length === 0 && imgs.images === undefined)) {
    io.send(res, 400, { error: 'goal must be a non-empty string' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const r = session.submit(goal, imgs.images);
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
  const parsed = await io.readJson(req, MAX_IMAGE_BODY_BYTES);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = (parsed.body ?? {}) as { text?: unknown; images?: unknown };
  const text = body.text;
  const imgs = parseImagesParam(body.images);
  if (!imgs.ok) {
    io.send(res, 400, { error: imgs.error });
    return;
  }
  if (typeof text !== 'string' || (text.trim().length === 0 && imgs.images === undefined)) {
    io.send(res, 400, { error: 'text must be a non-empty string' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  session.steer(text, imgs.images);
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
/** 任务输出尾读（2026-10-24 后台任务面结果区）：末 4KB 有界读，头截断标 outputTruncated——
 *  账本输出流式落 <dataDir>/tasks/<id>.log，结果(如果有)随 /tasks 行内联回（任务量小,逐行
 *  尾读成本可控）;读失败(竞态删除/权限)缺字段,GUI 结果区即不示 */
const TASK_TAIL_BYTES = 4096;
function taskOutputTail(file: string): { outputTail: string; outputTruncated?: boolean } {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return { outputTail: '' };
    const start = Math.max(0, st.size - TASK_TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return { outputTail: buf.toString('utf8'), ...(start > 0 ? { outputTruncated: true } : {}) };
  } catch {
    // 任务日志缺场（running 早期/已被清理）或读失败：尾读尽力而为，空尾不炸 /tasks 列表
    return { outputTail: '' };
  }
}

export function handleSessionTasks(io: SessionHandlerIo, res: http.ServerResponse, id: string): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  // 板任务派发登记(boardDispatch)不进 GUI 后台任务面(2026-11-03 用户裁定):团队任务归任务板呈现,
  // 此处只剩 exec / 后台 spawn(subagent);等待面(task_wait/agent_team_task_wait)仍见全量账本
  const rows = session.runtime.harness.tasks.list()
    .filter((t2) => t2.boardDispatch !== true)
    .map((t2) => ({
    id: t2.id,
    kind: t2.kind,
    label: t2.label,
    ...(t2.title !== undefined ? { title: t2.title } : {}),
    status: t2.status,
    startedAt: t2.startedAt,
    ...(t2.endedAt !== undefined ? { endedAt: t2.endedAt } : {}),
    ...(t2.exitCode !== undefined ? { exitCode: t2.exitCode } : {}),
    ...taskOutputTail(t2.outputFilePath),
  }));
  io.send(res, 200, rows);
}

/** POST /session/:id/tasks/stop（2026-11-02 用户裁定「暂停就是复用 task_stop」）：body {id: taskId}；
 *  经 resolveId 归一（task_wait 同款）。停止语义=abortLedger（exec 杀进程树/subagent 打断线），终态落
 *  'stopped'，task_wait 等待面自然收敛。404=会话/任务未知；已终态幂等回执 200 */
export function handleTaskStop(io: SessionHandlerIo, res: http.ServerResponse, id: string, taskId: string): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const tid = session.runtime.harness.tasks.resolveId(taskId);
  const t = session.runtime.harness.tasks.get(tid);
  if (t === undefined) return io.send(res, 404, { error: 'unknown task' });
  if (t.status !== 'running') {
    return io.send(res, 200, { id: t.id, status: t.status, receipt: `task ${t.id} already finished with status ${t.status}` });
  }
  abortLedger(session.runtime.harness.tasks, t);
  io.send(res, 200, { id: t.id, status: session.runtime.harness.tasks.get(tid)?.status ?? 'stopped' });
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
    agents: parts.agents,
    teams: parts.teams,
    memory: parts.memory,
    compacted: ctx.compactedView(),
    chain: ctx.chainView(),
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

/** 回退点后仍在运行的执行体停掉(2026-11-06 严格回退):其记录已被裁出新档,留着即不可见的
 *  孤儿进程。后台任务(exec/直发 spawn)走 abortLedger;板任务走 stopBoardTask(pending 取消/
 *  running 中止台账);活成员走 team.stop(成员台账行已随 createdAt 裁出)。执行体停止事件落在
 *  旧会话对象投影上(旧档不在列表),新会话零污染 */
function stopAfterCutoff(session: SessionRuntime, cutoff: number | undefined): void {
  if (cutoff === undefined) return;
  const h = session.runtime.harness;
  for (const t of h.tasks.list()) {
    if (t.status !== 'running' || t.startedAt < cutoff || t.boardDispatch === true) continue;
    abortLedger(h.tasks, t);
  }
  const board = h.taskboard;
  for (const task of Object.values(board.snapshot().tasks)) {
    if (task.createdAt < cutoff || (task.status !== 'pending' && task.status !== 'running')) continue;
    const stopped = stopBoardTask(board, h.tasks, task.id);
    if (stopped !== undefined && !stopped.ok) console.warn(`[serve] rewind stop board task ${task.id}: ${stopped.error.message}`);
  }
  for (const name of h.team.aliveNames()) h.team.stop(name); // 名册行已随 createdAt 裁出,成员只停进程
}

/** rewind 寻址两形:userFromEnd=用户消息倒序序号(编辑重发),turn=任务轮锚点(回到此轮菜单) */
export type RewindTarget = { turn: number } | { userFromEnd: number };

function resolveRewindCut(jrnl: ReturnType<typeof parseJournalFile>, target: RewindTarget): RewindCut | undefined {
  return 'turn' in target ? rewindCutOfTurn(jrnl, target.turn) : rewindCutOfUser(jrnl, target.userFromEnd);
}

/** GET /session/:id/restore-plan?turn=N|userFromEnd=N(二次确认弹窗):该点之后的文件回退清单,只读;
 *  实际回退在 rewind 携 restoreFiles 时应用 */
export function handleRestorePlan(io: SessionHandlerIo, res: http.ServerResponse, id: string, target: RewindTarget): void {
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  const srcId = session.attachedJournalId;
  if (srcId === undefined) return io.send(res, 409, { error: 'no journaled session' });
  const srcFile = path.join(sessionsDir(resolveDataDir(session.root)), srcId + '.jsonl');
  const cut = resolveRewindCut(parseJournalFile(srcFile), target);
  if (cut === undefined) return io.send(res, 400, { error: 'no such turn' });
  const files = collectRestorePlan(srcFile, cut.cut + 1).map((f) => ({ path: f.path, deleted: f.deleted === true }));
  io.send(res, 200, { files });
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
  if (sw === null) return io.send(res, 200, { current: undefined, choices: [] });
  // current 回退(SUNSHINEX_MODEL env 直导出档):切换器未选时 default 内芯即 env 模型——回其名供 GUI
  // pill 显示具体模型(Codex 同形),而非「默认模型」占位。explicitDefault 字段已退役
  // (2026-10-28 spec §15:providers 唯一事实源,装配方恒切 choices[0],响应不再携带该位)
  const envDefault = (process.env.SUNSHINEX_MODEL ?? '').trim();
  io.send(res, 200, {
    current: sw.currentId() ?? (envDefault !== '' ? envDefault : undefined),
    choices: sw.choices().map((c) => ({ id: c.id, model: c.model, baseUrl: c.baseUrl, effort: c.reasoningEffort, contextWindow: c.contextWindow, supportsImages: c.supportsImages })),
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


/** POST /session/:id/mode {mode}(G10-C1b,spec §3.2):read-only/acceptEdits/full-access 三权限档+plan 流程标记(阶段三 plan-arm);运行中 409 busy */
export async function handleSessionMode(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const mode = (parsed.body as { mode?: unknown }).mode;
  if (mode !== 'read-only' && mode !== 'acceptEdits' && mode !== 'full-access' && mode !== 'plan') return io.send(res, 400, { error: 'invalid mode' });
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  // setMode 异步化(终审修复:disarm 收口——切离 plan 先中止在途流程再实切)后本端点 await 等其落定,
  // 409 busy 面语义不变;disarm 收束窗口内被并发 run 抢跑同样归 busy
  if ((await session.setMode(mode)) === 'busy') return io.send(res, 409, { error: 'session is running' });
  io.send(res, 200, { ok: true, mode });
}


/** POST /session/:id/board/stop {taskId}：与 agent_team_task_stop 板分支同语义——pending|running → cancelled，running 再 abort 台账。 */
export async function handleBoardStop(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const taskId = (parsed.body as { taskId?: unknown } | null)?.taskId;
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    io.send(res, 400, { error: 'taskId must be a non-empty string' });
    return;
  }
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  const raw = taskId.trim();
  const stopped = stopBoardTask(session.runtime.harness.taskboard, session.runtime.harness.tasks, raw);
  if (stopped === undefined) {
    io.send(res, 400, { error: `unknown task: ${raw}` });
    return;
  }
  if (!stopped.ok) {
    io.send(res, 400, { error: stopped.error.message });
    return;
  }
  // 物理板终态幂等时无事件——影子板可能仍是打开态(重启孤儿);强制同步 cancelled
  session.syncBoardStopToShadow(stopped.value.taskId);
  io.send(res, 200, { ok: true });
}

export function handleSnapshot(io: SessionHandlerIo, res: http.ServerResponse, id: string | undefined, page?: import('../serve/session').SessionSnapshotPage): void {
  const session = io.sessionFor(res, id);
  if (session === undefined) return;
  // P6 §4:挂起段由会话自产（表下沉后快照合并零过滤）;2026-10-26 三期:page 透传分页(缺省尾窗 200)
  io.send(res, 200, { ...session.snapshotResponse(page), pending: session.pendingSnapshot() });
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
  // G5 白名单收紧：undefined|'full-access'|'acceptEdits' 之外一律 400 恒定文案（此前静默按 full-access 装配——
  //  传 mode:'auto' 的客户端拿到的是 full-access 会话，审批行为与预期不符且无提示；旧值 manual/dontAsk 随全链改名退役）
  if (mode !== undefined && mode !== 'acceptEdits' && mode !== 'full-access') {
    io.send(res, 400, { error: 'invalid mode' });
    return;
  }
  const r = io.createSession(root, mode === 'acceptEdits' ? { mode: 'acceptEdits' } : undefined);
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

/** POST /plan-approval/:pid {approved,mode?,feedback?}（阶段三 plan-arm,spec §5.1;2026-11-03 修订
 *  批准卡三选）：planFlow 裁决回执——沿既有审批路由同形：approved 必布尔（400）、mode 可选且仅
 *  acceptEdits|full-access（400,缺省 acceptEdits 由 plan-flow 兜底）、feedback 可选非空字符串（400;
 *  无 feedback 的 approved:false=放弃本轮,空反馈不 400——GUI 重新计划空框即此形态）;命中且 kind 对
 *  resolve+notice（会话面）+200;未知 pid/已决（重复回执）/kind 错配（plan 卡错打 approval 端点等）
 *  统一 404 */
export async function handlePlanApprovalReply(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) {
    io.send(res, parsed.status, { error: parsed.error });
    return;
  }
  const body = (parsed.body ?? {}) as { approved?: unknown; mode?: unknown; feedback?: unknown };
  if (typeof body.approved !== 'boolean') {
    io.send(res, 400, { error: 'approved must be a boolean' });
    return;
  }
  if (body.mode !== undefined && body.mode !== 'acceptEdits' && body.mode !== 'full-access') {
    io.send(res, 400, { error: "mode must be 'acceptEdits' or 'full-access' when present" });
    return;
  }
  if (body.feedback !== undefined && (typeof body.feedback !== 'string' || body.feedback.trim().length === 0)) {
    io.send(res, 400, { error: 'feedback must be a non-empty string when present' });
    return;
  }
  const decision = {
    approved: body.approved,
    ...(body.mode === 'acceptEdits' || body.mode === 'full-access' ? { mode: body.mode as 'acceptEdits' | 'full-access' } : {}),
    ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
  };
  // P6 §4:回执路由到会话表(命中 false=未知 pid/kind 错配/已回执删除 → 404);notice 入转录在会话面
  if (!io.resolvePlanApproval(pid, decision)) {
    io.send(res, 404, { error: 'unknown pending plan approval' });
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

/** 辅助对话下一编号:扫父档名下 side 档取最大 N+1。2026-11-06 根修——原为父档 meta sideCount
 *  计数,该键随父会话换档(rewind/fork 产新 journal)丢失=序号重置重名(实测「辅助对话 4/5」与盘上
 *  「辅助对话 1」并存);盘面派生对换档与计数丢失免疫(sideCount 停写,存量档不再读)。
 *  2026-11-07:序号落辅助档自身 meta 的显式 sideSeq 数字键(建档时随批写)——标题改文案/多语言不再
 *  静默重号(标题仅展示);存量档无此键回退标题正则(兼容面,随存量自然消亡) */
export function nextSideSeq(dataDir: string, srcId: string): number {
  let seq = 0;
  try {
    for (const name of fs.readdirSync(sessionsDir(dataDir))) {
      if (!name.endsWith('.meta.json')) continue;
      const m = readSessionMeta(dataDir, name.slice(0, -'.meta.json'.length));
      if (m.side !== true || m.sideOf !== srcId) continue;
      if (typeof m.sideSeq === 'number' && Number.isInteger(m.sideSeq)) {
        seq = Math.max(seq, m.sideSeq);
        continue;
      }
      const hit = /^(?:辅助对话|Side chat)\s+(\d+)$/.exec(m.title ?? '');
      if (hit !== null) seq = Math.max(seq, Number(hit[1]));
    }
  } catch {
    /* 目录缺席=首个辅助对话 */
  }
  return seq + 1;
}

export async function handleBranch(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string, kind: 'rewind' | 'fork'): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const body = parsed.body as { turn?: unknown; userFromEnd?: unknown; side?: unknown; restoreFiles?: unknown };
  const turn = body.turn;
  const userFromEnd = kind === 'rewind' && typeof body.userFromEnd === 'number' && Number.isInteger(body.userFromEnd) && body.userFromEnd >= 0 ? body.userFromEnd : undefined;
  if (userFromEnd === undefined && (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1)) return io.send(res, 400, { error: 'invalid turn' });
  const side = body.side === true; // G14.29:辅助会话标记(列表滤除)
  // 同时回退文件(被丢弃段的写改动按 snapshots 行 pre-image 回退);fork 是平行新会话,不动工作区
  const restoreFiles = body.restoreFiles === true && kind === 'rewind';
  const session = io.sessions.get(id);
  if (session === undefined) return io.send(res, 404, { error: 'unknown session' });
  // 2026-11-04 用户裁定「辅助会话=观察主对话当前状态,运行中也能 fork」:side fork 放行——
  // journal 追加写、fork 只读复制已落盘行,与运行中的源会话互不干扰;普通 rewind/fork 仍拦
  if (session.status() === 'running' && !side) return io.send(res, 409, { error: 'session is running' });
  const srcId = session.attachedJournalId;
  if (srcId === undefined) return io.send(res, 409, { error: 'no journaled session' });
  const dataDir = resolveDataDir(session.root);
  const srcFile = path.join(sessionsDir(dataDir), srcId + '.jsonl');
  const jrnl = parseJournalFile(srcFile);
  let cutLine: number;
  let rewind: RewindCut | undefined;
  if (side) {
    // G14.29 辅助 fork:整档继承(上下文完整),turn 不参与寻址
    cutLine = jrnl.lines.length;
  } else if (kind === 'rewind') {
    rewind = resolveRewindCut(jrnl, userFromEnd !== undefined ? { userFromEnd } : { turn: turn as number });
    if (rewind === undefined) return io.send(res, 400, { error: 'no such turn' });
    cutLine = rewind.cut;
  } else {
    const anchors = listAnchors(jrnl);
    if (anchors[(turn as number) - 1] === undefined) return io.send(res, 400, { error: 'no such turn' });
    // fork=含点击轮整轮(2026-11-04 用户裁定「点哪轮 fork 其上全部」实测修订:旧切点在点击轮
    // 锚点前=点击轮内容不进子档+下轮 user 段行悬挂)
    cutLine = forkIncludeCut(jrnl, anchors, turn as number);
  }
  // 文件回退计划以分支前源档收集(规格 §6.2 同 TUI;切点之后=被丢弃段的写改动)
  const restorePlan = restoreFiles ? collectRestorePlan(srcFile, cutLine + 1) : undefined;
  let newId: string;
  try {
    newId = branchFrom(dataDir, srcId, cutLine, kind, kind === 'rewind' ? { inheritLineage: true } : undefined);
  } catch (err) {
    return io.send(res, 500, { error: 'branch failed: ' + String((err as Error).message) });
  }
  if (kind === 'fork') {
    copySessionStores(dataDir, srcId, newId); // 会话级静态存储随 fork 克隆(账本/团队面/辅助档;attach 收养前落位)
    if (side) {
      // 2026-10-31 用户裁定「辅助对话持久化可见+编号」:辅助档题=辅助对话 N、sideOf 回指父档
      // (重进主会话可列其辅助对话)
      const seq = nextSideSeq(dataDir, srcId);
      writeSessionMeta(dataDir, newId, { side: true, title: `辅助对话 ${seq}`, sideSeq: seq, sideOf: srcId });
      pruneSideForkArchive(dataDir, newId);
    } else {
      // fork 子档题=`Fork of 父显示题`(2026-11-04 用户裁定:前缀显性化,递归 fork 自然链名——
      // 父档已带前缀即 Fork of Fork of …)。父显示题经 journalDisplayTitle 单点(meta 题/首条
      // 输入摘要/源 root 名兜底),落 meta 后 /sessions 列表与标题面即显
      writeSessionMeta(dataDir, newId, { title: `Fork of ${journalDisplayTitle(dataDir, srcId, path.basename(session.root))}` });
    }
  } else {
    rewindSessionStores(dataDir, srcId, newId, rewind?.ts); // 静态存储随档迁移+严格裁到回退点(attach 收养前落位)
    // 未题名会话的列表名取自首条输入,回退后沿用;回退到首条之前则无可沿用,留待新输入
    const keptUser = jrnl.events.slice(0, cutLine).some((e) => e.t === 'seg' && e.kind === 'user');
    if (keptUser && readSessionMeta(dataDir, newId).title === undefined) {
      writeSessionMeta(dataDir, newId, { title: journalDisplayTitle(dataDir, srcId, path.basename(session.root)) });
    }
  }
  // rewind 同样挂新会话对象而非原地换档:attach 只支持 idle 新会话(双挂守卫拒绝已有实质档的会话),
  // 板/委派/待办等内存投影按增量折叠,同对象重挂会叠旧态;GUI 按返回的 sessionId 换座,等同 fork
  const created = io.createSession(session.root);
  if (!created.ok) return io.send(res, 500, { error: created.error.message });
  const ar = io.attach(created.value.sessionId, newId);
  if (!ar.ok) return io.send(res, 500, { error: ar.error.message });
  if (rewind === undefined) return io.send(res, 200, { ok: true, sessionId: created.value.sessionId, turn });
  stopAfterCutoff(session, rewind.ts); // 回退点后启动的运行中进程属旧会话对象(裁掉记录即不可见),一并停掉
  writeSessionMeta(dataDir, srcId, { rewoundTo: newId });
  repointPin(srcId, newId);
  let restore: { restored: string[]; removed: string[]; skipped: string[] } | undefined;
  if (restorePlan !== undefined) {
    restore = applyRestorePlan(session.root, restorePlan, path.join(sessionsDir(dataDir), '_blobs'));
    const { restored, removed, skipped } = restore;
    io.sessions.get(created.value.sessionId)?.pump({
      type: 'notice',
      text: t(`Files rewound (${restored.length} restored, ${removed.length} removed, ${skipped.length} skipped)`, `文件已回退(恢复 ${restored.length}、删除 ${removed.length}、跳过 ${skipped.length})`),
      ts: Date.now(),
    });
  }
  io.send(res, 200, {
    ok: true,
    sessionId: created.value.sessionId,
    journalId: newId,
    text: rewind.text,
    ...(rewind.ts !== undefined ? { atTs: rewind.ts } : {}),
    ...(restore !== undefined ? { restore } : {}),
  });
}
