import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ok, fail } from '../result';
import type { Result } from '../result';
import { SessionRuntime } from './session';
import { ensureEnvWorkdirFact } from '../harness/context';
import type { DaemonFrame } from './daemon-wire';
import { ModelAdapter } from '../model/adapter';
import { ModelSwitcher } from '../model/catalog';
import { SessionJournal, journalDisplayTitle, newSessionId, parseJournalFile, purgeSession, readSessionMeta, reduceJournal, sessionsDir, type JournalEvent } from '../session/journal';
import { reduceSteerRows, reduceSegRows, crashWindowEntries, entriesToChainSteps } from '../session/seglog';
import type { RestoredInterrupted } from '../session/wake';
import { projectsRoot, projectSlug, resolveDataDir, sunxDomainDir, worktreeMainRootOf } from '../config/data-dir';
import { findSunxJournalOwner } from './sessions-list-handlers';
import { validSessionId } from './session-id';
import type { ScheduleCreateSeam } from '../harness/tools/schedule-create-tool';
import type { SunxPeersSeam } from '../harness/tools/sunx-peer-tools';

/**
 * 会话生命周期域(2026-10-27 技术债轮 自 daemon.ts 外提,D31 骨架域续批,行为零变化):
 * 会话新建(create)/attach 恢复双入口 + 会话 id 铸造与 default 工作区锚定两助手。
 * daemon 类状态触点收敛为 io 六面(sessions 注册表/model/seq 泵/挂起票据铸造/广播面/激活位),
 * 装配注释与裁定随码平移。
 */

/** daemon 类状态触点面:注册表直引用(Map 本体——createSessionIn 写入/attachIn 遍历收编),
 *  其余八面为回调注入(与 SessionRuntime 装配面同形透传)。watchProject/unwatchProject 两面
 *  (任务14):daemon 持 ConfigWatcher——会话打开挂项目监听、会话关闭(与收编弃壳)拆监听 */
export interface SessionLifecycleIo {
  readonly sessions: Map<string, SessionRuntime>;
  readonly model: ModelAdapter;
  readonly nextSeq: () => number;
  readonly mintPid: () => string;
  readonly broadcast: (frame: DaemonFrame) => void;
  readonly setActive: (id: string) => void;
  /** 会话打开挂项目配置监听（daemon 侧守护：.sunshinex 缺失降级跳过，不产告警） */
  readonly watchProject: (root: string) => void;
  /** 拆项目配置监听（daemon 侧守护：同 root 仍被其他会话持有时不拆） */
  readonly unwatchProject: (root: string) => void;
  /** 定时任务创建接缝（2026-11-20）：daemon ScheduleEngine 出口——构造 SessionRuntime 时透传，
   *  create_scheduled_task 工具据此落档；缺席（测试/纯终端）=工具不注册 */
  readonly scheduleCreate?: ScheduleCreateSeam;
  /** send_channel_message 接缝工厂（spec §6;2026-11-23 用户裁定「补上 send_channel_message」）：
   *  按 sessionId 产出通道推送出口（daemon channelsEngine.sendToSessionChat 绑定反查投递）——
   *  create/attach 构造 SessionRuntime 时按当次 id 取值透传；缺席=工具不注册 */
  readonly channelSendFor?: (sessionId: string) => { send(text: string): Promise<boolean> };
  /** 定时分派清单接缝（2026-11-25 用户裁定④「定时任务也要在任务状态中显示」）：按工作区根回列
   *  启用中的分派（daemon 注入 ScheduleEngine root 过滤）——task_status 工具回执附段 */
  readonly schedulesFor?: (root: string) => Array<{ name: string; nextRunAt: number | null }>;
  /** 跨 Sunx 对等消息接缝工厂（2026-11-26 用户裁定「两个工具实现 sunx 之间的聊天」）：
   *  按 sessionId 产出活实例枚举/投递出口（daemon 会话表+域容器）——create/attach 构造
   *  SessionRuntime 时按当次 id 取值透传；缺席=两件工具不注册 */
  readonly sunxPeersFor?: (sessionId: string) => SunxPeersSeam;
}

/** root 缺省锚字面量单点（GUI 欢迎页非项目会话的缺省锚，serve 侧解析面同源引用） */
export const DEFAULT_ROOT_LITERAL = 'default';

/** 缺省锚点 slug（D90 收敛：路径字面量原三处双写——本函数+两 handler 内联重推导） */
export const DEFAULT_SCRATCH_SLUG = 'sunshinex-default';

/** 缺省锚点路径（无副作用纯函数；落盘面走 defaultScratchRoot 的 mkdir 形） */
export function defaultScratchRootPath(): string {
  return path.join(os.tmpdir(), DEFAULT_SCRATCH_SLUG);
}

/** 默认锚点工作区判定单点（D90：原 basename 词法与 slug includes 词法两处并存漂移——判定词法
 *  统一取宽口径 includes）。入参取末段（root 尾段或注册 slug）：'default' 字面量或含
 *  sunshinex-default 锚点名（G14.96 历史档 slug 自证身份） */
export function isDefaultWorkspaceSlug(name: string): boolean {
  return name === DEFAULT_ROOT_LITERAL || name.includes(DEFAULT_SCRATCH_SLUG);
}

