import type { SessionEvent } from '../../src/types';
import type { TaskBoardState } from '../../src/taskboard/model';
import type { Delegation } from '../../src/delegation/projection';

/**
 * G3.5 gui 连接层（会话维）：daemon 控制面的浏览器侧单点，单连接生命周期状态机
 * （connecting → open ⇄ reconnecting → closed）。骨架平移自 G3 单点版（四态/指数退避/
 * generation guard/seq 过滤），会话维三处改判：
 * - 帧按 sessionId 分发：单 WS 收全会话帧（daemon 无订阅概念，连接建立即补发全部会话缓冲），
 *   连接层不滤会话全交上层 onEvent(sessionId, e, seq)——投影挂哪个会话由上层裁。
 * - seq 过滤改每会话基线：daemon seq 泵全局单调（跨会话不重号），但多会话补发流按会话序
 *   s1..sN 交错到达——全局单 lastSeq 会误丢他会话帧，故 Map<sessionId, lastSeq> 各归各。
 *   基线写点：①每次连接建立清零（重连=全量重放裁定，见下）；②sessionSnapshot(id) 应答
 *   以 lastSeq 抬高（防快照在途帧双应用——种子替换投影后，≤ 快照切割序的迟到帧照投即重）。
 * - 重连 = onReset + 全量重放：连接建立（首连与重连同路径）不再自动拉快照——多会话下由
 *   上层逐会话重拉（sessionSnapshot 供上层），连接层只回调 onReset()（上层清投影）后放行
 *   全部补发帧（基线清零 → 补发帧各会话依序全过）。旧 onResync(snapshot) 载荷路径退役。
 * 退避重连/显式 close/generation guard 语义平移：非显式 close 掉线 → reconnecting →
 * base×2^n 帽 30s 重连，成功建立（open 落定）清零；旧 socket 迟到回调凭代次失效。
 * 旧名退役（G3.5 裁定）：裸端点 submit/steer/interrupt/snapshot 删除——会话维 :id 形态
 * 唯一（daemon 侧裸端点仍是激活别名，gui 面不再消费）。
 * G4 挂起面（审批/问询/reset）：approval/ask 挂起帧无 seq 不入单调序列——pid（daemon 级
 * 铸票，连接生命周期维 Set 去重，重连重发幂等）回调上层；回执走 HTTP（replyApproval/
 * replyAsk，寻址统一帧顶层 pid——req.id 是会话内编号非寻址键）；reset 通知帧帧帧回调
 * （onResetSession）；deleteSession（T2 回收端点）供 Chat 顶栏 Delete（G5:Home 行 Delete 以
 * journal id 寻址恒 404 退役——会话端点以 daemon 会话 id 寻址才是有效路径）；boardReview
 * （G5 看板服务面）供 Board 页 gate 行内审批。
 */

/** 粗粒度转录条目(对齐主仓 src/serve/transcript.ts TranscriptEntry;G4 对齐五 kind——
 *  notice/error 归档面在档,三 kind 子集声明会静默窄化种子数据) */
export interface SnapshotMessage {
  seq: number;
  ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error';
  md: string;
}

/** G4 审批挂起请求(gui 侧契约声明;对齐 daemon ApprovalFrame.req 即 src/types ApprovalRequest
 *  字面,不引其类型):id 是会话内编号(ap-N)——非回执寻址键,回执统一用帧顶层 pid(T1 契约:
 *  误用 req.id 打 /approval/:pid 会静默 404)。字段全可选:gui 只展示不消费其结构完整性 */
export interface GuiApprovalReq {
  id?: string;
  kind?: string;
  subject?: string;
  reason?: string;
}

/** G4 问询挂起请求(对齐 AskUserRequest 实发字段——现场核 daemon 帧形态):customIndex 即
 *  「Other…」自由输入项下标(allowCustom 形态的实载字段,gui 以 customIndex !== undefined
 *  判输入面在场);filterable 仅 TUI 渲染面消费,gui 忽略 */
export interface GuiAskReq {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  customIndex?: number;
  filterable?: boolean;
}

/** G4 问询回执三态(对齐 AskUserAnswer):勾选 / 自定义文本 / 放弃(放弃属正常观察非错误) */
export type GuiAskAnswer =
  | { type: 'selected'; labels: string[] }
  | { type: 'custom'; text: string }
  | { type: 'dismissed' };

/** GET /session/:id/snapshot 载荷形态（T1 会话维，gui 侧契约声明）；lastSeq 见 Connection.sessionSnapshot 交集。
 *  G5 扩段:team(teammate 投影——harness.team 同源,Board 侧栏消费;daemon 必发,类型上可选防旧档)、
 *  pending(本会话未决挂起;G7 增 req=挂起表 entry.req 直序列化——连接层 pid 去重拦了重连重发帧,
 *  snapshot 是刷新/reseed 后卡内容的唯一来源,Chat reseed 据此重建卡) */
