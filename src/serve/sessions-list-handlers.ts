import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRuntime } from './session';
import { validSessionId } from './session-id';
import type { SessionHandlerIo } from './session-handlers';
import { urlOf } from './daemon-wire';
import { listSessions, markSessionArchived, sessionsDir, type SessionSidecarMeta } from '../tui/session-journal';
import { projectsRoot, resolveDataDir } from '../config/data-dir';

/**
 * 会话列表面 + 归档族（D42 端点族拆分自 session-handlers.ts，行搬运零逻辑变化）：
 * RECENTS 默认锚点工作区行 / 按根会话列表 / 活跃反查 / journal 寻址 / 归档翻档与归档列表。
 * 消费方经 session-handlers 原路径再导出取用（daemon 路由与 daemon.gui-state.test 零迁移）。
 */

export function handleSessionsRecent(io: SessionHandlerIo, res: http.ServerResponse): void {
  type RecentRow = {
    id: string; updatedAt: number; firstUser?: string; root: string; slug: string;
  } & Partial<Pick<SessionSidecarMeta, 'title' | 'runs' | 'steps' | 'tokens' | 'seconds' | 'cacheTokens' | 'promptTokens' | 'childTokens' | 'ctxUsed' | 'ctxWindow' | 'model' | 'effort'>> & { createdAt?: string; liveSessionId?: string };
  const out: RecentRow[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    io.send(res, 200, out);
    return;
  }
  const liveByJournal = liveSessionByJournal(io.sessions); // G14.52:行附活跃会话 id(运行圆点直比)
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(projectsRoot(), ent.name, 'data');
    let root: string | undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
      if (typeof raw?.root === 'string' && raw.root.length > 0) root = raw.root;
    } catch {
      root = undefined;
    }
    if (root === undefined) {
      // G14.96 历史档降级:workspace.json 缺失(TUI 时代档/落档失败)但 slug 含默认锚点名
      // → 视为默认工作区(root 回锚定路径,attach 可用),不再被过滤出 RECENTS;
      // 非默认命名维持跳过(项目会话归 PROJECTS 各组,组列表由 /workspaces 承载)
      if (!ent.name.includes('sunshinex-default')) continue;
      root = path.join(os.tmpdir(), 'sunshinex-default');
    }
    const isDefaultWs = (root: string): boolean => {
      const base = root.split(/[\\/]+/).filter(Boolean).pop() ?? '';
      return base === 'default' || base.startsWith('sunshinex-default');
    };
    for (const r of listSessions(dataDir)) {
      if (r.archived === true) continue; // 2026-10-21 归档滤除:归档会话退出 RECENTS
      if (!isDefaultWs(root)) continue; // G14.35:RECENTS 只收默认锚点工作区(非项目会话的家;项目会话归各组)
      out.push({
        id: r.id,
        updatedAt: r.updatedAt,
        ...(r.firstUser !== undefined ? { firstUser: r.firstUser } : {}),
        ...(r.title !== undefined ? { title: r.title } : {}),
        ...(r.runs !== undefined ? { runs: r.runs } : {}),
        ...(r.steps !== undefined ? { steps: r.steps } : {}),
        ...(r.tokens !== undefined ? { tokens: r.tokens } : {}),
        ...(r.seconds !== undefined ? { seconds: r.seconds } : {}),
        ...(r.cacheTokens !== undefined ? { cacheTokens: r.cacheTokens } : {}),
        ...(r.promptTokens !== undefined ? { promptTokens: r.promptTokens } : {}),
        ...(r.childTokens !== undefined ? { childTokens: r.childTokens } : {}),
        ...(r.ctxUsed !== undefined ? { ctxUsed: r.ctxUsed } : {}),
        ...(r.ctxWindow !== undefined ? { ctxWindow: r.ctxWindow } : {}),
        ...(r.model !== undefined ? { model: r.model } : {}),
        ...(r.effort !== undefined ? { effort: r.effort } : {}),
        ...(r.createdAt !== undefined ? { createdAt: r.createdAt } : {}),
        root,
        slug: ent.name,
        ...(liveByJournal.get(r.id) !== undefined ? { liveSessionId: liveByJournal.get(r.id) } : {}),
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  io.send(res, 200, out.slice(0, 20));
}

export function handleSessions(io: SessionHandlerIo, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = urlOf(req);
  const root = url.searchParams.get('root');
  if (root === null || root.length === 0) {
    io.send(res, 400, { error: 'root query param required' });
    return;
  }
  // G14.52:行附 liveSessionId(journal ↔ 活跃会话反查)——GUI 侧栏行运行圆点直比会话 id,
  // 不再依赖 attach 时的本地映射(新建会话首条 append 前无 journal id,映射缺位圆点不亮)
  const liveByJournal = liveSessionByJournal(io.sessions);
  const rows = listSessions(resolveDataDir(root)).filter((r) => r.archived !== true).map((r) => {
    const live = liveByJournal.get(r.id);
    return live !== undefined ? { ...r, liveSessionId: live } : r;
  });
  io.send(res, 200, rows);
}

export function liveSessionByJournal(sessions: Map<string, SessionRuntime>): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of sessions.values()) {
    if (s.status() !== 'running') continue;
    const jid = s.attachedJournalId;
    if (jid !== undefined) m.set(jid, s.id);
  }
  return m;
}

