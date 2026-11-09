// 警告过滤必须首个 import（node:sqlite 实验横幅在 import 链内即发射）
import '../warning-filter';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ModelAdapter, parseEffort } from '../model/adapter';
import type { Result } from '../result';
import type { SessionRuntime } from './session';
import type { ApprovalDecision, AskUserAnswer } from '../types';
import { purgeSession, purgeSideJournals, sideJournalsOf, readSessionMeta, sessionsDir } from "../tui/session-journal";
import { listCommands } from './commands';
import { COMMAND_SUPPORT } from './session-commands';
import { listChanges, changeContent, commitChanges, pushChanges, restoreChange, gitStatusMap, gitBranches, checkoutBranch, workspaceFiles } from './session-changes';
import { ModelSwitcher } from '../model/catalog';
import { loadProviders } from '../config/providers';
import { projectsRoot, resolveDataDir } from '../config/data-dir';
import {
  applySettings,
  getSelfFilledSlots,
  loadGlobalSettings,
  loadProjectSettings,
  resetSelfFilledSlots,
} from '../config/settings';
import { PtyManager } from './pty';
import { saveReplay } from './pty-replay-store';
import { ConfigWatcher } from '../catalog/watch';
import { setOnCatalogWrite } from '../catalog/io';
import { userConfigDir } from '../config/env';
import { fetchWebMeta } from './web-meta';
import * as configHandlers from './config-handlers';
import type { ConfigHandlerIo } from './config-handlers';
import { findJournalOwner, validSessionId } from './session-handlers';
import * as sessionHandlers from './session-handlers';
import * as editorsHandlers from './editors-handlers';
import type { SessionHandlerIo } from './session-handlers';
import * as fileHandlers from './file-handlers';
import * as workspaceHandlers from './workspace-handlers';
import type { WorkspaceHandlerIo } from './workspace-handlers';
import * as ptyHandlers from './pty-handlers';
import type { PtyHandlerIo } from './pty-handlers';
import type { FileHandlerIo } from './file-handlers';
import * as lifecycle from './session-lifecycle';
import type { SessionLifecycleIo } from './session-lifecycle';
import { WsHub } from './daemon-ws';
import { startBuiltinFacade } from './cdp-facade';
import { purgeBrowserState, reapBuiltinBrowsers as reapBuiltinBrowsersHost, sweepOrphanBrowserState } from './builtin-browser';
import {
  GUI_ASSETS_HINT,
  mimeOf,
  readStaticFile,
} from './daemon-static';
import {
  urlOf,
  LOOPBACK_HOST,
  type DaemonFrame,
} from './daemon-wire';

export { LOOPBACK_HOST } from './daemon-wire';
// 壳装配序依赖(2026-10-23):桌面壳在 buildModel 前须跑 settings 链(全局 env 块=API key、
// projectsDir、language)——CLI serve 同序先例 cli/index.ts;不导出则壳侧模型适配器构造期读空 env
export { loadSettingsChain } from '../config/settings';
export type { ApprovalFrame, AskFrame, ResetFrame, ConfigChangedFrame, DaemonFrame } from './daemon-wire';

/** GUI daemon 构造面（G3 会话中心）：不再绑 root——daemon 持会话注册表，会话经 createSession(root)
 *  按需装配（--root CLI 参数降级为「启动即预选」，缺省空注册表启动）。model 与 CLI buildModel/TUI
 *  同源注入（三面同一 ModelAdapter 契约，daemon 级单例供各会话共享）；staticRoot 为 GUI 静态产物目录
 *  （G3 静态挂载），缺省 cwd 相对 dist-gui——serve 命令从仓库根跑即对，测试注入 tmp 路径保持 hermetic */
export interface GuiDaemonOpts {
  model: ModelAdapter;
  staticRoot?: string;
  /** providers 装载根（与 assembleGuiModel 装配期同一根；配置热重载按它重读清单）——缺省 process.cwd() */
  providerRoot?: string;
}

/** start 入参：port 缺省 0（临时端口，返回实际监听值）；token 缺省随机 24 字节 hex（规格 §4.3） */
export interface GuiDaemonStartOpts {
  port?: number;
  token?: string;
}

/** start 回执：port 为实际监听端口；close 与 GuiDaemon.close 同一幂等收口 */
export interface GuiDaemonHandle {
  port: number;
  /** undefined = 免鉴权档(G10:本地 serve 缺省);显式 --token 启用时为该值 */
  token: string | undefined;
  close(): Promise<void>;
}

/** 旁车 fork/ask 一次性调用墙钟上限：旁车与主链长任务预算解耦，到点 abort 收口（fork 问询面唯一消费） */
/** GET /workspaces 行（T2 工作区注册表）：slug=projectsRoot 下工作区目录名；root 经 createSession
 *  落档的 `<dataDir>/workspace.json` 反解——历史工作区（TUI 时代档）无此档 → root undefined（前端
 *  不可 attach，仅统计展示）；mtime=dataDir mtime；sessionCount=sessions 目录 jsonl 数（缺目录=0） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
  /** 注册目录创建时刻(birthtimeMs;2026-10-31 项目排序「创建时间」维度;旧档/平台不支持=可缺省) */
  createdAt?: number;
}


/** JSON body 上限（1MB）：防无界 body 撑爆 daemon 内存；超限即断连收口 */
const MAX_BODY_BYTES = 1024 * 1024;


/** 路由表条目：path 支持 `:name` 段参数（会话维端点 /session/:id/*）；auth 恒验除 healthz */
interface Route {
  method: string;
  path: string;
  auth: boolean;
  run: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void>;
}

/** 多源多模型装配单点（2026-10-23 桌面「默认模型/无法选模型」根因修复）：settings providers 键
 *  展开为 ModelSwitcher——CLI serve 与桌面壳共用本工厂。同束结构性排除跨束 instanceof 坑：
 *  壳形态 GuiDaemon 在 daemon.cjs、buildModel 在 runtime.cjs,两束各有一份 ModelSwitcher 类,
 *  壳侧 `new (外部目录 ModelSwitcher)` 过不了 daemon 束的 `instanceof ModelSwitcher` 注入闸
 *  （modelSwitcher 恒 null → /model 恒 {choices:[]}）;工厂与本文件同类 → instanceof 恒真。
 *  2026-10-28 spec §15 散键退役裁定：explicitDefault 档退役——providers 列表唯一事实源,
 *  choices 非空恒切首个源模型 choices[0]（默认模型 = 第一个 provider 的第一个 model）,
 *  SUNSHINEX_MODEL env 只喂 default 内芯（无 providers 的单模型形态,buildModel env 读取保留）;
 *  effort 缺省随装配注入各源内芯;providers warnings 原样透出（调用方 i18n 打印）。 */
