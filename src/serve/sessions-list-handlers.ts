import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { SessionRuntime } from './session';
import { validSessionId } from './session-id';
import { defaultScratchRootPath, isDefaultWorkspaceSlug } from './session-lifecycle';
import type { SessionHandlerIo } from './session-handlers';
import { urlOf } from './daemon-wire';
import { listSessions, markSessionArchived, sessionsDir, type SessionSidecarMeta } from '../tui/session-journal';
import { projectsRoot, resolveDataDir, sunxContainerDir, sunxDomainDir, channelsContainerDir } from '../config/data-dir';

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
  const liveByJournal = liveSessionByJournal(io.sessions); // G14.52:行附活跃会话 id(运行圆点直比)
  const awaiting = awaitingByJournal(io.sessions); // 2026-10-31:行附待确认标注(主菜单「?」图标)
  // projects 区扫描脚手架走 forEachProjectSlug 单点（D89②）；root 语义本面自裁——
  // G14.96 历史档降级:workspace.json 缺失(TUI 时代档/落档失败)但 slug 含默认锚点名
  // → 视为默认工作区(root 回锚定路径,attach 可用),不再被过滤出 RECENTS;
  // 非默认命名 undefined=跳过(项目会话归 PROJECTS 各组,组列表由 /workspaces 承载)
  forEachProjectSlug(
    (slug, raw) => (raw !== undefined ? raw : isDefaultWorkspaceSlug(slug) ? defaultScratchRootPath() : undefined),
    (slug, dataDir, root) => {
      for (const r of listSessions(dataDir)) {
        if (r.archived === true) continue; // 2026-10-21 归档滤除:归档会话退出 RECENTS
        // G14.35:RECENTS 只收默认锚点工作区(非项目会话的家;项目会话归各组)——判定走单点(D90)
        if (!isDefaultWorkspaceSlug(root.split(/[\\/]+/).filter(Boolean).pop() ?? '')) continue;
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
          slug,
          ...(liveByJournal.get(r.id) !== undefined ? { liveSessionId: liveByJournal.get(r.id) } : {}),
          ...(awaiting.has(r.id) ? { awaiting: true } : {}),
        });
      }
    },
  );
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
  const runtimeByJournal = byJournal(io.sessions, () => true, (s) => s);
  const rows = listSessions(resolveDataDir(root)).filter((r) => r.archived !== true).map((r) => {
    const live = liveByJournal.get(r.id);
    const runtime = runtimeByJournal.get(r.id);
    const liveRoot = runtime?.root;
    const row = { ...r, ...(liveRoot !== undefined && liveRoot !== '' ? { root: liveRoot } : {}), ...(live !== undefined ? { liveSessionId: live } : {}) };
    return awaitingSet.has(r.id) ? { ...row, awaiting: true as const } : row;
  });
  io.send(res, 200, rows);
}

/** journalId 反查索引共享底座（D89③收敛：liveSessionByJournal/awaitingByJournal/runtimeByJournal/
 *  statusByJournal 四写同构「遍历在座表、按 attachedJournalId 键，仅谓词/值形漂移」）——
 *  predicate 过滤在座会话，value 取每会话载荷；无 attachedJournalId（未建档）不入索引 */
function byJournal<T>(sessions: Map<string, SessionRuntime>, predicate: (s: SessionRuntime) => boolean, value: (s: SessionRuntime) => T): Map<string, T> {
  const m = new Map<string, T>();
  for (const s of sessions.values()) {
    if (!predicate(s)) continue;
    const jid = s.attachedJournalId;
    if (jid !== undefined) m.set(jid, value(s));
  }
  return m;
}

export function liveSessionByJournal(sessions: Map<string, SessionRuntime>): Map<string, string> {
  return byJournal(sessions, (s) => s.status() === 'running', (s) => s.id);
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
  const out = enumerateContainerSessions({
    containerDir: sunxContainerDir(),
    kind: 'sunx',
    sessions: io.sessions,
    domainColumns: (r) => (r.root !== undefined ? { root: r.root } : {}), // root=journal 行 root（随档）
  });
  io.send(res, 200, out);
}

/** 会话待确认标注(2026-10-31 主菜单「?」图标数据源):live 会话挂起表非空(approval/ask/
 *  plan-approval 任一未决)=运行中需要用户确认;journal 反查走 byJournal 底座（D89③）。
 *  导出单点：serve/channels/handlers 通道域会话枚举共用（原 handlers 内同构副本已收编） */
export function awaitingByJournal(sessions: Map<string, SessionRuntime>): Set<string> {
  return new Set(byJournal(sessions, (s) => s.pendingSnapshot().length > 0, () => true).keys());
}