/** G14.10 B 方案:default 工作区锚定专用临时目录——root 字面 'default'(GUI 欢迎页非项目
 *  会话的缺省锚点)解析为 <tmp>/sunshinex-default(缺场 mkdir recursive):临时任务的文件
 *  落在系统临时目录,不再污染仓库/项目目录。非字面 root(显式项目路径)不经过此处。 */
export function defaultScratchRoot(): string {
  const dir = defaultScratchRootPath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 会话 id(2026-10-23 用户裁定):sun-{项目摘要12}-{随机8hex}——项目段确定性(会话 id 即可见
 *  项目归属),随机段 4 字节 hex 单进程防撞,撞库重掷(注册表查重)。形态为 validSessionId
 *  ([A-Za-z0-9_-])子集;退役 s<n> 单调草档(重启即重号、跨项目不可归因) */
function mintSessionId(sessions: Map<string, SessionRuntime>, root: string): string {
  const project = projectSlug(root).slice(-12);
  for (;;) {
    const id = `sun-${project}-${crypto.randomBytes(4).toString('hex')}`;
    if (!sessions.has(id)) return id;
  }
}

/** 创建会话入参（2026-11-15 sunx P1 Task 4 扩面）：mode 既有三值外增 sunx 三键——kind 缺席=standard
 *  路径零变化（既有调用全部不传,行为逐字节不变）;name/charter 仅 kind='sunx' 时生效（HTTP 面已按
 *  此收窄,直调方自律）。dataDir（2026-11-15 sunx P3 Task 3 换座缝）：域绑定覆写——分支/回退链
 *  （handleBranch）对 sunx 源会话造换座壳时传入其既有域目录（journal 手术已落域,新壳直接绑定领养,
 *  attach 才能在域内认档）；传入时跳过 workspace.json 注册（域不进 /workspaces,与 sunx 出生路径同
 *  纪律）且不铸新档不落出生行（领养既有 journal）。HTTP /session/new 面不透传本键（wire 白名单面,
 *  直调方自律） */
export interface CreateSessionOpts {
  /** 三档全收（internal read-only 扩面，2026-11-20 定时任务 Task 4——HTTP /session/new 仍只收
   *  acceptEdits/full-access，直调方自律） */
  mode?: 'read-only' | 'acceptEdits' | 'full-access';
  /** false=后台建会话不抢 daemon active（定时任务用）；缺省/true=既有行为 */
  activate?: boolean;
  /** 会话形态：'sunx'=编排会话（稳定段章程/工具白名单/fork kind 继承,出生 meta 落 kind/title/charterRev:1） */
  kind?: 'sunx';
  /** 自定义会话名：出生 meta 落 title（G14.16 显示链） */
  name?: string;
  /** 实例品性原文：装配透传 ContextManager 品性冻结层 */
  charter?: string;
  /** Sunx 所属群（2026-11-26 群组规格 §3.2）：出生 meta.groupId；HTTP 层校验群存在并兜底默认群 */
  groupId?: string;
  /** 通道元信息（2026-11-23 用户裁定「平台/聊天 id/应用名进系统上下文」）：装配透传 ContextManager
   *  会话冻结层——出生定版一次不重写（前缀缓存纪律）；仅通道域会话传入（router createOpts） */
  channelMeta?: { platform: string; chatId: string; appName?: string };
  /** 域绑定覆写（换座缝,见接口注）：传入=领养既有域目录（不铸档不注册工作区） */
  dataDir?: string;
  /** 固定模型 id（2026-11-20 定时任务）：装配 per-session 适配器（不切 daemon 全局选择）——
   *  仅内部调用（定时执行器）；HTTP /session/new 不透传。未知 id 回落全局默认。 */
  model?: string;
  /** 思考强度（2026-11-23 用户裁定「可以选择默认的模型和强度」）：通道域缺省档——
   *  出生即 setEffort 落 meta（attach 回放归位）；非法值 setEffort 内部解析失败静默忽略 */
  effort?: string;
}

/**
 * 创建会话(spec §7):root 存在性/目录校验(INVALID_ARG)→ 按 root 装配 SessionRuntime(同 root
 * 多会话允许——各自独立主链,Ruling 2)→ 入注册表 → 置激活。同时向
 * `resolveDataDir(root)/workspace.json` 落档 `{root}`(T2 工作区注册表:slug 单向哈希反解不了
 * root——落档供 GET /workspaces 读回真 root;历史工作区无此档降级 slug-only)。落档尽力而为:
 * 数据面不可写(只读 projects 根)不挡会话创建,/workspaces 对该工作区降级 slug-only 行。Result
 * 面:daemon 级 API(serve --root 预选/后续工作区注册表消费),HTTP 面映射 400/200。
 * G4:opts.mode='acceptEdits' 时向会话注入审批/问询两闭包——resolve 挂在 daemon 挂起表条目上 + 广播
 *  挂起帧(WS 消费面回执 POST /approval/:pid / /ask/:pid/reply);缺省 full-access 零行为变化(沿原 dontAsk 地位正名,spec §3.2)。
 * T2:出生即挂新 SessionJournal(`new SessionJournal(dataDir)` 惰性建档——首 run 首条 chain append
 *  才落盘建新档,档 id 同源 newSessionId();空会话零文件,TUI 惰性先例同构)——首 run 起链持久,
 *  后续 /sessions 列档与 attach 重开(chain 派生转录)可消费。
 * sunx 装配（2026-11-15 P1 Task 4）：kind/name/charter 三键透传 SessionRuntime 实例字段（换铸不丢）。
 * sunx 出生即铸档（2026-11-15 P3 Task 2 用户裁定「放弃惰性建档——持久化实体语义：出生即存在」）：
 * journalId 先铸（域路径依赖它）→ 域目录 `~/.sunshinex/sunx/<journalId>/data` mkdir → SessionRuntime
 * 注入 dataDir=域 → SessionJournal.startWithId 建档 header（无实质事件也建档）→ attachJournal 绑域内档
 * → ensureSunxBirth 补出生行（ctx-snap 快照冻结起点+出生 meta kind/title/charterRev:1/root）。跳过
 * workspace.json 注册（sunx 域不进 /workspaces——连 resolveDataDir 都不调,缺省区零副作用）。standard
 * 惰性建档不变（出生写收口:首实质事件落档时铸造,幽灵会话语义原样）。
 */
export function createSessionIn(io: SessionLifecycleIo, root: string, opts?: CreateSessionOpts): Result<{ sessionId: string }> {
  const abs = root === DEFAULT_ROOT_LITERAL ? defaultScratchRoot() : path.resolve(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return fail('INVALID_ARG', `root does not exist: ${abs}`);
  }
  if (!st.isDirectory()) return fail('INVALID_ARG', `root is not a directory: ${abs}`);
  const isSunx = opts?.kind === 'sunx';
  const adoptDomain = opts?.dataDir; // 换座缝（P3 Task 3）：领养既有域（分支/回退链直调,HTTP 面不透传）
  // standard：workspace.json 注册（树会话跳过——既有裁定原样）；sunx/换座领养：整块跳过（域不进 /workspaces）
  let dataDir: string | undefined;
  if (adoptDomain !== undefined) {
    dataDir = adoptDomain;
  } else if (!isSunx) {
    dataDir = resolveDataDir(abs);
    if (worktreeMainRootOf(abs) === undefined) {
      // 树会话不注册工作区(2026-11-10 用户报障「树会话自立伪项目 wt-*」根修):写入会**覆写主项目
      // workspace.json**(resolveDataDir 已重定向同目录)——/workspaces 反解出树路径,侧栏多出伪项目
      // 且主项目行根错乱。树会话归主项目分组,注册面跳过
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ root: abs }) + '\n', 'utf8');
      } catch {
        // 落档尽力:写失败只让 /workspaces 降级 slug-only,不影响会话装配
      }
    }
  }
  // 会话 id(2026-10-23 用户裁定):sun-{项目摘要12}-{随机8}——退役 s<n> 单调草档(重启即重号、
  // 跨项目不可归因);项目段=工作区 slug 摘要尾(确定性,会话 id 即可见归属),随机段单进程防撞
  const id = mintSessionId(io.sessions, abs);
  // sunx 出生即铸档（P3 Task 2）：journalId 先铸（纯铸造零 IO）——域目录路径=sunxDomainDir(journalId)
  // 依赖它；域目录先于档存在（journal header 随后落域内 sessions/）。换座领养（P3 Task 3）：域已存在
  // （journal 手术已落域）——不铸 id 不 mkdir，直接绑定
  let domainDir: string | undefined;
  let journalId: string | undefined;
  if (adoptDomain !== undefined) {
    domainDir = adoptDomain;
  } else if (isSunx) {
    journalId = newSessionId();
    // 通道域 Sunx 会话（2026-11-25 用户裁定「sunx 模式下的 session data 也应该放到同一个应用的
    // 某个会话下」）：channelMeta 在场=通道聊天会话——域落**聊天域 data**（resolveDataDir 归约
    // channels/<chatKey>/data,与该聊天 standard 会话同域:通道组直觉入口,SUNX 组零重叠）;
    // 缺省=手建 Sunx,域落全局 sunx 容器（既有语义零变化）
    domainDir = opts?.channelMeta !== undefined ? resolveDataDir(abs) : sunxDomainDir(journalId);
    fs.mkdirSync(domainDir, { recursive: true });
  }
  // P6 §4 挂起表下沉会话:daemon 只注入网络寻址两接缝(mintPid/broadcast)——注册/守卫(ghost 硬化
  // isAborted/manual 档位判定)/组帧/回执全部在 SessionRuntime 挂起面(suspendApproval/suspendAsk)
  // 定时任务固定模型（2026-11-20）：从 daemon 的 ModelSwitcher 取该 id 的已构建适配器，
  // 只用于本会话 harness；不注入全局 switcher（避免 setModel 侧切到用户当前模型/全局选择）
  const fixedModel = opts?.model !== undefined && io.model instanceof ModelSwitcher ? io.model.adapterFor(opts.model) : undefined;
  const session = new SessionRuntime({
    id,
    root: abs,
    model: fixedModel ?? io.model,
    ...(fixedModel === undefined && io.model instanceof ModelSwitcher ? { modelSwitcher: io.model } : {}),
    nextSeq: io.nextSeq,
    broadcast: io.broadcast,
    ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
    // sunx 三键透传（2026-11-15 P1 Task 4）：构造入参落 SessionRuntime 实例字段,assemble()/出生 meta 消费
    ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    ...(opts?.charter !== undefined ? { charter: opts.charter } : {}),
    ...(opts?.groupId !== undefined ? { groupId: opts.groupId } : {}),
    ...(opts?.channelMeta !== undefined ? { channelMeta: opts.channelMeta } : {}),
    ...(io.channelSendFor !== undefined ? { channelSend: io.channelSendFor(id) } : {}),
    // 域绑定（2026-11-15 sunx P3 Task 2）：dataDir=域——持久化数据面全落域,handler 寻址走 dataDir 外窥
    ...(domainDir !== undefined ? { dataDir: domainDir } : {}),
    ...(io.scheduleCreate !== undefined ? { scheduleCreate: io.scheduleCreate } : {}),
    ...(io.schedulesFor !== undefined ? { schedulesFor: io.schedulesFor } : {}),
    ...(io.sunxPeersFor !== undefined ? { sunxPeers: io.sunxPeersFor(id) } : {}),
    mintPid: io.mintPid,
  });
  io.sessions.set(id, session);
  // 激活位（2026-11-20 定时任务 Task 4）：activate:false=后台建会话不抢 daemon active（定时任务用）；
  // 缺省/true 沿既有置激活行为逐字节不变
  if (opts?.activate !== false) io.setActive(id);
  // 通道缺省档(2026-11-23 用户裁定「可以选择默认的模型和强度」):出生 setEffort 落 meta(attach 回放归位)
  if (opts?.effort !== undefined) session.setEffort(opts.effort);
  // T2 出生 journal:挂载即接 onContextChange 续写链。standard=惰性建档（首实质事件才落盘——幽灵
  // 会话语义原样）;sunx=出生即铸档（startWithId 以预铸 id 落 header+ensureSunxBirth 补出生行——
  // 持久化实体语义:出生即存在）
  if (isSunx && domainDir !== undefined && journalId !== undefined) {
    const journal = new SessionJournal(domainDir);
    journal.startWithId(journalId, 3);
    session.attachJournal(journal);
    session.ensureSunxBirth();
  } else {
    // 换座领养（P3 Task 3）=domainDir（既有域,journal 在场）；standard=dataDir（惰性建档既有推导）
    session.attachJournal(new SessionJournal(domainDir ?? dataDir!));
  }
  // 任务14 双向同步:会话打开即挂项目配置监听(.sunshinex 缺失由 daemon 侧守护降级跳过——
  // 缺失目录不产告警;目录补建后下次会话打开重试即真实生效,watchXxx 幂等)
  io.watchProject(abs);
  return ok({ sessionId: id });
}