export interface SnapshotResponse {
  messages: SnapshotMessage[];
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
  /** G10 切换/队列回显段 */
  model?: string;
  mode?: 'dontAsk' | 'manual' | 'plan';
  tier?: 'small' | 'medium' | 'large';
  effort?: string;
  queued?: Array<{ seq: number; text: string }>;
  team?: Array<{ name: string; busy: boolean }>;
  pending?: Array<{ pid: string; kind: 'approval' | 'ask'; req?: unknown }>;
}

/** GET /workspaces 行（T2 工作区注册表，对齐主仓 daemon.ts WorkspaceRow）：root 经 workspace.json
 *  反解——历史工作区（TUI 时代档）无此档 → root undefined（不可 attach，仅统计展示） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
}

/** GET /sessions?root= 行（T2，对齐主仓 session-journal.ts SessionMeta 实际返回）：id=journal id */
export interface SessionRow {
  id: string;
  file: string;
  updatedAt: number;
  firstUser?: string;
  forkedFrom?: { sourceSessionId: string; upToLine: number; kind: 'rewind' | 'fork' };
}

/** GET /dirpicker?path= 载荷（T2 服务端目录选择）：path=绝对路径，parent=上级（盘根=自身），dirs=子目录名 */
export interface DirPickerResp {
  path: string;
  parent: string;
  dirs: string[];
}

/** GET /session/:id/file?path= 载荷（G6 预览面）：path=daemon 侧 resolve 归一后的绝对路径；
 *  truncated=true 表示原文超 512KB、content 为首 512KB 截断（预览语义非全文） */
export interface FileResp {
  path: string;
  content: string;
  truncated?: boolean;
}

/** GET /session/:id/diff?callId= 载荷（G7 收口交接）：write 调用 pre-image ↔ 磁盘现文件双内容——
 *  oldContent=写前 pre-image blob（新建写无 blob 缺场）;newContent=磁盘现文件(后续写已覆盖时非
 *  本调用的 content——现文件语义);truncated=任一侧超 512KB 截断 */
export interface DiffResp {
  path: string;
  oldContent?: string;
  newContent: string;
  truncated?: boolean;
}

/** GET /session/:id/tree 行（G8b T4 目录面）：name=文件/目录名（单层直读，无路径前缀） */
export interface TreeEntry {
  name: string;
  kind: 'dir' | 'file';
}

/** GET /session/:id/tree?path= 载荷（G8b T4）：path=相对会话 root 的目录路径（缺省 ''=root，
 *  判界一致性由服务端保证——403 越界/404 不存在/400 非目录以 HTTP 失败抛错）；truncated=true
 *  表示超服务端上限截断（T4 定 500 行）——目录树行尾「…已截断」标记的判据 */
export interface TreeResp {
  entries: TreeEntry[];
  truncated?: boolean;
}

// ---------- G8c T7：设置面类型（gui 侧契约声明，字段形与 daemon T2-T6 应答同形；不引服务端类型） ----------

/** GET /settings keys 行（T2，对齐 daemon effectiveKeyRow 产物）：value 恒取 env 槽（槽缺即
 *  null——文件有值但未装载的键如实报「有配置但未生效」）；source 四态 effective 归因；
 *  envOverride=true 表示真导出环境变量覆盖文件面（GUI 禁编+徽标） */
export interface SettingsKeyRow {
  key: string;
  value: string | null;
  source: 'env' | 'project' | 'global' | 'default';
  envOverride: boolean;
}

/** permissions 单面（对齐主仓 PermissionsConfig）：deny/allow 命令规则 + additionalDirs 可达目录 */
export interface PermissionsBlocks {
  deny: string[];
  allow: string[];
  additionalDirs: string[];
}

/** providers.choices 行（对齐主仓 ModelChoice 的 gui 只读投影——reasoningEffort 宽化为 string，
 *  GUI 呈现面不消费其枚举约束） */
export interface ProviderChoice {
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  contextWindow?: number;
  reasoningEffort?: string;
}

/** GET /settings 载荷（T2 Settings 页数据源）：keys 按 SEMANTIC_KEYS 键序全量；permissions 三面
 *  {merged=两级拼接去重视图态, project, global}；providers 密钥只报在场布尔不显值。
 *  G8d T5 增 warnings：两级 settings.json 的 flatten 告警（未知/退役键，项目先行拼全局）——
 *  RawPane 顶部告警列表数据源；可选防旧 daemon（无该字段） */
export interface SettingsView {
  keys: SettingsKeyRow[];
  permissions: { merged: PermissionsBlocks; project: PermissionsBlocks; global: PermissionsBlocks };
  providers: { choices: ProviderChoice[]; apiKeyPresent: Record<string, boolean>; warnings: string[] };
  warnings?: string[];
}

/** GET /settings/mcp 行（T4 两级遮蔽视图）：env 打码折叠为键名列表（env 值不回传——PUT 结构化写
 *  全值回写、raw 面另有无打码原文）；transport 缺省归一显形 'stdio'；shadowed=被项目同名遮蔽 */
export interface McpRow {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  source: 'project' | 'global';
  shadowed: boolean;
}

/** PUT /settings/mcp servers 行（T4 结构化写输入）：与 McpRow 的差面=写面收 env 全值（文件本就
 *  承载）、无 source/shadowed（写恒项目级、遮蔽是装载态）；transport 可缺省（daemon 归一 stdio） */
