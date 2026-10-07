import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { ModelAdapter } from '../model/adapter';
import { ok, fail } from '../result';
import type { Result } from '../result';
import { SessionRuntime } from './session';
import type { EventFrame } from './session';
import type { SnapshotPendingRow } from './session';
import { journalMessagesToEntries, chainStepsToEntries } from './session';
import type { ApprovalDecision, ApprovalRequest, AskUserAnswer, AskUserRequest } from '../types';
import { SessionJournal, listSessions, parseJournalFile, reduceJournal, sessionsDir } from '../tui/session-journal';
import { resolveDataDir, projectsRoot } from '../config/data-dir';
import { isWithin } from '../paths';
import { PtyManager } from './pty';

/** GUI daemon 构造面（G3 会话中心）：不再绑 root——daemon 持会话注册表，会话经 createSession(root)
 *  按需装配（--root CLI 参数降级为「启动即预选」，缺省空注册表启动）。model 与 CLI buildModel/TUI
 *  同源注入（三面同一 ModelAdapter 契约，daemon 级单例供各会话共享）；staticRoot 为 GUI 静态产物目录
 *  （G3 静态挂载），缺省 cwd 相对 dist-gui——serve 命令从仓库根跑即对，测试注入 tmp 路径保持 hermetic */
export interface GuiDaemonOpts {
  model: ModelAdapter;
  staticRoot?: string;
}

/** start 入参：port 缺省 0（临时端口，返回实际监听值）；token 缺省随机 24 字节 hex（规格 §4.3） */
export interface GuiDaemonStartOpts {
  port?: number;
  token?: string;
}

/** start 回执：port 为实际监听端口；close 与 GuiDaemon.close 同一幂等收口 */
export interface GuiDaemonHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

/** GET /workspaces 行（T2 工作区注册表）：slug=projectsRoot 下工作区目录名；root 经 createSession
 *  落档的 `<dataDir>/workspace.json` 反解——历史工作区（TUI 时代档）无此档 → root undefined（前端
 *  不可 attach，仅统计展示）；mtime=dataDir mtime；sessionCount=sessions 目录 jsonl 数（缺目录=0） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
}

/** 挂起面 WS 帧（G4 审批问询，spec §4.2）：无 seq——不入单调序列（挂起非事件流成员，重连重发幂等，
 *  客户端以 pid 去重）；pid 为 daemon 级铸造的挂起票据（回执端点 `POST /approval/:pid` /
 *  `POST /ask/:pid/reply` 的寻址键）；req 纯数据直序列化（ApprovalRequest/AskUserRequest 字面） */
export interface ApprovalFrame {
  kind: 'approval';
  sessionId: string;
  pid: string;
  req: ApprovalRequest;
}

/** ask 挂起帧：AskUserRequest 无 id 字段（types.ts 现场核）——pid 由 daemon 单点铸造承载回执寻址 */
export interface AskFrame {
  kind: 'ask';
  sessionId: string;
  pid: string;
  req: AskUserRequest;
}

/** reset 通知帧（G4 裁定 7）：无 seq——GUI 收到即清该会话本地投影并重播种（sessionSnapshot） */
export interface ResetFrame {
  kind: 'reset';
  sessionId: string;
}

/** daemon 下行帧全并集：pump 事件帧（有 seq）+ 挂起/reset 帧（无 seq）——广播面单点共用序列化 */
export type DaemonFrame = EventFrame | ApprovalFrame | AskFrame | ResetFrame;

/** 挂起表条目（G4 裁定 1）：kind 判别联合——回执端点按 kind 对表（approval 回执打到 ask 挂起 = 404）；
 *  resolve 即回执值（interrupt/teardown 以 deny/dismissed 回填，TUI approval.ts 先例） */
type PendingEntry =
  | { kind: 'approval'; sessionId: string; req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }
  | { kind: 'ask'; sessionId: string; req: AskUserRequest; resolve: (a: AskUserAnswer) => void };

/** 挂起条目 → WS 帧（首播与重连重发同形同构：kind/sessionId/pid/req 四件） */
function pendingFrameOf(pid: string, entry: PendingEntry): ApprovalFrame | AskFrame {
  return entry.kind === 'approval'
    ? { kind: 'approval', sessionId: entry.sessionId, pid, req: entry.req }
    : { kind: 'ask', sessionId: entry.sessionId, pid, req: entry.req };
}

/** AskUserAnswer 回执载荷校验（G4）：三态字面核验——selected 需 string[]、custom 需非空 text、
 *  dismissed 无参；非法形态回 null（HTTP 面 400）。labels 空数组放行——类型面合法，工具执行面
 *  自行降级为 dismissed 观察文案（builtin.ts ask_question executor 既有口径） */
function parseAskAnswer(v: unknown): AskUserAnswer | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as { type?: unknown; labels?: unknown; text?: unknown };
  if (a.type === 'dismissed') return { type: 'dismissed' };
  if (a.type === 'custom') return typeof a.text === 'string' && a.text.length > 0 ? { type: 'custom', text: a.text } : null;
  if (a.type === 'selected') {
    if (!Array.isArray(a.labels) || !a.labels.every((l) => typeof l === 'string')) return null;
    return { type: 'selected', labels: a.labels as string[] };
  }
  return null;
}

/** JSON body 上限（1MB）：防无界 body 撑爆 daemon 内存；超限即断连收口 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 文件预览上限（G6 /file 端点，512KB）：≤ 上限全文回执；> 上限读首 512KB + truncated:true
 *  （预览语义而非 413——Ruling 1 修正：截断标记让 GUI 呈现「文件过大已截断」而非直接拒读） */
const MAX_PREVIEW_BYTES = 512 * 1024;

/** 二进制探测窗（首 8KB）：UTF-8 文本不含 \0，命中即按二进制拒（415）——预览面只服务文本 */
const BINARY_PROBE_BYTES = 8 * 1024;

/** tree 忽略名集（G8b T4 /tree 端点）：VCS 内脏/依赖安装物/构建产物——GUI 树的纯噪音，恒不枚举 */
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'dist-gui']);

/** tree 单层上限（G8b T4）：500 条；超限截断 + truncated:true（GUI 呈现「已截断」而非无界载荷） */
const TREE_MAX_ENTRIES = 500;

/** WS 保活节拍：30s 一 ping；pong 静默超 60s 即 terminate（close 事件统一清理） */
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

/** 静态缺失提示（G1 裁定恒定文案；G3 起 dist-gui 在场则 GET 挂静态，缺场仍回此形态） */
const GUI_ASSETS_HINT = 'GUI assets not built — run pnpm --filter gui build (G2)';

/** 旧 /session/new 裸软重置的迁移提示（G3 裸端点兼容裁定：无 root 的旧语义让位 /session/:id/reset） */
const ROOT_REQUIRED_HINT = 'root required — the old soft-reset moved to /session/:id/reset';

/** 静态 mime 表（G3）：按扩展名映射，缺省 application/octet-stream（浏览器按 Content-Type 处置，
 *  未知类型不猜测——下载面行为由客户端定） */
const STATIC_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function mimeOf(file: string): string {
  return STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 静态读文件：任何读失败（缺失/目录/权限）归一 null——SPA 兜底与 404 由调用方分径 */
function readStaticFile(file: string): Promise<Buffer | null> {
  return new Promise((resolve) => fs.readFile(file, (err, data) => resolve(err === null ? data : null)));
}

/** 判界用路径归一（G6 /file 端点；与 SafetyChain.resolveSafe 同口径）：存在段 realpathSync 解析
 * 符号链接（新建段字面拼接——resolve 产物无 .. 残留），防「根内符号链接指向根外」的逃逸；整链无
 * 存在锚（不可达驱动器等）或 realpath 异常回 undefined——调用方回退字面判定（fail-closed 不放行） */
function realPathOf(abs: string): string | undefined {
  try {
    let anchor = abs;
    while (!fs.existsSync(anchor)) {
      const parent = path.dirname(anchor);
      if (parent === anchor) return undefined; // 盘根都不存在：无锚可归一
      anchor = parent;
    }
    return fs.realpathSync(anchor) + abs.slice(anchor.length);
  } catch {
    return undefined;
  }
}

/** 信任根判定（G6 /file 判界单点；G7 /diff 共用）：主根 rootReal ∪ 活动工作树根（read 工具同口径
 *  信任域；rootReal/activeRoot 是 SafetyChain 仅有公开判定面）。real 已归一（realPathOf ?? 字面兜底） */
function insideTrustedRoots(safety: { rootReal: string; activeRoot: string | null }, real: string): boolean {
  const roots = [safety.rootReal];
  const active = safety.activeRoot; // worktree 会话的活动根（null=缺省主根态）
  if (active !== null) {
    try {
      roots.push(fs.existsSync(active) ? fs.realpathSync(active) : active);
    } catch {
      roots.push(active);
    }
  }
  return roots.some((r) => real === r || isWithin(r, real));
}

/** 有界读文件（G6 /file 单点；G7 /diff 共用）：≤512KB 全文；>512KB 读首 512KB + truncated:true；
 *  首 8KB 含 \0 按二进制定论（'binary'）；不存在/非文件/读失败归一 'missing'（调用方 404）——
 *  预览语义的读侧三态，判界（insideTrustedRoots）由调用方先行 */
function readFileBounded(resolved: string): { content: string; truncated: boolean } | 'binary' | 'missing' {
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    return 'missing';
  }
  if (!st.isFile()) return 'missing';
  const truncated = st.size > MAX_PREVIEW_BYTES;
  const len = truncated ? MAX_PREVIEW_BYTES : st.size;
  let buf: Buffer;
  try {
    const fd = fs.openSync(resolved, 'r'); // 只读句柄：预览面零写副作用
    try {
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'missing';
  }
  // 二进制拒：首 8KB 含 \0 即按二进制定论（UTF-8 文本不含 NUL 字节）
  if (buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES)).includes(0)) return 'binary';
  return { content: buf.toString('utf8'), truncated };
}

