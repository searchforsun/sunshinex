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
import { channelsContainerDir, sunxContainerDir } from '../../config/data-dir';
import { loadChannels } from '../../config/channels';
import { loadGlobalSettings } from '../../config/settings';
import { readSessionMeta } from '../../session/journal';
import { writeJsonAtomic } from '../../catalog/io';
import { slugify } from '../../slug';
import { enumerateContainerSessions } from '../sessions-list-handlers';
import { listSessions } from '../../session/journal';
import { readStrictSettingsRootForWrite } from '../config-handlers';
import type { ChannelsEngine } from './engine';
import type { ChannelsBindingsStore } from './store';
import { parseChannelsKey } from './model';
import type { ChannelConfig } from './model';

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

/** PUT /channels/:id/secret body {secret: string}（内联裁定,权威口径 model.ts 头注）：通道密钥写面
 *  ——把密钥写进**全局 settings.json 的 channels 键对应条目**的 secret 字段（密钥随配置项存放、
 *  GET /settings/channels 可回显；env 块不再承载密钥）。本端点是 GUI 弹窗保存链的密钥腿。
 *  守卫族照 config-handlers.handleChannelsPut 同款（settings 结构化写面既有口径）：文件不可读 409 /
 *  注释档 409 引流 raw（hint 'use raw editor'）/ 畸形 JSON 409 / 根非对象 409 / version≠1 409 /
 *  BOM 容忍（0xfeff 剥除，装载口径一致）/ 原子写（writeJsonAtomic，新档补 version:1）。
 *  操作对象 = root['channels'] 数组中 id 匹配的条目：无键/无条目 404（GUI 只以真实配置 id 调用，
 *  引擎面校验属 testChannel 职责）；条目其余字段零触碰（解析归一后的形状——重写前用 parseChannelsKey
 *  归一回写，防手编档混入畸形字段）；secret 空串 = 删除该字段（删缺席字段 = 幂等零写）。
 *  响应与日志**永不回显 secret**——成功回执恰 {ok:true}，错误回执零键值。写后 afterWrite 注入
 *  （daemon：settings 链重载 + config-changed 广播，同 handleChannelsPut 收尾）。 */
export async function handleChannelsSecretPut(io: ChannelsHandlerIo, req: http.IncomingMessage, res: http.ServerResponse, id: string, afterWrite?: () => void): Promise<void> {
  const parsed = await io.readJson(req);
  if (!parsed.ok) return io.send(res, parsed.status, { error: parsed.error });
  const secret = (parsed.body as { secret?: unknown } | null)?.secret;
  if (typeof secret !== 'string') return io.send(res, 400, { error: 'secret must be a string' });
  const target = loadGlobalSettings();
  // 409 守卫族（readStrictSettingsRootForWrite 单点，D108——原 config-handlers 同款内联第三份）：
  // 不可读/注释/畸形/根非对象/version≠1（结构化写不越权处置）
  const guarded = readStrictSettingsRootForWrite(target);
  if (!guarded.ok) {
    io.send(res, guarded.status, guarded.hint !== undefined ? { error: guarded.error, hint: guarded.hint } : { error: guarded.error });
    return;
  }
  const obj = guarded.root;
  // channels 条目手术：定位 id 匹配条目（无键/无条目 404，catalog 写面同文案）；条目经 parseChannelsKey
  // 归一后回写（防手编档混入畸形字段随写固化）；secret 覆写/空串删除字段；条目外键与数组其余条目零触碰
  const listRaw = obj['channels'];
  if (!Array.isArray(listRaw)) return io.send(res, 404, { error: `channel not found: ${id}` });
  const parsedList = parseChannelsKey(listRaw);
  const entry = parsedList.value.find((c) => c.id === id);
  if (entry === undefined) return io.send(res, 404, { error: `channel not found: ${id}` });
  const { secret: _prev, ...rest } = entry; // 先剥旧密钥再按入场值落（缺席/空串=清除）
  const nextEntry: Record<string, unknown> = { ...rest, ...(secret !== '' ? { secret } : {}) };
  const idx = listRaw.findIndex((item) => (item as { id?: unknown } | null)?.['id'] === id);
  listRaw[idx] = nextEntry;
  obj['channels'] = listRaw;
  writeJsonAtomic(target, JSON.stringify(obj, null, 2) + '\n'); // 原子写单点（catalog/io，D60）
  afterWrite?.(); // daemon 注入：settings 链重载 + config-changed 广播（handleChannelsPut 收尾同语义）
  io.send(res, 200, { ok: true }); // 回执恰 {ok:true}——secret 值不出现在响应/日志任何位置
}