export interface McpRowInput {
  name: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/** POST /settings/mcp/probe 联合应答：ok:true 携 tools 清单；ok:false 携 error（连接失败/身份
 *  不符/超时截断文）——探测是诊断面，失败即结果，同为 200 非 HTTP 错误码 */
export type McpProbeResult = { ok: true; tools: Array<{ name: string; description?: string }> } | { ok: false; error: string };

/** GET /settings/agents builtins 行（T5 四预设角色平铺）：role=AgentRole 字面量（gui 侧宽化为
 *  string——呈现面不消费枚举闭包），name/framing 取 ROLE_PRESETS */
export interface BuiltinRole {
  role: string;
  name: string;
  framing: string;
}

/** GET /settings/agents view.entries 行（T5，对齐主仓 AgentEntryView 只读投影）：source 两级
 *  归因 + shadowed 被遮蔽标记 + bodyPreview 正文前 200 字符（防长正文击穿设置面板） */
export interface AgentEntryView {
  id: string;
  name: string;
  description?: string;
  memory?: boolean;
  isolation?: string;
  executor?: string;
  source: 'project' | 'global';
  shadowed: boolean;
  bodyPreview: string;
}

/** 两级扫描宽容清单（T5）：生效+被遮蔽全量 + 逐文件告警（畸形文件不抛死，路径入 warnings） */
export interface AgentsView {
  entries: AgentEntryView[];
  warnings: string[];
}

/** PUT /settings/agents upsert 的 frontmatter 面（T5）：name 必填，可选键按需——字符串值须单行
 *  （frontmatter 是单行 KV 词法，多行内容属 body 面；单行约束由 daemon 400 面守卫） */
export interface AgentFrontmatterInput {
  name: string;
  description?: string;
  memory?: boolean;
  isolation?: string;
  executor?: string;
}

/** 技能三源分组行（T6，对齐主仓 SkillsGroup）：source 三段 project/user/learned；组内去重沿装载
 *  序、跨组不去重（多源同名两组各在，遮蔽裁决属装配面）；无 frontmatter 的技能行只含 id */
export interface SkillsGroup {
  source: 'project' | 'user' | 'learned';
  skills: Array<{ id: string; name?: string; description?: string }>;
}

/** T8/T9 面别名（规划文档中的 Gui 后缀名——与上面主名同一类型，两个导入名均可用） */
export type AgentsViewGui = AgentsView;
export type SkillsGroupGui = SkillsGroup;

/** 连接状态机：启动 connecting；建立 open；掉线 reconnecting；显式 close 恒 closed */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** WS 下行帧：`{kind:'event', sessionId, seq, e}`（T1 会话维）；G4 挂起/reset 帧无 seq 不入单调
 *  序列（approval/ask 带 pid+req，reset 只挂 sessionId）；其余 kind（hello 等）/无 seq/
 *  无 sessionId 帧不入单调序列，忽略 */
interface WsFrame {
  kind: string;
  sessionId?: string;
  seq?: number;
  e?: SessionEvent;
  pid?: string;
  req?: unknown;
}

export interface ConnectionOpts {
  baseUrl: string;
  token: string;
  /** 就绪帧投递（已过每会话 seq 过滤，按帧 sessionId 分发——连接层不滤会话，全给上层） */
  onEvent: (sessionId: string, e: SessionEvent, seq: number) => void;
  /** 每次连接建立（首连与重连同路径）回调：上层清各会话投影 + 逐会话重拉 snapshot
   *  （重连=重置投影+全量重放裁定——连接层不再自动拉快照，sessionSnapshot 供上层重建基线） */
  onReset: () => void;
  /** G4 审批挂起帧回调（pid 为 daemon 级回执寻址键，非 req.id；同 pid 重复帧只回调一次——
   *  重连重发幂等；会话过滤归上层） */
  onApproval?: (sessionId: string, pid: string, req: GuiApprovalReq) => void;
  /** G4 问询挂起帧回调（同上 pid 去重；AskUserRequest 无 id 字段——pid 单点承载寻址） */
  onAsk?: (sessionId: string, pid: string, req: GuiAskReq) => void;
  /** G4 会话 reset 通知帧回调（不去重——每帧都回调：一次 HTTP reset = 一次通知；上层清该
   *  会话投影重播种） */
  onResetSession?: (sessionId: string) => void;
  /** 状态机迁移回调（含初始 connecting） */
  onStateChange?: (s: ConnectionState) => void;
  /** 退避基数 ms（缺省 1000；delay = base×2^连续失败数，帽 30s）——测试注入 1 */
  backoffBaseMs?: number;
}

export interface Connection {
  /** GET /workspaces：工作区注册表扫描（T2） */
  workspaces(): Promise<WorkspaceRow[]>;
  /** GET /sessions?root=：工作区会话（journal）列表（T2） */
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** GET /sessions/recent：跨工作区扁平最近会话（G10-C2 侧栏 Recents 区） */
  recentSessions(): Promise<Array<SessionRow & { root: string; slug: string }>>;
  /** GET /session/:id/model：模型 pill 数据源(G10-C4;choices 空=不可切) */
  sessionModel(id: string): Promise<{ current?: string; explicitDefault: boolean; choices: Array<{ id: string; model: string; baseUrl: string; effort?: string; contextWindow?: number }> }>;
  /** POST /session/:id/model|tier|effort|mode:运行中切换(下一轮生效;G10-C1b/C2b) */
  setSessionModel(id: string, model?: string): Promise<void>;
  setSessionTier(id: string, tier?: 'small' | 'medium' | 'large'): Promise<void>;
  setSessionEffort(id: string, effort?: string): Promise<void>;
  setSessionMode(id: string, mode: 'dontAsk' | 'manual' | 'plan'): Promise<void>;
  /** POST /session/:id/steer/cancel:撤回排队插话(G10-C1d) */
  cancelSteer(id: string, seq: number): Promise<void>;
  /** POST /session/:id/rewind|fork(G10-C1d):turn=anchors 1-based */
  rewindSession(id: string, turn: number): Promise<void>;
  forkSession(id: string, turn: number): Promise<{ sessionId: string }>;
  /** GET /session/:id/anchors:任务轮锚点(rewind/fork 寻址) */
  sessionAnchors(id: string): Promise<Array<{ turn: number; text: string }>>;
  /** POST /memory/rm:记忆删除(G10-C1d) */
  removeMemory(root: string, slugs: string[]): Promise<{ removed: string[]; failed: Array<{ slug: string; error: string }> }>;
  /** POST /session/:id/command:斜杠命令直跑(G10-C1c) */
  runCommand(id: string, line: string): Promise<void>;
  /** GET /commands:清单+双语描述+supported(G10-C4 命令面板数据源) */
  commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }>;
  /** GET /session/:id/context:上下文分段构成(G10-C6 面板) */
  sessionContext(id: string): Promise<{ parts: Array<{ id: string; tokens: number; count: number }>; chainByAction: Array<{ action: string; tokens: number }>; total: number; window: number; free: number }>;
  /** GET /session/:id/tasks:后台任务账本行(G10-C6 面板) */
  sessionTasks(id: string): Promise<Array<{ id: string; kind: string; label: string; status: string; startedAt: number; exitCode?: number }>>;
  /** GET /memory?root=:记忆清单(G10-C6 面板) */
  memoryList(root: string): Promise<Array<{ slug: string; type: string; created: string; modified: string; description: string }>>;
  /** GET /dirpicker?path=（缺省 home）：服务端目录浏览（T2） */
  dirpicker(path?: string): Promise<DirPickerResp>;
  /** POST /session/new {root, mode?}:按 root 装配新会话（并置激活）→ {sessionId};mode 可选
   *  ('manual' 审批问询挂起 / 'dontAsk' 缺省)——缺省不发 body 字段(旧 daemon 兼容) */
  newSession(root: string, mode?: 'dontAsk' | 'manual'): Promise<{ sessionId: string }>;
  /** POST /session/:id/attach {journalId}：恢复既有 journal 到该会话（并置激活） */
  attach(sessionId: string, journalId: string): Promise<void>;
  /** POST /session/:id/submit {goal}：会话提交（202 受理；409 拒二次提交） */
  sessionSubmit(id: string, goal: string): Promise<void>;
  /** POST /session/:id/steer {text}：运行中插话（排队语义）；HTTP 失败抛错（消息含 status） */
  sessionSteer(id: string, text: string): Promise<void>;
  /** POST /session/:id/interrupt：中止在跑 run（无在跑 409） */
  sessionInterrupt(id: string): Promise<void>;
  /** GET /session/:id/snapshot：会话全量快照；lastSeq 同源 seq 泵——本连接层以其抬高该会话
   *  过滤基线（种子替换投影后的迟到补发帧双应用防线） */
  sessionSnapshot(id: string): Promise<SnapshotResponse & { lastSeq: number }>;
  /** POST /approval/:pid {decision}（G4）：decision ∈ 'allow'|'always'|'deny'——回执寻址用帧
   *  顶层 pid（非 req.id）；未知/已决/kind 不符 pid 404（GUI 侧失败也移卡） */
  replyApproval(pid: string, decision: string): Promise<void>;
  /** POST /ask/:pid/reply {answer}（G4）：answer 三态（GuiAskAnswer）；404 面同上 */
  replyAsk(pid: string, answer: GuiAskAnswer): Promise<void>;
  /** POST /session/:id/board/review {taskId, approved}（G5 看板服务面）:gate 双语义(gated 审批
   *  解锁 / in-review 关单)——Board 页 onReview 装配点;400 面=未知任务/状态不符 */
  boardReview(sessionId: string, taskId: string, approved: boolean): Promise<void>;
  /** GET /session/:id/file?path=（G6 预览面）：path 相对会话 root 或绝对均可；403(越界)/404(不
   *  存在/目录)/415(二进制)以 HTTP 失败抛错（消息含 status）——Files 页错误态消费 */
  readFile(sessionId: string, path: string): Promise<FileResp>;
  /** GET /session/:id/diff?callId=（G7 diff 面）：write 调用双内容（见 DiffResp）；404（无快照/
   *  callId 无帧/会话）以 HTTP 失败抛错——Chat write 展开退单列现内容的判据 */
  fetchDiff(sessionId: string, callId: string): Promise<DiffResp>;
  /** POST /session/:id/delete（T2 会话回收，Home 消费）：running 409；journal 文件保留 */
  deleteSession(id: string): Promise<void>;
  /** POST /session/:id/pty {cols?,rows?}（G8b T3）：按需开 pty → {ptyId}；cols/rows 缺省省字段
   *  （daemon 缺省 80×24）；Terminal 页（T6）持 ptyId 开专用 WS /session/:id/pty/:ptyId */
  openPty(sessionId: string, cols?: number, rows?: number): Promise<{ ptyId: string }>;
  /** DELETE /session/:id/pty/:ptyId（G8b T3）：同步注销——kill 后新 WS 连入收 error
   *  'pty not found'（注销即失效，无宽限窗） */
  killPty(sessionId: string, ptyId: string): Promise<void>;
  /** GET /session/:id/tree?path=（G8b T4 目录面，path 缺省 = root 单层直读）：DirectoryTab 逐层
   *  惰拉的取数面；403 越界/404 不存在/400 非目录以 HTTP 失败抛错（消息含 status） */
  tree(sessionId: string, path?: string): Promise<TreeResp>;
  /** G8c T7 设置面方法族（T8/T9 Settings 面全数据面；签名与 task-7 brief 逐字对齐）。root 缺省
   *  = 无项目上下文的仅全局面（服务端同裁定：query 参整体省略，空串 root 不可靠）；写面恒项目级
   *  （400 缺 root），全局编辑走 raw */
  /** GET /settings?root=（T2）：effective 视图（keys 来源分层/permissions 三面/providers 打码） */
  settings(root?: string): Promise<SettingsView>;
  /** PUT /settings {root, updates}（T2）：语义键结构化改写（null=delete）；400 未知键/类型坏、
   *  409 文件含注释/畸形（引流 raw 编辑面）以 HTTP 失败抛错 */
  putSettings(root: string, updates: Record<string, string | number | null>): Promise<void>;
  /** GET /settings/raw?scope=&root=&file=（T3）：原文逐字复读（JSONC 保真）；缺文件 {content:null}
   *  是编辑器空态判据；scope=project 必带 root（缺 400） */
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
  /** PUT /settings/raw {scope, root?, file, content}（T3）：服务端验证拒存+原子写；root 缺省省
   *  字段（scope=global 无锚只写盘不 reload，scope=project 缺 root 400） */
  putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
  /** GET /settings/mcp?root=（T4）：两级遮蔽清单（项目全量 source='project' + 全局逐名 shadowed 标记） */
  mcpServers(root?: string): Promise<{ servers: McpRow[] }>;
  /** POST /settings/mcp/probe {root?, name}（T4）：单台真探测联合应答（失败即结果非错误码，见
   *  McpProbeResult）；root 缺省 = 仅全局清单定位 */
  mcpProbe(root: string | undefined, name: string): Promise<McpProbeResult>;
  /** PUT /settings/mcp {root, servers}（T4）：项目级 mcp.json 整块结构化写（旧清单整块替换） */
  putMcpServers(root: string, servers: McpRowInput[]): Promise<void>;
  /** GET /settings/agents?root=（T5）：builtins 四预设 + 两级宽容清单（root 缺省 = 仅全局清单） */
  agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }>;
  /** PUT /settings/agents {root?, scope, op, id, frontmatter?, body?}（T5，AgentsPane 表单增删改）：
   *  input 原文即请求体（缺省字段不落 JSON）；scope=project 必带 root（缺 400），delete 不存在幂等 ok */
  putAgent(input: { root?: string; scope: 'project' | 'global'; op: 'upsert' | 'delete'; id: string; frontmatter?: AgentFrontmatterInput; body?: string }): Promise<void>;
  /** GET /settings/agents/body?scope=&id=&root=（G8d T3，AgentsPane 编辑全文装载）：agent.md
   *  frontmatter 后正文全文（bodyPreview 200 帽不适用）；root 缺省省查询参（scope=global 忽略
   *  root）；404（缺文件）/400（坏 id·scope=project 缺 root·畸形 frontmatter）以 HTTP 失败抛错 */
  agentBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }>;
  /** GET /settings/skills?root=（T6）：三源分组固定序 project/user/learned（root 缺省 = 仅 user 组） */
  skillsGroups(root?: string): Promise<{ groups: SkillsGroup[] }>;
  /** GET /settings/memory-stats?root=（T6）：主域记忆概览（root 缺省 = 零值非 400） */
  memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }>;
  close(): void;
  state(): ConnectionState;
  /** 测试钩子（e2e 断链注入专用）：当前底层 socket（无连接 undefined）——产品面勿消费 */
  debug: { socket(): WebSocket | undefined };
}

