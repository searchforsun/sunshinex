import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRuntime } from './session';
import { validSessionId } from './session-id';
import type { SessionHandlerIo } from './session-handlers';
import { urlOf } from './daemon-wire';
import { listSessions, markSessionArchived, sessionsDir, type SessionSidecarMeta } from '../tui/session-journal';
import { projectsRoot, resolveDataDir, sunxContainerDir, sunxDomainDir } from '../config/data-dir';

/**
 * 会话列表面 + 归档族（D42 端点族拆分自 session-handlers.ts，行搬运零逻辑变化）：
 * RECENTS 默认锚点工作区行 / 按根会话列表 / 活跃反查 / journal 寻址 / 归档翻档与归档列表。
 * 消费方经 session-handlers 原路径再导出取用（daemon 路由与 daemon.gui-state.test 零迁移）。
 */

export function handleSessionsRecent(io: SessionHandlerIo, res: http.ServerResponse): void {
  type RecentRow = {
    id: string; updatedAt: number; firstUser?: string; root: string; slug: string;
  } & Partial<Pick<SessionSidecarMeta, 'title' | 'kind' | 'scheduled' | 'runs' | 'steps' | 'tokens' | 'seconds' | 'cacheTokens' | 'promptTokens' | 'childTokens' | 'ctxUsed' | 'ctxWindow' | 'model' | 'effort'>> & { createdAt?: string; liveSessionId?: string };
  const out: RecentRow[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    io.send(res, 200, out);
    return;
  }
  const liveByJournal = liveSessionByJournal(io.sessions); // G14.52:行附活跃会话 id(运行圆点直比)
  const awaiting = awaitingByJournal(io.sessions); // 2026-10-31:行附待确认标注(主菜单「?」图标)
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
        ...(r.kind !== undefined ? { kind: r.kind } : {}), // sunx 形态透出（2026-11-15 P1 Task 4,meta 读面）
        ...(r.scheduled === true ? { scheduled: true } : {}), // 定时任务执行会话(2026-11-21,侧栏时间左钟面标)
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
        ...(awaiting.has(r.id) ? { awaiting: true } : {}),
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
  const awaitingSet = awaitingByJournal(io.sessions); // 2026-10-31:待确认标注(主菜单「?」图标)
  // 行根现取(2026-11-13 用户实测「会话 hover 首显主工作区路径/分支,首轮结束才变树路径」根修):
  // 旁车 root 要 run 收尾才落(<journalId>.meta.json),建档后首轮前 sr.root 缺场=行回落主工作区
  // 根/分支。活会话 runtime 自建席起即持真根(树会话=worktree 路径),按 journalId 全量反查(不限
  // running——刚建未跑的会话正是本案);在座行优先现取,离座行走旁车(daemon 重启后 run 收尾已落)
  const runtimeByJournal = new Map<string, SessionRuntime>();
  for (const s of io.sessions.values()) {
    const jid = s.attachedJournalId;
    if (jid !== undefined) runtimeByJournal.set(jid, s);
  }
  const rows = listSessions(resolveDataDir(root)).filter((r) => r.archived !== true).map((r) => {
    const live = liveByJournal.get(r.id);
    const runtime = runtimeByJournal.get(r.id);
    const liveRoot = runtime?.root;
    const row = { ...r, ...(liveRoot !== undefined && liveRoot !== '' ? { root: liveRoot } : {}), ...(live !== undefined ? { liveSessionId: live } : {}) };
    return awaitingSet.has(r.id) ? { ...row, awaiting: true as const } : row;
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

/** GET /sunx/sessions（2026-11-15 sunx P3 Task 3 数据源改向）：扫 sunx 域容器
 *  （sunxContainerDir 单点——`~/.sunshinex/sunx/<jid>/data` 逐域 listSessions 归并）出行
 *  SessionRow 族（id=journalId/kind 恒 'sunx'——容器=纯 sunx 域，钉死不读 meta；root/title/
 *  firstUser 随档）+ daemon 注册表匹配补 liveSessionId（running）/awaiting（挂起非空）/status
 *  （在座即标，idle/running）。空容器（目录不存在/不可读）返回空列；行序 updatedAt 降序。
 *  行形收窄（2026-11-15 终审 Minor）：白名单字段族——剔 charterText 全文（负载膨胀+超集暴露）
 *  与其余旁车超集（file/forkedFrom/side 族/rewoundTo/charterRev/model/effort/tokens 细目）；
 *  保留 GUI 消费面（分组键 root/标签回退 firstUser/悬浮卡 runs·steps·createdAt）。
 *  归档行随列（2026-11-15 终审 Fix 4 可达性）：archived meta 行不再滤除，携 `archived: true`
 *  标记（GUI 归档入口过滤数据源=后续 GUI 迭代；unarchive/delete 端点对 sunx 域按 journalId
 *  寻址可达=findSunxJournalOwner 兜底）——旧滤除形态下归档 sunx 重启后两列表都不在=死态 */
export function handleSunxSessions(io: SessionHandlerIo, res: http.ServerResponse): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sunxContainerDir(), { withFileTypes: true });
  } catch {
    io.send(res, 200, []);
    return;
  }
  const liveByJournal = liveSessionByJournal(io.sessions);
  const awaitingSet = awaitingByJournal(io.sessions);
  const statusByJournal = new Map<string, string>();
  for (const s of io.sessions.values()) {
    const jid = s.attachedJournalId;
    if (jid !== undefined) statusByJournal.set(jid, s.status());
  }
  const out: Array<Record<string, unknown>> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(sunxContainerDir(), ent.name, 'data');
    for (const r of listSessions(dataDir)) {
      const live = liveByJournal.get(r.id);
      const status = statusByJournal.get(r.id);
      out.push({
        id: r.id,
        ...(r.title !== undefined ? { title: r.title } : {}),
        ...(r.firstUser !== undefined ? { firstUser: r.firstUser } : {}),
        ...(r.root !== undefined ? { root: r.root } : {}),
        kind: 'sunx', // 域容器恒 sunx（裁定：容器=纯 sunx 域；不读 meta，杂散目录不误标）
        updatedAt: r.updatedAt,
        ...(r.archived === true ? { archived: true as const } : {}), // 归档行随列（终审 Fix 4 可达性）
        ...(r.runs !== undefined ? { runs: r.runs } : {}),
        ...(r.steps !== undefined ? { steps: r.steps } : {}),
        ...(r.createdAt !== undefined ? { createdAt: r.createdAt } : {}),
        ...(live !== undefined ? { liveSessionId: live } : {}),
        ...(awaitingSet.has(r.id) ? { awaiting: true as const } : {}),
        ...(status !== undefined ? { status } : {}),
      });
    }
  }
  out.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
  io.send(res, 200, out);
}