/** DELETE /channels/:id（2026-11-23 用户裁定「删除增加弹窗确认……真正的删除各种配置和目录」）：
 *  通道**真删除**——① settings.json channels 条目移除（readStrictSettingsRootForWrite 守卫族同
 *  secret 写面；afterWrite=daemon 注入 applyConfigs 热生效+config-changed 广播）；② 绑定解绑+
 *  在座运行时释放（active 会话不释放——用户正看的不动）；③ 该通道全部聊天域目录真删
 *  （`im-<slugify(id)>-*` 前缀匹配递归删——配置+会话记录+工作区产物一体清除，弹窗确认后执行）。
 *  条目缺失 404（secret 写面同文案） */
export function handleChannelsDelete(io: ChannelsHandlerIo, res: http.ServerResponse, id: string, afterWrite?: (channels: ChannelConfig[]) => void): void {
  // ① settings 条目移除（其余条目原样保留——raw 数组过滤,不重归一防手编档字段固化/丢失）。
  // 守卫走 **raw 数组**（2026-11-25 用户裁定「删除也删除不掉,再进入后就报错了」根修：原守卫走
  // parseChannelsKey 归一清单——装载/解析任何异常（整档读失败/单条目 warning 跳过）都会让条目
  // 404 永不可删,设置页卡死;raw 在=可删,解析态不再握删除权）
  const target = loadGlobalSettings();
  const guarded = readStrictSettingsRootForWrite(target);
  if (!guarded.ok) {
    io.send(res, guarded.status, guarded.hint !== undefined ? { error: guarded.error, hint: guarded.hint } : { error: guarded.error });
    return;
  }
  const obj = guarded.root;
  const listRaw = obj['channels'];
  if (!Array.isArray(listRaw) || !listRaw.some((item) => (item as { id?: unknown } | null)?.['id'] === id)) {
    io.send(res, 404, { error: `channel not found: ${id}` });
    return;
  }
  obj['channels'] = listRaw.filter((item) => (item as { id?: unknown } | null)?.['id'] !== id);
  writeJsonAtomic(target, JSON.stringify(obj, null, 2) + '\n');
  afterWrite?.(loadChannels().value); // daemon 注入:applyConfigs(teardown 该通道适配器)+config-changed
  // ② 绑定解绑+在座释放（**含 active**：数据目录随后要真删，留着活座=幽灵运行时——GUI 页签态
  // 保存会把已删域目录重建（2026-11-27 用户报障「已删除通道元数据还在」实测：域下只剩
  // gui/sessions/*.json）;GUI 凭 removedSessionIds 回欢迎页,不留死会话）
  // 被清会话 id 收集（GUI 据此 SESSION_DELETED_EVENT 回欢迎页+卸页签池）——**绑定座直收是根修**
  // （2026-11-25 用户报障「删除通道后没有回到普通对话的欢迎页」）：rootOverride 指到工作区的
  // 活会话 dataDir 在通道容器外,③ 的 dataDir 前缀扫描收不进,GUI 收不到事件不回欢迎页;
  // 运行时 id+journalId 双列（GUI 两 ref 双寻址）
  const removedSessionIds: string[] = [];
  const pushRemoved = (sid: string): void => {
    if (!removedSessionIds.includes(sid)) removedSessionIds.push(sid);
  };
  /** 域目录真删的公共段：①先收**域内全部活座**（绑定/解绑/active 都可能）——数据要删，运行时
   *  必须释放，否则它（及 GUI 对它的页签态保存）会把域目录重建出 gui/sessions 残留；②冷档
   *  journal id 一并进 removedSessionIds；③递归删域。 */
  const purgeDomain = (domainDir: string): void => {
    for (const [sid, sess] of io.sessions.entries()) {
      const dd = sess.dataDir;
      if (dd === undefined) continue;
      if (dd !== domainDir && !dd.startsWith(domainDir + path.sep)) continue;
      pushRemoved(sid);
      io.releaseSession(sid);
    }
    for (const jr of listSessions(path.join(domainDir, 'data'))) pushRemoved(jr.id);
    fs.rmSync(domainDir, { recursive: true, force: true });
  };
  const prefix = `${id}:`;
  for (const b of io.bindings.all()) {
    if (!b.key.startsWith(prefix)) continue;
    io.releaseSession(b.sessionId);
    pushRemoved(b.sessionId);
    if (b.journalId !== undefined) pushRemoved(b.journalId);
    io.bindings.remove(b.key);
  }
  // ③ 聊天域目录真删（`im-<slugify(id)>-*` 前缀=该通道全部聊天;recursive+force 尽力而为）
  const domainPrefix = `im-${slugify(id, { max: 60, fallback: 'chat' })}-`;
  const container = channelsContainerDir();
  let removedDomains = 0;
  try {
    for (const ent of fs.readdirSync(container, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith(domainPrefix)) continue;
      purgeDomain(path.join(container, ent.name));
      removedDomains += 1;
    }
  } catch {
    /* 容器缺席/不可读=无域可删（合法空态） */
  }
  // ③b sunx 容器滞留域清扫（2026-11-25 布局迁移前的通道 Sunx 会话落在 sunx 容器——删通道
  // 一并真删,防幽灵档永驻 SUNX 组;meta.channel===id 判据,手建 Sunx 零波及;尽力而为）
  try {
    const sunxRoot = sunxContainerDir();
    for (const ent of fs.readdirSync(sunxRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const domainDir = path.join(sunxRoot, ent.name);
      if (readSessionMeta(path.join(domainDir, 'data'), ent.name).channel !== id) continue;
      purgeDomain(domainDir);
      removedDomains += 1;
    }
  } catch {
    /* 容器缺席/不可读=无滞留域（合法空态） */
  }
  io.send(res, 200, { ok: true, removedDomains, removedSessionIds });
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

/** 行 chatId 三重兜底（2026-11-23 用户裁定「旧会话也要有会话 id hover」）：
 *  ① 出生档 meta chatId（seatAndTag 落档，权威源）；② 绑定档 journalId 反查（现行绑定）；
 *  ③ 域名反查——`<域>=im-<通道slug>-<聊天slug>`，聊天 slug 为已知 id 前缀（oc/ou）时首
 *  '-' 还原 '_'（slugify 只换 '_'→'-'，oc_/ou_ 形可逆）；都缺=undefined（卡回落根路径行） */
function rowChatId(r: { id: string; chatId?: string }, domainDir: string, chatIdByJournal: ReadonlyMap<string, string>): string | undefined {
  if (r.chatId !== undefined && r.chatId !== '') return r.chatId;
  const viaBinding = chatIdByJournal.get(r.id);
  if (viaBinding !== undefined) return viaBinding;
  const base = domainDir.split(/[\\/]/).pop() ?? '';
  const m = /^im-[a-z0-9]+-((?:oc|ou)-[0-9a-f]+)$/.exec(base);
  return m !== null ? m[1].replace('-', '_') : undefined;
}

/** 行 chatTitle 双兜底（2026-11-24 用户裁定「hover 显示聊天名称,单聊=聊天人名称,群聊=群聊名称」）：
 *  ① 出生档 meta chatTitle（seatAndTag 落档,权威源）；② 绑定档 journalId 反查（现行绑定）;
 *  都缺=undefined（卡回落显示 chatId 旧行） */
function rowChatTitle(r: { id: string; chatTitle?: string }, chatTitleByJournal: ReadonlyMap<string, string>): string | undefined {
  if (r.chatTitle !== undefined && r.chatTitle !== '') return r.chatTitle;
  return chatTitleByJournal.get(r.id);
}

/** GET /channels/sessions（spec §2 运维面；Task 13 侧栏「通道」数据源）：扫 channels 容器各域
 *  （`<容器>/<域>/data` 逐域 listSessions 归并——GET /sunx/sessions 同构镜像，域列举换成
 *  channelsContainerDir()）。行形白名单同源（剔 charterText 全文与其余旁车超集）；行 root=域目录
 *  （`<容器>/<域>`，非 journal meta root——GUI attach 直寻址：resolveDataDir 对容器内路径归约回
 *  `<域>/data`，GUI 以行 root 铸壳 new+attach 即落在正确的域）；kind 钉 'channel'（容器=纯通道域，
 *  不读 meta，杂散目录不误标）；channel=出生 meta 的通道配置 id（SessionSidecarMeta.channel，
 *  Task 13 分组键）随行透出；daemon 注册表匹配补 liveSessionId（running）/awaiting（挂起非空）/
 *  status（在座即标）。应答=裸 SessionRow[]（评审裁定：sunx 先例 handleSunxSessions :177 裸数组
 *  出行，GUI 既有消费形 getJson<SessionRow[]>('/sunx/sessions') 同款，无信封）。空容器（目录不
 *  存在/不可读）=空列合法空态；行序 updatedAt 降序 */
export function handleChannelsSessions(io: ChannelsHandlerIo, res: http.ServerResponse): void {
  // chatId 反查表（2026-11-22 用户裁定「hover 显示飞书会话 id」）：绑定档 journalId → 聊天 id
  // （key=`<channelId>:<chatId>` 首冒号切分）——平台聊天会话标识（飞书 oc_/Telegram chat id），
  // GUI 会话悬浮卡显示与复制用；未绑定行（异常）缺席=卡回落根路径行
  const chatIdByJournal = new Map<string, string>();
  const chatTitleByJournal = new Map<string, string>();
  for (const b of io.bindings.all()) {
    const i = b.key.indexOf(':');
    if (i <= 0 || b.journalId === undefined) continue;
    chatIdByJournal.set(b.journalId, b.key.slice(i + 1));
    if (b.chatTitle !== undefined && b.chatTitle !== '') chatTitleByJournal.set(b.journalId, b.chatTitle);
  }
  const out = enumerateContainerSessions({
    containerDir: channelsContainerDir(),
    kind: 'channel', // 域容器恒 channel（容器=纯通道域；不读 meta，杂散目录不误标）
    sessions: io.sessions,
    skipMissingDataDir: true, // <域>/data 缺席（手工杂散目录）=不列
    domainColumns: (r, domainDir) => ({
      root: domainDir, // 行 root=域目录（GUI attach 直寻址：resolveDataDir 对容器内路径归约回 <域>/data）
      ...(r.channel !== undefined ? { channel: r.channel } : {}), // 通道配置 id（Task 13 分组键）
      // 平台聊天会话标识（悬浮卡显示/复制）——meta 出生档 → 绑定反查 → 域名反查三重兜底
      ...(rowChatId(r, domainDir, chatIdByJournal) !== undefined ? { chatId: rowChatId(r, domainDir, chatIdByJournal) } : {}),
      // 聊天名称（悬浮卡聊天名称行,2026-11-24 裁定）——meta 出生档 → 绑定反查双兜底
      ...(rowChatTitle(r, chatTitleByJournal) !== undefined ? { chatTitle: rowChatTitle(r, chatTitleByJournal) } : {}),
    }),
  });
  // Sunx 模式通道的聊天会话**不并入**本列（2026-11-25 用户裁定「不能直接改到 channels 下,
  // 不然和 sunx 重叠了」）：sessionKind='sunx' 通道的聊天会话走 sunx 出生路径——journal 落
  // sunx 容器,由 GET /sunx/sessions（SUNX 组）独家承载;通道组只扫通道容器,两组零重叠。
  io.send(res, 200, out); // 裸 SessionRow[]（sunx 面同款，GUI 消费形对齐）
}