/** journalId → {dataDir, slug}(跨工作区扫描;archive/delete 的 journal 寻址与归档列表共用) */
export function findJournalOwner(root: string, jid: string): { dataDir: string; slug: string } | undefined {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(root, ent.name, 'data');
    if (fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`))) return { dataDir, slug: ent.name };
  }
  return undefined;
}

/** POST /session/:id/archive {archived?}(2026-10-21 归档):双寻址——:id 命中 daemon 会话表走运行时
 *  路径(缺 journal 404),否则视作 journalId 走磁盘路径;running 一律 409(先停再归档,与 delete 同门禁) */
export function handleSessionArchive(io: SessionHandlerIo, res: http.ServerResponse, id: string, body: { archived?: unknown }): void {
  const archived = body.archived !== false;
  const liveByJournal = liveSessionByJournal(io.sessions);
  let dataDir: string;
  let jid: string;
  const session = io.sessions.get(id);
  if (session !== undefined) {
    if (session.status() === 'running') return io.send(res, 409, { error: 'cannot archive while a run is in progress' });
    const attached = session.attachedJournalId;
    if (attached === undefined) return io.send(res, 404, { error: 'session has no journal' });
    jid = attached;
    dataDir = resolveDataDir(session.root);
  } else {
    if (!validSessionId(id)) return io.send(res, 400, { error: 'invalid session id' });
    const owner = findJournalOwner(projectsRoot(), id);
    if (owner === undefined) return io.send(res, 404, { error: 'unknown session' });
    jid = id;
    dataDir = owner.dataDir;
  }
  if (liveByJournal.get(jid) !== undefined) return io.send(res, 409, { error: 'cannot archive while a run is in progress' });
  markSessionArchived(dataDir, jid, archived);
  io.send(res, 200, { ok: true, archived });
}

/** GET /sessions/archived(归档页数据源):跨工作区扫描各 slug 的 archived 档,archivedAt 降序;
 *  行带 slug+root(来源项目标注)——不设 isDefaultWs 过滤(项目会话同样可归档) */
export function handleSessionsArchived(io: SessionHandlerIo, res: http.ServerResponse): void {
  type ArchivedRow = { id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number };
  const out: ArchivedRow[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    io.send(res, 200, out);
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(projectsRoot(), ent.name, 'data');
    let root = '';
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
      if (typeof raw?.root === 'string' && raw.root.length > 0) root = raw.root;
    } catch {
      root = '';
    }
    for (const r of listSessions(dataDir)) {
      if (r.archived !== true || r.archivedAt === undefined) continue;
      out.push({ id: r.id, slug: ent.name, root, ...(r.title !== undefined ? { title: r.title } : {}), updatedAt: r.updatedAt, archivedAt: r.archivedAt });
    }
  }
  out.sort((a, b) => b.archivedAt - a.archivedAt);
  io.send(res, 200, out);
}
