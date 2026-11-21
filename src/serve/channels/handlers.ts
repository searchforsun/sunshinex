/** 通道 HTTP 面触点（channels Task 9，spec §2/§8.3）：/channels 运维面——健康快照 / dry-run 测试 /
 *  绑定读写（rootOverride 切换写面，Task 13 聊天信息条消费）/ 聊天域会话枚举。daemon 单点注入 io
 *  （schedules/handlers.ts SchedulesHandlerIo 同模式）：send/readJson 复用 daemon 单点，engine/bindings
 *  注入单例，sessions/activeSessionId/releaseSession 供会话枚举标注与绑定解除回收判据。
 *
 *  裁定引用：
 *  - DELETE binding 回收判据同 schedules/handlers.ts:56-70（定时任务删除）：解除绑定后回收绑定会话
 *    运行时（journal/meta 留盘，点记录可重建），但用户正在看的 active 运行时不得被回收（拆掉观感中
 *    的会话不可接受）；回收尽力而为，异常不挡绑定解除。
 *  - GET /channels/sessions 逐字同构镜像 GET /sunx/sessions（sessions-list-handlers.ts
 *    handleSunxSessions）：域列举换成 channelsContainerDir()（严格三分容器 projects/sunx/channels），
 *    行形白名单同源（剔旁车超集，charterText 全文不入行）；行 root=域目录（GUI attach 直寻址），
 *    kind 钉 'channel'（容器=纯通道域，不读 meta，杂散目录不误标——sunx 面 kind:'sunx' 同判）。
 */
import type * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionRuntime } from '../session';
import { listSessions } from '../../tui/session-journal';
import { channelsContainerDir } from '../../config/data-dir';
import { liveSessionByJournal } from '../sessions-list-handlers';
import type { ChannelsEngine } from './engine';
import type { ChannelsBindingsStore } from './store';

/** HTTP 面触点（daemon 单点注入；engine/bindings 单例；sessions 表供枚举活跃标注与解除回收判据） */
export interface ChannelsHandlerIo {
  send(res: http.ServerResponse, status: number, body: object): void;
  readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  engine: ChannelsEngine;
  bindings: ChannelsBindingsStore;
  /** daemon 会话注册表（枚举行附 liveSessionId/awaiting/status 标注） */
  sessions: Map<string, SessionRuntime>;
  /** 绑定解除回收判据：daemon 当前 active 会话（用户正在看的运行时不得被回收） */
  activeSessionId(): string | undefined;
  /** 绑定解除时回收绑定会话运行时（journal/meta 留盘，点记录可重建） */
  releaseSession(id: string): void;
}

/** GET /channels → 健康快照（engine.health 单点：已知通道 union 逐行 enabled/connected/detail） */
export function handleChannelsList(io: ChannelsHandlerIo, res: http.ServerResponse): void {
  io.send(res, 200, { channels: io.engine.health() });
}

/** POST /channels/:id/test → dry-run 测试连接（engine.test 单点：独立起停适配器，不动在座表）。
 *  失败面恒 200 {ok:false,error}——测试是诊断面，失败即结果不是错误码（mcp probe 同裁定） */
export async function handleChannelsTest(io: ChannelsHandlerIo, res: http.ServerResponse, id: string): Promise<void> {
  io.send(res, 200, await io.engine.test(id));
}

/** GET /channels/bindings → 绑定档全列（store.all；行含 rootOverride 供聊天信息条回显） */
export function handleChannelsBindingsGet(io: ChannelsHandlerIo, res: http.ServerResponse): void {
  io.send(res, 200, { bindings: io.bindings.all() });
}

/** PUT /channels/bindings/:key body {rootOverride?: string|null}（Task 13 聊天信息条「绑定工作区
 *  切换」写面）：绑定不存在 404（写面锚定既有绑定——绑定由入站建立，无创建端点）；null/缺席=清除、
 *  非空字符串=设置（trim 归一；空串/非串 400——写面从严）。每次 PUT 完全决定 rootOverride 态
 *  （全量定态无合并歧义）；其余字段（sessionId/journalId/lockedUserId）保留，updatedAt 刷新 →
 *  upsert（store persist 原子写）→ {ok:true} */