/** URL 段解码（G8b T3 pty 升级路径）：坏 % 序列按字面回退（decodeURIComponent throw 面）——
 *  未命中注册表即 error 帧，fail-closed */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** pty 帧 S→C 下行单点（G8b T3）：readyState 判存——CLOSED/CLOSING 静默丢帧（断线窗口的输出
 *  靠重连 replay 补，不追赶） */
function sendPtyFrame(ws: WebSocket, frame: { t: 'data' | 'exit'; b?: string; code?: number }): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

/** 路由表条目：path 支持 `:name` 段参数（会话维端点 /session/:id/*）；auth 恒验除 healthz */
interface Route {
  method: string;
  path: string;
  auth: boolean;
  run: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void>;
}

/**
 * GUI daemon 核心（spec §3/§7 会话中心）：HTTP 控制面 + WS 事件面 + 会话注册表。每会话一个
 * SessionRuntime（按 root 独立装配 createRuntime——独立泵/影子投影/转录/run 票据），daemon 持
 * 全局面：seq 计数（T1 裁定：全局单调而非每会话——跨会话帧不重号，客户端按 sessionId 过滤后仍是
 * 严格递增流）、WS 连接面、激活会话指针。HTTP 面：healthz 免鉴权 + 会话维端点（/session/:id/*）
 * 与裸端点（/submit 等四件 = 激活会话别名，G2 gui 面渐进迁移不破，v1.x 移除）经 Bearer token 鉴权
 * （§4.3：仅回环 + token，远程暴露为 v1 非目标）。WS 事件面：onEvent 单点泵入 → 帧挂 sessionId
 * 广播全部连接 + 各会话 512 环形缓冲，连接建立即补发全部会话缓冲（会话序 s1..sN，各内缓冲序——
 * T1 裁定：全部会话，客户端按 sessionId 过滤）；升级同走 Bearer 头鉴权。
 */
export class GuiDaemon {
  private readonly model: ModelAdapter;
  private readonly sessions = new Map<string, SessionRuntime>();
  /** 会话 id 方言 s<n>：进程内单调计数（spec §7） */
  private sessionSeq = 0;
  /** seq 泵计数（G3 seq 协议 + T1 全局裁定）：计数在先帧在后（首帧 seq=1），跨会话全局单调不重置——
   *  各会话 snapshot.lastSeq 同一计数器分配故各自单调 */
  private seqCounter = 0;
  /** 激活会话（spec §7 Ruling 1）：最近 create/attach 的会话；裸端点与 board/review 挂它。UI 切换 =
   *  纯前端状态，不改 daemon active（协议兼容层概念，不是 UI 状态） */
  private active?: string;
  private server?: http.Server;
  /** 幂等收口：首调落链，后续调用复用同一 Promise（close 链只走一遍） */
  private closePromise?: Promise<void>;
  /** WS 面：noServer 挂 http server upgrade；连接 Set=pump 广播面 */
  private wss?: WebSocketServer;
  private readonly wsClients = new Set<WebSocket>();
  /** 每 pong 时间戳（WeakMap 旁挂，不入连接对象）：ping 心跳判活依据 */
  private readonly wsLastPong = new WeakMap<WebSocket, number>();
  private pingTimer?: NodeJS.Timeout;
  /** GUI 静态产物根（G3）：opts 注入，缺省 cwd 相对 dist-gui */
  private readonly staticRoot: string;
  /** 静态面探测结果（start 时一次缓存）：index.html 在场才挂静态，缺场保持 API-only（404 hint 原样） */
  private staticReady = false;
  /** 挂起表（G4 裁定 1：daemon 级单表，entry 携 sessionId）：pid=daemon 级单调铸造 `p<n>`——guard 的
   *  ap-N 是会话内序（每会话独立 guard 实例），跨会话可撞，全局唯一由 daemon 单点保证；resolve 后即删
   *  （重复回执 404 的判据） */
  private readonly pending = new Map<string, PendingEntry>();
  private pendingSeq = 0;
  /** pty 面（G8b T3）：daemon 持 manager（serve 分层——session.ts 不引 pty，会话回收由 daemon
   *  在 delete/teardown 两处 killAllFor 插杀）；ptyId 铸造 `pty-<n>` 进程内单调、永不复用（防
   *  同 id 新会话撞旧缓冲/双连的竞态——T2 缓议裁定） */
  private readonly ptyManager = new PtyManager();
  private ptySeq = 0;
  /** pty 专用 WS 连接面：与事件面 wsClients 独立（不参与事件广播；复用 heartbeat ping + 同一
   *  wsLastPong 计时；daemon close 随 wss.close 一并退场） */
  private readonly ptySockets = new Set<WebSocket>();

  constructor(opts: GuiDaemonOpts) {
    this.staticRoot = opts.staticRoot ?? path.resolve('dist-gui');
    this.model = opts.model;
  }