/** 会话待确认标注(2026-10-31 主菜单「?」图标数据源):live 会话挂起表非空(approval/ask/
 *  plan-approval 任一未决)=运行中需要用户确认;journal 反查与 liveSessionByJournal 同构 */
function awaitingByJournal(sessions: Map<string, SessionRuntime>): Set<string> {
  const m = new Set<string>();
  for (const s of sessions.values()) {
    if (s.pendingSnapshot().length === 0) continue;
    const jid = s.attachedJournalId;
    if (jid !== undefined) m.add(jid);
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

/** journalId → sunx 域 dataDir（2026-11-15 终审 Fix 4 可达性兜底）：先按域键直查
 *  （sunxDomainDir(jid)——独占域形态），缺席扫容器各域（fork/rewind 子档落父域的领养形态——
 *  子 journalId ≠ 域键）；找到即返回所在域。archive/unarchive/delete 的 journalId 磁盘寻址
 *  与 projectsRoot 兜底串联（projects 区缺席才扫 sunx 容器——两区物理独立零歧义） */
export function findSunxJournalOwner(jid: string): string | undefined {
  const own = sunxDomainDir(jid);
  if (fs.existsSync(path.join(sessionsDir(own), `${jid}.jsonl`))) return own;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(sunxContainerDir(), { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(sunxContainerDir(), ent.name, 'data');
    if (fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`))) return dataDir;
  }
  return undefined;
}

/** POST /session/:id/archive {archived?}(2026-10-21 归档):双寻址——:id 命中 daemon 会话表走运行时
 *  路径(缺 journal 404),否则视作 journalId 走磁盘路径。运行中照常归档(2026-11-07 用户裁定:归档=
 *  切换显示位置,不停运行;删除仍要求先归档,其运行门禁在 delete 侧) */
export function handleSessionArchive(io: SessionHandlerIo, res: http.ServerResponse, id: string, body: { archived?: unknown }): void {
  const archived = body.archived !== false;
  let dataDir: string;
  let jid: string;
  const session = io.sessions.get(id);
  if (session !== undefined) {
    const attached = session.attachedJournalId;
    if (attached === undefined) return io.send(res, 404, { error: 'session has no journal' });
    jid = attached;
    dataDir = session.dataDir; // 域绑定寻址（P3 Task 2）：sunx 随域,standard=resolveDataDir 既有推导字节不变
  } else {
    if (!validSessionId(id)) return io.send(res, 400, { error: 'invalid session id' });
    // journalId 兜底双扫（终审 Fix 4）：projects 区缺席再扫 sunx 容器（归档 sunx 重启后不在座=
    // 两列表只剩 /sunx/sessions archived 行,unarchive/delete 按 journalId 必须可达=死态根修）
    const owner = findJournalOwner(projectsRoot(), id);
    const sunxDataDir = owner === undefined ? findSunxJournalOwner(id) : undefined;
    if (owner === undefined && sunxDataDir === undefined) return io.send(res, 404, { error: 'unknown session' });
    jid = id;
    dataDir = owner !== undefined ? owner.dataDir : sunxDataDir!;
  }
  markSessionArchived(dataDir, jid, archived);
  io.send(res, 200, { ok: true, archived });
}

/** GET /sessions/archived(归档页数据源):跨工作区扫描各 slug 的 archived 档,archivedAt 降序;
 *  行带 slug+root(来源项目标注)——不设 isDefaultWs 过滤(项目会话同样可归档) */
export function handleSessionsArchived(io: SessionHandlerIo, res: http.ServerResponse): void {
  type ArchivedRow = { id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number; liveSessionId?: string; awaiting?: true; kind?: string };
  const out: ArchivedRow[] = [];
  const liveByJournal = liveSessionByJournal(io.sessions); // 运行中可归档:行附运行/待确认标注(与 recent 同源)
  const awaitingSet = awaitingByJournal(io.sessions);
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
      const live = liveByJournal.get(r.id);
      out.push({
        id: r.id, slug: ent.name, root, ...(r.title !== undefined ? { title: r.title } : {}), updatedAt: r.updatedAt, archivedAt: r.archivedAt,
        ...(r.kind !== undefined ? { kind: r.kind } : {}), // sunx 形态透出（2026-11-15 sunx P2 Task 7,归档行徽标）
        ...(live !== undefined ? { liveSessionId: live } : {}),
        ...(awaitingSet.has(r.id) ? { awaiting: true as const } : {}),
      });
    }
  }
  out.sort((a, b) => b.archivedAt - a.archivedAt);
  io.send(res, 200, out);
}

/** dataDir 枚举帮手(2026-11-21 归档保留期/缓存面共用;D89 同构族的新成员自出生走本帮手,
 *  既有三组扫描不动):projectsRoot slug 枚举;目录不可读=空表 */
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

/** sunx 域枚举(容器缺席=空表;slug=域名) */
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