/**
 * attach 恢复(spec §4b 装载序 + 渲染中立 spec v3):会话 root 的 dataDir 下定位 `<journalId>.jsonl`(未知 id
 * INVALID_ARG)→ parseJournalFile → 版本守卫(v3 段级词汇;v1/v2 旧档拒载,dev 用 purge 脚本清理)→
 * 装载双读面:reduceJournal(chain/compact → restoreSession 上下文;model/todos/view 参数面不动) +
 * reduceSegRows(seg/seg-update/run-open/runmeta/truncate → kernel.seed 转录投影,seq 原样沿用)→
 * SessionJournal attach 续挂 + SessionRuntime.attachJournal 挂订阅(后续 run 的 chain 行与段级行
 * 续落同档,teardown seal)→ 置激活。双挂/运行中挂 INVALID_STATE(播种会击穿在飞 run 的链)。
 */
export function attachSessionIn(io: SessionLifecycleIo, id: string, journalId: string): Result<{ sessionId: string; root: string }> {
  // G14.2xx 运行中刷新恢复:同 journal 已在座 → **收编复用**并丢弃 newSession 造的空壳——空壳挂同档
  // =会话 id 换号,直播帧按会话过滤全丢,GUI 种子态冻结成假「已停止」而侧栏仍在跑(实测病根)。
  // 2026-11-07 扩至 idle 在座(用户实测「切会话非常慢」根修):原 idle 走重播种=每次重开铸一个新运行时,
  // 旧运行时永不释放(daemon 内存只增、同档多运行时并挂),GUI 侧按运行时 id 分座=座位/常驻 webview
  // 随重开次数累积。在座运行时即该档的唯一写者,其内存态与档等价,收编免重放且身份稳定。
  // 自挂(sid===id)仅运行中放行,idle 自挂仍落下方双挂 409 守卫
  for (const [sid, s] of io.sessions) {
    if (s.attachedJournalId === journalId && (sid !== id || s.status() === 'running')) {
      // 任务14:被收编丢弃的空壳会话出生时挂的项目监听随壳拆除(unwatchProject 守护——同 root
      // 仍被在座会话持有则不拆);壳 root 与被收编会话 root 可不同,不拆则监听句柄泄漏到 daemon 收口
      const shell = io.sessions.get(id);
      if (sid !== id) {
        io.sessions.delete(id);
        if (shell !== undefined) {
          io.unwatchProject(shell.root);
          // 空壳出生档随壳清扫(2026-10-31 用户报障「每次点击运行中会话都产生一个新对话」):
          // 内存收编了,盘面 birth-only 档还在——/sessions 列表每次点击多一行「新会话」孤儿。
          // 仅零实质行档可删(birthOnlyFile 守卫从严,真档绝不触碰)
          const shellJid = shell.attachedJournalId;
          if (shellJid !== undefined && birthOnlyFile(sessionsDir(shell.dataDir), `${shellJid}.jsonl`)) {
            try {
              fs.rmSync(path.join(sessionsDir(shell.dataDir), `${shellJid}.jsonl`), { force: true });
            } catch {
              /* 单文件收口失败不阻塞收编(下次启动清扫兜底) */
            }
          }
        }
      }
      io.setActive(sid);
      return ok({ sessionId: sid, root: s.root });
    }
  }
  const session = io.sessions.get(id);
  if (session === undefined) return fail('INVALID_ARG', `unknown session: ${id}`);
  // 双挂守卫（出生写语义适配,2026-10-31 spec §2）：出生写后每个新会话出生即铸 birth-only 档
  // （仅 header+ctx-snap 行,零实质内容）——此类档不构成「已挂载」,放行换挂真档（否则 GUI 重开
  // 的 newSession+attach 流程被出生写全数 409）;已落实质行的档守卫照旧（防档双写）
  const prevJournalId = session.attachedJournalId;
  if (prevJournalId !== undefined && !birthOnlyJournal(session.dataDir, prevJournalId)) {
    return fail('INVALID_STATE', 'session already has an attached journal');
  }
  if (session.status() === 'running') return fail('INVALID_STATE', 'cannot attach while a run is in progress');
  // 树会话重启回主分支根修(2026-11-11 用户实测「重启后会话自动回到主分支」):GUI 恢复链只持
  // 组根(指针档 lastRoot/组行 onAttach 都传主项目根),journal 旁车 meta.root 才是会话真根(隔离
  // 会话=工作树路径;树数据经 resolveDataDir 重定向落在主档,同 journalId 同文件,壳根也能找到档
  // =跑在错误工作区无人察觉)。档记根在盘即重挂壳根(unwatch 旧根 refcount 守护,watch 新根幂等),
  // 装配/转录/改动面从此以真根行走;根目录已删(树被手清)则维持壳根不阻断恢复。
  // meta 一次性整读（2026-11-15 final review fix wave）：root 归位外兼读 kind/title——sunx 重铸
  // 判据（kind）与重铸名源（title）同拍取用,零二次读盘。寻址随 dataDir 外窥（P3 Task 2 域绑定：
  // sunx 档在 ~/.sunshinex/sunx/<jid>/data——缺席=resolveDataDir(root) 既有推导,standard 字节不变）
  const meta = readSessionMeta(session.dataDir, journalId);
  const metaRoot = meta.root;
  if (metaRoot !== undefined && metaRoot !== session.root && fs.existsSync(metaRoot)) {
    io.unwatchProject(session.root);
    session.rehomeRoot(metaRoot);
    io.watchProject(metaRoot);
  }
  const dataDir = session.dataDir;
  const file = path.join(sessionsDir(dataDir), `${journalId}.jsonl`);
  if (!fs.existsSync(file)) return fail('INVALID_ARG', `unknown journalId: ${journalId}`);
  const replayEvents = parseJournalFile(file).events;
  // fork 分界横幅(2026-11-04 用户裁定「固定到 fork 位置,不随新内容漂移」):header.upToLine=复制段
  // 末行(文件 1-based)——合成 notice 段行 splice 进重放事件,**内存态不落档**,重放/重启/重进恒现
  // 且位置恒在复制段末、子会话自有内容前(此前 GUI 重播种时追加=每次重进漂到转录底部)。旧子档
  // (横幅行缺席)统一覆盖;GUI ChatEntryView 专支渲染,TUI 无此行
  const headerRow = replayEvents[0];
  const ff = headerRow !== undefined && headerRow.t === 'header' ? headerRow.forkedFrom : undefined;
  if (ff !== undefined && ff.kind === 'fork' && ff.upToLine >= 1) {
    const idx = Math.min(ff.upToLine, replayEvents.length);
    const info = JSON.stringify({
      sessionId: ff.sourceSessionId,
      title: journalDisplayTitle(dataDir, ff.sourceSessionId, path.basename(session.root)),
    });
    // ts/seq 缺省:reduceSegRows 编号器自增(显式 seq 会与相邻复制行撞号→GUI 视图键碰撞)
    replayEvents.splice(idx, 0, { t: 'seg', kind: 'notice', md: `[fork-origin]${info}` } as unknown as JournalEvent);
  }
  const replay = reduceJournal(replayEvents);
  if (replay.version !== 3) return fail('INVALID_ARG', `unsupported journal version: ${String(replay.version)} (v3 required — legacy sessions: node scripts/purge-legacy-sessions.mjs --delete)`);
  // sunx 重铸（2026-11-15 final review fix wave，spec §13 P1 场景「用户关掉 GUI 重开恢复」根修）：
  // 旁车 meta.kind='sunx' 而在座壳非 sunx（重开链 newSession 无 kind → standard 出生态）→ 壳重铸为
  // sunx 形态。序铁律：必须落在 restoreSession/kernelSeed/seedTodoBatches/steerSeed/seedShadow/
  // 快照回种**之前**——换铸清运行时态，先播种再换铸=全丢（rehomeRoot 注释明言 attach 时壳为
  // 出生态零损，同路径先例）。品性原文取 replay.snapshot.sig.charter（string|null——null=无品性层，
  // 与 ContextManager 缺席门一致；快照缺席档回落 null 同形，恢复永不阻断）。幂等：在座已是 sunx
  // （收编复用路径在上方位提前返回；rewind 同源换档壳亦经此守）不二次换铸。name 取 meta.title
  // （出生 meta 落档的 G14.16 显示链名源）。出生 meta 不重写——persistBirthMeta 只在 mint 时可达，
  // charterRev 等旁车键原样保留。
  if (meta.kind === 'sunx' && session.sessionKind !== 'sunx') {
    session.reCast({
      kind: 'sunx',
      ...(meta.title !== undefined ? { name: meta.title } : {}),
      // 品性原文源（fix round 1）：meta.charterText 优先（POST /charter 编辑时与 charterRev 同拍
      // 落盘的当前全文——编辑文跨重启存活,否则重开读面回退出生文而模型面链回放含替代行跟编辑文
      // =两窗漂移）；缺席（旧档/未编辑过）回落快照出生文,字节不变
      charter: meta.charterText ?? replay.snapshot?.sig.charter ?? null,
    });
  }
  session.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
  // 环境事实行对齐（2026-11-23 路线一）：回放链上的 worktree 翻转行 vs 本次运行时活动根（重启后
  // activeRoot 内存态归零）失配即尾追修正——重建上下文不带入安全态错位
  ensureEnvWorkdirFact(session.runtime.harness.context, session.runtime.harness.context.root, session.runtime.harness.safety.activeRoot);
  // 转录装载:seg 面重放入核(no-compat——v1 的 msg 行/链派生播种已随 collector 退役)
  session.kernelSeed(reduceSegRows(replayEvents));
  session.seedTodoBatches(replayEvents); // todo 批次权威投影(2026-10-31 用户裁定):journal 全量行派生,内核环窗之外的老批次由此可见
  // 等待队列装载(P5 spec §12):末条 steer 行整列回种(无行=空队列)
  session.steerSeed(reduceSteerRows(replayEvents));
  // 影子投影装载(G14.2xx 断线重连):board/delegation 事件行回种——重启后快照/补发不再空板空委派
  session.seedShadow(replayEvents);
  // 会话选择面回放(G14.2xx 公共持久化归位):model/effort/mode 运行中切换即落 meta 旁车,
  // attach 按档归位——重启/重开不再回落装配缺省(CLAUDE.md §13 持久化分层口径)。
  // 复用 attach 头部一次性整读的 meta(2026-11-16 技术债补审 I1:原此处二次读盘,与「零二次读盘」注释失符)
  if (meta.effort !== undefined) session.setEffort(meta.effort);
  if (meta.model !== undefined) session.setModel(meta.model);
  if (meta.mode !== undefined) {
    // 权限档回放只认现值三档(2026-10-24 用户裁定「不要有兼容逻辑,旧会话记录可以删」:旧值
    // manual/dontAsk 一律回落缺省档+warn,沿 MANUAL-GUI「不保旧档」开发期先例);'plan' 是流程
    // 标记非档,照写不照回——arm 不跨重启(spec §5.2),静默落缺省档。
    // setMode 异步化后(终审修复:disarm 收口)此处 fire-and-forget 仍同步生效——attach 只落在从未
    // 附档的新会话(idle+plan 流程必不在途,复附有上 guard 拦),setMode 无 await 点直落换新,随后的
    // attachJournal 挂的就是换新后的运行时;带流程在途的 setMode 只经 mode 端点(async)行走
    const mode = meta.mode;
    if (mode === 'read-only' || mode === 'acceptEdits' || mode === 'full-access') void session.setMode(mode);
    else if (mode !== 'plan') console.warn(`[serve] session mode in meta not restorable: ${String(mode)} — falling back to default`);
  }
  // 快照回种（2026-10-31 spec §4）：落档快照直注入替代磁盘重读——前缀字节跨换铸逐位稳定;基线同拍
  // 回种,磁盘 diff 留给首条提交追尾。落点在 meta 回放（mode → setMode 换铸）**之后**:setMode 换新
  // 运行时=新 ContextManager 磁盘重读,先回种会被换铸静默冲掉;attach 只落 idle 新会话,setMode 无
  // await 点直落换铸（同步生效）,此处 `session.runtime` 已是最终在座运行时。旧档无行/坏包
  // （restoreSnapshot 拒收）→ snapOk=false,attach 收尾回退出生写（坏档永不阻断恢复）
  const snapOk = replay.snapshot !== undefined && session.runtime.harness.context.restoreSnapshot(replay.snapshot);
  const journal = new SessionJournal(dataDir);
  journal.attach(journalId);
  session.attachJournal(journal);
  // 物理板已收养 TeamStore:影子板改跟盘面快照(createdAt/durationMs 权威),再 reconcile 收孤儿
  session.pullBoardFromHarness();
  // 物理板 init 自愈 cancelled 后,journal 回放会把旧 running/pending 盖回影子——对齐权威板并落档
  // (须在 attachJournal 之后,reconcile 的 pump 才能把 cancelled 写入 journal 防下次再孤儿)
  session.reconcileBoardWithHarness();
  // 定时调度重布防（2026-11-15 sunx P2 Task 3）：journal wake-schedule 机制行回放——已触发
  // （firedAt 终态行）跳过、未触发项 re-arm（fireAt 已过=停机跨越,R7 补发一次注明延迟）。须在
  // attachJournal 之后：到点补发的 firedAt 终态行须经挂载 journal 落档（「补发一次」语义）
  session.rearmSchedules(replayEvents);
  // 挂起持久化回放（2026-11-15 sunx P2 Task 4,与 rearmSchedules 同区并列）：journal pending-open/
  // pending-resolve 机制行回放——未决（open 无 resolve 对位=daemon 重启蒸发的挂起）**不复活 promise**
  // （executor 已死,复活无消费者）：不重建挂起表、不重发挂起帧（GUI 卡不复活）,转成恢复轮素材
  // （问题原文+选项+askedBy 归因）由恢复后的 Sunx 在新 run 重新处理（Task 5 接线消费）;已决行仅审计。
  // standard/sunx 同产素材（行面普适）,素材消费（恢复轮 notice）限 sunx（Task 5 范围）。幂等安全——
  // 素材由行推导非累加态,重复 attach 整列替换
  session.seedPendingMaterials(replayEvents);
  // 崩溃档兜底回灌（2026-10-30 spec §2）：与 TUI restoreFromSession 同构——seg 面有而链没有的在飞
  // 窗口归约成链行 appendChain（journal attach 之后执行,回灌行经订阅落 chain 行,恢复即持久化）。
  // 正常档窗口恒空、零开销;回灌失败不阻塞 attach——恢复永远可用,只是兜底少一条
  try {
    const crash = entriesToChainSteps(crashWindowEntries(replayEvents));
    if (crash.length > 0) session.runtime.harness.context.appendChain(crash);
  } catch {
    /* 兜底尽力而为:残缺档不阻塞恢复 */
  }
  // 出生写回退（2026-10-31 spec §4）：旧档无 ctx-snap 行或坏包被拒——磁盘现读即出生写,档尾补新行
  // （末行为准）;回种成功则零事务（快照已随档走）
  if (!snapOk) session.persistSnapshotRow();
  // 孤儿出生档回收（2026-10-31 spec §2 伴生面）：出生写后每个新会话出生即铸 birth-only 档,换挂
  // 真档后成孤儿（/sessions 列表的幻影空会话）——守卫已验其仅含 header/ctx-snap,尽力 purge;
  // 自挂形态（attach 自己的出生档 id）不回收
  if (prevJournalId !== undefined && prevJournalId !== journalId) {
    try {
      purgeSession(dataDir, prevJournalId);
    } catch {
      /* 回收尽力而为:不阻断 attach */
    }
  }
  // 恢复唤醒轮（2026-11-15 sunx P2 Task 5,R9 自动重估）：attach 全序收尾之后的一次性 fire-and-forget
  // （reCast/播种/rearmSchedules/seedPendingMaterials 全部落定,本点即全序最末）。触发=kind==='sunx'
  // 且（存在自愈 cancelled/stopped 打断任务 或 存在未决挂起素材）——打断清单从 attach 序已有信息推导
  // （板 init 自愈读面 restartRecovered + 台账孤儿 stopped 读面 restartOrphans——零新增生产状态,行
  // 推导幂等）;素材取 pendingMaterial()（Task 4 回放产出,呈现只取 title/askedBy）。全无素材静默
  // 不起轮（避免每次重开空转一轮）;standard 零触发（submitRestoredRound 内 kind 守卫双保险）。
  // busy 竞争用户优先:恢复轮走 submit 单 run 锁,409 即丢弃+skip notice——素材已入链可被下一轮
  // 自然消费,不做复杂排队（裁定 2/3 在 SessionRuntime.submitRestoredRound 内收口）
  if (session.sessionKind === 'sunx') {
    const h = session.runtime.harness;
    const materials = session.pendingMaterial();
    const ledgerOrphans = h.tasks.restartOrphans();
    const boardRecovered = h.taskboard.restartRecovered();
    if (materials.length > 0 || boardRecovered.length > 0 || ledgerOrphans.length > 0) {
      const interrupted: RestoredInterrupted[] = [
        ...boardRecovered.map((t) => ({ name: t.title, id: t.id, status: 'cancelled' })),
        ...ledgerOrphans.map((t) => ({ name: t.title ?? t.label, id: t.id, status: 'stopped' })),
      ];
      if (session.submitRestoredRound(interrupted, materials)) {
        // 一次性消化(2026-11-16 用户实测重复拍醒根修):恢复轮起跑成功即回执 ack——账本 ack 行落档
        // (重放即知)+board 集清空;后续 attach 对同批孤儿零重复拍醒(真损失首轮已补救,余为陈旧账目)
        h.tasks.ackInterruptOrphans(ledgerOrphans.map((t) => t.id));
        h.taskboard.clearRestartRecovered();
      }
    }
  }
  io.setActive(id);
  return ok({ sessionId: id, root: session.root });
}