/** 退避帽（1×2^n 上限） */
const BACKOFF_CAP_MS = 30_000;
/** 退避基数缺省 */
const DEFAULT_BACKOFF_BASE_MS = 1_000;

/** baseUrl 的 http(s) 面 → ws(s) 面（浏览器 WebSocket 不接受 http 前缀；已 ws(s) 则原样透传） */
function wsUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '');
  if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  return `${url}/events`;
}

export function createConnection(opts: ConnectionOpts): Connection {
  const { baseUrl, token, onEvent, onReset } = opts;
  const { onApproval, onAsk, onResetSession } = opts;
  const onStateChange = opts.onStateChange;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const base = baseUrl.replace(/\/+$/, '');

  let status: ConnectionState = 'connecting';
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 连续失败计数（成功建立清零）→ 退避指数 n；首个延迟恒 = base×2^0 */
  let failures = 0;
  /** 每会话 seq 基线：连接建立清零（重连=全量重放），sessionSnapshot 应答抬高（防双应用）；
   *  过滤单点 deliver 只读此表 */
  const lastSeqBySession = new Map<string, number>();
  /** G4 挂起 pid 去重表（连接生命周期维，重连不清——重连重发幂等）：同 pid 帧只回调一次；
   *  pid 是 daemon 级铸票，跨会话全局唯一，单 Set 足矣 */
  const seenPids = new Set<string>();
  /** 连接代次：旧 socket 迟到回调（close 后回放的 onclose、慢到的 snapshot 应答）凭此失效 */
  let generation = 0;

  function setState(next: ConnectionState): void {
    status = next;
    onStateChange?.(next);
  }

  /** seq 过滤单点（每会话独立）：≤ 基线丢（补发/乱序旧帧），> 更新基线并按 sessionId 投上层 */
  function deliver(sessionId: string, seq: number, e: SessionEvent): void {
    if (seq <= (lastSeqBySession.get(sessionId) ?? 0)) return;
    lastSeqBySession.set(sessionId, seq);
    onEvent(sessionId, e, seq);
  }

  /** G4 挂起帧单点（无 seq，不入单调序列）：pid 去重后按 kind 回调——同 pid 重复帧（含重连
   *  重发）只回调一次；reset 通知不走此径（帧帧回调，见 onmessage） */
  function deliverPending(sessionId: string, pid: string, req: unknown, kind: 'approval' | 'ask'): void {
    if (typeof req !== 'object' || req === null) return; // 坏载荷忽略
    if (seenPids.has(pid)) return; // 重连重发/重复帧幂等
    seenPids.add(pid);
    if (kind === 'approval') onApproval?.(sessionId, pid, req as GuiApprovalReq);
    else onAsk?.(sessionId, pid, req as GuiAskReq);
  }

  function detach(sock: WebSocket): void {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
  }

  /** 掉线收口（onclose/onerror 同路径）：非显式 close 且本 socket 仍在代 → 退避重连 */
  function onLost(sock: WebSocket, gen: number): void {
    if (status === 'closed' || gen !== generation) return;
    generation += 1; // 本连接逻辑退场（迟到回调全部失效）
    detach(sock);
    if (ws === sock) ws = null;
    scheduleRetry();
  }

  function scheduleRetry(): void {
    if (status === 'closed' || retryTimer !== undefined) return;
    const delay = Math.min(backoffBaseMs * 2 ** failures, BACKOFF_CAP_MS);
    failures += 1;
    setState('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (status !== 'closed') connect();
    }, delay);
  }

  function connect(): void {
    if (status === 'closed') return;
    const gen = ++generation;
    // subprotocol `bearer.<token>` 鉴权（浏览器 WebSocket 不能自定义请求头，T1 裁定的浏览器路径）
    const sock = new WebSocket(wsUrl(base), [`bearer.${token}`]);
    ws = sock;

    sock.onopen = () => {
      if (status === 'closed' || gen !== generation) return;
      // 建立=基线清零+投影重置+全量重放：上层先清各会话投影（onReset），随后到达的补发帧
      // （daemon 连接即发全部会话缓冲）各会话依序全过，上层重拉 snapshot 重建权威态
      lastSeqBySession.clear();
      failures = 0; // 完全建立才清退避计数
      onReset();
      setState('open');
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (status === 'closed' || gen !== generation) return;
      let frame: WsFrame | undefined;
      try {
        frame = JSON.parse(String(ev.data)) as WsFrame;
      } catch {
        return; // 非 JSON 帧忽略
      }
      if (frame === null || typeof frame !== 'object') return;
      // G4 会话 reset 通知帧：无 seq/pid——不入单调序列也不去重，帧帧回调
      if (frame.kind === 'reset') {
        if (typeof frame.sessionId === 'string' && frame.sessionId.length > 0) onResetSession?.(frame.sessionId);
        return;
      }
      // G4 审批/问询挂起帧：无 seq——pid 去重后回调（寻址键=帧顶层 pid）
      if (frame.kind === 'approval' || frame.kind === 'ask') {
        if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return;
        if (typeof frame.pid !== 'string' || frame.pid.length === 0) return;
        deliverPending(frame.sessionId, frame.pid, frame.req, frame.kind);
        return;
      }
      if (frame.kind !== 'event' || typeof frame.seq !== 'number' || !frame.e) return;
      if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) return;
      deliver(frame.sessionId, frame.seq, frame.e);
    };
    sock.onclose = () => onLost(sock, gen);
    sock.onerror = () => onLost(sock, gen);
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  async function post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }

  /** PUT 恒带 JSON body（G8c 设置写面）；void 面不读应答体——服务端 200 {ok:true} 只作成功信号，
   *  不解析（空体 200 同过，也为服务端留改 204 的余地） */
  async function put(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }

  /** POST 带 JSON 应答（G8c mcpProbe——联合应答 200 两态均正常落定，非 2xx 才是错误） */
  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** sessionSnapshot 单点：GET + 代次守卫下的基线抬高（慢到应答不污新连接的全量重放窗） */
  async function fetchSessionSnapshot(id: string): Promise<SnapshotResponse & { lastSeq: number }> {
    const gen = generation;
    const resp = await getJson<SnapshotResponse & { lastSeq: number }>(`/session/${encodeURIComponent(id)}/snapshot`);
    if (gen === generation && resp.lastSeq > (lastSeqBySession.get(id) ?? 0)) {
      lastSeqBySession.set(id, resp.lastSeq);
    }
    return resp;
  }

  function close(): void {
    if (status === 'closed') return; // 幂等
    generation += 1; // 在册 socket 与在途 snapshot 应答全部失效
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const sock = ws;
    ws = null;
    if (sock !== null) {
      detach(sock);
      sock.close();
    }
    setState('closed');
  }

  setState('connecting'); // 初始态即报（消费者免另查 state()）
  connect();

  return {
    workspaces(): Promise<WorkspaceRow[]> {
      return getJson<WorkspaceRow[]>('/workspaces');
    },
    sessionsOf(root: string): Promise<SessionRow[]> {
      return getJson<SessionRow[]>(`/sessions?root=${encodeURIComponent(root)}`);
    },
    recentSessions(): Promise<Array<SessionRow & { root: string; slug: string }>> {
      return getJson<Array<SessionRow & { root: string; slug: string }>>('/sessions/recent');
    },
    sessionModel(id: string) {
      return getJson('/session/' + encodeURIComponent(id) + '/model');
    },
    async setSessionModel(id: string, model?: string): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/model', { model });
    },
    async setSessionTier(id: string, tier?: 'small' | 'medium' | 'large'): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/tier', { tier });
    },
    async setSessionEffort(id: string, effort?: string): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/effort', { effort });
    },
    async setSessionMode(id: string, mode: 'dontAsk' | 'manual' | 'plan'): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/mode', { mode });
    },
    async cancelSteer(id: string, seq: number): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/steer/cancel', { seq });
    },
    async rewindSession(id: string, turn: number): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/rewind', { turn });
    },
    async forkSession(id: string, turn: number): Promise<{ sessionId: string }> {
      const res = await fetch(`${base}/session/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ turn }),
      });
      if (!res.ok) throw new Error(`/session/${id}/fork -> ${res.status}`);
      return (await res.json()) as { sessionId: string };
    },
    sessionAnchors(id: string) {
      return getJson('/session/' + encodeURIComponent(id) + '/anchors');
    },
    async removeMemory(root: string, slugs: string[]) {
      const res = await fetch(`${base}/memory/rm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ root, slugs }),
      });
      if (!res.ok) throw new Error(`/memory/rm -> ${res.status}`);
      return (await res.json()) as { removed: string[]; failed: Array<{ slug: string; error: string }> };
    },
    async runCommand(id: string, line: string): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/command', { line });
    },
    commands() {
      return getJson('/commands');
    },
    sessionContext(id: string) {
      return getJson('/session/' + encodeURIComponent(id) + '/context');
    },
    sessionTasks(id: string) {
      return getJson('/session/' + encodeURIComponent(id) + '/tasks');
    },
    memoryList(root: string) {
      return getJson('/memory?root=' + encodeURIComponent(root));
    },
    dirpicker(path?: string): Promise<DirPickerResp> {
      return getJson<DirPickerResp>(path === undefined ? '/dirpicker' : `/dirpicker?path=${encodeURIComponent(path)}`);
    },
    async newSession(root: string, mode?: 'dontAsk' | 'manual'): Promise<{ sessionId: string }> {
      const res = await fetch(`${base}/session/new`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(mode === undefined ? { root } : { root, mode }),
      });
      if (!res.ok) throw new Error(`/session/new -> ${res.status}`);
      return (await res.json()) as { sessionId: string };
    },
    attach(sessionId: string, journalId: string): Promise<void> {
      return post(`/session/${encodeURIComponent(sessionId)}/attach`, { journalId });
    },
    sessionSubmit(id: string, goal: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/submit`, { goal });
    },
    sessionSteer(id: string, text: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/steer`, { text });
    },
    sessionInterrupt(id: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/interrupt`);
    },
    sessionSnapshot(id: string): Promise<SnapshotResponse & { lastSeq: number }> {
      return fetchSessionSnapshot(id);
    },
    replyApproval(pid: string, decision: string): Promise<void> {
      return post(`/approval/${encodeURIComponent(pid)}`, { decision });
    },
    replyAsk(pid: string, answer: GuiAskAnswer): Promise<void> {
      return post(`/ask/${encodeURIComponent(pid)}/reply`, { answer });
    },
    boardReview(sessionId: string, taskId: string, approved: boolean): Promise<void> {
      return post(`/session/${encodeURIComponent(sessionId)}/board/review`, { taskId, approved });
    },
    readFile(sessionId: string, filePath: string): Promise<FileResp> {
      return getJson<FileResp>(`/session/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`);
    },
    fetchDiff(sessionId: string, callId: string): Promise<DiffResp> {
      return getJson<DiffResp>(`/session/${encodeURIComponent(sessionId)}/diff?callId=${encodeURIComponent(callId)}`);
    },
    deleteSession(id: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/delete`);
    },
    async openPty(sessionId: string, cols?: number, rows?: number): Promise<{ ptyId: string }> {
      const path = `/session/${encodeURIComponent(sessionId)}/pty`;
      // 缺省尺寸省字段(newSession mode 同款——旧 daemon 兼容;daemon 缺省 80×24)
      const body: { cols?: number; rows?: number } = {};
      if (cols !== undefined) body.cols = cols;
      if (rows !== undefined) body.rows = rows;
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      return (await res.json()) as { ptyId: string };
    },
    async killPty(sessionId: string, ptyId: string): Promise<void> {
      const path = `/session/${encodeURIComponent(sessionId)}/pty/${encodeURIComponent(ptyId)}`;
      const res = await fetch(`${base}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    },
    tree(sessionId: string, path?: string): Promise<TreeResp> {
      // path 缺省/root 省查询参(对齐 T4 缺省 '' 语义;dirpicker 同款)
      const query = path === undefined || path === '' ? '' : `?path=${encodeURIComponent(path)}`;
      return getJson<TreeResp>(`/session/${encodeURIComponent(sessionId)}/tree${query}`);
    },
    // ---- G8c T7 设置面：root 缺省省查询参（tree/dirpicker 同款——空串 root 服务端不可靠）；写面
    // root 缺省省 body 字段（newSession mode 同款）----
    settings(root?: string): Promise<SettingsView> {
      return getJson<SettingsView>(root === undefined ? '/settings' : `/settings?root=${encodeURIComponent(root)}`);
    },
    putSettings(root: string, updates: Record<string, string | number | null>): Promise<void> {
      return put('/settings', { root, updates });
    },
    settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }> {
      // scope=global 时 root 定位面被服务端忽略——undefined 即省参（不留 root= 空串伪参）
      const query = `scope=${scope}${root === undefined ? '' : `&root=${encodeURIComponent(root)}`}&file=${file}`;
      return getJson<{ content: string | null }>(`/settings/raw?${query}`);
    },
    putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void> {
      return put('/settings/raw', { scope, ...(root === undefined ? {} : { root }), file, content });
    },
    mcpServers(root?: string): Promise<{ servers: McpRow[] }> {
      return getJson<{ servers: McpRow[] }>(root === undefined ? '/settings/mcp' : `/settings/mcp?root=${encodeURIComponent(root)}`);
    },
    mcpProbe(root: string | undefined, name: string): Promise<McpProbeResult> {
      return postJson<McpProbeResult>('/settings/mcp/probe', { ...(root === undefined ? {} : { root }), name });
    },
    putMcpServers(root: string, servers: McpRowInput[]): Promise<void> {
      return put('/settings/mcp', { root, servers });
    },
    agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }> {
      return getJson<{ builtins: BuiltinRole[]; view: AgentsView }>(
        root === undefined ? '/settings/agents' : `/settings/agents?root=${encodeURIComponent(root)}`,
      );
    },
    putAgent(input: { root?: string; scope: 'project' | 'global'; op: 'upsert' | 'delete'; id: string; frontmatter?: AgentFrontmatterInput; body?: string }): Promise<void> {
      return put('/settings/agents', input);
    },
    // G8d T3 全文面:root 缺省省查询参(settings 系同款);scope=global 时 root 定位面被服务端忽略
    agentBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }> {
      const query = `scope=${scope}&id=${encodeURIComponent(id)}${root === undefined ? '' : `&root=${encodeURIComponent(root)}`}`;
      return getJson<{ body: string }>(`/settings/agents/body?${query}`);
    },
    skillsGroups(root?: string): Promise<{ groups: SkillsGroup[] }> {
      return getJson<{ groups: SkillsGroup[] }>(root === undefined ? '/settings/skills' : `/settings/skills?root=${encodeURIComponent(root)}`);
    },
    memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }> {
      return getJson<{ entries: number; lastWriteAt: number | null }>(
        root === undefined ? '/settings/memory-stats' : `/settings/memory-stats?root=${encodeURIComponent(root)}`,
      );
    },
    close,
    state(): ConnectionState {
      return status;
    },
    debug: { socket: (): WebSocket | undefined => ws ?? undefined },
  };
}