export function assembleGuiModel(
  model: ModelAdapter,
  providerRoot: string,
  flags?: Record<string, string | boolean | string[]>,
): { model: ModelSwitcher; warnings: string[] } {
  const providers = loadProviders(providerRoot);
  const effortDef = parseEffort(typeof flags?.effort === 'string' ? flags.effort : undefined) ?? parseEffort(process.env.SUNSHINEX_REASONING_EFFORT);
  const sw = new ModelSwitcher({
    choices: providers.choices,
    default: model,
    ...(effortDef ? { reasoningEffort: effortDef } : {}),
  });
  if (providers.choices.length > 0) sw.switchTo(providers.choices[0]!.id);
  return { model: sw, warnings: providers.warnings };
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
  /** seq 泵计数（G3 seq 协议 + T1 全局裁定）：计数在先帧在后（首帧 seq=1），跨会话全局单调不重置——
   *  各会话 snapshot.lastSeq 同一计数器分配故各自单调 */
  private seqCounter = 0;
  /** 激活会话（spec §7 Ruling 1）：最近 create/attach 的会话；裸端点挂它。UI 切换 =
   *  纯前端状态，不改 daemon active（协议兼容层概念，不是 UI 状态） */
  private active?: string;
  private server?: http.Server;
  /** 幂等收口：首调落链，后续调用复用同一 Promise（close 链只走一遍） */
  private closePromise?: Promise<void>;
  /** GUI 静态产物根（G3）：opts 注入，缺省 cwd 相对 dist-gui */
  private readonly staticRoot: string;
  /** 静态面探测结果（start 时一次缓存）：index.html 在场才挂静态，缺场保持 API-only（404 hint 原样） */
  private staticReady = false;
  /** 挂起 id 铸造计数（P6 §4：表下沉会话后 daemon 只留 pid 单调铸造——跨会话全局唯一的回执寻址键;
   *  guard 的 ap-N 是会话内序会撞,全局唯一由本单点保证） */
  private pendingSeq = 0;
  /** pty 面（G8b T3）：daemon 持 manager（serve 分层——session.ts 不引 pty，会话回收由 daemon
   *  在 delete/teardown 两处 killAllFor 插杀）；ptyId 铸造 `pty-<启动段>-<n>` 永不复用（防同 id 新会话
   *  撞旧缓冲/双连的竞态——T2 缓议裁定）。启动段=每次 daemon 启动随机:GUI 盘档持有旧 ptyId 跨重启,
   *  纯进程内序号重启归零即撞上新进程的活 pty(连错壳)、落盘回放档也被同号覆盖 */
  private readonly ptyManager = new PtyManager();
  private ptySeq = 0;
  private readonly ptyBoot = crypto.randomBytes(3).toString('hex');
  /** 回放周期落盘(5s,只写有变化的条目):落盘原只在 teardown 尾段——壳关闭有界等待 5s 常截断,
   *  强杀/崩溃则全丢,重启后终端回不到原屏。lastSaved 记每条上次落盘文本,未变不写 */
  private ptyPersistTimer: ReturnType<typeof setInterval> | undefined;
  private readonly ptyLastSaved = new Map<string, string>();
  /** WS 传输域 hub（daemon-ws 单点，2026-10-27 技术债轮 D31 骨架域续批外提）：连接生命周期/
   *  batch 合帧窗/保活心跳/pty 专用连接/泵广播面,传输状态归 hub 私有;teardown 步 1 经 hub.close */
  private readonly wsHub = new WsHub({
    sessions: this.sessions,
    ptyManager: this.ptyManager,
    isClosing: () => this.closePromise !== undefined,
  });
  /** 配置变更监听（任务14：双向实时同步的「外部编辑感知」半边）——daemon 持单例；start 时挂全局
   *  目录 + onChange→config-changed 帧广播，会话打开/关闭随 lifecycleIo 挂/拆项目监听；写回环抑制
   *  与内部写直发经 onCatalogWrite 钩子装配（suppress 丢 watcher 回声、broadcast 承担帧下行，两路
   *  合一：外部编辑走 watcher、内部写走直发，同键不双发；project 写通知另担补监听——见 start 注）。
   *  句柄面：start 开、teardown 收 */
  private readonly watcher = new ConfigWatcher();
  /** M2 内置浏览器融合面(壳内 CDP facade,只暴露侧栏 webview):electron 在场才启,纯 node 降级 */
  private builtinFacade: { facade: import('./cdp-facade').BuiltinFacade; ws: string } | undefined;
  private builtinMetaTimer: ReturnType<typeof setInterval> | undefined;
  private readonly providerRoot: string;

  constructor(opts: GuiDaemonOpts) {
    this.staticRoot = opts.staticRoot ?? path.resolve('dist-gui');
    this.model = opts.model;
    this.providerRoot = opts.providerRoot ?? process.cwd();
  }

  /**
   * 创建会话（spec §7）：root 存在性/目录校验（INVALID_ARG）→ 按 root 装配 SessionRuntime（同 root
   * 多会话允许——各自独立主链，Ruling 2）→ 入注册表（s<n> 进程内单调）→ 置激活。同时向
   * `resolveDataDir(root)/workspace.json` 落档 `{root}`（T2 工作区注册表：slug 单向哈希反解不了
   * root——落档供 GET /workspaces 读回真 root；历史工作区无此档降级 slug-only）。落档尽力而为：
   * 数据面不可写（只读 projects 根）不挡会话创建，/workspaces 对该工作区降级 slug-only 行。Result
   * 面：daemon 级 API（serve --root 预选/后续工作区注册表消费），HTTP 面映射 400/200。
   * G4：opts.mode='acceptEdits' 时向会话注入审批/问询两闭包——resolve 挂在 daemon 挂起表条目上 + 广播
   *  挂起帧（WS 消费面回执 POST /approval/:pid / /ask/:pid/reply）；缺省 full-access 零行为变化（沿原 dontAsk 地位正名,spec §3.2）。
   * T2：出生即挂新 SessionJournal（`new SessionJournal(dataDir)` 惰性建档——首 run 首条 chain append
   *  才落盘建新档，档 id 同源 newSessionId()；空会话零文件，TUI 惰性先例同构）——首 run 起链持久，
   *  后续 /sessions 列档与 attach 重开（chain 派生转录）可消费。
   */
  /** 会话生命周期域(session-lifecycle 单点,2026-10-27 技术债轮 D31 骨架域续批外提):
   *  create/attach 双入口+id 铸造+default 锚定,类状态触点=io 六面 */
  private get lifecycleIo(): SessionLifecycleIo {
    return {
      sessions: this.sessions,
      model: this.model,
      nextSeq: () => {
        this.seqCounter += 1;
        return this.seqCounter;
      },
      mintPid: () => {
        this.pendingSeq += 1;
        return `p${this.pendingSeq}`;
      },
      broadcast: (frame) => this.broadcastFrame(frame),
      setActive: (id) => {
        this.active = id;
      },
      watchProject: (root) => this.watchProjectRoot(root),
      unwatchProject: (root) => this.unwatchProjectRoot(root),
    };
  }

  /** 项目配置监听挂载（任务14，watchProject 守护面）：`.sunshinex` 缺失跳过不监听不产告警——
   *  watcher 对缺失目录本就逐目录 warn 降级，会话打开于无项目配置的普通目录（含 default 草稿根）
   *  是常态，静默跳过即「GET 即读」降级口径；目录补建后下次会话打开重试即真实生效（watchProject
   *  幂等，同 root 已监听则跳过）。返回是否真实挂载（create 面据此决定是否广播 skills 帧——
   *  无 `.sunshinex` 的纯新目录不产假帧） */
  private watchProjectRoot(root: string): boolean {
    if (!fs.existsSync(path.join(root, '.sunshinex'))) return false;
    this.watcher.watchProject(root);
    return true;
  }

  /** 项目配置监听拆除（任务14，unwatchProject 守护面）：同 root 多会话允许（Ruling 2）——注册表
   *  内仍有该 root 的会话在场则保留监听（会话粒度挂/拆的 root 粒度折算）；无人在场才整组拆 */
  private unwatchProjectRoot(root: string): void {
    for (const s of this.sessions.values()) {
      if (s.root === root) return;
    }
    this.watcher.unwatchProject(root);
  }

  createSession(root: string, opts?: { mode?: 'full-access' | 'acceptEdits' }): Result<{ sessionId: string }> {
    return lifecycle.createSessionIn(this.lifecycleIo, root, opts);
  }

  attach(id: string, journalId: string): Result<{ sessionId: string }> {
    return lifecycle.attachSessionIn(this.lifecycleIo, id, journalId);
  }

  /** 会话外窥（测试/后续 T2+ 端点消费）：未知 id 回 undefined */
  get(id: string): SessionRuntime | undefined {
    return this.sessions.get(id);
  }

  /** 激活会话 id（无会话时 undefined——裸端点 409 的判据） */
  activeId(): string | undefined {
    return this.active;
  }

  /** 会话维挂起回填（G4 裁定 3：interrupt/reset=deny 回填）：P6 §4 表在会话——薄委托 denyPending
   *  （approval→deny、ask→dismissed 清表,不发 notice）;未知会话静默（与旧全表过滤等价） */
  private denyPendingFor(sessionId: string): void {
    this.sessions.get(sessionId)?.denyPending();
  }

  /** 全表回填（close 序步骤 0，同构裁定 3——分会话 denyPending 的全表形态） */
  private denyAllPending(): void {
    for (const session of this.sessions.values()) session.denyPending();
  }

  /** 挂起回执路由（P6 §4）：pid 无会话前缀（`p<n>` 全局票据）——迭代各会话表寻址;命中 false 即
   *  404（未知 pid / kind 错配 / 已回执删除） */
  private resolveApproval(pid: string, decision: ApprovalDecision): boolean {
    for (const session of this.sessions.values()) {
      if (session.resolvePendingApproval(pid, decision)) return true;
    }
    return false;
  }

  private resolveAsk(pid: string, answer: AskUserAnswer): boolean {
    for (const session of this.sessions.values()) {
      if (session.resolvePendingAsk(pid, answer)) return true;
    }
    return false;
  }

  /** plan 审批回执路由（阶段三 spec §5.1,同构 approval/ask——pid 全局票据迭代寻址,命中 false 即 404） */
  private resolvePlanApproval(pid: string, decision: { approved: boolean; feedback?: string }): boolean {
    for (const session of this.sessions.values()) {
      if (session.resolvePendingPlanApproval(pid, decision)) return true;
    }
    return false;
  }

  /** 泵广播面薄委托(broadcast 四法+WS 五法已外提 daemon-ws WsHub——传输状态归 hub 私有):
   *  两张 io 面(lifecycle/session)经本名保持零迁移 */
  private broadcastFrame(frame: DaemonFrame): void {
    this.wsHub.broadcastFrame(frame);
  }

  /**
   * 启动 HTTP 控制面：恒绑 127.0.0.1（§4.3 裁定——远程暴露为 v1 非目标，bind 面=鉴权面的第一道）；
   * port 0 = 系统分配临时端口，回执返回实际监听值（测试并行不撞口）。
   */
  async start(opts?: GuiDaemonStartOpts): Promise<GuiDaemonHandle> {
    // token 语义(G10 后裁定):undefined = 免鉴权档(服务恒绑 127.0.0.1,本地工具不设密);显式传入才启用鉴权
    const token = opts?.token;
    // 出生档启动清扫(2026-10-31「点击运行中会话每次多一个新对话」存量收口):boot 序零在座
    // 会话,birth-only 档(零实质行)删除无引用可破——历次点击遗留的孤儿「新会话」行就此清零
    try {
      const swept = lifecycle.sweepBirthOnlyJournals();
      if (swept > 0) console.log(`[daemon] swept ${swept} birth-only journal(s)`);
      sweepOrphanBrowserState(); // 删档后的浏览器状态/输出/侧栏分区随之清扫(此刻尚无 webview 占用分区)
    } catch {
      /* 清扫失败不阻塞启动(下次 boot 再扫) */
    }
/** keep-alive 加长窗（2026-11-07 用户实测「置顶 Failed to fetch/卡」根修）：Node 缺省 5s 关空闲连接，
 *  浏览器连接池旧 socket 上 PUT 不重试直接炸（GET 会自动重试故鲜感）；65s>浏览器池复用窗 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** keep-alive +1s：防 requestTimeout 误杀 65s 内长连接（headersTimeout 须 ≥ keepAliveTimeout） */
const HEADERS_TIMEOUT_MS = 66_000;
/** 终端回放周期落盘间隔（与 pty.ts CPR 兜底 5000 同值不同义——上新删旧勿连改） */
const PTY_PERSIST_INTERVAL_MS = 5_000;
    const server = http.createServer((req, res) => this.dispatch(req, res, token));
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts?.port ?? 0, LOOPBACK_HOST, () => resolve());
    });
    this.server = server;
    this.wsHub.attach(server, token);
    this.ptyPersistTimer = setInterval(() => this.persistPtyReplays(), PTY_PERSIST_INTERVAL_MS);
    this.ptyPersistTimer.unref();
    // M2 融合面过滤闸需要 daemon 自身 origin(GUI 渲染层 target 按 http://127.0.0.1:<port> 过滤)
    process.env.SUNSHINEX_DAEMON_PORT = String((server.address() as { port: number }).port);
    // 任务14 配置监听装配：全局目录（userConfigDir——HOME/部署重定向口，测试钉 tmp HOME 即 hermetic）
    // + 写回环抑制/直发钩子 + 变更→config-changed 帧广播（无 seq，broadcastFrame 全连接直发）
    this.watcher.watchGlobal(userConfigDir());
    setOnCatalogWrite((resource, scope, root) => {
      // 补监听（终审修复波 2026-10-28）：project-scope 写通知到达时该 root 尚未监听（会话打开时
      // `.sunshinex` 还不存在——watchProjectRoot 当时静默跳过）则就地补挂，使 `.sunshinex` 后建的
      // 项目也能获得实时帧（首次写本身已产直发帧；补挂保证后续外部编辑走 watcher 同样有帧）。
      // watchProjectRoot 幂等 + 内建 `.sunshinex` 存在性守卫，global 通知 root 恒 null 不入此支。
      if (scope === 'project' && root !== null && !this.watcher.isProjectWatched(root)) {
        this.watchProjectRoot(root);
      }
      this.watcher.suppress(resource, scope, root); // 抑制 watcher 事件源（防自触回声双发）
      this.broadcastFrame({ kind: 'config-changed', resource, scope, root }); // 帧下行由直发承担
    });
    this.watcher.onChange((c) => {
      // 外部编辑（编辑器直改 settings.json）：先重装 env 链+刷新模型层，再下行帧——前端据帧重拉时读到的已是新态。
      // 全局面变更（root=null）由 reloadSettingsChain 锚 providerRoot 重装两层，全局变更即时生效不丢项目槽
      if (c.resource === 'settings') this.reloadSettingsChain(c.root);
      this.broadcastFrame({ kind: 'config-changed', ...c });
    });
    // M2 融合面启动(尽力而为:electron 缺场/端口失败静默降级——插件 builtin 档回落旧桥路径);
    // 在场即向注册工作区落融合 meta 并周期重写(新工作区/重启端口漂移自愈)
    const startFacadeOnce = (): void => {
      if (this.builtinFacade !== undefined) return;
      void startBuiltinFacade((m) => console.log(`[cdp-facade] ${m}`)).then((h) => {
        this.builtinFacade = h;
        if (h === undefined) return; // 未就绪(DevToolsActivePort 未落盘等):下个周期重试
        // 浏览器宿主(同进程 harness 装配)按会话连 facade 端点 <base>/session/<key>
        process.env.SUNSHINEX_BUILTIN_CDP = h.ws.replace(/\/devtools\/browser$/, '');
      });
    };
    startFacadeOnce();
    this.builtinMetaTimer = setInterval(startFacadeOnce, 5_000);
    // 静态面探测（启动一次，缓存布尔）：index.html 在场才挂静态——缺场 GET 保持 G1 的 404+hint 原样
    this.staticReady = fs.existsSync(path.join(this.staticRoot, 'index.html'));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('GuiDaemon: listen address unavailable');
    // 退出兜底收割(2026-11-01「应用停止也要停内置 mcp 服务」belt):teardown 首刀之外,任何优雅
    // 退出路径(未走 close 的 process.exit/未捕获异常等)也收割——exit 钩子只跑同步码,spawnSync
    // 合法;强杀(TerminateProcess)不触发属物理极限。幂等:二次收割杀已死 pid 无害
    process.once('exit', () => this.reapBuiltinBrowsers());
    return { port: addr.port, token, close: () => this.close() };
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
    // -2) M2 融合面收口:meta 周期写停 + facade ws 停(先于收割——收割删壳 kind 指针档防死端口误导)
    if (this.builtinMetaTimer !== undefined) clearInterval(this.builtinMetaTimer);
    this.builtinFacade?.facade.stop();
    delete process.env.SUNSHINEX_BUILTIN_CDP;
    // -1) 内置浏览器收割**最先**执行(2026-11-01 实测踩坑:壳侧 close 有界等待仅 5s,teardown 前段
    //     步骤(全会话 abort/WS/HTTP 收口/mcpClose)任一拖住即超时放行退出——排末尾的收割刀没跑到,
    //     孤儿 Chrome 锁死数据目录(用户面「应用关了文件夹删不掉」);收割独立于其它收口步骤且为
    //     同步 spawnSync,置顶后即使后续被有界等待截断也已杀净)
    this.reapBuiltinBrowsers();
    // -1b) 终端回放全量落盘(同步、与收割同理置顶):后段收口被有界等待截断也不丢屏
    if (this.ptyPersistTimer !== undefined) clearInterval(this.ptyPersistTimer);
    this.ptyPersistTimer = undefined;
    this.persistPtyReplays();
    // 0-) 配置监听面先收（任务14）：摘写通知钩子（还原缺省 no-op——收口途中 catalog 写不再产帧）+
    //     watcher.close 全组拆句柄清回调（防收口途中残留 fs 事件再产广播）；project 组随 close 全拆，
    //     无需逐会话 unwatch
    setOnCatalogWrite(null);
    this.watcher.close();
    // 0) 挂起全表回填（G4 裁定 3）：悬挂的 asker promise 先落 deny/dismissed——被中止 run 才能在
    //    有界窗口内真正 settle
    this.denyAllPending();
    // 0b) 全会话在跑 run 即刻中止（并发）：与单会话序同理——悬挂 run 的 promise 会拖住事件循环/测试
    //    收口；每会话有界等待 2s（Promise.all 并发不叠加）
    await Promise.all([...this.sessions.values()].map((s) => s.abortAndSettle()));
    // 0c) pty 全量插杀（G8b T3，teardown 插杀处之二）：逐会话 killAllFor 覆盖全部条目（owner 恒为
    //     会话 id——daemon 持 manager、session.ts 不引 pty 的 serve 分层面）。kill 同步注销，exit 帧
    //     异步送达在线 pty WS（尽力投递，网络面下一拍收口）；防孤儿 conpty 拖住 daemon close
    for (const [id, rt] of [...this.sessions.entries()]) {
      this.sealAndKillPtyFor(id, rt.attachedJournalId);
    }
    // 1) WS 面先收（daemon-ws hub.close：停 ping 计时器，逐连接 1001 Going Away 后 wss.close，
    //    pty 专用 WS 同拍退场）——先于 HTTP server close，升级连接与请求连接同序退场，server close
    //    时无存活的升级套接字拖尾
    await this.wsHub.close();
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

  /** 终端回放落盘(周期/teardown 共用):有变化才写;已注销条目出账(其终态由关页签/删除路径落盘) */
  private persistPtyReplays(): void {
    const live = new Set<string>();
    for (const r of this.ptyManager.allReplays()) {
      live.add(r.id);
      if (this.ptyLastSaved.get(r.id) === r.text) continue;
      saveReplay(r.id, r.text);
      this.ptyLastSaved.set(r.id, r.text);
    }
    for (const id of [...this.ptyLastSaved.keys()]) if (!live.has(id)) this.ptyLastSaved.delete(id);
  }

  /** 内置浏览器收割（宿主侧单点 serve/builtin-browser，D61 外提）：本座工作区 roots 注入 */
  private reapBuiltinBrowsers(): void {
    reapBuiltinBrowsersHost([...this.sessions.values()].map((rt) => rt.root));
  }

  /** pty 双锚清杀单点（2026-11-07 收敛——此前 teardown/单会话 delete/side 连带三面四处展开）：
   *  每锚先落回放最后一笔（seal 先于 kill，防复活后丢尾段）再 killAllFor（幂等）；owners 传
   *  runtime id 与 attachedJournalId 双锚（2026-11-01 漏杀根修：建档前 owner=runtime id 不回填，
   *  只锚 journalId 会漏），同值去重杀一遍 */
  private sealAndKillPtyFor(...owners: Array<string | undefined>): void {
    for (const owner of new Set(owners.filter((o): o is string => o !== undefined))) {
      for (const r of this.ptyManager.replaysFor(owner)) saveReplay(r.id, r.text);
      this.ptyManager.killAllFor(owner);
    }
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
    { method: 'GET', path: '/session/:id/snapshot', auth: true, run: async (req, res, p) => this.handleSnapshot(req, res, p.id) },
    { method: 'POST', path: '/session/:id/board/stop', auth: true, run: (req, res, p) => sessionHandlers.handleBoardStop(this.sessionIo, req, res, p.id) },
    // 2026-10-26 三期 §4.5:按需全量观测(快照分页剥 full 后,工具行展开按 seq 单条拉)
    { method: 'GET', path: '/session/:id/entry/:seq/observation', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const seq = Number(p.seq);
        if (!Number.isInteger(seq) || seq <= 0) return this.send(res, 400, { error: 'invalid seq' });
        const obs = session.entryObservation(seq);
        if (obs === undefined) return this.send(res, 404, { error: 'no such entry' });
        this.send(res, 200, obs);
      } },
    { method: 'GET', path: '/session/:id/model', auth: true, run: async (_req, res, p) => this.handleSessionModelGet(res, p.id) },
    { method: 'POST', path: '/session/:id/model', auth: true, run: (req, res, p) => this.handleSessionModel(req, res, p.id) },
    { method: 'POST', path: '/session/:id/tier', auth: true, run: async (req, res, p) => this.handleSessionTierEffort(req, res, p.id, 'tier') },
    { method: 'POST', path: '/session/:id/effort', auth: true, run: async (req, res, p) => this.handleSessionTierEffort(req, res, p.id, 'effort') },
    { method: 'POST', path: '/session/:id/mode', auth: true, run: (req, res, p) => this.handleSessionMode(req, res, p.id) },
    // G14.2xx GUI 面私有态存取(标签页等;CLAUDE.md §13 持久化分层——<slug>/gui/sessions/<id>.json)
    { method: 'GET', path: '/session/:id/gui-state', auth: true, run: async (_req, res, p) => sessionHandlers.handleGuiStateGet(this.sessionIo, res, p.id) },
    { method: 'PUT', path: '/session/:id/gui-state', auth: true, run: async (req, res, p) => sessionHandlers.handleGuiStatePut(this.sessionIo, req, res, p.id) },
    // G14.2xx 应用级指针档(恢复现场入口:刷新后据此重放 lastRoot/lastJournalId 打开链)
    { method: 'GET', path: '/app/gui-state', auth: true, run: async (_req, res) => sessionHandlers.handleAppGuiStateGet(this.sessionIo, res) },
    { method: 'PUT', path: '/app/gui-state', auth: true, run: async (req, res) => sessionHandlers.handleAppGuiStatePut(this.sessionIo, req, res) },
    // 置顶档(2026-10-21 GUI 专属):userConfigDir/gui/pins.json,机器级跨工作区视图偏好
    { method: 'GET', path: '/app/pins', auth: true, run: async (_req, res) => sessionHandlers.handleAppPinsGet(this.sessionIo, res) },
    { method: 'PUT', path: '/app/pins', auth: true, run: async (req, res) => sessionHandlers.handleAppPinsPut(this.sessionIo, req, res) },
    // 已读档(2026-10-23):userConfigDir/gui/seen.json,机器级 id→最近已读 updatedAt(已读/未读态落底层)
    { method: 'GET', path: '/app/seen', auth: true, run: async (_req, res) => sessionHandlers.handleAppSeenGet(this.sessionIo, res) },
    { method: 'PUT', path: '/app/seen', auth: true, run: async (req, res) => sessionHandlers.handleAppSeenPut(this.sessionIo, req, res) },
    // 外部打开应用族(2026-10-27 顶栏「打开」分体钮):预设应用安装态探测 + 以指定应用打开路径
    { method: 'GET', path: '/app/editors', auth: true, run: async (_req, res) => editorsHandlers.handleEditorsGet(this.sessionIo, res) },
    { method: 'POST', path: '/app/open', auth: true, run: async (req, res) => editorsHandlers.handleEditorsOpen(this.sessionIo, req, res) },
    { method: 'GET', path: '/app/editors/icon/:id', auth: true, run: async (_req, res, p) => editorsHandlers.handleEditorsIcon(this.sessionIo, res, decodeURIComponent(p.id)) },
    // G10-C7 标题总结面：模型一次性概括首条用户消息(≤20 字,无状态不落盘)——落盘走 rename(G14.16)
    { method: 'POST', path: '/session/:id/title', auth: true, run: (req, res, p) => this.handleSessionTitle(req, res, p.id) },
    // G14.16 标题统一流：rename 落旁车 <id>.meta.json(侧栏/TUI 列表同源)；GET 回读(重开回显)
    { method: 'POST', path: '/session/:id/rename', auth: true, run: (req, res, p) => this.handleSessionRename(req, res, p.id) },
    { method: 'GET', path: '/session/:id/title/get', auth: true, run: async (_req, res, p) => this.handleSessionTitleGet(res, p.id) },
    // G10-C11 建项目面：原生文件选择器选完自动建项目——name=浏览器态(projectsRoot 下建目录+初始化)、
    // path=桌面壳态(系统对话框回全路径,直接注册外部根);同名幂等返回既有行
    { method: 'POST', path: '/workspace/create', auth: true, run: (req, res) => this.handleWorkspaceCreate(req, res) },
    // 移除工作区(2026-10-23):slug 入隐藏档,仅摘出侧栏;数据保留,重新 create 即原地加回
    { method: 'POST', path: '/workspace/hide', auth: true, run: (req, res) => this.handleWorkspaceHide(req, res) },
    // G14.69 原生选择定位:浏览器态 showDirectoryPicker 拿不到绝对路径——GUI 在所选目录落标记
    // 文件,daemon 全盘 BFS 找标记即得绝对路径(限时/噪声目录跳过/roots 可覆写供测试)
    { method: 'POST', path: '/workspace/locate', auth: true, run: (req, res) => this.handleWorkspaceLocate(req, res) },
    { method: 'POST', path: '/session/:id/steer/cancel', auth: true, run: async (req, res, p) => this.handleSteerCancel(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer/move', auth: true, run: async (req, res, p) => this.handleSteerMove(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer/front', auth: true, run: async (req, res, p) => this.handleSteerFront(req, res, p.id) },
    { method: 'POST', path: '/session/:id/steer/edit', auth: true, run: async (req, res, p) => this.handleSteerEdit(req, res, p.id) },
    { method: 'GET', path: '/session/:id/anchors', auth: true, run: async (_req, res, p) => this.handleAnchors(res, p.id) },
    { method: 'GET', path: '/session/:id/restore-plan', auth: true, run: async (req, res, p) => this.handleRestorePlan(req, res, p.id) },
    { method: 'POST', path: '/session/:id/rewind', auth: true, run: async (req, res, p) => this.handleBranch(req, res, p.id, 'rewind') },
    { method: 'POST', path: '/session/:id/fork', auth: true, run: async (req, res, p) => this.handleBranch(req, res, p.id, 'fork') },
    // G14.29 辅助问答：fork 整档旁路 + 隔离一轮，主会话零污染（TUI /btw 同机制）
    { method: 'POST', path: '/session/:id/btw', auth: true, run: (req, res, p) => this.handleSessionBtw(req, res, p.id) },
    // 辅助对话列表(2026-10-31 用户裁定「辅助对话持久化+编号页签」):主会话的 side 档清单
    // (GUI 重进主会话恢复 辅助对话 N 页签;sideOf=主 journal 的档按 mtime 正序)
    { method: 'GET', path: '/session/:id/sides', auth: true, run: async (_req, res, p) => this.handleSessionSides(res, p.id) },
    { method: 'POST', path: '/memory/rm', auth: true, run: (req, res) => this.handleMemoryRm(req, res) },
    { method: 'GET', path: '/memory', auth: true, run: async (req, res) => this.handleMemoryList(req, res) },
    { method: 'GET', path: '/session/:id/tasks', auth: true, run: async (_req, res, p) => this.handleSessionTasks(res, p.id) },
    // 后台任务停止面（2026-11-02 用户裁定「暂停=复用 task_stop,撤恢复」）：body {id: taskId}——
    // task_stop 同语义（abortLedger：exec 杀进程树/subagent 打断线），终态 stopped 即 task_wait 可见
    { method: 'POST', path: '/session/:id/tasks/stop', auth: true, run: async (req, res, p) => {
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        sessionHandlers.handleTaskStop(this.sessionIo, res, p.id, String((parsed.body as { id?: unknown }).id ?? ''));
      } },

    // 内置浏览器会话键(2026-11-03):GUI 侧栏 webview 持久分区 persist:sx-<key> 与插件连接同键
    { method: 'GET', path: '/session/:id/browser-key', auth: true, run: async (_req, res, p) => {
        const s = this.sessionFor(res, p.id);
        if (s !== undefined) this.send(res, 200, { key: s.ensureBrowserKey() });
      } },
    { method: 'GET', path: '/session/:id/context', auth: true, run: async (_req, res, p) => this.handleSessionContext(res, p.id) },
    // G14.2xx b 影子投影水合面:journal shadow 行全量(board/delegation/subagent)+ cut 水位——
    // GUI 刷新/重连后会话打开时拉取清零重放(WS 环窗对长会话子智能体流必溢出,恢复唯一可靠入口)
    { method: 'GET', path: '/session/:id/shadow-events', auth: true, run: async (_req, res, p) => this.handleShadowEvents(res, p.id) },
    // G6 文件预览面：会话 root 内只读文本预览（Files 页消费；判界/二进制/512KB 截断语义见 handleFile）
    { method: 'GET', path: '/session/:id/file', auth: true, run: async (req, res, p) => this.handleFile(req, res, p.id) },
    // G7 diff 面：write 调用 pre-image ↔ 磁盘现文件双内容（Chat write 展开消费；查询面见 handleDiff）
    { method: 'GET', path: '/session/:id/diff', auth: true, run: async (req, res, p) => this.handleDiff(req, res, p.id) },
    // G8b T4 tree 面：会话 root 内单层目录列举（Files 页树消费；忽略集/500 上限/判界语义见 handleTree）
    { method: 'GET', path: '/session/:id/tree', auth: true, run: async (req, res, p) => this.handleTree(req, res, p.id) },
    // 2026-11-04 计划页签数据面：数据目录计划书清单（名/绝对路径/末次生成时刻，mtime 降序——PlansTab 消费）
    { method: 'GET', path: '/session/:id/plans', auth: true, run: async (req, res, p) => fileHandlers.handlePlans(this.sessionIo, req, res, p.id) },
    { method: 'POST', path: '/session/:id/attach', auth: true, run: (req, res, p) => this.handleAttach(req, res, p.id) },
    // 2026-10-21 归档面:双寻址(daemon 会话 id 或 journalId)+ 跨工作区归档列表(归档页消费)
    { method: 'POST', path: '/session/:id/archive', auth: true, run: async (req, res, p) => {
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        sessionHandlers.handleSessionArchive(this.sessionIo, res, p.id, parsed.body as { archived?: unknown });
      } },
    { method: 'GET', path: '/sessions/archived', auth: true, run: async (_req, res) => sessionHandlers.handleSessionsArchived(this.sessionIo, res) },
    // 受控删除(2026-10-21 门禁升级):双寻址同 archive;未归档 409;归档态 purgeSession 真清全家
    { method: 'POST', path: '/session/:id/delete', auth: true, run: async (_req, res, p) => this.handleDelete(res, p.id) },
    // G8b T3 pty 面：分配（shell 探测 daemon 内定，cols/rows 缺省 80/24）+ kill（幂等）
    { method: 'POST', path: '/session/:id/pty', auth: true, run: (req, res, p) => this.handlePtyAlloc(req, res, p.id) },
    { method: 'DELETE', path: '/session/:id/pty/:ptyId', auth: true, run: async (_req, res, p) => this.handlePtyKill(res, p.id, p.ptyId) },
    // 2026-10-27 欢迎页全局草稿:App 级 pty（终端页签不绑会话;root 直供 cwd,owner '@app'）
    { method: 'POST', path: '/app/pty', auth: true, run: (req, res) => ptyHandlers.handleAppPtyAlloc(this.ptyIo, req, res) },
    { method: 'DELETE', path: '/app/pty/:ptyId', auth: true, run: async (_req, res, p) => ptyHandlers.handleAppPtyKill(this.ptyIo, res, p.ptyId) },
    // 2026-10-27 欢迎页全局草稿:App 级文件读（注册工作区根信任域,不绑会话;handler 同步,async 包一层
    // 适配 Route.run 的 Promise<void> 契约——f08cbd6 带伤入库,HEAD tsc 不通,技术债轮补直）
    { method: 'GET', path: '/app/file', auth: true, run: async (req, res) => fileHandlers.handleAppFile(this.fileIo, req, res) },
    // G4 挂起回执面：pid 为 daemon 级挂起票据（会话无关路由——pid 本身寻址，无会话维前缀）
    { method: 'POST', path: '/approval/:pid', auth: true, run: (req, res, p) => this.handleApprovalReply(req, res, p.pid) },
    { method: 'POST', path: '/ask/:pid/reply', auth: true, run: (req, res, p) => this.handleAskReply(req, res, p.pid) },
    // plan 审批回执（阶段三 plan-arm,spec §5.1）：planFlow 裁决卡回执——{approved,feedback?}
    { method: 'POST', path: '/plan-approval/:pid', auth: true, run: (req, res, p) => this.handlePlanApprovalReply(req, res, p.pid) },
    // T2 工作区注册表 + 恢复面：workspaces 扫描 / sessions 列档 / dirpicker 目录选择
    { method: 'GET', path: '/workspaces', auth: true, run: async (_req, res) => this.handleWorkspaces(res) },
    { method: 'GET', path: '/sessions', auth: true, run: async (req, res) => this.handleSessions(req, res) },
    { method: 'GET', path: '/sessions/recent', auth: true, run: async (_req, res) => this.handleSessionsRecent(res) },
    { method: 'GET', path: '/commands', auth: true, run: async (_req, res) => this.send(res, 200, { ...listCommands(), supported: COMMAND_SUPPORT }) },
    // G14.113 分支清单/切换(欢迎页分支选择弹窗;root 必传 query/body)
    { method: 'GET', path: '/git/branches', auth: true, run: async (req, res) => {
        const root = urlOf(req).searchParams.get('root') ?? '';
        if (root === '') return this.send(res, 400, { error: 'root query param required' });
        this.send(res, 200, await gitBranches(path.resolve(root)));
      } },
    // G14.121 工作区文件索引(@ 文件面板;root 必传,文件按 mtime 倒序=最近改动优先;dirs=尾斜杠目录清单,@面板滤目录用)
    { method: 'GET', path: '/workspace/files', auth: true, run: async (req, res) => {
        const root = urlOf(req).searchParams.get('root') ?? '';
        if (root === '') return this.send(res, 400, { error: 'root query param required' });
        const idx = await workspaceFiles(path.resolve(root));
        this.send(res, 200, { files: idx.files, dirs: idx.dirs });
      } },
    // Web 标签页名/站标(2026-10-25 用户报障「页签只显 host+地球图标」):iframe 跨域拒访,页名/
    // 图标服务端代取——尽力而为面,解析失败回空字段(GUI 退 host/地球,不报错)
    { method: 'GET', path: '/web/meta', auth: true, run: async (req, res) => {
        const target = urlOf(req).searchParams.get('url') ?? '';
        if (target === '') return this.send(res, 400, { error: 'url query param required' });
        this.send(res, 200, (await fetchWebMeta(target)) ?? { title: '', icon: '' });
      } },
    { method: 'POST', path: '/git/checkout', auth: true, run: async (req, res) => {
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        const root = (parsed.body as { root?: unknown }).root;
        const branch = (parsed.body as { branch?: unknown }).branch;
        if (typeof root !== 'string' || typeof branch !== 'string') return this.send(res, 400, { error: 'root and branch required' });
        const r = await checkoutBranch(path.resolve(root), branch);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true });
      } },
    { method: 'GET', path: '/session/:id/git-status', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const res2 = await gitStatusMap(session.root);
        if (!res2.ok) return this.send(res, 500, { error: res2.error });
        this.send(res, 200, res2.value);
      } },
    // G14.99 工作区未提交变动面（Diff 标签数据源）：git 只读清单/单文件内容/提交/推送
    { method: 'GET', path: '/session/:id/changes', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const r = await listChanges(session.root);
        if (!r.ok) return this.send(res, 500, { error: r.error });
        this.send(res, 200, r.value);
      } },
    { method: 'GET', path: '/session/:id/changes/content', auth: true, run: async (req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const rel = urlOf(req).searchParams.get('path') ?? '';
        const r = await changeContent(session.root, rel);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, r.value);
      } },
    { method: 'POST', path: '/session/:id/changes/commit', auth: true, run: async (req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        const message = (parsed.body as { message?: unknown }).message;
        if (typeof message !== 'string') return this.send(res, 400, { error: 'message required' });
        const r = await commitChanges(session.root, message);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true, out: r.value.out });
      } },
    { method: 'POST', path: '/session/:id/changes/push', auth: true, run: async (_req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const r = await pushChanges(session.root);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true, out: r.value.out });
      } },
    { method: 'POST', path: '/session/:id/changes/restore', auth: true, run: async (req, res, p) => {
        const session = this.sessionFor(res, p.id);
        if (session === undefined) return;
        const parsed = await this.readJson(req);
        if (!parsed.ok) return this.send(res, parsed.status, { error: parsed.error });
        const pathArg = (parsed.body as { path?: unknown }).path;
        if (typeof pathArg !== 'string') return this.send(res, 400, { error: 'path required' });
        const r = await restoreChange(session.root, pathArg);
        if (!r.ok) return this.send(res, 400, { error: r.error });
        this.send(res, 200, { ok: true });
      } },
    { method: 'POST', path: '/session/:id/command', auth: true, run: (req, res, p) => this.handleSessionCommand(req, res, p.id) },
    { method: 'GET', path: '/dirpicker', auth: true, run: async (req, res) => this.handleDirpicker(req, res) },
    // G8c T2 settings 面：effective 视图（来源分层 env>project>global>default）+ 项目级结构化改写
    // （含注释 409 引流 raw 编辑面；成功后清自填槽重载链，新会话即刻生效）
    { method: 'GET', path: '/settings', auth: true, run: async (req, res) => this.handleSettingsGet(req, res) },
    { method: 'PUT', path: '/settings', auth: true, run: (req, res) => this.handleSettingsPut(req, res) },
    // G8c T3 raw 双文件面：settings.json/mcp.json 原文编辑（JSONC 注释保真）——GET 原文复读 + PUT
    // 服务端验证拒存（验证口径=装载口径）+ 原子写；T2 结构化改写 409（含注释/畸形）的引流目标端点
    { method: 'GET', path: '/settings/raw', auth: true, run: async (req, res) => this.handleSettingsRawGet(req, res) },
    { method: 'PUT', path: '/settings/raw', auth: true, run: (req, res) => this.handleSettingsRawPut(req, res) },
    // G8c T4 mcp 面：两级遮蔽视图 + 单台真探测 + 项目级结构化写（mcp 装配期语义——写盘不触发
    // settings reload，新会话/下次装配生效）；Task 15 单条目操作端点（add/remove/enable/disable/
    // approve/deny——handler 薄封装 catalog 写面，config-changed 帧由写内 notify 直发）
    { method: 'GET', path: '/settings/mcp', auth: true, run: async (req, res) => this.handleMcpGet(req, res) },
    { method: 'POST', path: '/settings/mcp/probe', auth: true, run: (req, res) => this.handleMcpProbe(req, res) },
    { method: 'PUT', path: '/settings/mcp', auth: true, run: (req, res) => this.handleMcpPut(req, res) },
    { method: 'PUT', path: '/settings/mcp/op', auth: true, run: (req, res) => this.handleMcpOp(req, res) },
    // G8c T5 agents 面：两级宽容清单 + builtins 四角色 / 表单增删改（Task 15 起写面收口 catalog——
    // upsert 落新家、op 扩 enable|disable|migrate；写盘不触发 settings reload，装配期语义）
    { method: 'GET', path: '/settings/agents', auth: true, run: async (req, res) => this.handleAgentsGet(req, res) },
    { method: 'PUT', path: '/settings/agents', auth: true, run: (req, res) => this.handleAgentsPut(req, res) },
    // G8d T3 agents 全文面：agent.md frontmatter 后正文全文（AgentsPane 编辑播种升级——清单面
    // bodyPreview 200 帽的引流端点；id/scope 守卫与定位裁定同 PUT 面）
    { method: 'GET', path: '/settings/agents/body', auth: true, run: async (req, res) => this.handleAgentsBodyGet(req, res) },
    // agents-teams P1 teams 面：两级宽容清单 + 表单增删改 + team.md 章程全文（镜像 agents 三端点全套
    // 裁定——handler 薄封装 catalog/teams 写面，config-changed 帧由写内 notify 直发；id 词法严格 kebab
    // isValidTeamId 单点；写盘不触发 settings reload，装配期语义）
    { method: 'GET', path: '/settings/teams', auth: true, run: async (req, res) => this.handleTeamsGet(req, res) },
    { method: 'PUT', path: '/settings/teams', auth: true, run: (req, res) => this.handleTeamsPut(req, res) },
    { method: 'GET', path: '/settings/teams/body', auth: true, run: async (req, res) => this.handleTeamsBodyGet(req, res) },
    // 全局规范面(2026-11-05 设置页「全局规范」):全局 SUNSHINE.md 原文读写——PUT 写在 daemon 进程
    // 内,回声抑制+直发帧经 notify 注入(handleSunshinePut 薄面,watcher 'sunshine' 键同 suppress 口径)
    { method: 'GET', path: '/settings/sunshine', auth: true, run: async (_req, res) => configHandlers.handleSunshineGet(this.configIo, res) },
    { method: 'PUT', path: '/settings/sunshine', auth: true, run: async (req, res) => configHandlers.handleSunshinePut(this.configIo, req, res, () => this.notifySunshineWrite()) },
    // G8c T6 skills/memory-stats 面：三源分组清单（project 五根合并一组/user 全局/learned 工作区锚定；
    // 组内沿装载序去重、跨组不去重——展示面重复 id 保留）+ 主域记忆概览（条数+最近写入，只读零副作用）
    { method: 'GET', path: '/settings/skills', auth: true, run: async (req, res) => this.handleSkillsGet(req, res) },
    // 学习技能删除面(2026-10-31 GUI 学习技能页签/TUI /skills-rm 共用)
    { method: 'POST', path: '/settings/skills/rm', auth: true, run: async (req, res) => configHandlers.handleSkillsRemove(this.configIo, req, res) },
    { method: 'GET', path: '/settings/memory-stats', auth: true, run: async (req, res) => this.handleMemoryStatsGet(req, res) },
    // 2026-10-26 插件面：两级装载清单视图（loadEffectivePlugins 可视化，manifest/启用态/平台/装配
    // 摘要/语义键 config 逐行列示）+ settings 语义键 plugins.<id> 结构化写（含注释/畸形 409 引流
    // raw、原子写；root 在场成功后链重载——plugins 键随 settings 链生效语义）
    { method: 'GET', path: '/settings/plugins', auth: true, run: async (req, res) => this.handlePluginsGet(req, res) },
    { method: 'PUT', path: '/settings/plugins', auth: true, run: (req, res) => this.handlePluginsPut(req, res) },
    // Task 16 providers/permissions 结构化编辑收口：单条目操作端点（handler 薄封装 catalog 写面，
    // CatalogWriteError→409+hint 沿 mcp/op 同映射；providers 写后链重载——env/模型清单随 settings 链
    // 生效；permissions 装配期语义不 reload；config-changed 帧由写内 notify 直发）
    { method: 'PUT', path: '/settings/providers/op', auth: true, run: (req, res) => this.handleProvidersOp(req, res) },
    { method: 'PUT', path: '/settings/permissions/op', auth: true, run: (req, res) => this.handlePermissionsOp(req, res) },
    // 裸端点 = 激活会话别名（G3 兼容裁定：G2 gui 面不破，v1.x 移除）；无 active 409
    { method: 'POST', path: '/submit', auth: true, run: (req, res) => this.handleSubmit(req, res, undefined) },
    { method: 'POST', path: '/steer', auth: true, run: (req, res) => this.handleSteer(req, res, undefined) },
    { method: 'POST', path: '/interrupt', auth: true, run: async (_req, res) => this.handleInterrupt(res, undefined) },
    { method: 'GET', path: '/snapshot', auth: true, run: async (req, res) => this.handleSnapshot(req, res, undefined) },
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

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse, token: string | undefined): void {
    const url = urlOf(req);
    const matched = this.matchRoute(req.method ?? 'GET', url.pathname);
    if (matched) {
      // 鉴权（§4.3/G10 收敛）：token 在场才验 Bearer（undefined=免鉴权档，恒绑回环兜底）；401 先于
      // 会话解析（不泄露会话语义）——恒时比较不做（token 非密钥材料，回环面时序侧信道无实义）
      if (token !== undefined && matched.route.auth && req.headers.authorization !== `Bearer ${token}`) {
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
      // G14.95 no-cache:index.html 恒回源(assets 文件名带内容 hash 可长缓存)——开发迭代不再踩旧壳缓存
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(index);
      return;
    }
    this.send(res, 404, { error: 'not found', hint: GUI_ASSETS_HINT });
  }

  /** body 读取 + JSON 解析：解析失败/超限统一以 {status, error} 回执，不抛出（dispatch 已兜 500，此处提前收口带准确码） */
  private async readJson(req: http.IncomingMessage, cap: number = MAX_BODY_BYTES): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > cap) return { ok: false, status: 413, error: 'payload too large' };
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
   *  /session/:id/reset）；可选 mode:'acceptEdits' 透传 createSession（G4 补面：HTTP 建 acceptEdits 会话——CLI
   *  --manual 只作用预选会话,无此面 e2e/客户端无法经 HTTP 装配 acceptEdits;其余值含缺省 = full-access 零变化）；
   *  createSession 单点（存在性/目录校验 INVALID_ARG → 400）→ 200 {ok,sessionId} */

  /** submit 处理（会话维 + 裸别名共用）：goal 非空 string 校验 → 会话 run 锁（409 拒二次提交）→
   *  202 即回（受理面；run 异步收束细节见 SessionRuntime.submit） */

  /** interrupt 处理：无在跑 run 409；中止信号发出即 200（run 以 stopReason=interrupted 收束后清锁）。
   *  G4 裁定 3：中止后该会话全部未决挂起以 deny/dismissed 回填并清表——asker promise 不回填则被中止
   *  run 永不收束（僵尸 run） */

  /** steer 处理（G3）：text 非空 string 校验（空白串与 enqueue 的 trim-忽略口径一致前置拒——静默
   *  no-op 的 200 比显式 400 更糟）→ 入该会话 steering → 恒 200 {ok:true}，无 409 分径（裁定：
   *  steering 非独占面，排队语义即承诺） */

  /** reset 处理（旧 /session/new 软重置语义迁入）：中止在跑 run + 换新运行时 + 清投影/转录/缓冲，
   *  200 {ok:true}（语义面见 SessionRuntime.reset）。G4：中止前该会话挂起回填（deny/dismissed——
   *  同 interrupt 裁定 3，防僵尸 asker promise 拖住被中止 run）；收尾广播 `{kind:'reset', sessionId}`
   *  通知帧（裁定 7：GUI 清本地投影重播种；无 seq，不入单调序列） */

  /** POST /approval/:pid {decision}（G4）：挂起表命中且 kind 对 → resolve + notice 事件帧（经该会话
   *  pump，转录可见）+ 200 {ok:true}；未知 pid / 已决（重复回执）/ kind 不符（ask 挂起错打 approval
   *  端点）统一 404；decision 非法字面 400（ApprovalDecision = 'allow'|'always'|'deny'） */

  /** POST /ask/:pid/reply {answer}（G4）：同构 approval 回执——AskUserAnswer 三态载荷校验（400）→
   *  命中且 kind 对 resolve + notice（`ask <pid> answered`）+ 200；未知/已决/kind 不符 404 */

  /** snapshot 处理：会话快照单点（载荷形态见 SessionRuntime.snapshotResponse）。G5 增挂起段——
   *  daemon 侧合并（snapshotResponse 保持 session 内聚不持挂起表）：本会话过滤（entry.sessionId）
   *  → [{pid, kind, req}]（G7 增 req=挂起表 entry.req 直序列化——连接层 pid 去重拦了重连重发帧，
   *  snapshot.pending 是 GUI 刷新/reseed 后卡内容的唯一来源），跨会话卡恢复（GUI 刷新/重连后重放
   *  挂起面）的基座 */
  /** POST /session/:id/title {text}(G10-C7):模型一次性总结会话标题(≤20 字,只回标题本身);
   *  无状态不落盘——标题缓存与编辑态由客户端 localStorage 承载;模型未接线/调用失败 503 降级 */

  /** 会话 id 形验（旁车文件名面）：newSessionId 产物字符集（时间戳+随机尾/attach journal id 同源），
   *  拒路径序列——旁车按 id 拼 sessionsDir 路径，越界 id 不得穿透 */
  /** POST /session/:id/btw {question}(G14.29 辅助问答,对标 Codex /side /btw):fork 整档旁路
   *  (side 标记,列表滤除)+ 一次性隔离 runtime 跑一轮问答,reply 直接回执——主会话上下文零污染。
   *  超时 180s 兜底;runtime 用完即弃(mcpClose 收口) */

  /** POST /session/:id/rename {title}(G14.16 标题统一流)：旁车 <journalId>.meta.json 落盘——
   *  键用 attachedJournalId(列表 listSessions 以 journal 档为行,rename 必须同键才可见)；
   *  无档会话 409(空会话零落盘不变式不破——GUI 乐观上屏静默降级,首轮建档后再改即持久)。
   *  title trim 非空、帽 80 字 */

  /** GET /session/:id/title/get(G14.16)：旁车标题回读(重开回显;无档/无旁车 = 无自定义名,
   *  title 缺省回空对象——客户端回落摘要,不当作错误) */

  /** POST /workspace/create {name}|{path}(G10-C11):原生文件选择器确认后自动建项目。
   *  name=浏览器态(showDirectoryPicker 只回名字):projectsRoot 下建 <name>/ 并初始化
   *  data/sessions + data/workspace.json{root:<name> 目录};path=桌面壳态:注册该既有目录为
   *  项目根(workspace.json 落 projectsRoot/<basename>/data)。同名/同根幂等返回既有行 */
  /** POST /workspace/locate {token, roots?}(G14.69 原生选择定位):浏览器 File System Access
   *  只回目录名不回路径——GUI 在用户所选目录写一枚标记文件,daemon 从各盘根 BFS 找同名标记文件,
   *  所在目录即所选文件夹绝对路径。roots 覆写供测试/加速;超时/未找到回 path:null(GUI 回退自建浏览) */

  /** POST /session/:id/rewind|fork {turn}(G10-C1d):1-based 轮锚点;不可变分档(branchFrom,源档零改动)。
   *  rewind=本会话切到新档(attach 重播种,原时间线保留可 /resume);fork=新会话分叉,源会话不动 */

  /** POST /session/:id/tier {tier} / …/effort {effort}(G10-C2b):per-run 覆盖,下一轮生效;
   *  'default'/缺省字段=清除覆盖回缺省;非法值 400 */

  /** POST /session/:id/model {model?: string}(G10-C1b):运行中模型切换,daemon 级共享切换器;
   *  无切换器 409 not switchable / 未知 id 400 unknown model(不动现状) */

  /** GET /session/:id/file?path=（G6 预览面，Files 页消费）：query path 必填（400）→ 会话解析
   *  （未知 :id 404）→ path.resolve(session.root, path) 归一（相对/绝对均可）→ 判界（本会话
   *  harness.safety 的路径判定面——insideTrustedRoots 单点，/diff 同口径）→ 越界 403 {path
   *  outside trusted roots} → readFileBounded（G7 抽取共用：missing 404 / binary 415 / >512KB
   *  截断 truncated:true）→ 200 {path, content, truncated?}。仅 GET（路由表 method 精确匹配） */

  /** GET /session/:id/diff?callId=（G7 收口交接，Chat write/edit 展开/Files 消费）：快照族（write/edit）
   *  调用的 pre-image ↔ 磁盘现文件双内容。查询面现场核结论——daemon 会话的影子快照 drain 仅在
   *  dispose/reset（清单随 seal 落 journal），会话存续期内 sink 内存清单常驻：**run 中与 run 后
   *  均查内存实时可得**（blob 落盘 <dataDir>/sessions/_blobs/<sha256> 即时可见）。callId → 调用
   *  对位：帧缓冲（512 环）内按序扫 tool-call 帧——首枚命中 callId 的帧即目标（text=注册名须在
   *  快照族 write/edit，payload.input.path 解析绝对路径）；同路径此前快照族调用的位次=该次
   *  pre-image 在 sink 清单的序（nthFor 按调用序对位，同路径多次写各自取写前态）。响应
   *  200 {path, oldContent?, newContent, truncated?}：oldContent=sink pre-image blob（512KB 截断；
   *  新建写无 blob 缺场）；newContent=磁盘现文件（readFileBounded——判界/截断/二进制同 /file）；
   *  truncated=任一侧截断。404 面：未知会话 / callId 无帧（含缓冲环已裁）/ 非快照族 / 无快照
   *  （root 外写不入清单）→ {error:'no snapshot'}；400：缺 callId。帧环裁剪的退化：目标帧若已被
   *  环裁（>512 事件）即 404——GUI 退单列现内容（write 回执 input.content / edit 回执 old→new 串），
   *  记档报告 */

  /** GET /session/:id/tree?path=<rel>（G8b T4 目录树面，Files 页消费）：path 缺省 ''=会话 root →
   *  判界样板同 /file（realPathOf 归一 ?? 字面兜底 → insideTrustedRoots，越界 403 恒定文案）→
   *  statSync 跟随后实态（不存在 404 / 非目录 400）→ readdirSync withFileTypes 单层列举：IGNORED
   *  名不枚举；symlink/junction 条目按跟随实态分型（dirent 对链接按链接本体分类——指向目录的
   *  链接 isDirectory()=false，win32 junction 同理，须 statSync 校正；断链/竞态消失的条目跳过）；
   *  排序=目录段先于文件段、同段 name 码点序；超 TREE_MAX_ENTRIES 截断+truncated:true →
   *  200 {entries:[{name,kind:'dir'|'file'}],truncated?} */

  /** POST /session/:id/attach {journalId}（T2）：journalId 非空 string 校验 → 未知 :id 404 →
   *  attach 单点（INVALID_ARG→400 / INVALID_STATE→409）→ 200 {ok,sessionId}（并置激活） */

  /** POST /session/:id/delete（2026-10-21 受控删除，归档页/侧栏/命令消费）：双寻址同 archive——:id 命中
   *  注册表走运行时路径（缺 journal 404），否则视作 journalId，先做 attached-journal 兜底认领（终审
   *  F1：同 journal 在座的 daemon 会话——含 idle，顶栏归档后从归档页删即此形，归档页按 journalId
   *  寻址——一律升格走运行时回收，防其仍开着的 runtime 下次 append 复活已清档；registry 命中优先，
   *  兜底不中再 findJournalOwner 跨工作区磁盘定位，未知 404）。running 一律 409（会话路径天然承继；
   *  兜底已覆盖「在座在跑」形态，旧 liveSessionByJournal 查在座在跑者随之冗余退役）。归档门禁：未归档
   *  409 'archive the session before deleting'——「下架但留档」职责已由归档态接管，删除即真清。放行后
   *  运行时路径做有界回收（deny/dismissed 挂起回填（同 interrupt 裁定 3，防僵尸 asker）+ teardown +
   *  注册表移出 + pty 连带清杀 + active 指向清 undefined；兜底命中时按 runtime id 键回收——注册表键
   *  ≠ 寻址 id），纯磁盘路径只服务真未挂载 journal；两路径同收 purgeSession 真清会话档全家（sessions
   *  目录 <jid>. 前缀伴生档 + gui/tui 面私有档） */
  private async handleDelete(res: http.ServerResponse, id: string): Promise<void> {
    const session =
      this.sessions.get(id) ??
      [...this.sessions.values()].find((s) => s.attachedJournalId === id); // F1 兜底:按 journalId 认领在座会话
    let dataDir: string;
    let jid: string;
    if (session !== undefined) {
      if (session.status() === 'running') {
        this.send(res, 409, { error: 'cannot delete while a run is in progress' });
        return;
      }
      const attached = session.attachedJournalId;
      if (attached === undefined) {
        this.send(res, 404, { error: 'session has no journal' });
        return;
      }
      jid = attached;
      dataDir = resolveDataDir(session.root);
    } else {
      if (!validSessionId(id)) {
        this.send(res, 400, { error: 'invalid session id' });
        return;
      }
      const owner = findJournalOwner(projectsRoot(), id);
      if (owner === undefined) {
        this.send(res, 404, { error: 'unknown session' });
        return;
      }
      jid = id;
      dataDir = owner.dataDir;
    }
    // 归档门禁(2026-10-21):未归档拒删——「下架但留档」职责已由归档态接管,删除即真清
    if (readSessionMeta(dataDir, jid).archived !== true) {
      this.send(res, 409, { error: 'archive the session before deleting' });
      return;
    }
    if (session !== undefined) {
      const key = session.id; // 注册表键恒为 runtime id（兜底命中时 ≠ 寻址 id）
      this.denyPendingFor(key);
      await session.teardown();
      this.sessions.delete(key);
      // 任务14：会话关闭拆其项目监听（守护面——同 root 仍被其他会话持有则保留）
      this.unwatchProjectRoot(session.root);
      // G8b T3 插杀（单会话回收处）：会话回收连带清杀其全部 pty（daemon 持 manager——serve 分层，
      // session.ts 不引 pty）；kill 同步注销 → 该会话 pty 的后续 WS 连入收 error 'pty not found'。
      // 双锚清杀(2026-11-01 漏杀根修)：journal 惰性建档前分配的 pty owner=runtime id(44a4b0a 起
      // owner 取 attachedJournalId ?? session.id 的当场值),建档后不回填——只按 journalId 锚杀会漏掉
      // 这批条目(delete 后终端进程永活),runtime id 与 journalId 两锚都杀(幂等,重复无害)
      this.sealAndKillPtyFor(key, session.attachedJournalId);
      if (this.active === key) this.active = undefined;
    }
    // 辅助会话连带删除(2026-11-06 用户裁定「删除主会话才连 side 一起清」):side 档清前先拆在座
    // side 运行时(顺序即正确性——teardown seal 落最后一笔后才 purge,否则 seal 复活已清档),pty 按
    // side journal 锚杀;浏览器状态键=journalId,side 逐个连清
    const sideIds = sideJournalsOf(dataDir, jid);
    for (const sid of sideIds) {
      const rt = [...this.sessions.values()].find((r2) => r2.attachedJournalId === sid);
      if (rt !== undefined) {
        const rk = rt.id;
        this.denyPendingFor(rk);
        await rt.teardown();
        this.sessions.delete(rk);
        this.unwatchProjectRoot(rt.root);
        this.sealAndKillPtyFor(rk);
      }
      this.sealAndKillPtyFor(sid);
    }
    purgeSession(dataDir, jid);
    purgeSideJournals(dataDir, jid); // 辅助会话档连带删除(2026-11-06 用户裁定:主删则 side 全家清)
    purgeBrowserState(dataDir, jid); // 浏览器键=journalId:状态文件/输出目录/侧栏分区随会话删除
    for (const sid of sideIds) purgeBrowserState(dataDir, sid);

    this.send(res, 200, { ok: true });
  }

  /** POST /session/:id/pty {cols?,rows?}（G8b T3 分配面）：cols/rows 缺省 80/24，在场须正整数
   *  （400）→ 会话解析（未知 :id 404，sessionFor 单点）→ shell 探测 daemon 内定（win32
   *  powershell.exe / 其余 process.env.SHELL ?? /bin/bash）→ PtyManager.spawn（cwd=session.root、
   *  owner=:id、env 继承 process.env）→ 200 {ptyId}（`pty-<启动段>-<n>` 单调永不复用）。T5/T6 拿 ptyId 连
   *  `/session/:id/pty/:ptyId` 专用 WS 升级路径（本文件 attachWs 分支） */

  /** DELETE /session/:id/pty/:ptyId（G8b T3 kill 面）：PtyManager.kill 幂等（无此 id 静默）——重复
   *  DELETE / 自然退出后再删均 200 {ok:true}；kill 同步注销（has→false 立即），exit 帧异步送达在线
   *  pty WS。会话解析先行（未知 :id 404，sessionFor 单点——路由面会话维语义一致性）。
   *  G8e-T4 归属校验：条目在但 owner ≠ :id → 404 'pty not found for session'（跨会话删他人终端
   *  拒绝且不误杀）；条目不在 → 200 幂等面维持（kill 幂等语义不因校验收紧而回退） */

  /** GET /workspaces（T2）：扫 projectsRoot() 下各 `<slug>/data` 存在者——root 经 workspace.json
   *  反解（历史工作区无档 → slug-only 行不可 attach）；mtime=dataDir mtime；sessionCount=sessions
   *  子目录 jsonl 计数（缺目录=0）。行序 mtime 降序（最近工作区在前，首页呈现序）；单目录/单档的
   *  扫描竞态（readdir 与 stat 之间被删）跳过该条目，不击穿整个列表 */

  /** GET /sessions/recent(G10-C2):跨工作区扁平最近会话(侧栏 Recents 区数据源)——遍历注册表
   *  逐 dataDir listSessions 归并,updatedAt 降序取前 20;每条附 root/slug(attach 两步寻址用) */

  /** GET /sessions?root=（T2）：root 必填（缺省 400——无 root 无法定位 dataDir）→ listSessions
   *  dirs=readdirSync withFileTypes 只目录 + 排序；parent=resolve('..')（盘根时=自身） */


  // ---------- D31 分域拆分：配置面处理器迁 config-handlers.ts（io 注入 send/readJson/
  //  reloadSettingsChain 三面——配置块对类状态的全部触点）；本类保留路由表与薄委托，行为零变化
  //  （daemon.test 全量为锚）。wire/static/config-helpers 助手域随批迁叶子模块 ----------
  private get configIo(): ConfigHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req, cap) => this.readJson(req, cap),
      reloadSettingsChain: (root) => this.reloadSettingsChain(root),
    };
  }

  /** PUT /settings 成功后的链重载（G8c T2）：清全部自填槽（env 槽 + 登记集，清集在删槽后、重装前）
   *  → 按项目→全局序重装（applySettings 只填缺省：真导出环境变量恒最优先，重载天然不触碰）。
   *  逐级 try/catch：PUT 已写盘成功是既成事实——重装时任一级文件畸形（如全局 settings 坏）不能让
   *  PUT 回 500（写成功却报失败误导；且坏文件会结构性死锁一切后续结构化改写）。该级跳过、错误经
   *  stderr 透出（与 warnings 同通道）；畸形文件的 fail-fast 属装载链入口（CLI）职责，不在此处。
   *  窄缝：进程内链可能来自其他 root 的项目文件——本重载以 PUT 目标 root 为准重装，跨 root 场景
   *  以最近编辑为准。root 缺省（scope=global 写）**不再只装全局面**（2026-11-09 用户裁定「全局更改
   *  时后台重载新的全局和项目配置」）：锚本 daemon 的装载根（providerRoot=serve 预选根/壳 cwd，与
   *  启动期 loadSettingsChain 的项目层同组成）重装两层——既保全局变更即时生效，又不丢启动装入的
   *  项目槽（只装全局=清掉项目槽的半截链，曾因此不敢在 raw 全局写路径触发 reload）。 */
  private reloadSettingsChain(root: string | null | undefined): void {
    const anchor = root ?? this.providerRoot;
    for (const slot of getSelfFilledSlots()) delete process.env[slot];
    resetSelfFilledSlots();
    for (const filePath of [loadProjectSettings(anchor), loadGlobalSettings()]) {
      try {
        for (const w of applySettings(filePath).warnings) console.error(`[serve] ${w}`);
      } catch (err) {
        console.error(`[serve] settings reload failed (${filePath}):`, err instanceof Error ? err.message : String(err));
      }
    }
    this.refreshModelLayer(anchor);
  }

  /** 模型层随配置热重载：切换器在启动时按当时 settings 冻结 choices 与各源密钥——env 重装后须原地重建内芯，
   *  否则欢迎页（实时读盘）看得到的 providers，会话发送时却回落缺省内芯报「API key 未配置」。
   *  非切换器装配（单模型形态）无清单可刷，跳过；providers 解析失败旁路不击穿写回执 */
  private refreshModelLayer(root: string | undefined): void {
    if (!(this.model instanceof ModelSwitcher)) return;
    try {
      const providers = loadProviders(root ?? this.providerRoot);
      for (const w of providers.warnings) console.error(`[serve] ${w}`);
      this.model.reload(providers.choices);
    } catch (err) {
      console.error('[serve] model reload failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private handleSettingsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleSettingsGet(this.configIo, req, res);
  }

  private async handleSettingsPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleSettingsPut(this.configIo, req, res);
  }

  private handleSettingsRawGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleSettingsRawGet(this.configIo, req, res);
  }

  private async handleSettingsRawPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleSettingsRawPut(this.configIo, req, res);
  }

  private handleMcpGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleMcpGet(this.configIo, req, res);
  }

  private async handleMcpProbe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleMcpProbe(this.configIo, req, res);
  }

  private async handleMcpPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleMcpPut(this.configIo, req, res);
  }

  private async handleMcpOp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleMcpOp(this.configIo, req, res);
  }

  private async handleProvidersOp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleProvidersOp(this.configIo, req, res);
  }

  private async handlePermissionsOp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handlePermissionsOp(this.configIo, req, res);
  }

  private handlePluginsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handlePluginsGet(this.configIo, req, res);
  }

  private async handlePluginsPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handlePluginsPut(this.configIo, req, res);
  }

  private handleAgentsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleAgentsGet(this.configIo, req, res);
  }

  private async handleAgentsPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleAgentsPut(this.configIo, req, res);
  }

  private handleAgentsBodyGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleAgentsBodyGet(this.configIo, req, res);
  }

  private handleTeamsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleTeamsGet(this.configIo, req, res);
  }

  private async handleTeamsPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleTeamsPut(this.configIo, req, res);
  }

  private handleTeamsBodyGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleTeamsBodyGet(this.configIo, req, res);
  }

  private handleSkillsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleSkillsGet(this.configIo, req, res);
  }

  private handleMemoryStatsGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleMemoryStatsGet(this.configIo, req, res);
  }

  /** 全局规范写后通知(2026-11-05):watcher 抑制(写发生在本进程,防自触回声)+config-changed 直发——
   *  与 onCatalogWrite 钩子同套两路合一,唯 sunshine 无 catalog 面,由 PUT 包装层就地注入 */
  private notifySunshineWrite(): void {
    this.watcher.suppress('sunshine', 'global', null);
    this.broadcastFrame({ kind: 'config-changed', resource: 'sunshine', scope: 'global', root: null });
  }

  // ---------- D31 批2 分域：会话控制面迁 session-handlers.ts（io 九面：send/readJson/sessionFor/
  //  sessions/denyPendingFor/broadcastFrame/pending/model/attach），文件面迁 file-handlers.ts
  //  （io 两面）；本类保留路由表与薄委托，行为零变化（daemon.test 为锚） ----------
  private get sessionIo(): SessionHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req, cap) => this.readJson(req, cap),
      sessionFor: (res, id) => this.sessionFor(res, id),
      sessions: this.sessions,
      denyPendingFor: (sessionId) => this.denyPendingFor(sessionId),
      broadcastFrame: (frame) => this.broadcastFrame(frame),
      model: this.model,
      attach: (id, journalId) => this.attach(id, journalId),
      createSession: (root, opts) => this.createSession(root, opts),
      defaultScratchRoot: () => lifecycle.defaultScratchRoot(),
      resolveApproval: (pid, decision) => this.resolveApproval(pid, decision),
      resolveAsk: (pid, answer) => this.resolveAsk(pid, answer),
      resolvePlanApproval: (pid, decision) => this.resolvePlanApproval(pid, decision),
    };
  }

  private get fileIo(): FileHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      sessionFor: (res, id) => this.sessionFor(res, id),
    };
  }

  // ---------- D31 批3 分域：工作区面迁 workspace-handlers.ts（io 两面）、pty 面迁 pty-handlers.ts
  //  （io 五面，ptyId 铸造经 nextPtyId 回调持守类内单调 seq）、memory 两处理器并入 config-handlers ——
  //  本类保留路由表与薄委托，行为零变化（daemon.test 为锚） ----------
  private get workspaceIo(): WorkspaceHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req, cap) => this.readJson(req, cap),
      // 创建/登记成功后静默补全（2026-10-30 用户裁定「创建项目后该加载都要静默加载」）：既有目录
      // 登记（选完即建）时 `.sunshinex` 可能已就位——就地挂 watcher（会话未开也有帧）+ 广播 skills
      // 帧（在座 GUI 面静默重拉该 root 的 skills 视图）；纯新目录（无 `.sunshinex`）不挂不广播，
      // 会话打开时「GET 即读」+ watchProject 补挂兜底
      afterCreate: (root) => {
        if (this.watchProjectRoot(root)) this.broadcastFrame({ kind: 'config-changed', resource: 'skills', scope: 'project', root });
      },
    };
  }

  private get ptyIo(): PtyHandlerIo {
    return {
      send: (res, status, body) => this.send(res, status, body),
      readJson: (req, cap) => this.readJson(req, cap),
      sessionFor: (res, id) => this.sessionFor(res, id),
      ptyManager: this.ptyManager,
      nextPtyId: () => `pty-${this.ptyBoot}-${(this.ptySeq += 1)}`,
    };
  }
  private async handleWorkspaceLocate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await workspaceHandlers.handleWorkspaceLocate(this.workspaceIo, req, res);
  }

  private async handleWorkspaceCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await workspaceHandlers.handleWorkspaceCreate(this.workspaceIo, req, res);
  }

  private async handleWorkspaceHide(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await workspaceHandlers.handleWorkspaceHide(this.workspaceIo, req, res);
  }

  private handleWorkspaces(res: http.ServerResponse): void {
    workspaceHandlers.handleWorkspaces(this.workspaceIo, res);
  }

  private handleDirpicker(req: http.IncomingMessage, res: http.ServerResponse): void {
    workspaceHandlers.handleDirpicker(this.workspaceIo, req, res);
  }

  private async handleMemoryRm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await configHandlers.handleMemoryRm(this.configIo, req, res);
  }

  private handleMemoryList(req: http.IncomingMessage, res: http.ServerResponse): void {
    configHandlers.handleMemoryList(this.configIo, req, res);
  }

  private async handlePtyAlloc(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await ptyHandlers.handlePtyAlloc(this.ptyIo, req, res, id);
  }

  private handlePtyKill(res: http.ServerResponse, id: string, ptyId: string): void {
    ptyHandlers.handlePtyKill(this.ptyIo, res, id, ptyId);
  }
  private async handleSessionNew(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await sessionHandlers.handleSessionNew(this.sessionIo, req, res);
  }

  private async handleApprovalReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    await sessionHandlers.handleApprovalReply(this.sessionIo, req, res, pid);
  }

  private async handleAskReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    await sessionHandlers.handleAskReply(this.sessionIo, req, res, pid);
  }

  private async handlePlanApprovalReply(req: http.IncomingMessage, res: http.ServerResponse, pid: string): Promise<void> {
    await sessionHandlers.handlePlanApprovalReply(this.sessionIo, req, res, pid);
  }

  private async handleSessionBtw(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionBtw(this.sessionIo, req, res, id);
  }

  /** 辅助对话清单：主会话 journal 的 side 档（sideOf 回指）按 mtime 正序——GUI 重进主会话恢复页签。
   *  双寻址(2026-11-06 竞态根修):在座按 attachedJournalId 认领;不在座(重启后 GUI 收养完成前,
   *  GUI 手握 journal id 查询)退磁盘定位 findJournalOwner——清单本就纯盘面推导,不依赖在座;
   *  此前不在座恒 200 [] 假空,GUI 对账按「无 side」放闸 stale 页签=重启后辅助页签空转录 */
  private handleSessionSides(res: http.ServerResponse, id: string): void {
    const session =
      this.sessions.get(id) ??
      [...this.sessions.values()].find((s) => s.attachedJournalId === id);
    let srcId: string | undefined = session?.attachedJournalId;
    let dataDir: string | undefined = session !== undefined ? resolveDataDir(session.root) : undefined;
    if (session === undefined) {
      if (!validSessionId(id)) return this.send(res, 200, []);
      const owner = findJournalOwner(projectsRoot(), id);
      if (owner === undefined) return this.send(res, 200, []);
      srcId = id;
      dataDir = owner.dataDir;
    }
    if (srcId === undefined || dataDir === undefined) return this.send(res, 200, []);
    const dir = sessionsDir(dataDir);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return this.send(res, 200, []);
    }
    const out: Array<{ journalId: string; sessionId?: string; title: string; updatedAt: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { side?: unknown; sideOf?: unknown; title?: unknown };
        if (meta.side !== true || meta.sideOf !== srcId) continue;
        const jid = name.slice(0, -'.meta.json'.length);
        const live = [...this.sessions.values()].find((rt) => rt.attachedJournalId === jid);
        out.push({
          journalId: jid,
          ...(live !== undefined ? { sessionId: live.id } : {}),
          title: typeof meta.title === 'string' ? meta.title : '辅助对话',
          updatedAt: fs.statSync(path.join(dir, name)).mtimeMs,
        });
      } catch {
        /* 坏 meta 行跳过 */
      }
    }
    out.sort((a, b) => a.updatedAt - b.updatedAt);
    this.send(res, 200, out);
  }

  private async handleBranch(req: http.IncomingMessage, res: http.ServerResponse, id: string, kind: 'rewind' | 'fork'): Promise<void> {
    await sessionHandlers.handleBranch(this.sessionIo, req, res, id, kind);
  }

  private handleSessionsRecent(res: http.ServerResponse): void {
    sessionHandlers.handleSessionsRecent(this.sessionIo, res);
  }

  private handleSessions(req: http.IncomingMessage, res: http.ServerResponse): void {
    sessionHandlers.handleSessions(this.sessionIo, req, res);
  }
  private async handleSubmit(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    await sessionHandlers.handleSubmit(this.sessionIo, req, res, id);
  }

  private handleInterrupt(res: http.ServerResponse, id: string | undefined): void {
    sessionHandlers.handleInterrupt(this.sessionIo, res, id);
  }

  private async handleSteer(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): Promise<void> {
    await sessionHandlers.handleSteer(this.sessionIo, req, res, id);
  }

  private async handleReset(res: http.ServerResponse, id: string | undefined): Promise<void> {
    await sessionHandlers.handleReset(this.sessionIo, res, id);
  }

  private async handleSessionCommand(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionCommand(this.sessionIo, req, res, id);
  }

  private handleSessionTasks(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionTasks(this.sessionIo, res, id);
  }

  private handleSessionContext(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionContext(this.sessionIo, res, id);
  }

  private handleShadowEvents(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleShadowEvents(this.sessionIo, res, id);
  }

  private handleAnchors(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleAnchors(this.sessionIo, res, id);
  }

  private handleRestorePlan(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const q = urlOf(req).searchParams;
    const turn = Number(q.get('turn') ?? NaN);
    const userFromEnd = Number(q.get('userFromEnd') ?? NaN);
    if (Number.isInteger(userFromEnd) && userFromEnd >= 0) return sessionHandlers.handleRestorePlan(this.sessionIo, res, id, { userFromEnd });
    if (Number.isInteger(turn) && turn >= 1) return sessionHandlers.handleRestorePlan(this.sessionIo, res, id, { turn });
    this.send(res, 400, { error: 'turn or userFromEnd query param required' });
  }

  private handleSnapshot(req: http.IncomingMessage, res: http.ServerResponse, id: string | undefined): void {
    // 2026-10-26 三期分页:tail(缺省 200)/before+limit(补全页)。校验失败 400;tail 与 before 互斥
    const q = urlOf(req).searchParams;
    const numOf = (k: string): number | undefined => {
      const v = q.get(k);
      if (v === null || v === '') return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : NaN;
    };
    const tail = numOf('tail');
    const before = numOf('before');
    const limit = numOf('limit');
    if (Number.isNaN(tail) || Number.isNaN(before) || Number.isNaN(limit) || (tail !== undefined && before !== undefined)) {
      this.send(res, 400, { error: 'invalid snapshot paging params' });
      return;
    }
    sessionHandlers.handleSnapshot(this.sessionIo, res, id, tail !== undefined || before !== undefined ? { ...(tail !== undefined ? { tail } : {}), ...(before !== undefined ? { before, ...(limit !== undefined ? { limit } : {}) } : {}) } : undefined);
  }

  private async handleSteerMove(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerMove(this.sessionIo, req, res, id);
  }

  private async handleSteerFront(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerFront(this.sessionIo, req, res, id);
  }

  private async handleSteerCancel(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerCancel(this.sessionIo, req, res, id);
  }

  private async handleSteerEdit(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSteerEdit(this.sessionIo, req, res, id);
  }

  private async handleSessionTierEffort(req: http.IncomingMessage, res: http.ServerResponse, id: string, kind: 'tier' | 'effort'): Promise<void> {
    await sessionHandlers.handleSessionTierEffort(this.sessionIo, req, res, id, kind);
  }

  private handleSessionModelGet(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionModelGet(this.sessionIo, res, id);
  }

  private async handleSessionModel(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionModel(this.sessionIo, req, res, id);
  }

  private async handleSessionMode(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionMode(this.sessionIo, req, res, id);
  }

  private async handleSessionRename(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionRename(this.sessionIo, req, res, id);
  }

  private handleSessionTitleGet(res: http.ServerResponse, id: string): void {
    sessionHandlers.handleSessionTitleGet(this.sessionIo, res, id);
  }

  private async handleSessionTitle(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleSessionTitle(this.sessionIo, req, res, id);
  }

  private async handleAttach(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    await sessionHandlers.handleAttach(this.sessionIo, req, res, id);
  }

  private handleFile(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    fileHandlers.handleFile(this.fileIo, req, res, id);
  }

  private handleDiff(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    fileHandlers.handleDiff(this.fileIo, req, res, id);
  }

  private handleTree(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    fileHandlers.handleTree(this.fileIo, req, res, id);
  }


  private send(res: http.ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