/**
 * sunx 重开链（2026-11-15 sunx P3 Task 2）：按 journalId 定位域目录（sunxDomainDir 单点推导——
 * journalId 即域键,确定性寻址强于扫容器;容器无此域=INVALID_ARG unknown sunx session）→ 壳
 * newSession（kind='sunx'/dataDir=域/name=meta.title/charter=meta.charterText ?? 档上出生快照
 * sig.charter ?? null）→ attachSessionIn 既有全链复用（reCast 守卫天然跳过——壳出生即 sunx 形态；
 * restoreSession/kernelSeed/seedTodoBatches/steerSeed/seedShadow/快照回种/rearmSchedules/
 * seedPendingMaterials/恢复唤醒轮全在 attach 链内,域绑定后自动工作。时序铁律不可动：先重铸后播种——
 * 壳形态在构造期定死,播种全在其后,铁律以更强形式成立）。壳根=域旁车 meta.root（出生 meta 落 root——
 * 出生未跑也有;根已删=INVALID_ARG 不给无根装配——工作树共享面锚 root 不可空）。同 journal 已在座
 * （含 idle——收编扩面同 attachSessionIn 裁定）早退置激活,不再造壳。attach 失败（版本拒载等）壳随
 * 回收（出注册表+拆监听）不留幽灵座。
 */