/** 容器域会话行枚举共享助法（D109 收敛：handleSunxSessions/handleChannelsSessions 原两份镜像
 *  ——「容器 readdir→逐域 <域>/data listSessions 归并→行形白名单→在座三标注→updatedAt 降序」
 *  骨架单点）。白名单族=GUI 消费面（id/title/firstUser/updatedAt/archived/runs/steps/createdAt
 *  + liveSessionId/awaiting/status 在座标注；剔 charterText 全文与其余旁车超集,2026-11-15 终审
 *  行形收窄口径）。域差异经 domainColumns 注入——sunx root=journal 行 root、channels root=域目录
 *  （GUI attach 直寻址）另附 channel/chatId 列。skipMissingDataDir=true 时 <域>/data 缺席（手工
 *  杂散目录）不列（channels 面）；false 交 listSessions 缺档自回空（sunx 面原语义）。容器不可读
 *  =空列合法空态。 */
export function enumerateContainerSessions(opts: {
  containerDir: string;
  kind: 'sunx' | 'channel';
  sessions: Map<string, SessionRuntime>;
  skipMissingDataDir?: boolean;
  domainColumns: (r: ReturnType<typeof listSessions>[number], domainDir: string) => Record<string, unknown>;
}): Array<Record<string, unknown>> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(opts.containerDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const liveByJournal = liveSessionByJournal(opts.sessions);
  const awaitingSet = awaitingByJournal(opts.sessions);
  const statusByJournal = byJournal(opts.sessions, () => true, (s) => s.status());
  const out: Array<Record<string, unknown>> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const domainDir = path.join(opts.containerDir, ent.name);
    const dataDir = path.join(domainDir, 'data');
    if (opts.skipMissingDataDir === true && !fs.existsSync(dataDir)) continue;
    for (const r of listSessions(dataDir)) {
      const live = liveByJournal.get(r.id);
      const status = statusByJournal.get(r.id);
      out.push({
        id: r.id,
        ...(r.title !== undefined ? { title: r.title } : {}),
        ...(r.firstUser !== undefined ? { firstUser: r.firstUser } : {}),
        kind: opts.kind, // 域容器恒该 kind（裁定：容器=纯域，不读 meta，杂散目录不误标）
        updatedAt: r.updatedAt,
        ...(r.archived === true ? { archived: true as const } : {}), // 归档行随列（sunx 面终审 Fix 4 可达性）
        ...(r.runs !== undefined ? { runs: r.runs } : {}),
        ...(r.steps !== undefined ? { steps: r.steps } : {}),
        ...(r.createdAt !== undefined ? { createdAt: r.createdAt } : {}),
        ...(live !== undefined ? { liveSessionId: live } : {}),
        ...(awaitingSet.has(r.id) ? { awaiting: true as const } : {}),
        ...(status !== undefined ? { status } : {}),
        ...opts.domainColumns(r, domainDir),
      });
    }
  }
  out.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
  return out;
}

/** 容器 journalId 磁盘寻址共享循环（D89①收敛：findJournalOwner/findSunxJournalOwner/
 *  findChannelsJournalOwner 三份「readdir→逐域 <域>/data→sessionsDir 档名命中」扫描——原登记
 *  两写，2026-11-22 通道域寻址落地成第三份）。返回命中域 {slug, dataDir}；容器不可读=undefined */
