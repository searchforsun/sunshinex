// Sunx 群组（2026-11-26 群组规格）：群存储 + 默认群 + 房间日志。本模块只做持久化与房间折叠，
// 不认 daemon 会话表；投递/命令执行经 deps 注入（daemon 接线），避免与 sunx-peers 形成环。
// 群目录：`<sunx 容器>-groups/`（跟随 SUNSHINEX_SUNX_DIR），groups.json + `<gid>/room.jsonl`。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sunxContainerDir, sunxGroupsDir } from '../config/data-dir';
import { listSessions, readSessionMeta } from '../session/journal';
import type { SunxPeerRef } from '../types';
import { COMMAND_SUPPORT } from './session-commands';
import { parseImagesParam } from '../images';

/** 默认群 id（存量实例无 meta.groupId 的读取兜底；不可删除，可改名） */
export const DEFAULT_GROUP_ID = 'grp_default';
/** 默认群名（GUI 对未改名默认群走 t('Default group','默认群组')，改名后以存储名为准） */
export const DEFAULT_GROUP_NAME = '默认群组';

export interface SunxGroupRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt?: number;
}

interface GroupsFile {
  version: 1;
  groups: SunxGroupRecord[];
}

function groupsFile(): string {
  return path.join(sunxGroupsDir(), 'groups.json');
}