  /**
   * 创建会话（spec §7）：root 存在性/目录校验（INVALID_ARG）→ 按 root 装配 SessionRuntime（同 root
   * 多会话允许——各自独立主链，Ruling 2）→ 入注册表（s<n> 进程内单调）→ 置激活。同时向
   * `resolveDataDir(root)/workspace.json` 落档 `{root}`（T2 工作区注册表：slug 单向哈希反解不了
   * root——落档供 GET /workspaces 读回真 root；历史工作区无此档降级 slug-only）。落档尽力而为：
   * 数据面不可写（只读 projects 根）不挡会话创建，/workspaces 对该工作区降级 slug-only 行。Result
   * 面：daemon 级 API（serve --root 预选/后续工作区注册表消费），HTTP 面映射 400/200。
   * G4：opts.mode='manual' 时向会话注入审批/问询两闭包——resolve 挂在 daemon 挂起表条目上 + 广播
   *  挂起帧（WS 消费面回执 POST /approval/:pid / /ask/:pid/reply）；缺省 dontAsk 零行为变化。
   * T2：出生即挂新 SessionJournal（`new SessionJournal(dataDir)` 惰性建档——首 run 首条 chain append
   *  才落盘建新档，档 id 同源 newSessionId()；空会话零文件，TUI 惰性先例同构）——首 run 起链持久，
   *  后续 /sessions 列档与 attach 重开（chain 派生转录）可消费。
   */
  createSession(root: string, opts?: { mode?: 'dontAsk' | 'manual' }): Result<{ sessionId: string }> {
    const abs = path.resolve(root);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return fail('INVALID_ARG', `root does not exist: ${abs}`);
    }
    if (!st.isDirectory()) return fail('INVALID_ARG', `root is not a directory: ${abs}`);
    const dataDir = resolveDataDir(abs);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ root: abs }) + '\n', 'utf8');
    } catch {
      // 落档尽力：写失败只让 /workspaces 降级 slug-only，不影响会话装配
    }
    this.sessionSeq += 1;
    const id = `s${this.sessionSeq}`;
    // G5 ghost 硬化：asker/onAskUser 闭包经 session 后置引用（构造即赋值，闭包执行期才解引用）——
    // 注册挂起前查该会话 run 已中止：interrupt/reset/delete 的 denyPendingFor 回填发生在 abort 时点，
    // abort 之后才到达的 ask 是 ghost（表已清、无人再回填）——直接 deny/dismissed 不入表不广播
    let session: SessionRuntime | undefined;
    session = new SessionRuntime({
      id,
      root: abs,
      model: this.model,
      nextSeq: () => {
        this.seqCounter += 1;
        return this.seqCounter;
      },
      broadcast: (frame) => this.broadcastFrame(frame),
      ...(opts?.mode === 'manual'
        ? {
            mode: 'manual' as const,
            asker: (req: ApprovalRequest): Promise<ApprovalDecision> =>
              session !== undefined && session.isAborted()
                ? Promise.resolve('deny')
                : new Promise((resolve) => {
                    const pid = this.nextPendingId();
                    this.pending.set(pid, { kind: 'approval', sessionId: id, req, resolve });
                    this.broadcastFrame({ kind: 'approval', sessionId: id, pid, req });
                  }),
            onAskUser: (req: AskUserRequest): Promise<AskUserAnswer> =>
              session !== undefined && session.isAborted()
                ? Promise.resolve({ type: 'dismissed' })
                : new Promise((resolve) => {
                    const pid = this.nextPendingId();
                    this.pending.set(pid, { kind: 'ask', sessionId: id, req, resolve });
                    this.broadcastFrame({ kind: 'ask', sessionId: id, pid, req });
                  }),
          }
        : {}),
    });
    this.sessions.set(id, session);
    this.active = id;
    // T2 出生 journal：挂载即接 onContextChange 续写链（惰性建档，见 createSession 注释）
    session.attachJournal(new SessionJournal(dataDir));
    return ok({ sessionId: id });
  }

  /**
   * attach 恢复（spec §7 / T2 实装）：会话 root 的 dataDir 下定位 `<journalId>.jsonl`（未知 id
   * INVALID_ARG）→ parseJournalFile/reduceJournal（TUI /resume 同源）→ 版本守卫（≠1 拒载）→ 播种：
   * 链经 context.restoreSession 直注入（TUI resume 单点——比逐条 appendChain 多保真 compact 态且
   * 不触发变更订阅）、msg 行经 journalMessagesToEntries 映射入 transcript.seed → SessionJournal
   * attach 续挂 + SessionRuntime.attachJournal 挂订阅（后续 run 的 chain 行续落同档，teardown
   * seal）→ 置激活。双挂/运行中挂 INVALID_STATE（播种会击穿在飞 run 的链）。
   */
  attach(id: string, journalId: string): Result<{ sessionId: string }> {
    const session = this.sessions.get(id);
    if (session === undefined) return fail('INVALID_ARG', `unknown session: ${id}`);
    if (session.attachedJournalId !== undefined) return fail('INVALID_STATE', 'session already has an attached journal');
    if (session.status() === 'running') return fail('INVALID_STATE', 'cannot attach while a run is in progress');
    const dataDir = resolveDataDir(session.root);
    const file = path.join(sessionsDir(dataDir), `${journalId}.jsonl`);
    if (!fs.existsSync(file)) return fail('INVALID_ARG', `unknown journalId: ${journalId}`);
    const replay = reduceJournal(parseJournalFile(file).events);
    if (replay.version !== 1) return fail('INVALID_ARG', `unsupported journal version: ${String(replay.version)}`);
    session.runtime.harness.context.restoreSession({ chain: replay.chain, chainFrom: replay.chainFrom, compacted: replay.compacted });
    // 转录播种（Ruling 5 双源不重复）：msg 行在场（TUI 档）→ msg 派生；msg 行计数===0（daemon 会话
    // 档只落 chain）→ chain 行派生兜底（task→user 引用块 / reply→assistant / call+result 配对→tool）——
    // 两路径互斥，零重复
    const msgs = journalMessagesToEntries(replay.messages);
    session.transcript.seed(msgs.length > 0 ? msgs : chainStepsToEntries(replay.chain));
    const journal = new SessionJournal(dataDir);
    journal.attach(journalId);
    session.attachJournal(journal);
    this.active = id;
    return ok({ sessionId: id });
  }

  /** 会话外窥（测试/后续 T2+ 端点消费）：未知 id 回 undefined */
  get(id: string): SessionRuntime | undefined {
    return this.sessions.get(id);
  }

  /** 激活会话 id（无会话时 undefined——裸端点 409 的判据） */
  activeId(): string | undefined {
    return this.active;
  }

  /** 挂起 id 铸造单点（G4）：daemon 级单调 `p<n>`（全局唯一，见 pending 字段注） */
  private nextPendingId(): string {
    this.pendingSeq += 1;
    return `p${this.pendingSeq}`;
  }

  /** 会话维挂起回填（G4 裁定 3：interrupt/reset=deny 回填——TUI approval.ts 先例）：该会话全部未决
   *  approval→deny、ask→dismissed 并清表；不发 notice（中止路径的观察行由 run 自身事件面承载） */
  private denyPendingFor(sessionId: string): void {
    for (const [pid, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(pid);
      if (entry.kind === 'approval') entry.resolve('deny');
      else entry.resolve({ type: 'dismissed' });
    }
  }

  /** 全表回填（close 序步骤 0，同构裁定 3——分会话 denyPendingFor 的全表形态） */
  private denyAllPending(): void {
    for (const [pid, entry] of this.pending) {
      this.pending.delete(pid);
      if (entry.kind === 'approval') entry.resolve('deny');
      else entry.resolve({ type: 'dismissed' });
    }
  }

  /** 回执落档单点（G4 裁定 1 尾项）：notice 事件帧经该会话 pump——入转录/环形缓冲/广播三面（粗归档
   *  可见，不发明新事件型）；会话已不在（理论上不可达——挂起条目随会话存续）静默跳过 */
  private noticePending(entry: PendingEntry, text: string): void {
    this.sessions.get(entry.sessionId)?.pump({ type: 'notice', text, ts: Date.now() });
  }

  /** 泵广播面（daemon 级单点）：帧序列化一次逐连接 send——同一连接的帧恒按 pump 调用序到达（ws
   *  内部发送缓冲有序，无需额外队列）；连接层按 sessionId 分发/过滤（T3）。G4：签名放宽至 DaemonFrame
   *  全并集（挂起/reset 帧与事件帧共用本序列化路径） */
  private broadcastFrame(frame: DaemonFrame): void {
    if (this.wsClients.size === 0) return;
    const json = JSON.stringify(frame);
    for (const ws of this.wsClients) ws.send(json);
  }

  /**
   * 启动 HTTP 控制面：恒绑 127.0.0.1（§4.3 裁定——远程暴露为 v1 非目标，bind 面=鉴权面的第一道）；
   * port 0 = 系统分配临时端口，回执返回实际监听值（测试并行不撞口）。
   */
  async start(opts?: GuiDaemonStartOpts): Promise<GuiDaemonHandle> {
    const token = opts?.token ?? crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => this.dispatch(req, res, token));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts?.port ?? 0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.wss = this.attachWs(server, token);
    // 静态面探测（启动一次，缓存布尔）：index.html 在场才挂静态——缺场 GET 保持 G1 的 404+hint 原样
    this.staticReady = fs.existsSync(path.join(this.staticRoot, 'index.html'));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('GuiDaemon: listen address unavailable');
    return { port: addr.port, token, close: () => this.close() };
  }

  /** WS 面装配：http server 'upgrade' → 鉴权双形态（§4.3 Bearer 头，G2 增补浏览器路径
   *  `Sec-WebSocket-Protocol: bearer.<token>`——浏览器 WebSocket API 不能自定义请求头，token 只能
   *  借 subprotocol 名携带）→ wss.handleUpgrade 接管；noServer 形态复用同一 http server（端口不另开）。
   *  G8b T3：`^/session/:sid/pty/:ptyId` 路径分支到 pty 专用连接（帧协议 replay/data/exit/error 与
   *  事件面完全不同，不分支会串协议）；鉴权同双形态先行。
   *  升级响应回显由 ws 库默认行为承担：completeUpgrade 未设 handleProtocols 时取请求协议列表首个
   *  （websocket-server.js `protocols.values().next().value`）写回 Sec-WebSocket-Protocol——客户端
   *  恰好只带一个协议（bearer.<token>），回显即原值，客户端 ws.protocol 可直接校验。30s ping 保活
   *  计时器在此启动，close 时清 */
  private attachWs(server: http.Server, token: string): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const viaHeader = req.headers.authorization === `Bearer ${token}`;
      const viaSubprotocol = req.headers['sec-websocket-protocol'] === `bearer.${token}`;
      // teardown 已启动即不再收新连接（WS 先于 server close 退场，此处与鉴权失败同拒升级）
      if (this.closePromise || (!viaHeader && !viaSubprotocol)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const m = /^\/session\/([^/]+)\/pty\/([^/]+)$/.exec(pathname);
      if (m) {
        // 段解码失败按字面处理（get 未命中 → error 帧，fail-closed 不放行错位寻址）
        wss.handleUpgrade(req, socket, head, (ws) => this.onPtyConnection(ws, safeDecode(m[1]), safeDecode(m[2])));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onWsConnection(ws));
    });
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    return wss;
  }

  /** 连接生命周期：入 Set（广播面）→ 补发全部会话缓冲 + 重发全部未决挂起帧（G4 裁定 4）→ pong 记时/
   *  close 清理。补发在 upgrade 回调内同步完成，与后续实时帧（pump 单点）天然无交错——逐会话帧序=缓冲
   *  序接事件序；T1 裁定：全部会话（s1..sN 会话序，各内缓冲序），客户端按帧面 sessionId 过滤（T3
   *  onSessionEvent）——不收 `{"kind":"listen"}` 订阅消息（帧全带 sessionId 客户端自滤）。
   *  挂起重发无 seq：同 pid 帧可能重复到达（首播+重连），客户端以 pid 去重幂等（G4） */
  private onWsConnection(ws: WebSocket): void {
    this.wsClients.add(ws);
    this.wsLastPong.set(ws, Date.now());
    ws.on('pong', () => this.wsLastPong.set(ws, Date.now()));
    // error 必须挂 listener（EventEmitter 契约）：socket 错误细节不倒面，close 统一走清理
    ws.on('error', () => {});
    ws.on('close', () => this.wsClients.delete(ws));
    for (const session of this.sessions.values()) {
      for (const f of session.bufferedFrames()) ws.send(JSON.stringify(f));
    }
    for (const [pid, entry] of this.pending) ws.send(JSON.stringify(pendingFrameOf(pid, entry)));
  }

  /** pty 专用 WS 连接生命周期（G8b T3，帧协议逐字 spec §终端目录）：
   *  - 未知 ptyId：升级后即发 `{"t":"error","message":"pty not found"}` 后 close(1008)
   *  - attach 即重放：首帧 `{"t":"replay","b":base64(环形缓冲)}`（断线重连重放，U-D5）
   *  - 下行：onData → `{"t":"data","b"}` / onExit → `{"t":"exit","code"}` + ws.close(1000)
   *  - 上行：`{"t":"in","b"}` → write（base64 解 UTF-8）/ `{"t":"resize","cols","rows"}` → resize
   *    （正整数校验，坏帧/非法形态静默忽略）
   *  - ws close ≠ kill：断线保活（kill 只走 DELETE / 两处 teardown 插杀），重连靠 replay 补窗；
   *    T2 回调不可注销——close 置 attached=false 门 + sendPtyFrame readyState 判存双保险
   *  - resize/write 对已退出会话是 no-op（T2 内建防崩，daemon 侧不 try/catch） */
  private onPtyConnection(ws: WebSocket, _sessionId: string, ptyId: string): void {
    const pty = this.ptyManager.get(ptyId);
    ws.on('error', () => {}); // EventEmitter 契约：挂空 listener，socket 错误细节不倒面（同 onWsConnection）
    if (pty === undefined) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'error', message: 'pty not found' }));
      ws.close(1008);
      return;
    }
    this.ptySockets.add(ws);
    this.wsLastPong.set(ws, Date.now());
    ws.on('pong', () => this.wsLastPong.set(ws, Date.now()));
    ws.send(JSON.stringify({ t: 'replay', b: Buffer.from(pty.replay(), 'utf8').toString('base64') }));
    let attached = true;
    pty.onData((d) => {
      if (attached) sendPtyFrame(ws, { t: 'data', b: Buffer.from(d, 'utf8').toString('base64') });
    });
    pty.onExit((code) => {
      if (!attached) return;
      sendPtyFrame(ws, { t: 'exit', code });
      ws.close(1000);
    });
    ws.on('message', (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // 坏帧忽略：非 JSON/半截帧静默丢弃
      }
      const f = frame as { t?: unknown; b?: unknown; cols?: unknown; rows?: unknown } | null;
      if (f === null || typeof f !== 'object') return;
      if (f.t === 'in' && typeof f.b === 'string') {
        pty.write(Buffer.from(f.b, 'base64').toString('utf8'));
        return;
      }
      if (f.t === 'resize' && Number.isInteger(f.cols) && (f.cols as number) > 0 && Number.isInteger(f.rows) && (f.rows as number) > 0) {
        pty.resize(f.cols as number, f.rows as number);
      }
    });
    ws.on('close', () => {
      attached = false;
      this.ptySockets.delete(ws);
    });
  }

  /** 保活心跳：逐连接判活——pong 静默超 60s 即 terminate（close 事件统一清理 Set），否则发 ping；
   *  G8b T3：pty 专用 WS 共用本面（ptySockets 独立 Set + 同一 wsLastPong 计时） */
  private heartbeat(): void {
    const now = Date.now();
    for (const ws of this.wsClients) this.beat(ws, now);
    for (const ws of this.ptySockets) this.beat(ws, now);
  }

  /** 单连接保活判定（heartbeat 内联步）：超时 terminate / 存活 ping */
  private beat(ws: WebSocket, now: number): void {
    if (now - (this.wsLastPong.get(ws) ?? now) > PONG_TIMEOUT_MS) {
      ws.terminate();
      return;
    }
    ws.ping();
  }

  /** 幂等 teardown：单次化落链（closePromise 守卫），升级拒绝面同判 */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.teardown();
    return this.closePromise;
  }

  /** daemon 收口序（平移扩展为全会话形态）：0) 全会话在跑 run 即刻中止 + 有界等待 settle（并发）→
   *  1) WS 面收 → 2) HTTP server 收 → 3) 全会话运行时内脏收口（stopAll→drain→mcpClose，并发）。
   *  网络面先行关闭——不再接受新请求/新连接、在跑 run 中止后再动运行时内脏（逐会话收口序在会话维
   *  保序，daemon 维网络面插在两相之间）；细节裁定见各步骤行内注释 */
  private async teardown(): Promise<void> {
    // 0) 挂起全表回填（G4 裁定 3）：悬挂的 asker promise 先落 deny/dismissed——被中止 run 才能在
    //    有界窗口内真正 settle
    this.denyAllPending();
    // 0b) 全会话在跑 run 即刻中止（并发）：与单会话序同理——悬挂 run 的 promise 会拖住事件循环/测试
    //    收口；每会话有界等待 2s（Promise.all 并发不叠加）
    await Promise.all([...this.sessions.values()].map((s) => s.abortAndSettle()));
    // 0c) pty 全量插杀（G8b T3，teardown 插杀处之二）：逐会话 killAllFor 覆盖全部条目（owner 恒为
    //     会话 id——daemon 持 manager、session.ts 不引 pty 的 serve 分层面）。kill 同步注销，exit 帧
    //     异步送达在线 pty WS（尽力投递，网络面下一拍收口）；防孤儿 conpty 拖住 daemon close
    for (const id of [...this.sessions.keys()]) this.ptyManager.killAllFor(id);
    // 1) WS 面先收：停 ping 计时器，逐连接 1001 Going Away 后 wss.close——先于 HTTP server close，
    //    升级连接与请求连接同序退场，server close 时无存活的升级套接字拖尾；pty 专用 WS（ptySockets）
    //    同拍退场（wss.close 统一收口两面的连接）
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    const wss = this.wss;
    if (wss) {
      for (const ws of this.wsClients) ws.close(1001);
      for (const ws of this.ptySockets) ws.close(1001);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      this.wsClients.clear();
      this.ptySockets.clear();
    }
    // 2) HTTP server 先收：close 停接新连接，closeAllConnections 掐掉存活的 keep-alive 空闲连接——
    //    否则 undici 连接池的滞留套接字会让 close 回调悬到超时，teardown 时序不可控
    const srv = this.server;
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
    }
    // 3) 全会话运行时内脏收口（并发）：stopAll → drain → mcpClose（序同 CLI teardownCliRun 现场）
    await Promise.all([...this.sessions.values()].map((s) => s.dispose()));
  }

  /** 内部路由表（T1 会话中心：会话维端点 + 裸端点激活别名；G2 /snapshot、G3 /steer 平移）；
   *  静态资源走 dispatch 的 GET 兜底分支，不占路由表 */
  private readonly routes: ReadonlyArray<Route> = [
    { method: 'GET', path: '/healthz', auth: false, run: async (_req, res) => this.send(res, 200, { ok: true }) },
    { method: 'POST', path: '/session/new', auth: true, run: (req, res) => this.handleSessionNew(req, res) },
    { method: 'POST', path: '/session/:id/submit', auth: true, run: (req, res, p) => this.handleSubmit(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer', auth: true, run: (req, res, p) => this.handleSteer(req, res, p.id) },
    { method: 'POST', path: '/session/:id/interrupt', auth: true, run: async (_req, res, p) => this.handleInterrupt(res, p.id) },
    { method: 'POST', path: '/session/:id/reset', auth: true, run: async (_req, res, p) => this.handleReset(res, p.id) },
    { method: 'GET', path: '/session/:id/snapshot', auth: true, run: async (_req, res, p) => this.handleSnapshot(res, p.id) },
    // G6 文件预览面：会话 root 内只读文本预览（Files 页消费；判界/二进制/512KB 截断语义见 handleFile）
    { method: 'GET', path: '/session/:id/file', auth: true, run: async (req, res, p) => this.handleFile(req, res, p.id) },
    // G7 diff 面：write 调用 pre-image ↔ 磁盘现文件双内容（Chat write 展开消费；查询面见 handleDiff）
    { method: 'GET', path: '/session/:id/diff', auth: true, run: async (req, res, p) => this.handleDiff(req, res, p.id) },
    // G8b T4 tree 面：会话 root 内单层目录列举（Files 页树消费；忽略集/500 上限/判界语义见 handleTree）
    { method: 'GET', path: '/session/:id/tree', auth: true, run: async (req, res, p) => this.handleTree(req, res, p.id) },
    // G5 看板服务面：lead 审批映射（gated 审批解锁 / in-review 关单——GUI Board 页消费）
    { method: 'POST', path: '/session/:id/board/review', auth: true, run: (req, res, p) => this.handleBoardReview(req, res, p.id) },
    { method: 'POST', path: '/session/:id/attach', auth: true, run: (req, res, p) => this.handleAttach(req, res, p.id) },
    // T2 会话回收：running 409（先收 run 再删）；journal 文件保留（磁盘档案非 daemon 生命周期资产）
    { method: 'POST', path: '/session/:id/delete', auth: true, run: async (_req, res, p) => this.handleDelete(res, p.id) },
    // G8b T3 pty 面：分配（shell 探测 daemon 内定，cols/rows 缺省 80/24）+ kill（幂等）
    { method: 'POST', path: '/session/:id/pty', auth: true, run: (req, res, p) => this.handlePtyAlloc(req, res, p.id) },
    { method: 'DELETE', path: '/session/:id/pty/:ptyId', auth: true, run: async (_req, res, p) => this.handlePtyKill(res, p.id, p.ptyId) },
    // G4 挂起回执面：pid 为 daemon 级挂起票据（会话无关路由——pid 本身寻址，无会话维前缀）
    { method: 'POST', path: '/approval/:pid', auth: true, run: (req, res, p) => this.handleApprovalReply(req, res, p.pid) },
    { method: 'POST', path: '/ask/:pid/reply', auth: true, run: (req, res, p) => this.handleAskReply(req, res, p.pid) },
    // T2 工作区注册表 + 恢复面：workspaces 扫描 / sessions 列档 / dirpicker 目录选择
    { method: 'GET', path: '/workspaces', auth: true, run: async (_req, res) => this.handleWorkspaces(res) },
    { method: 'GET', path: '/sessions', auth: true, run: async (req, res) => this.handleSessions(req, res) },
    { method: 'GET', path: '/dirpicker', auth: true, run: async (req, res) => this.handleDirpicker(req, res) },
    // 裸端点 = 激活会话别名（G3 兼容裁定：G2 gui 面不破，v1.x 移除）；无 active 409
    { method: 'POST', path: '/submit', auth: true, run: (req, res) => this.handleSubmit(req, res, undefined) },
    { method: 'POST', path: '/steer', auth: true, run: (req, res) => this.handleSteer(req, res, undefined) },
    { method: 'POST', path: '/interrupt', auth: true, run: async (_req, res) => this.handleInterrupt(res, undefined) },
    { method: 'GET', path: '/snapshot', auth: true, run: async (_req, res) => this.handleSnapshot(res, undefined) },
  ];

  /** 路由匹配（段参数 :name）：段数与字面段全等才命中；参数段解码（失败按字面处理，不命中） */
  private matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const segs = pathname.split('/').filter((s) => s.length > 0);
    for (const route of this.routes) {
      const rSegs = route.path.split('/').filter((s) => s.length > 0);
      if (route.method !== method || rSegs.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let hit = true;
      for (let i = 0; i < rSegs.length; i++) {
        if (rSegs[i].startsWith(':')) {
          try {
            params[rSegs[i].slice(1)] = decodeURIComponent(segs[i]);
          } catch {
            params[rSegs[i].slice(1)] = segs[i];
          }
        } else if (rSegs[i] !== segs[i]) {
          hit = false;
          break;
        }
      }
      if (hit) return { route, params };
    }
    return undefined;
  }

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const matched = this.matchRoute(req.method ?? 'GET', url.pathname);
    if (matched) {
      // 鉴权（§4.3）：除 healthz 外恒验 Bearer token，且先于会话解析（401 面不泄露会话语义）——恒时
      // 比较不做（token 非密钥材料，回环面时序侧信道无实义）
      if (matched.route.auth && req.headers.authorization !== `Bearer ${token}`) {
        this.send(res, 401, { error: 'unauthorized' });
        return;
      }
      matched.route.run(req, res, matched.params).catch((err) => {
        console.error('[serve] handler error:', err);
        if (!res.headersSent) this.send(res, 500, { error: 'internal error' });
        else res.end();
      });
      return;
    }
    // API 未命中的 GET 且静态产物在场（G3 静态挂载）：安全拼接 + mime + SPA 兜底；仅 GET（HEAD/POST 不挂）
    if (req.method === 'GET' && this.staticReady) {
      this.handleStatic(url.pathname, res).catch((err) => {
        console.error('[serve] static error:', err);
        if (!res.headersSent) this.send(res, 500, { error: 'internal error' });
        else res.end();
      });
      return;
    }
    // 静态缺失提示（G1 裁定：恒定 hint；GET/POST 未知路径统一带 hint）
    this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
  }

  /** 静态文件面（G3）：pathname → 解码（%2E%2E 类编码穿越在 URL 解析后才现形）→ join+normalize →
   *  必须仍在 staticRoot 内（前缀判定含分隔符，root 本体即 / 兜底 index.html）→ 未命中（缺失/目录）
   *  落 SPA 兜底 index.html，兜底亦缺才 404+hint。穿越越界直接 404——不落 SPA 兜底（防以 200 html
   *  掩盖探测）。免鉴权：GUI 壳非密钥材料，token 只保 API 面 */
  private async handleStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
      return;
    }
    const target = path.normalize(path.join(this.staticRoot, rel));
    if (target !== this.staticRoot && !target.startsWith(this.staticRoot + path.sep)) {
      this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
      return;
    }
    const data = await readStaticFile(target);
    if (data !== null) {
      res.writeHead(200, { 'content-type': mimeOf(target) });
      res.end(data);
      return;
    }
    const index = await readStaticFile(path.join(this.staticRoot, 'index.html'));
    if (index !== null) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(index);
      return;
    }
    this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
  }

  /** body 读取 + JSON 解析：解析失败/超限统一以 {status, error} 回执，不抛出（dispatch 已兜 500，此处提前收口带准确码） */
  private async readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'payload too large' };
      chunks.push(chunk as Buffer);
    }
    try {
      return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { ok: false, status: 400, error: 'invalid json body' };
    }
  }

  /** 会话解析单点：id=undefined 走激活别名（无 active 409 {no active session}——G3 裸端点兼容裁定）；
   *  显式 id 未知 404 {unknown session}。响应已发即回 undefined（调用方直返） */
  private sessionFor(res: http.ServerResponse, id: string | undefined): SessionRuntime | undefined {
    if (id === undefined) {
      const active = this.active !== undefined ? this.sessions.get(this.active) : undefined;
      if (active === undefined) {
        this.send(res, 409, { error: 'no active session' });
        return undefined;
      }
      return active;
    }
    const session = this.sessions.get(id);
    if (session === undefined) {
      this.send(res, 404, { error: 'unknown session' });
      return undefined;
    }
    return session;
  }

  /** POST /session/new {root, mode?}（spec §4.1）：root 必填（无 root 400+迁移提示——旧裸软重置语义让位
   *  /session/:id/reset）；可选 mode:'manual' 透传 createSession（G4 补面：HTTP 建 manual 会话——CLI
   *  --manual 只作用预选会话,无此面 e2e/客户端无法经 HTTP 装配 manual;其余值含缺省 = dontAsk 零变化）；
   *  createSession 单点（存在性/目录校验 INVALID_ARG → 400）→ 200 {ok,sessionId} */
  private async handleSessionNew(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const root = (parsed.body as { root?: unknown } | null)?.root;
    if (typeof root !== 'string' || root.length === 0) {
      this.send(res, 400, { error: ROOT_REQUIRED_HINT });
      return;
    }
    const mode = (parsed.body as { mode?: unknown } | null)?.mode;
    // G5 白名单收紧：undefined|'dontAsk'|'manual' 之外一律 400 恒定文案（此前静默按 dontAsk 装配——
    //  传 mode:'auto' 的客户端拿到的是 dontAsk 会话，审批行为与预期不符且无提示）
    if (mode !== undefined && mode !== 'manual' && mode !== 'dontAsk') {
      this.send(res, 400, { error: 'invalid mode' });
      return;
    }
    const r = this.createSession(root, mode === 'manual' ? { mode: 'manual' } : undefined);
    if (!r.ok) {
      this.send(res, 400, { error: r.error.message });
      return;
    }
    this.send(res, 200, { ok: true, sessionId: r.value.sessionId });
  }

  /** submit 处理（会话维 + 裸别名共用）：goal 非空 string 校验 → 会话 run 锁（409 拒二次提交）→
   *  202 即回（受理面；run 异步收束细节见 SessionRuntime.submit） */
  private async handleSubmit(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const goal = (parsed.body as { goal?: unknown } | null)?.goal;
    if (typeof goal !== 'string' || goal.length === 0) {
      this.send(res, 400, { error: 'goal must be a non-empty string' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const r = session.submit(goal);
    if (!r.ok) {
      this.send(res, r.status, { error: r.error });
      return;
    }
    this.send(res, 202, { ok: true });
  }

  /** interrupt 处理：无在跑 run 409；中止信号发出即 200（run 以 stopReason=interrupted 收束后清锁）。
   *  G4 裁定 3：中止后该会话全部未决挂起以 deny/dismissed 回填并清表——asker promise 不回填则被中止
   *  run 永不收束（僵尸 run） */
  private handleInterrupt(res: http.ServerResponse, id: string | undefined): void {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const r = session.interrupt();
    if (!r.ok) {
      this.send(res, 409, { error: r.error });
      return;
    }
    this.denyPendingFor(session.id);
    this.send(res, 200, { ok: true });
  }

  /** steer 处理（G3）：text 非空 string 校验（空白串与 enqueue 的 trim-忽略口径一致前置拒——静默
   *  no-op 的 200 比显式 400 更糟）→ 入该会话 steering → 恒 200 {ok:true}，无 409 分径（裁定：
   *  steering 非独占面，排队语义即承诺） */
  private async handleSteer(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const text = (parsed.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      this.send(res, 400, { error: 'text must be a non-empty string' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    session.steer(text);
    this.send(res, 200, { ok: true });
  }

  /** reset 处理（旧 /session/new 软重置语义迁入）：中止在跑 run + 换新运行时 + 清投影/转录/缓冲，
   *  200 {ok:true}（语义面见 SessionRuntime.reset）。G4：中止前该会话挂起回填（deny/dismissed——
   *  同 interrupt 裁定 3，防僵尸 asker promise 拖住被中止 run）；收尾广播 `{kind:'reset', sessionId}`
   *  通知帧（裁定 7：GUI 清本地投影重播种；无 seq，不入单调序列） */
  private async handleReset(res: http.ServerResponse, id: string | undefined): Promise<void> {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    this.denyPendingFor(session.id);
    await session.reset();
    this.broadcastFrame({ kind: 'reset', sessionId: session.id });
    this.send(res, 200, { ok: true });
  }

  /** POST /approval/:pid {decision}（G4）：挂起表命中且 kind 对 → resolve + notice 事件帧（经该会话
   *  pump，转录可见）+ 200 {ok:true}；未知 pid / 已决（重复回执）/ kind 不符（ask 挂起错打 approval
   *  端点）统一 404；decision 非法字面 400（ApprovalDecision = 'allow'|'always'|'deny'） */
  private async handleApprovalReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const decision = (parsed.body as { decision?: unknown } | null)?.decision;
    if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') {
      this.send(res, 400, { error: 'decision must be one of: allow, always, deny' });
      return;
    }
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'approval') {
      this.send(res, 404, { error: 'unknown pending approval' });
      return;
    }
    this.pending.delete(pid);
    entry.resolve(decision);
    this.noticePending(entry, `approval ${pid} resolved: ${decision}`);
    this.send(res, 200, { ok: true });
  }

  /** POST /ask/:pid/reply {answer}（G4）：同构 approval 回执——AskUserAnswer 三态载荷校验（400）→
   *  命中且 kind 对 resolve + notice（`ask <pid> answered`）+ 200；未知/已决/kind 不符 404 */
  private async handleAskReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const answer = parseAskAnswer((parsed.body as { answer?: unknown } | null)?.answer);
    if (answer === null) {
      this.send(res, 400, { error: 'invalid answer: expected {type:"selected",labels} | {type:"custom",text} | {type:"dismissed"}' });
      return;
    }
    const entry = this.pending.get(pid);
    if (entry === undefined || entry.kind !== 'ask') {
      this.send(res, 404, { error: 'unknown pending ask' });
      return;
    }
    this.pending.delete(pid);
    entry.resolve(answer);
    this.noticePending(entry, `ask ${pid} answered`);
    this.send(res, 200, { ok: true });
  }

  /** snapshot 处理：会话快照单点（载荷形态见 SessionRuntime.snapshotResponse）。G5 增挂起段——
   *  daemon 侧合并（snapshotResponse 保持 session 内聚不持挂起表）：本会话过滤（entry.sessionId）
   *  → [{pid, kind, req}]（G7 增 req=挂起表 entry.req 直序列化——连接层 pid 去重拦了重连重发帧，
   *  snapshot.pending 是 GUI 刷新/reseed 后卡内容的唯一来源），跨会话卡恢复（GUI 刷新/重连后重放
   *  挂起面）的基座 */
  private handleSnapshot(res: http.ServerResponse, id: string | undefined): void {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const pending: SnapshotPendingRow[] = [...this.pending.entries()]
      .filter(([, entry]) => entry.sessionId === session.id)
      .map(([pid, entry]) => ({ pid, kind: entry.kind, req: entry.req }));
    this.send(res, 200, { ...session.snapshotResponse(), pending });
  }

  /** GET /session/:id/file?path=（G6 预览面，Files 页消费）：query path 必填（400）→ 会话解析
   *  （未知 :id 404）→ path.resolve(session.root, path) 归一（相对/绝对均可）→ 判界（本会话
   *  harness.safety 的路径判定面——insideTrustedRoots 单点，/diff 同口径）→ 越界 403 {path
   *  outside trusted roots} → readFileBounded（G7 抽取共用：missing 404 / binary 415 / >512KB
   *  截断 truncated:true）→ 200 {path, content, truncated?}。仅 GET（路由表 method 精确匹配） */
  private handleFile(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const q = url.searchParams.get('path');
    if (q === null || q.length === 0) {
      this.send(res, 400, { error: 'path query param required' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const abs = path.resolve(session.root, q);
    // 判界基准：目标经 realPathOf 归一（存在段 realpath，防符号链接逃逸——read 工具同口径）；
    // 归一不可得回退字面 abs（fail-closed：字面 isWithin 判定兜底，越界照拒）
    const real = realPathOf(abs) ?? abs;
    if (!insideTrustedRoots(session.runtime.harness.safety, real)) {
      this.send(res, 403, { error: 'path outside trusted roots' });
      return;
    }
    const read = readFileBounded(abs);
    if (read === 'missing') {
      this.send(res, 404, { error: 'not found' });
      return;
    }
    if (read === 'binary') {
      this.send(res, 415, { error: 'binary file' });
      return;
    }
    this.send(res, 200, { path: abs, content: read.content, ...(read.truncated ? { truncated: true } : {}) });
  }

  /** GET /session/:id/diff?callId=（G7 收口交接，Chat write 展开/Files 消费）：write 调用的
   *  pre-image ↔ 磁盘现文件双内容。查询面现场核结论——daemon 会话的 write 影子快照 drain 仅在
   *  dispose/reset（清单随 seal 落 journal），会话存续期内 sink 内存清单常驻：**run 中与 run 后
   *  均查内存实时可得**（blob 落盘 <dataDir>/sessions/_blobs/<sha256> 即时可见）。callId → 调用
   *  对位：帧缓冲（512 环）内按序扫 tool-call 帧——首枚命中 callId 的帧即目标（text=注册名须
   *  'write'，payload.input.path 解析绝对路径）；同路径此前 write 调用的位次=该次 pre-image 在
   *  sink 清单的序（nthFor 按调用序对位，同路径多次写各自取写前态）。响应
   *  200 {path, oldContent?, newContent, truncated?}：oldContent=sink pre-image blob（512KB 截断；
   *  新建写无 blob 缺场）；newContent=磁盘现文件（readFileBounded——判界/截断/二进制同 /file）；
   *  truncated=任一侧截断。404 面：未知会话 / callId 无帧（含缓冲环已裁）/ 非 write / 无快照
   *  （root 外写不入清单）→ {error:'no snapshot'}；400：缺 callId。帧环裁剪的退化：目标帧若已被
   *  环裁（>512 事件）即 404——GUI 退单列现内容（调用方回执 input.content），记档报告 */
  private handleDiff(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const callId = url.searchParams.get('callId');
    if (callId === null || callId.length === 0) {
      this.send(res, 400, { error: 'callId query param required' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    // 帧 copy 一致性：扫描与位次计数同一快照（bufferedFrames 每调用新数组，两遍扫同一引用）
    const frames = session.bufferedFrames();
    /** 目标帧定位：首枚 callId 命中的 tool-call（text=注册名，payload.input 形态现场核 batch-runner：
     *  emit('tool-call', name, {input, callId, status})） */
    let targetSeq = -1;
    let targetAbs: string | undefined;
    for (const f of frames) {
      const e = f.e;
      if (e.type !== 'tool-call') continue;
      const p = e.payload as { callId?: unknown } | undefined;
      if (p?.callId !== callId) continue;
      if (e.text !== 'write') {
        this.send(res, 404, { error: 'no snapshot' }); // 命中 callId 但非 write——无 pre-image 面
        return;
      }
      const inPath = (e.payload as { input?: unknown } | undefined)?.input;
      const p2 = inPath !== null && typeof inPath === 'object' ? (inPath as { path?: unknown }) : undefined;
      if (typeof p2?.path !== 'string' || p2.path.length === 0) {
        this.send(res, 404, { error: 'no snapshot' }); // 坏参调用（argsOf null 面）——无快照可查
        return;
      }
      targetAbs = path.resolve(session.root, p2.path);
      targetSeq = f.seq;
      break;
    }
    if (targetAbs === undefined || targetSeq < 0) {
      this.send(res, 404, { error: 'no snapshot' }); // 无帧命中（未知 callId/帧环已裁）
      return;
    }
    /** 调用序位次：同路径（resolve 归一后等值）且先于目标的 write 调用数 + 1（sink 清单内的序） */
    let ordinal = 1;
    for (const f of frames) {
      if (f.seq >= targetSeq) break;
      const e = f.e;
      if (e.type !== 'tool-call' || e.text !== 'write') continue;
      const inPath = (e.payload as { input?: unknown } | undefined)?.input;
      const p = inPath !== null && typeof inPath === 'object' ? (inPath as { path?: unknown }) : undefined;
      if (typeof p?.path === 'string' && p.path.length > 0 && path.resolve(session.root, p.path) === targetAbs) ordinal += 1;
    }
    const sink = session.runtime.harness.writeSnapshot;
    const entry = sink.nthFor(targetAbs, ordinal);
    if (entry === undefined) {
      this.send(res, 404, { error: 'no snapshot' }); // root 外写不入清单/序越界——同恒定文案
      return;
    }
    // 判界同 /file：pre-image 在场 ⇒ 写时路径在 root 内，此处防符号链接逃逸（现文件读侧）
    const real = realPathOf(targetAbs) ?? targetAbs;
    if (!insideTrustedRoots(session.runtime.harness.safety, real)) {
      this.send(res, 403, { error: 'path outside trusted roots' });
      return;
    }
    // oldContent：pre-image blob（新建写 entry.deleted 缺场；读侧 512KB 截断）
    let oldContent: string | undefined;
    let truncated = false;
    if (entry.deleted !== true && entry.hash.length > 0) {
      const blob = sink.readBlob(entry.hash);
      if (blob !== null) {
        truncated = blob.length > MAX_PREVIEW_BYTES;
        oldContent = blob.subarray(0, MAX_PREVIEW_BYTES).toString('utf8');
      }
    }
    // newContent：磁盘现文件（判界/截断/二进制同 /file——readFileBounded 单点）
    const read = readFileBounded(targetAbs);
    if (read === 'missing') {
      this.send(res, 404, { error: 'not found' });
      return;
    }
    if (read === 'binary') {
      this.send(res, 415, { error: 'binary file' });
      return;
    }
    truncated = truncated || read.truncated;
    this.send(res, 200, {
      path: targetAbs,
      ...(oldContent !== undefined ? { oldContent } : {}),
      newContent: read.content,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  /** GET /session/:id/tree?path=<rel>（G8b T4 目录树面，Files 页消费）：path 缺省 ''=会话 root →
   *  判界样板同 /file（realPathOf 归一 ?? 字面兜底 → insideTrustedRoots，越界 403 恒定文案）→
   *  statSync 跟随后实态（不存在 404 / 非目录 400）→ readdirSync withFileTypes 单层列举：IGNORED
   *  名不枚举；symlink/junction 条目按跟随实态分型（dirent 对链接按链接本体分类——指向目录的
   *  链接 isDirectory()=false，win32 junction 同理，须 statSync 校正；断链/竞态消失的条目跳过）；
   *  排序=目录段先于文件段、同段 name 码点序；超 TREE_MAX_ENTRIES 截断+truncated:true →
   *  200 {entries:[{name,kind:'dir'|'file'}],truncated?} */
  private handleTree(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = url.searchParams.get('path') ?? ''; // 缺 path 与 ?path= 空串同义=会话 root
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const abs = path.resolve(session.root, rel);
    // 判界基准同 /file：目标经 realPathOf 归一（存在段 realpath 防符号链接逃逸）；归一不可得回退
    // 字面 abs（fail-closed：字面 isWithin 判定兜底，越界照拒）
    const real = realPathOf(abs) ?? abs;
    if (!insideTrustedRoots(session.runtime.harness.safety, real)) {
      this.send(res, 403, { error: 'path outside trusted roots' });
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(abs); // 跟随后实态：指向目录的链接本身就是目录（root 即此口径进入）
    } catch {
      this.send(res, 404, { error: 'not found' });
      return;
    }
    if (!st.isDirectory()) {
      this.send(res, 400, { error: 'not a directory' });
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      this.send(res, 404, { error: 'not found' }); // stat 在场但列举失败（权限面/竞态删除）：fail-closed 归 404
      return;
    }
    const entries: Array<{ name: string; kind: 'dir' | 'file' }> = [];
    for (const d of dirents) {
      if (IGNORED.has(d.name)) continue;
      // 分型：真实目录/文件直取 dirent；链接（及其它非常规实体——socket/fifo）dirent 按链接本体
      // 分类（指向目录的链接 isDirectory()=false），statSync 跟随实态校正——断链/竞态消失/跟随落空
      // 既非 dir 又非 file 的条目不枚举
      let kind: 'dir' | 'file' | undefined = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : undefined;
      if (kind === undefined) {
        try {
          const follow = fs.statSync(path.join(abs, d.name));
          kind = follow.isDirectory() ? 'dir' : follow.isFile() ? 'file' : undefined;
        } catch {
          kind = undefined;
        }
      }
      if (kind !== undefined) entries.push({ name: d.name, kind });
    }
    // 排序口径：目录段先于文件段，同段内 name 码点序（显式 </> 而非 localeCompare——后者随区域/ICU
    // 漂移，树呈现需跨机确定性；混合大小写段的码点序稳定可预测，目录先序在段级优先）
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    const truncated = entries.length > TREE_MAX_ENTRIES;
    if (truncated) entries.length = TREE_MAX_ENTRIES; // 截断保序：裁尾，前 500 条维持排序面
    this.send(res, 200, { entries, ...(truncated ? { truncated: true } : {}) });
  }

  /** POST /session/:id/board/review {taskId, approved}（G5 看板服务面）：body 校验（taskId 非空
   *  string + approved boolean → 400）→ 该会话 taskboard.review 双语义（gated → 审批：approved
   *  解锁派发 / 拒绝维持；in-review → 关单：approved=done / 拒=failed）→ r.ok 200 {ok:true} /
   *  fail 400 {error: r.error.message}（未知任务/状态不符直译）；未知 :id 404（sessionFor 单点）。
   *  review 触发的 gate-resolved/task-status 事件经该会话 pump 自然广播（既有链，零新协议） */
  private async handleBoardReview(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const body = parsed.body as { taskId?: unknown; approved?: unknown } | null;
    if (typeof body?.taskId !== 'string' || body.taskId.length === 0 || typeof body.approved !== 'boolean') {
      this.send(res, 400, { error: 'taskId must be a non-empty string and approved must be a boolean' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    const r = session.runtime.harness.taskboard.review(body.taskId, { approved: body.approved });
    if (!r.ok) {
      this.send(res, 400, { error: r.error.message });
      return;
    }
    this.send(res, 200, { ok: true });
  }

  /** POST /session/:id/attach {journalId}（T2）：journalId 非空 string 校验 → 未知 :id 404 →
   *  attach 单点（INVALID_ARG→400 / INVALID_STATE→409）→ 200 {ok,sessionId}（并置激活） */
  private async handleAttach(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const journalId = (parsed.body as { journalId?: unknown } | null)?.journalId;
    if (typeof journalId !== 'string' || journalId.length === 0) {
      this.send(res, 400, { error: 'journalId must be a non-empty string' });
      return;
    }
    if (this.sessions.get(id) === undefined) {
      this.send(res, 404, { error: 'unknown session' });
      return;
    }
    const r = this.attach(id, journalId);
    if (!r.ok) {
      this.send(res, r.error.code === 'INVALID_STATE' ? 409 : 400, { error: r.error.message });
      return;
    }
    this.send(res, 200, { ok: true, sessionId: r.value.sessionId });
  }

  /** POST /session/:id/delete（T2 会话回收，GUI Home 消费）：未知 :id 404；running 409（回收前必须
   *  先收 run——teardown 会中止在跑 run，静默中止比显式 409 更糟）；idle → 有界 teardown（该会话
   *  挂起回填 deny/dismissed（同 interrupt 裁定 3，防僵尸 asker）+ abortAndSettle + dispose（含
   *  journal seal））→ 注册表移出（后续 :id 访问 404、WS 补发不再含该会话）；active 指向该会话即清
   *  undefined（裸端点回 409 面）；journal 文件保留——磁盘档案非 daemon 生命周期资产，/sessions 列档
   *  与后续 attach 重开仍可消费 */
  private async handleDelete(res: http.ServerResponse, id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      this.send(res, 404, { error: 'unknown session' });
      return;
    }
    if (session.status() === 'running') {
      this.send(res, 409, { error: 'cannot delete while a run is in progress' });
      return;
    }
    this.denyPendingFor(id);
    await session.teardown();
    this.sessions.delete(id);
    // G8b T3 插杀（单会话回收处）：会话回收连带清杀其全部 pty（daemon 持 manager——serve 分层，
    // session.ts 不引 pty）；kill 同步注销 → 该会话 pty 的后续 WS 连入收 error 'pty not found'
    this.ptyManager.killAllFor(id);
    if (this.active === id) this.active = undefined;
    this.send(res, 200, { ok: true });
  }

  /** POST /session/:id/pty {cols?,rows?}（G8b T3 分配面）：cols/rows 缺省 80/24，在场须正整数
   *  （400）→ 会话解析（未知 :id 404，sessionFor 单点）→ shell 探测 daemon 内定（win32
   *  powershell.exe / 其余 process.env.SHELL ?? /bin/bash）→ PtyManager.spawn（cwd=session.root、
   *  owner=:id、env 继承 process.env）→ 200 {ptyId}（`pty-<n>` 单调永不复用）。T5/T6 拿 ptyId 连
   *  `/session/:id/pty/:ptyId` 专用 WS 升级路径（本文件 attachWs 分支） */
  private async handlePtyAlloc(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const body = parsed.body as { cols?: unknown; rows?: unknown } | null;
    const cols = body?.cols ?? 80;
    const rows = body?.rows ?? 24;
    if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 1 || typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1) {
      this.send(res, 400, { error: 'cols and rows must be positive integers' });
      return;
    }
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    this.ptySeq += 1;
    const ptyId = `pty-${this.ptySeq}`;
    const file = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash');
    this.ptyManager.spawn(ptyId, {
      file,
      args: [],
      cwd: session.root,
      cols,
      rows,
      owner: session.id,
      env: process.env as Record<string, string>,
    });
    this.send(res, 200, { ptyId });
  }

  /** DELETE /session/:id/pty/:ptyId（G8b T3 kill 面）：PtyManager.kill 幂等（无此 id 静默）——重复
   *  DELETE / 自然退出后再删均 200 {ok:true}；kill 同步注销（has→false 立即），exit 帧异步送达在线
   *  pty WS。会话解析先行（未知 :id 404，sessionFor 单点——路由面会话维语义一致性） */
  private handlePtyKill(res: http.ServerResponse, id: string, ptyId: string): void {
    const session = this.sessionFor(res, id);
    if (session === undefined) return;
    this.ptyManager.kill(ptyId);
    this.send(res, 200, { ok: true });
  }

  /** GET /workspaces（T2）：扫 projectsRoot() 下各 `<slug>/data` 存在者——root 经 workspace.json
   *  反解（历史工作区无档 → slug-only 行不可 attach）；mtime=dataDir mtime；sessionCount=sessions
   *  子目录 jsonl 计数（缺目录=0）。行序 mtime 降序（最近工作区在前，首页呈现序）；单目录/单档的
   *  扫描竞态（readdir 与 stat 之间被删）跳过该条目，不击穿整个列表 */
  private handleWorkspaces(res: http.ServerResponse): void {
    const rows: WorkspaceRow[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectsRoot(), { withFileTypes: true });
    } catch {
      // projects 根不存在/不可读：空注册表（合法态——从未建过会话）
      this.send(res, 200, rows);
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dataDir = path.join(projectsRoot(), ent.name, 'data');
      let st: fs.Stats;
      try {
        st = fs.statSync(dataDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let root: string | undefined;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) as { root?: unknown };
        if (typeof raw?.root === 'string' && raw.root.length > 0) root = raw.root;
      } catch {
        // 历史工作区无档/坏档 → slug-only（root undefined，前端不可 attach）
      }
      let sessionCount = 0;
      try {
        sessionCount = fs.readdirSync(path.join(dataDir, 'sessions')).filter((f) => f.endsWith('.jsonl')).length;
      } catch {
        // sessions 目录不存在 = 0
      }
      rows.push({ ...(root !== undefined ? { root } : {}), slug: ent.name, mtime: st.mtimeMs, sessionCount });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    this.send(res, 200, rows);
  }

  /** GET /sessions?root=（T2）：root 必填（缺省 400——无 root 无法定位 dataDir）→ listSessions
   *  （TUI /resume 同源导出：id/file/updatedAt mtime 降序/firstUser 首条用户输入摘要）原样回执 */
  private handleSessions(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const root = url.searchParams.get('root');
    if (root === null || root.length === 0) {
      this.send(res, 400, { error: 'root query param required' });
      return;
    }
    this.send(res, 200, listSessions(resolveDataDir(root)));
  }

  /** GET /dirpicker?path=（T2 服务端目录选择）：path 缺省 os.homedir()；不存在/非目录 400；
   *  dirs=readdirSync withFileTypes 只目录 + 排序；parent=resolve('..')（盘根时=自身） */
  private handleDirpicker(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const abs = path.resolve(url.searchParams.get('path') ?? os.homedir());
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      this.send(res, 400, { error: `path does not exist: ${abs}` });
      return;
    }
    if (!st.isDirectory()) {
      this.send(res, 400, { error: `path is not a directory: ${abs}` });
      return;
    }
    let dirs: string[];
    try {
      dirs = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      this.send(res, 400, { error: `path is not readable: ${abs}` });
      return;
    }
    this.send(res, 200, { path: abs, parent: path.resolve(abs, '..'), dirs });
  }

  private send(res: http.ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