export function attachSunxIn(io: SessionLifecycleIo, journalId: string): Result<{ sessionId: string; root: string }> {
  if (!validSessionId(journalId)) return fail('INVALID_ARG', `invalid journalId: ${journalId}`);
  // 域定位双查（2026-11-15 终审 Fix 5）：域键直查（sunxDomainDir(journalId)——独占域形态）缺席
  // 扫容器各域（fork/rewind 子档落父域的领养形态——子 journalId ≠ 域键，档在父域 sessions/ 内；
  // 旧实现域键直查即定论=子档重开恒 400 unknown 死态）
  const ownDomain = sunxDomainDir(journalId);
  const domain = fs.existsSync(path.join(sessionsDir(ownDomain), `${journalId}.jsonl`))
    ? ownDomain
    : findSunxJournalOwner(journalId);
  if (domain === undefined || !fs.existsSync(path.join(sessionsDir(domain), `${journalId}.jsonl`))) {
    return fail('INVALID_ARG', `unknown sunx session: ${journalId}`);
  }
  const file = path.join(sessionsDir(domain), `${journalId}.jsonl`);
  // 在座收编早退：同 journal 已在座（attachSessionIn 收编裁定同源——壳弃座免铸）直接置激活返回
  for (const [sid, s] of io.sessions) {
    if (s.attachedJournalId === journalId) {
      io.setActive(sid);
      return ok({ sessionId: sid, root: s.root });
    }
  }
  const meta = readSessionMeta(domain, journalId);
  const shellRoot = meta.root;
  if (shellRoot === undefined || !fs.existsSync(shellRoot)) {
    return fail('INVALID_ARG', `sunx session root missing: ${journalId}`);
  }
  // 壳 charter 源（reCast 同口径）：meta.charterText（编辑文——POST /charter 同拍落盘）优先,
  // 缺席（旧档/未编辑过）回落档上末条合法快照的出生文;都无=null=无品性层（构造键缺席同形）
  const replay = reduceJournal(parseJournalFile(file).events);
  if (replay.version !== 3) return fail('INVALID_ARG', `unsupported journal version: ${String(replay.version)} (v3 required)`);
  const charter = meta.charterText ?? replay.snapshot?.sig.charter ?? null;
  const id = mintSessionId(io.sessions, shellRoot);
  const session = new SessionRuntime({
    id,
    root: shellRoot,
    model: io.model,
    ...(io.model instanceof ModelSwitcher ? { modelSwitcher: io.model } : {}),
    nextSeq: io.nextSeq,
    broadcast: io.broadcast,
    kind: 'sunx',
    ...(meta.title !== undefined ? { name: meta.title } : {}),
    ...(charter !== null ? { charter } : {}),
    dataDir: domain,
    ...(io.scheduleCreate !== undefined ? { scheduleCreate: io.scheduleCreate } : {}),
    ...(io.schedulesFor !== undefined ? { schedulesFor: io.schedulesFor } : {}),
    ...(io.channelSendFor !== undefined ? { channelSend: io.channelSendFor(id) } : {}),
    ...(io.sunxPeersFor !== undefined ? { sunxPeers: io.sunxPeersFor(id) } : {}),
    mintPid: io.mintPid,
  });
  io.sessions.set(id, session);
  io.setActive(id);
  io.watchProject(shellRoot);
  const r = attachSessionIn(io, id, journalId);
  if (!r.ok) {
    // 壳回收：attach 全链失败（版本拒载/在座运行中竞争等）——出注册表+拆监听,不留幽灵座
    io.sessions.delete(id);
    io.unwatchProject(shellRoot);
    return r;
  }
  return r;
}