function scanContainerForJournal(containerDir: string, jid: string): { slug: string; dataDir: string } | undefined {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(containerDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(containerDir, ent.name, 'data');
    if (fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`))) return { slug: ent.name, dataDir };
  }
  return undefined;
}

/** journalId → {dataDir, slug}(跨工作区扫描;archive/delete 的 journal 寻址与归档列表共用) */
export function findJournalOwner(root: string, jid: string): { dataDir: string; slug: string } | undefined {
  return scanContainerForJournal(root, jid);
}

/** journalId → sunx 域 dataDir（2026-11-15 终审 Fix 4 可达性兜底）：先按域键直查
 *  （sunxDomainDir(jid)——独占域形态），缺席扫容器各域（fork/rewind 子档落父域的领养形态——
 *  子 journalId ≠ 域键）；找到即返回所在域。archive/unarchive/delete 的 journalId 磁盘寻址
 *  与 projectsRoot 兜底串联（projects 区缺席才扫 sunx 容器——两区物理独立零歧义） */
export function findSunxJournalOwner(jid: string): string | undefined {
  const own = sunxDomainDir(jid);
  if (fs.existsSync(path.join(sessionsDir(own), `${jid}.jsonl`))) return own;
  return scanContainerForJournal(sunxContainerDir(), jid)?.dataDir;
}

/** journalId → 通道域 dataDir（2026-11-22 侧栏通道行归档可达性）：扫 channels 容器各域。
 *  通道会话归档/撤销/删除按 journalId 磁盘寻址必须可达：IM 会话冷档（daemon 重启后不在座）时
 *  GUI 归档链（archive→delete）的 journalId 兜底若只扫 projects+sunx 两区恒 404=死态。
 *  物理三容器独立零歧义，串联兜底同序 */
export function findChannelsJournalOwner(jid: string): string | undefined {
  return scanContainerForJournal(channelsContainerDir(), jid)?.dataDir;
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
    // journalId 兜底三扫（终审 Fix 4 + 2026-11-22 通道归档可达性）：projects 区缺席再扫 sunx、
    // channels 两容器（归档 sunx/通道会话重启后不在座=两列表只剩归档行,unarchive/delete 按
    // journalId 必须可达=死态根修）
    const owner = findJournalOwner(projectsRoot(), id);
    const sunxDataDir = owner === undefined ? findSunxJournalOwner(id) : undefined;
    const chanDataDir = owner === undefined && sunxDataDir === undefined ? findChannelsJournalOwner(id) : undefined;
    if (owner === undefined && sunxDataDir === undefined && chanDataDir === undefined) return io.send(res, 404, { error: 'unknown session' });
    jid = id;
    dataDir = owner !== undefined ? owner.dataDir : sunxDataDir !== undefined ? sunxDataDir : chanDataDir!;
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
  // projects 区扫描脚手架走 forEachProjectSlug 单点（D89②）；root 语义本面自裁——缺档/坏档 '' 兜底、不过滤
  forEachProjectSlug(
    (_slug, raw) => raw ?? '',
    (slug, dataDir, root) => {
      for (const r of listSessions(dataDir)) {
        if (r.archived !== true || r.archivedAt === undefined) continue;
        const live = liveByJournal.get(r.id);
        out.push({
          id: r.id, slug, root, ...(r.title !== undefined ? { title: r.title } : {}), updatedAt: r.updatedAt, archivedAt: r.archivedAt,
          ...(r.kind !== undefined ? { kind: r.kind } : {}), // sunx 形态透出（2026-11-15 sunx P2 Task 7,归档行徽标）
          ...(live !== undefined ? { liveSessionId: live } : {}),
          ...(awaitingSet.has(r.id) ? { awaiting: true as const } : {}),
        });
      }
    },
  );
  // 域容器（sunx/channels）不进本聚合（daemon.archive.test 钉死的契约：「域容器枚举=Task 3」
  // ——sunx 走 /sunx/sessions、channels 走 /channels/sessions,各自归档行随列携 kind/archived
  // 标,GUI 归档层按 scope 取对应专域枚举;本聚合恒 projects 区）。
  out.sort((a, b) => b.archivedAt - a.archivedAt);
  io.send(res, 200, out);
}

/** projects 区逐 slug 扫描脚手架（D89②收敛：handleSessionsRecent/handleSessionsArchived 原
 *  「readdir→逐 slug dataDir→读 workspace.json 取 root→listSessions」双写收此一处）。readRoot
 *  裁各面 root 语义（recent=缺省锚点降级、非默认锚 undefined=跳过；archived='' 兜底不滤），
 *  返回 undefined=跳过该 slug；容器不可读=零迭代。 */
function forEachProjectSlug(
  readRoot: (slug: string, rawRoot: string | undefined) => string | undefined,
  visit: (slug: string, dataDir: string, root: string) => void,
): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(projectsRoot(), ent.name, 'data');
    let rawRoot: string | undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
      if (typeof raw?.root === 'string' && raw.root.length > 0) rawRoot = raw.root;
    } catch {
      rawRoot = undefined; // 历史工作区无档/坏档：readRoot 面自裁（slug 自证/空兜底各形）
    }
    const root = readRoot(ent.name, rawRoot);
    if (root === undefined) continue;
    visit(ent.name, dataDir, root);
  }
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

/** 保留期清扫/缓存清点扫描域单点（D110 消双写：retention/cache-inventory 原各自
 *  `[...listWorkspaceDataDirs(), ...listSunxDataDirs()]` 拼装行两处双写）。channels 容器纳入
 *  与否（通道域归档会话入不入保留期清扫/缓存清点）随产品裁定后在此一并落地——登记在案。 */
export function listScanDataDirs(): Array<{ slug: string; dataDir: string }> {
  return [...listWorkspaceDataDirs(), ...listSunxDataDirs()];
}