/** 群 id：`grp_` + 12 位 hex；与 journalId/sessionId 不撞前缀 */
function mintGroupId(existing: ReadonlySet<string>): string {
  for (;;) {
    const id = `grp_${crypto.randomBytes(6).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
}

function isGroupRecord(v: unknown): v is SunxGroupRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && r.id !== '' && typeof r.name === 'string' && r.name !== '' && typeof r.createdAt === 'number';
}

/** 读 groups.json：缺失/坏档=补种默认群并落盘（惰性补种；读面也会写一次，保证 GUI 首拉有稳定 id） */
function readGroups(): GroupsFile {
  let file: GroupsFile;
  try {
    const raw = JSON.parse(fs.readFileSync(groupsFile(), 'utf8')) as Partial<GroupsFile>;
    const groups = Array.isArray(raw.groups) ? raw.groups.filter(isGroupRecord) : [];
    file = { version: 1, groups };
  } catch {
    file = { version: 1, groups: [] };
  }
  let changed = false;
  if (!file.groups.some((g) => g.id === DEFAULT_GROUP_ID)) {
    file.groups.unshift({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, createdAt: Date.now() });
    changed = true;
  }
  if (changed) writeGroups(file);
  return file;
}

/** 原子写（tmp + rename；daemon 单写者） */
function writeGroups(file: GroupsFile): void {
  fs.mkdirSync(sunxGroupsDir(), { recursive: true });
  const tmp = groupsFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file), 'utf8');
  fs.renameSync(tmp, groupsFile());
}

function normalizeName(name: string): string | undefined {
  const n = name.trim();
  return n.length >= 1 && n.length <= 60 ? n : undefined;
}

/** 群列表（默认群惰性补种；按名称排序） */
export function listGroups(): SunxGroupRecord[] {
  return [...readGroups().groups].sort((a, b) => a.name.localeCompare(b.name));
}

export function groupById(id: string): SunxGroupRecord | undefined {
  return readGroups().groups.find((g) => g.id === id);
}

export function createGroup(name: string): { ok: true; group: SunxGroupRecord } | { ok: false; error: string } {
  const n = normalizeName(name);
  if (n === undefined) return { ok: false, error: 'group name must be 1-60 chars' };
  const file = readGroups();
  if (file.groups.some((g) => g.name.toLowerCase() === n.toLowerCase())) {
    return { ok: false, error: 'group name already exists' };
  }
  const group: SunxGroupRecord = {
    id: mintGroupId(new Set(file.groups.map((g) => g.id))),
    name: n,
    createdAt: Date.now(),
  };
  file.groups.push(group);
  writeGroups(file);
  return { ok: true, group };
}

export function renameGroup(id: string, name: string): { ok: true; group: SunxGroupRecord } | { ok: false; error: string } {
  const n = normalizeName(name);
  if (n === undefined) return { ok: false, error: 'group name must be 1-60 chars' };
  const file = readGroups();
  if (file.groups.some((g) => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) {
    return { ok: false, error: 'group name already exists' };
  }
  const group = file.groups.find((g) => g.id === id);
  if (group === undefined) return { ok: false, error: 'group not found' };
  group.name = n;
  group.updatedAt = Date.now();
  writeGroups(file);
  return { ok: true, group };
}

/** 删除群：默认群/有成员拒绝；空群连同 room 目录一起清 */
export function deleteGroup(id: string, memberCount: number): { ok: true } | { ok: false; error: string } {
  if (id === DEFAULT_GROUP_ID) return { ok: false, error: 'default group cannot be deleted' };
  if (memberCount > 0) return { ok: false, error: 'group has members' };
  const file = readGroups();
  const i = file.groups.findIndex((g) => g.id === id);
  if (i < 0) return { ok: false, error: 'group not found' };
  file.groups.splice(i, 1);
  writeGroups(file);
  fs.rmSync(path.join(sunxGroupsDir(), id), { recursive: true, force: true });
  return { ok: true };
}

/** 房间日志路径（append-only） */
export function roomPath(groupId: string): string {
  return path.join(sunxGroupsDir(), groupId, 'room.jsonl');
}

// ─── 房间消息（spec §3.3/§3.4）──────────────────────────────────────────────────────────────────────

export type SunxRoomKind = 'human' | 'peer' | 'command';
export interface SunxRoomTarget { id: string; name: string }
export interface SunxRoomDelivery { to: string; name: string; ok: boolean; queued?: boolean; error?: string }
export interface SunxReplyPreview { from: SunxPeerRef; text: string }

export interface SunxRoomMessage {
  id: string;
  seq: number;
  ts: number;
  kind: SunxRoomKind;
  from: SunxPeerRef;
  to?: SunxPeerRef;
  text: string;
  /** 群主随行图片（2026-11-27 用户裁定「可以复制图片，直接分发到各个群中」）：dataURL 列，
   *  随投递进目标成员用户气泡（submitExternal/steer images），房间右侧气泡同显 */
  images?: string[];
  mentions?: SunxRoomTarget[];
  mentionAll?: boolean;
  replyTo?: string;
  replyPreview?: SunxReplyPreview;
  targets?: SunxRoomTarget[];
  deliveries?: SunxRoomDelivery[];
  command?: string;
  clientMsgId?: string;
  updatedSeq?: number;
  runSeq?: number;
}

interface RoomMsgLine {
  t: 'msg';
  seq: number;
  id: string;
  ts: number;
  kind: SunxRoomKind;
  from: SunxPeerRef;
  to?: SunxPeerRef;
  text: string;
  images?: string[];
  mentions?: SunxRoomTarget[];
  mentionAll?: boolean;
  replyTo?: string;
  replyPreview?: SunxReplyPreview;
  targets?: SunxRoomTarget[];
  command?: string;
  clientMsgId?: string;
}

interface RoomDeliveryLine {
  t: 'delivery';
  seq: number;
  msgId: string;
  to: string;
  name: string;
  ok: boolean;
  queued?: boolean;
  error?: string;
  ts: number;
}

type RoomLine = RoomMsgLine | RoomDeliveryLine;

function isPeerRef(v: unknown): v is SunxPeerRef {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && r.id !== '' && typeof r.name === 'string' && r.name !== '';
}

/** 读房间行（坏行/未知行跳过；不抛） */
export function readRoomLines(groupId: string): RoomLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(roomPath(groupId), 'utf8');
  } catch {
    return [];
  }
  const out: RoomLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.seq !== 'number' || !Number.isFinite(r.seq)) continue;
    if (r.t === 'msg') {
      if (
        typeof r.id !== 'string' || r.id === '' || typeof r.ts !== 'number' ||
        (r.kind !== 'human' && r.kind !== 'peer' && r.kind !== 'command') ||
        !isPeerRef(r.from) || typeof r.text !== 'string'
      ) continue;
      out.push(r as unknown as RoomMsgLine);
    } else if (r.t === 'delivery') {
      if (typeof r.msgId !== 'string' || typeof r.to !== 'string' || typeof r.name !== 'string' || typeof r.ok !== 'boolean' || typeof r.ts !== 'number') continue;
      out.push(r as unknown as RoomDeliveryLine);
    }
  }
  return out;
}

/** 追加一行：群内 seq 单调（读末/最大值 +1；daemon 单写者，测试串行） */
export function appendRoomLine(groupId: string, line: Omit<RoomMsgLine, 'seq'> | Omit<RoomDeliveryLine, 'seq'>): number {
  const lines = readRoomLines(groupId);
  const seq = (lines.length === 0 ? 0 : Math.max(...lines.map((l) => l.seq))) + 1;
  fs.mkdirSync(path.dirname(roomPath(groupId)), { recursive: true });
  fs.appendFileSync(roomPath(groupId), JSON.stringify({ ...line, seq }) + '\n', 'utf8');
  return seq;
}

function mintMessageId(): string {
  return `m_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim().slice(0, 200);
}

/** 引用预览：按房间内目标消息 id 取 from+首行；不存在=undefined */
export function replyPreviewOf(groupId: string, replyTo: string): SunxReplyPreview | undefined {
  const hit = readRoomLines(groupId).find((l): l is RoomMsgLine => l.t === 'msg' && l.id === replyTo);
  return hit === undefined ? undefined : { from: hit.from, text: firstLine(hit.text) };
}

/** 追加群主消息（targets=发送时快照；返回 id/seq 供 HTTP 立即回执） */
export function appendRoomHuman(
  groupId: string,
  input: {
    from: SunxPeerRef;
    text: string;
    images?: string[];
    mentions?: SunxRoomTarget[];
    mentionAll?: boolean;
    targets?: SunxRoomTarget[];
    replyTo?: string;
    replyPreview?: SunxReplyPreview;
    clientMsgId?: string;
  },
): { id: string; seq: number } {
  const id = mintMessageId();
  const seq = appendRoomLine(groupId, {
    t: 'msg',
    id,
    ts: Date.now(),
    kind: 'human',
    from: input.from,
    text: input.text,
    ...(input.images !== undefined && input.images.length > 0 ? { images: input.images } : {}),
    ...(input.mentions !== undefined && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
    ...(input.mentionAll === true ? { mentionAll: true } : {}),
    ...(input.targets !== undefined ? { targets: input.targets } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.replyPreview !== undefined ? { replyPreview: input.replyPreview } : {}),
    ...(input.clientMsgId !== undefined ? { clientMsgId: input.clientMsgId } : {}),
  });
  return { id, seq };
}

/** 追加成员消息（只记录成功投递；to=群主或成员） */
export function appendRoomPeer(
  groupId: string,
  input: { from: SunxPeerRef; to: SunxPeerRef; text: string; replyTo?: string; replyPreview?: SunxReplyPreview },
): { id: string; seq: number } {
  const id = mintMessageId();
  const seq = appendRoomLine(groupId, {
    t: 'msg',
    id,
    ts: Date.now(),
    kind: 'peer',
    from: input.from,
    to: input.to,
    text: input.text,
    ...(input.from.runSeq !== undefined ? { runSeq: input.from.runSeq } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.replyPreview !== undefined ? { replyPreview: input.replyPreview } : {}),
  });
  return { id, seq };
}

/** 追加命令结果（from=目标成员，to=群主；replyTo=群主那条命令消息） */
export function appendRoomCommand(
  groupId: string,
  input: { from: SunxPeerRef; to: SunxPeerRef; text: string; command: string; replyTo?: string; replyPreview?: SunxReplyPreview },
): { id: string; seq: number } {
  const id = mintMessageId();
  const seq = appendRoomLine(groupId, {
    t: 'msg',
    id,
    ts: Date.now(),
    kind: 'command',
    from: input.from,
    to: input.to,
    text: input.text,
    command: input.command,
    ...(input.from.runSeq !== undefined ? { runSeq: input.from.runSeq } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.replyPreview !== undefined ? { replyPreview: input.replyPreview } : {}),
  });
  return { id, seq };
}

/** 追加投递结果（human 消息的逐目标回执） */
export function appendRoomDelivery(
  groupId: string,
  input: { msgId: string; to: string; name: string; ok: boolean; queued?: boolean; error?: string },
): number {
  return appendRoomLine(groupId, {
    t: 'delivery',
    ts: Date.now(),
    msgId: input.msgId,
    to: input.to,
    name: input.name,
    ok: input.ok,
    ...(input.queued === true ? { queued: true } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  });
}

/** 成员推断引用（spec R7）：目标是群→该成员最近收到的消息；目标是成员 B→B 最近发给该成员的消息 */
export function inferQuote(groupId: string, senderId: string, targetMemberId?: string): { replyTo: string; replyPreview: SunxReplyPreview } | undefined {
  const msgs = readRoomLines(groupId).filter((l): l is RoomMsgLine => l.t === 'msg');
  const hit = [...msgs].reverse().find((m) => {
    if (targetMemberId !== undefined) return m.kind === 'peer' && m.from.id === targetMemberId && m.to?.id === senderId;
    return (m.kind === 'human' && m.targets?.some((t) => t.id === senderId) === true) || (m.kind === 'peer' && m.to?.id === senderId);
  });
  return hit === undefined ? undefined : { replyTo: hit.id, replyPreview: { from: hit.from, text: firstLine(hit.text) } };
}

export interface RoomReadResult {
  messages: SunxRoomMessage[];
  cursor: number;
  hasMore: boolean;
  reset?: boolean;
}

/** 房间读：msg 按 seq 升序；delivery 按 (msgId,to) 后写覆盖；after/before 用事件 seq 游标 */
export function readRoom(groupId: string, opts: { after?: number; before?: number; limit?: number } = {}): RoomReadResult {
  const lines = readRoomLines(groupId);
  const maxSeq = lines.length === 0 ? 0 : Math.max(...lines.map((l) => l.seq));
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const deliveries = new Map<string, RoomDeliveryLine & { seq: number }>();
  for (const l of lines) {
    if (l.t !== 'delivery') continue;
    const key = `${l.msgId}\u0000${l.to}`;
    const prev = deliveries.get(key);
    if (prev === undefined || l.seq > prev.seq) deliveries.set(key, l);
  }
  const folded: SunxRoomMessage[] = lines
    .filter((l): l is RoomMsgLine => l.t === 'msg')
    .map((m) => {
      const ds = [...deliveries.values()].filter((d) => d.msgId === m.id).sort((a, b) => a.seq - b.seq);
      const updatedSeq = Math.max(m.seq, ...ds.map((d) => d.seq));
      return {
        ...m,
        ...(ds.length > 0 ? { deliveries: ds.map(({ seq: _seq, ...d }) => ({ to: d.to, name: d.name, ok: d.ok, ...(d.queued === true ? { queued: true } : {}), ...(d.error !== undefined ? { error: d.error } : {}) })) } : {}),
        updatedSeq,
      };
    })
    .sort((a, b) => a.seq - b.seq);

  if (opts.after !== undefined) {
    if (opts.after < 0 || opts.after > maxSeq) {
      const slice = folded.slice(-limit);
      return { messages: slice, cursor: maxSeq, hasMore: folded.length > slice.length, reset: true };
    }
    const picked = folded.filter((m) => (m.updatedSeq ?? m.seq) > opts.after!);
    const cursor = picked.length > 0 ? Math.max(...picked.map((m) => m.updatedSeq ?? m.seq)) : Math.max(opts.after, maxSeq);
    return { messages: picked, cursor, hasMore: false };
  }
  if (opts.before !== undefined) {
    const older = folded.filter((m) => m.seq < opts.before!);
    const slice = older.slice(-limit);
    return { messages: slice, cursor: maxSeq, hasMore: older.length > slice.length };
  }
  const slice = folded.slice(-limit);
  return { messages: slice, cursor: maxSeq, hasMore: folded.length > slice.length };
}

export interface RoomSearchHit {
  id: string;
  seq: number;
  ts: number;
  kind: SunxRoomKind;
  from: SunxPeerRef;
  text: string;
}

/** 查询侧栏数据（spec §4.3）：大小写不敏感子串；命中片段前后各留上下文，供 GUI 高亮 */
export function searchRoom(groupId: string, query: string, limit = 50): RoomSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const hits: RoomSearchHit[] = [];
  for (const m of readRoomLines(groupId)) {
    if (m.t !== 'msg') continue;
    const lower = m.text.toLowerCase();
    const i = lower.indexOf(q);
    if (i < 0) continue;
    const start = Math.max(0, i - 40);
    const end = Math.min(m.text.length, i + q.length + 120);
    const snippet = `${start > 0 ? '…' : ''}${m.text.slice(start, end).replace(/\n/g, ' ')}${end < m.text.length ? '…' : ''}`;
    hits.push({ id: m.id, seq: m.seq, ts: m.ts, kind: m.kind, from: m.from, text: snippet });
  }
  return hits.sort((a, b) => b.seq - a.seq).slice(0, Math.max(1, Math.min(limit, 200)));
}

/** 群列表 lastMessageAt：只认 msg 行（delivery 更新不算新消息） */
export function lastMessageAt(groupId: string): number | undefined {
  const msgs = readRoomLines(groupId).filter((l): l is RoomMsgLine => l.t === 'msg');
  return msgs.length === 0 ? undefined : Math.max(...msgs.map((m) => m.ts));
}

// ─── 群成员/群列表/群发送准备（daemon 接线；本模块不持会话表）────────────────────────────────────

/** 会话表最小面（daemon Map 直接满足；避免与 sunx-peers 形成环） */
export interface GroupLiveSession {
  readonly attachedJournalId: string | undefined;
  status(): string;
  pendingSnapshot(): ReadonlyArray<unknown>;
}

export interface SunxGroupMemberRow {
  id: string;
  name: string;
  live: boolean;
  running: boolean;
  awaiting: boolean;
  archived?: boolean;
  updatedAt: number;
  root: string;
  runs?: number;
  steps?: number;
  /** 成员会话当前 ask_question 挂起（2026-11-27 用户裁定「群聊页内直接弹 ask 卡」）：pid+问询请求；
   *  群页渲染同一张卡，裁决走既有 /ask/:pid/reply（与成员会话内回答同一 pending，天然双向同步） */
  asks?: Array<{ pid: string; req: unknown }>;
}

export interface SunxGroupSummary {
  id: string;
  name: string;
  isDefault: boolean;
  memberCount: number;
  lastMessageAt?: number;
  createdAt: number;
  updatedAt?: number;
}

function liveByJournalLocal(sessions: ReadonlyMap<string, GroupLiveSession>): Map<string, GroupLiveSession> {
  const m = new Map<string, GroupLiveSession>();
  for (const s of sessions.values()) {
    const jid = s.attachedJournalId;
    if (jid !== undefined && jid !== '' && !m.has(jid)) m.set(jid, s);
  }
  return m;
}

/** 群成员（未归档；includeArchived=true 供发送校验归档显式 mention） */
export function listGroupMembers(
  groupId: string,
  sessions: ReadonlyMap<string, GroupLiveSession>,
  includeArchived = false,
): SunxGroupMemberRow[] {
  const live = liveByJournalLocal(sessions);
  const out: SunxGroupMemberRow[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(sunxContainerDir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(sunxContainerDir(), ent.name, 'data');
    for (const r of listSessions(dataDir)) {
      const meta = readSessionMeta(dataDir, r.id);
      const effective = meta.groupId !== undefined && meta.groupId !== '' ? meta.groupId : DEFAULT_GROUP_ID;
      if (effective !== groupId) continue;
      if (r.archived === true && !includeArchived) continue;
      const rt = live.get(r.id);
      const pending = (rt?.pendingSnapshot() ?? []) as Array<{ pid?: unknown; kind?: unknown; req?: unknown }>;
      const asks = pending
        .filter((p) => p.kind === 'ask' && typeof p.pid === 'string' && p.pid !== '')
        .map((p) => ({ pid: p.pid as string, req: p.req }));
      out.push({
        id: r.id,
        name: r.title ?? meta.title ?? r.firstUser ?? 'Sunx',
        live: rt !== undefined,
        running: rt !== undefined && rt.status() !== 'idle',
        awaiting: pending.length > 0,
        ...(asks.length > 0 ? { asks } : {}),
        ...(r.archived === true ? { archived: true as const } : {}),
        updatedAt: r.updatedAt,
        root: r.root ?? meta.root ?? '',
        ...(r.runs !== undefined ? { runs: r.runs } : {}),
        ...(r.steps !== undefined ? { steps: r.steps } : {}),
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 群列表：群记录 + 未归档成员数 + 房间最后消息时刻（一次容器扫描） */
export function listGroupSummaries(): SunxGroupSummary[] {
  const counts = new Map<string, number>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(sunxContainerDir(), { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(sunxContainerDir(), ent.name, 'data');
    for (const r of listSessions(dataDir)) {
      if (r.archived === true) continue;
      const meta = readSessionMeta(dataDir, r.id);
      const effective = meta.groupId !== undefined && meta.groupId !== '' ? meta.groupId : DEFAULT_GROUP_ID;
      counts.set(effective, (counts.get(effective) ?? 0) + 1);
    }
  }
  return listGroups().map((g) => {
    const last = lastMessageAt(g.id);
    return {
      id: g.id,
      name: g.name,
      isDefault: g.id === DEFAULT_GROUP_ID,
      memberCount: counts.get(g.id) ?? 0,
      ...(last !== undefined ? { lastMessageAt: last } : {}),
      createdAt: g.createdAt,
      ...(g.updatedAt !== undefined ? { updatedAt: g.updatedAt } : {}),
    };
  });
}

/** 群聊专用控制命令（2026-11-27 用户裁定）：/stop 暂停对应 Sunx 执行（中断+暂停队列）、
 *  /clear 清空对应 Sunx 排队消息、/continue 恢复其队列。不并进普通会话 COMMAND_SUPPORT，
 *  避免普通会话命令面板出现无对应执行面的项。 */
export const GROUP_CONTROL_COMMANDS = ['/stop', '/clear', '/continue'] as const;

/** 是否群聊专用控制命令（daemon fan-out 分支用） */
export function isGroupControlCommand(cmd: string): boolean {
  return (GROUP_CONTROL_COMMANDS as readonly string[]).includes(cmd);
}

/** 破坏四件：只允许恰好 1 个显式成员（@all/多目标禁止发出） */
export const GROUP_COMMAND_SINGLE_ONLY: ReadonlySet<string> = new Set(['/delete', '/skills-rm', '/memory-rm', '/memory-gc']);

export interface GroupSendInput {
  text: string;
  images?: string[];
  mentions?: string[];
  mentionAll?: boolean;
  replyTo?: string;
  clientMsgId?: string;
  /** 选中模型（2026-11-27 用户裁定「支持选择模型，直接透传到对应sunx」）：fan-out 前逐个 setModel */
  model?: string;
  /** 选中思考强度（2026-11-28 用户裁定「模型选择要有强度选择条」）：fan-out 前逐个 setEffort */
  effort?: string;
  /** 选中权限（三档；Sunx 无 plan）：fan-out 前逐个 setMode */
  mode?: 'read-only' | 'acceptEdits' | 'full-access';
}

export interface GroupSendPrepared {
  groupId: string;
  owner: SunxPeerRef;
  messageId: string;
  seq: number;
  text: string;
  images?: string[];
  targets: SunxRoomTarget[];
  command?: string;
  /** fan-out 投递文本（2026-11-28 八轮「显示不去,@ 真正发出时才去」）：前置 @提及 段剥除后的
   *  命令/正文;缺省=原样投 text（房间留全文,本字段只管成员侧）。 */
  fanoutText?: string;
  replyPreview?: SunxReplyPreview;
  model?: string;
  effort?: string;
  mode?: 'read-only' | 'acceptEdits' | 'full-access';
}

export type GroupSendPrepareResult =
  | { ok: true; prepared: GroupSendPrepared }
  | { ok: false; status: number; error: string };

/** 群主发送准备（校验+落 human 消息；fan-out 由 daemon 后台执行）：破坏件单目标、@all 快照、
 *  room-only、replyTo 校验。不 attach、不投递。 */
export function prepareGroupSend(groupId: string, input: GroupSendInput, members: readonly SunxGroupMemberRow[]): GroupSendPrepareResult {
  if (groupById(groupId) === undefined) return { ok: false, status: 404, error: 'group not found' };
  if (typeof input.text !== 'string') return { ok: false, status: 400, error: 'text required' };
  if (input.text.length > 4000) return { ok: false, status: 400, error: 'text too long' };
  const imgs = parseImagesParam(input.images);
  if (!imgs.ok) return { ok: false, status: 400, error: imgs.error };
  const images = imgs.images;
  if (input.text.trim() === '' && images === undefined) return { ok: false, status: 400, error: 'text or images required' };
  if (input.mode !== undefined && input.mode !== 'read-only' && input.mode !== 'acceptEdits' && input.mode !== 'full-access') {
    return { ok: false, status: 400, error: 'invalid mode' };
  }
  if (input.model !== undefined && input.model.trim() === '') return { ok: false, status: 400, error: 'invalid model' };
  if (input.effort !== undefined && input.effort.trim() === '') return { ok: false, status: 400, error: 'invalid effort' };

  // @ 前缀过滤（2026-11-28 八轮「显示不去,@ 真正发出时才去」）：首令牌=@提及(目标名/全体)
  // 且次令牌=命令 → 命令生效;房间留全文(appendRoomHuman 原文),fan-out 投递剥前缀段
  // (fanoutText)。GUI 手动键入与面板选人殊途同归,门在服务端单点。
  const trimmedText = input.text.trim();
  const parts0 = trimmedText.split(/\s+/);
  const mentionTokens = new Set(['@全体成员', ...members.filter((m) => m.archived !== true).map((m) => `@${m.name}`)]);
  let lead = 0;
  while (lead < parts0.length && mentionTokens.has(parts0[lead] ?? '')) lead += 1;
  const first = parts0[lead] ?? '';
  const command = ((COMMAND_SUPPORT as readonly string[]).includes(first) || isGroupControlCommand(first))
    ? first
    : undefined;
  let fanoutText: string | undefined;
  if (lead > 0 && command !== undefined) {
    let rest = trimmedText;
    for (const tok of parts0.slice(0, lead)) {
      rest = rest.replace(new RegExp(`^${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '');
    }
    fanoutText = rest;
  }
  if (command !== undefined && images !== undefined) return { ok: false, status: 400, error: 'commands do not accept images' };
  if (command === '/plan') return { ok: false, status: 400, error: 'plan mode is not supported for Sunx' };
  // @全体成员 前缀剥除等价 mentionAll（2026-11-28 八轮:手动键入 @全体成员 /命令 无面板旗标也能全员）
  const mentionAll = input.mentionAll === true || (lead > 0 && parts0.slice(0, lead).includes('@全体成员'));
  let targets: SunxRoomTarget[] = [];
  let mentions: SunxRoomTarget[] | undefined;
  if (mentionAll) {
    targets = members.filter((m) => m.archived !== true).map((m) => ({ id: m.id, name: m.name }));
    if (targets.length === 0) return { ok: false, status: 409, error: 'group has no deliverable members' };
  } else if (Array.isArray(input.mentions) && input.mentions.length > 0) {
    const seen = new Set<string>();
    for (const id of input.mentions) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = members.find((x) => x.id === id);
      if (m === undefined) return { ok: false, status: 400, error: `unknown mention: ${id}` };
      targets.push({ id: m.id, name: m.name });
    }
    mentions = targets;
  }
  if (command !== undefined) {
    if (targets.length === 0) return { ok: false, status: 400, error: 'command requires at least one mentioned Sunx' };
    if (GROUP_COMMAND_SINGLE_ONLY.has(command) && (mentionAll || targets.length !== 1)) {
      return { ok: false, status: 400, error: 'destructive command requires exactly one target (not @all or multiple)' };
    }
  }
  let replyPreview: SunxReplyPreview | undefined;
  if (input.replyTo !== undefined && input.replyTo !== '') {
    replyPreview = replyPreviewOf(groupId, input.replyTo);
    if (replyPreview === undefined) return { ok: false, status: 400, error: 'replyTo not found in this group' };
  }
  const owner: SunxPeerRef = { id: groupId, name: '群主', kind: 'group' };
  const human = appendRoomHuman(groupId, {
    from: owner,
    text: input.text,
    ...(images !== undefined ? { images } : {}),
    ...(mentions !== undefined ? { mentions } : {}),
    ...(mentionAll ? { mentionAll: true } : {}),
    targets,
    ...(input.replyTo !== undefined && input.replyTo !== '' ? { replyTo: input.replyTo } : {}),
    ...(replyPreview !== undefined ? { replyPreview } : {}),
    ...(input.clientMsgId !== undefined && input.clientMsgId !== '' ? { clientMsgId: input.clientMsgId } : {}),
  });
  return {
    ok: true,
    prepared: {
      groupId,
      owner,
      messageId: human.id,
      seq: human.seq,
      text: input.text,
      ...(images !== undefined ? { images } : {}),
      targets,
      ...(command !== undefined ? { command } : {}),
      ...(replyPreview !== undefined ? { replyPreview } : {}),
      ...(fanoutText !== undefined ? { fanoutText } : {}),
      ...(input.model !== undefined && input.model.trim() !== '' ? { model: input.model.trim() } : {}),
      ...(input.effort !== undefined && input.effort.trim() !== '' ? { effort: input.effort.trim() } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    },
  };
}