export async function handleChannelsBindingPut(io: ChannelsHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, key: string): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const binding = io.bindings.get(key);
  if (binding === undefined) return io.send(res, 404, { error: 'unknown binding' });
  const body = parsed.body as { rootOverride?: unknown } | null;
  const raw = body?.rootOverride;
  let rootOverride: string | undefined;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return io.send(res, 400, { error: 'rootOverride must be a non-empty string or null' });
    rootOverride = t;
  } else if (raw !== null && raw !== undefined) {
    return io.send(res, 400, { error: 'rootOverride must be a non-empty string or null' });
  }
  const { rootOverride: _prev, ...rest } = binding; // 先剥旧覆盖再按入场值落（缺席/null=清除；带 rest 的解构兄弟项豁免 noUnusedLocals）
  io.bindings.upsert({ ...rest, ...(rootOverride !== undefined ? { rootOverride } : {}), updatedAt: Date.now() });
  io.send(res, 200, { ok: true });
}

/** DELETE /channels/bindings/:key → 解除绑定（store.remove；journal 留盘）+ 回收绑定会话运行时
 *  ——回收判据同 schedules/handlers.ts:56-70：绑定会话若为 active（用户正在看）则跳过回收；
 *  回收尽力而为（运行时触点异常不挡解除）。缺失 404（非幂等，写面从严）。→ {ok:true} */
export function handleChannelsBindingDelete(io: ChannelsHandlerIo, res: http.ServerResponse, key: string): void {
  const binding = io.bindings.get(key);
  if (binding === undefined || !io.bindings.remove(key)) return io.send(res, 404, { error: 'unknown binding' });
  if (binding.sessionId !== io.activeSessionId()) {
    try {
      io.releaseSession(binding.sessionId);
    } catch {
      /* 尽力回收：运行时触点异常不得挡绑定解除 */
    }
  }
  io.send(res, 200, { ok: true });
}

/** 会话待确认标注（挂起表非空=需要用户确认；sessions-list-handlers.awaitingByJournal 同构副本——
 *  源文件未导出且不在本任务可改清单，副本随源裁定注释对齐；liveSessionByJournal 已导出，直引同源） */
function awaitingByJournal(sessions: Map<string, SessionRuntime>): Set<string> {
  const m = new Set<string>();
  for (const s of sessions.values()) {
    if (s.pendingSnapshot().length === 0) continue;
    const jid = s.attachedJournalId;
    if (jid !== undefined) m.add(jid);
  }
  return m;
}

/** GET /channels/sessions（spec §2 运维面；Task 13 侧栏「通道」数据源）：扫 channels 容器各域
 *  （`<容器>/<域>/data` 逐域 listSessions 归并——GET /sunx/sessions 同构镜像，域列举换成
 *  channelsContainerDir()）。行形白名单同源（剔 charterText 全文与其余旁车超集）；行 root=域目录
 *  （`<容器>/<域>`，非 journal meta root——GUI attach 直寻址：resolveDataDir 对容器内路径归约回
 *  `<域>/data`，GUI 以行 root 铸壳 new+attach 即落在正确的域）；kind 钉 'channel'（容器=纯通道域，
 *  不读 meta，杂散目录不误标）；channel=出生 meta 的通道配置 id（SessionSidecarMeta.channel，
 *  Task 13 分组键）随行透出；daemon 注册表匹配补 liveSessionId（running）/awaiting（挂起非空）/
 *  status（在座即标）。空容器（目录不存在/不可读）=空列合法空态；行序 updatedAt 降序 */
export function handleChannelsSessions(io: ChannelsHandlerIo, res: http.ServerResponse): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(channelsContainerDir(), { withFileTypes: true });
  } catch {
    io.send(res, 200, { sessions: [] });
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
    const domainDir = path.join(channelsContainerDir(), ent.name);
    const dataDir = path.join(domainDir, 'data');
    if (!fs.existsSync(dataDir)) continue; // <域>/data 缺席（手工杂散目录）=不列
    for (const r of listSessions(dataDir)) {
      const live = liveByJournal.get(r.id);
      const status = statusByJournal.get(r.id);
      out.push({
        id: r.id,
        ...(r.title !== undefined ? { title: r.title } : {}),
        ...(r.firstUser !== undefined ? { firstUser: r.firstUser } : {}),
        root: domainDir, // 行 root=域目录（GUI attach 直寻址，见上注）
        kind: 'channel', // 域容器恒 channel（容器=纯通道域；不读 meta，杂散目录不误标）
        updatedAt: r.updatedAt,
        ...(r.archived === true ? { archived: true as const } : {}), // 归档行随列（sunx 面 Fix 4 可达性同款）
        ...(r.channel !== undefined ? { channel: r.channel } : {}), // 通道配置 id（Task 13 分组键）
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
  io.send(res, 200, { sessions: out });
}