/** birth-only 档判定（出生写语义的守卫面,2026-10-31 spec §2）：档仅含 header/ctx-snap 行（零实质
 *  内容）即出生档——逐行 JSON 校验,任一实质行/坏行/读失败即非 birth-only（守卫从严,不误放双挂）。
 *  入参=持久化域目录（P3 Task 2 起随 dataDir 外窥——sunx 档在域,standard=resolveDataDir 既有推导） */
function birthOnlyJournal(dataDir: string, jid: string): boolean {
  return birthOnlyFile(sessionsDir(dataDir), `${jid}.jsonl`);
}

/** birth-only 文件判定（目录+文件名形态;启动清扫/收编清扫共用——单一判定面） */
function birthOnlyFile(dir: string, fileName: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, fileName), 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const t = (JSON.parse(line) as { t?: unknown }).t;
      if (t !== 'header' && t !== 'ctx-snap') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 出生档启动清扫（2026-10-31 用户报障「每次点击运行中会话都产生一个新对话」存量收口）：
 *  收编路径曾只丢内存空壳,盘面 birth-only 档遗留——/sessions 列表每次点击多一行「新会话」
 *  孤儿。boot 序扫全部注册工作区删零实质行档:boot 时零在座会话,无引用可破;birthOnlyFile
 *  守卫从严(任一实质行/坏行/读失败即保留),历史实质档零风险。返回清除数(启动日志面) */
export function sweepBirthOnlyJournals(): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = sessionsDir(path.join(projectsRoot(), ent.name, 'data'));
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (!birthOnlyFile(dir, f)) continue;
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        removed++;
      } catch {
        /* 单文件失败不阻塞清扫 */
      }
    }
  }
  return removed;
}
