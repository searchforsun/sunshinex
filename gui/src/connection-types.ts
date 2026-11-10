import type { SessionEvent } from '../../src/types';
import type { TaskBoardState } from '../../src/taskboard/model';
import type { Delegation } from '../../src/delegation/projection';

/** GUI ↔ daemon wire 类型（D32 批A′ 拆分自 connection.ts）：快照/挂起/清单/设置/agents/skills
 *  各 HTTP 面应答形态与连接选项——纯类型叶子，connection.ts 原路径再导出（消费方 import 路径零变化）。
 */


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
 * （onResetSession）；deleteSession（2026-10-21 受控删除端点——归档门禁后真清,daemon 会话 id /
 * journalId 双寻址）供归档页删除与 /delete 命令消费。
 */

/** 粗粒度转录条目(对齐主仓 src/serve/transcript.ts TranscriptEntry;G4 对齐五 kind——
 *  notice/error 归档面在档,三 kind 子集声明会静默窄化种子数据)。images=user 条随行图片附件
 *  (dataURL 形态,daemon KernelEntry 直映——气泡缩略图数据源) */
export interface SnapshotMessage {
  seq: number;
  ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error';
  md: string;
  images?: string[];
  /** tool 消息面（session/entry 模型同形）：配对条名/入参/结果/三态与 callId（折叠行渲染与 e2e 断言消费） */
  callId?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** tool 条配对结果(wire 真值=对象形,src/serve/session.ts 快照序列化只剥 full——8c7be9e 曾误补 string 形) */
  result?: { text: string; ok: boolean; full?: string };
  status?: 'pending' | 'running' | 'done'; // 对齐 session/entry 内核三态（无 failed：失败语义在 result 内容面）
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

/** 阶段三 plan-arm 计划审批挂起请求(对齐 serve PlanApprovalFrame.req 字面,spec §5.1;
 *  2026-11-03 交稿协议 +name/path):doc=计划书 markdown 全文,items=步骤清单——PlanCard 渲染载荷,
 *  回执寻址仍统一帧顶层 pid;name=计划名(exit_plan 出牌/兜底派生),path=计划文件绝对路径
 *  (落盘成功才有——卡头链接经 /session/:id/file 打开侧栏原文) */
export interface GuiPlanApprovalReq {
  name?: string;
  path?: string;
  doc: string;
  items: string[];
}

/** 阶段三 plan-arm 决策体(与 serve harness PlanDecision 同构):mode=批准落档档位(2026-11-03 修订
 *  批准卡三选,缺省 acceptEdits);approved=false 携 feedback 进修订轮,feedback 空=纯拒绝(2026-11-03
 *  修订=放弃本轮流程,armed 保持)。POST /plan-approval/:pid 请求体字面 */
export interface GuiPlanDecision {
  approved: boolean;
  mode?: 'acceptEdits' | 'full-access';
  feedback?: string;
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
  /** 内核流式游标(P4 归位):快照时刻 openRun/openSeg(-1 无)——seed 直用,客户端不再从条目反推 */
  openRun?: number;
  openSeg?: number;
  /** 2026-10-26 三期分页(恒在):total=daemon 内核条目全量数;oldestSeq=本页最旧 seq(向前翻页
   *  游标);hasMore=本页之前仍有更早条目。分页响应剥 result.full(按需走 observation 端点) */
  total?: number;
  oldestSeq?: number;
  hasMore?: boolean;
  board: TaskBoardState;
  delegations: Delegation[];
  status: 'idle' | 'running';
  /** G10 切换/队列回显段 */
  model?: string;
  mode?: 'read-only' | 'acceptEdits' | 'full-access' | 'plan';
  tier?: 'small' | 'medium' | 'large';
  effort?: string;
  queued?: Array<{ seq: number; text: string; images?: string[] }>;
  team?: Array<{ name: string; busy: boolean; teamId?: string; createdAt?: number }>;
  /** 工作区团队注册表（daemon 快照必发） */
  teams?: Array<{ teamId: string; name: string; createdAt: number }>;
  /** 挂起段 kind 三值(阶段三 plan-arm 增 plan-approval):reseed 据此重建挂起卡(卡内容唯一来源) */
  pending?: Array<{ pid: string; kind: 'approval' | 'ask' | 'plan-approval'; req?: unknown }>;
  /** 2026-10-21 归档态:旁车 meta archived 回读(顶栏归档钮/徽标三态播种);可选防旧 daemon(无此字段=未归档面) */
  archived?: boolean;
  /** todo 批次权威投影(2026-10-31 用户裁定「任务历史持久化可见」):daemon journal 全量派生+live 增量,
   *  GUI「待办」页签直显——不再仅靠转录派生(内核环窗/尾窗之外的老批次派生面看不到) */
  todoBatches?: Array<{ key: string; ts: number; goal: string; userKey?: string; items: Array<{ text: string; status: 'completed' | 'in_progress' | 'pending' }> }>;
  /** fork 血缘(2026-11-04 用户裁定「分叉于会话」横幅面):daemon 快照 header 读数——kind='fork'
   *  主链分档才有;可选防旧 daemon。title=父档显示题,sessionId=点击横幅回父会话的寻址键 */
  forkedFrom?: { sessionId: string; title: string };
}

/** GET /workspaces 行（T2 工作区注册表，对齐主仓 daemon.ts WorkspaceRow）：root 经 workspace.json
 *  反解——历史工作区（TUI 时代档）无此档 → root undefined（不可 attach，仅统计展示） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
  /** 注册目录创建时刻(birthtimeMs;旧 daemon 不带=可缺省,排序「创建时间」维度回退 mtime) */
  createdAt?: number;
}

/** GET /sessions?root= 行（T2，对齐主仓 session-journal.ts SessionMeta 实际返回）：id=journal id；
 *  title=自定义会话名 + 会话级统计（G14.17 旁车 meta：runs/steps/tokens/缓存/上文/模型档位，回溯面） */
export interface SessionRow {
  id: string;
  file: string;
  updatedAt: number;
  firstUser?: string;
  /** 会话工作区根(2026-11-10 worktree 会话=树真实路径;悬浮卡路径/复制钮消费) */
  root?: string;
  title?: string;
  createdAt?: string;
  runs?: number;
  steps?: number;
  tokens?: number;
  seconds?: number;
  cacheTokens?: number;
  promptTokens?: number;
  childTokens?: number;
  ctxUsed?: number;
  ctxWindow?: number;
  model?: string;
  effort?: string;
  forkedFrom?: { sourceSessionId: string; upToLine: number; kind: 'rewind' | 'fork' };
  /** G14.52:该 journal 当前挂载的活跃会话 id(daemon 反查标注)——侧栏行运行圆点直比,不依赖 attach 本地映射 */
  liveSessionId?: string;
  /** 会话待确认(2026-10-31 主菜单「?」图标):daemon 挂起表非空(approval/ask/plan-approval 任一未决) */
  awaiting?: boolean;
}

/** GET /dirpicker?path= 载荷（T2 服务端目录选择）：path=绝对路径，parent=上级（盘根=自身），dirs=子目录名 */
export interface DirPickerResp {
  path: string;
  parent: string;
  dirs: string[];
}

/** rewind 寻址：userFromEnd=用户消息倒序序号（编辑重发，0=最后一条），turn=任务轮锚点（回到此轮菜单） */
export type RewindTarget = { turn: number } | { userFromEnd: number };

/** POST /session/:id/rewind 载荷（2026-11-05）：回退落在新会话对象+新 journal 上（换座同 fork）；
 *  text=被回退的用户原文，atTs=首个被丢弃行时刻（侧栏页签回退基准），restore=文件回退实际结果 */
export interface RewindResult {
  ok: true;
  sessionId: string;
  journalId: string;
  text: string;
  atTs?: number;
  restore?: { restored: string[]; removed: string[]; skipped: string[] };
}

/** GET /session/:id/restore-plan 载荷：该回退点之后记录到的文件改动（deleted=该文件由被丢弃段新建，回退即删） */
export interface RestorePlan {
  files: Array<{ path: string; deleted: boolean }>;
}

/** GET /session/:id/file?path= 载荷（G6 预览面）：path=daemon 侧 resolve 归一后的绝对路径；
 *  truncated=true 表示原文超 512KB、content 为首 512KB 截断（预览语义非全文） */
export interface FileResp {
  path: string;
  /** G14.2xx 目录路径回执:path 为目录时 type=directory(content 缺省);图片扩展名 type=image
   *  (2026-10-26 侧栏预览:mime+base64 载荷,无 content——Files 页 dataURL 直显) */
  type?: 'file' | 'directory' | 'image';
  content: string;
  truncated?: boolean;
  /** 图片预览载荷(type='image'):MIME(如 image/png)+base64 裸串(非 dataURL 前缀) */
  mime?: string;
  data?: string;
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

/** GET /session/:id/tree?query= 命中行（全层级搜索）：path=相对基目录 / 分隔全路径（gitMap
 *  查表/文件行 openTab 直用），name=末段名（图标/展示），kind 同 TreeEntry */
export interface TreeSearchHit {
  path: string;
  name: string;
  kind: 'dir' | 'file';
  /** git 忽略项(2026-10-24 用户裁定:搜索非忽略优先,忽略组殿后)——GUI 暗淡渲染判据 */
  ignored?: boolean;
}

/** GET /session/:id/tree?query= 载荷（全层级搜索）：服务端递归有界应答（100 命中/4000 目录
 *  截断）；truncated=true = 上限触顶——结果面「…已截断」标记的判据 */
export interface TreeSearchResp {
  results: TreeSearchHit[];
  truncated?: boolean;
}

/** GET /session/:id/tasks 行形（exec + 后台 spawn/subagent；conn.sessionTasks 滤掉 teammate）：
 *  endedAt=终态时刻（时长计算）；outputTail=输出末 4KB 尾读（结果区直示），outputTruncated=头截断 */
export interface SessionTaskRow {
  id: string;
  kind: string;
  label: string;
  /** 任务名(exec 的 purpose,2026-11-07);缺省=无名任务,显示回落 label(命令原文) */
  title?: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  outputTail?: string;
  outputTruncated?: boolean;
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

/** GET /settings providers.entries 的 models 条目（Task 16 源级分组投影，对齐主仓
 *  ParsedProviderEntry.models——文件显式值；tier/reasoningEffort 宽化为 string 同 choices 口径） */
export interface ProviderEntryModel {
  model: string;
  contextWindow?: number;
  reasoningEffort?: string;
  supportsImages?: boolean;
  tier?: string;
}

/** GET /settings providers.entries 行（Task 16 增量消费 listProviders 源级分组——文件结构镜像，
 *  对齐主仓 ParsedProviderEntry + catalog listProviders 密钥面富化（每行 apiKeyEnv/apiKeyPresent
 *  恒在场）。T9 拆分语义（daemon handler 注释）：entries=文件显式值（GUI 编辑回显走此面——
 *  非继承源级缺省）、生效值看 choices（条目级 > 源级缺省）。
 *  可选防旧 daemon（无该字段时 ProvidersPane 按空清单处理） */
export interface ProviderEntry {
  name: string;
  baseUrl: string;
  contextWindow?: number;
  reasoningEffort?: string;
  supportsImages?: boolean;
  models: ProviderEntryModel[];
  /** 专用密钥槽名（catalog providerApiKeyEnv 单点——GUI 零本地镜像/零 choices 派生） */
  apiKeyEnv: string;
  /** 密钥槽在场布尔（resolveProviderApiKey 判存——含 choices 无行的畸形源，密钥状态点单点数据源） */
  apiKeyPresent: boolean;
  /** 来源级归因（Task 27.5 富化）：项目 providers 键在场整键遮蔽 → 该面全部条目 'project'
   *  （全局源不可能混列），否则 'global'。可选防旧 daemon（未富化 daemon 无该键） */
  origin?: 'project' | 'global';
}

/** GET /settings 载荷（T2 Settings 页数据源）：keys 按 SEMANTIC_KEYS 键序全量；permissions 三面
 *  {merged=两级拼接去重视图态, project, global}；providers 密钥只报在场布尔不显值。
 *  G8d T5 增 warnings：两级 settings.json 的 flatten 告警（未知/退役键，项目先行拼全局）——
 *  RawPane 顶部告警列表数据源；可选防旧 daemon（无该字段）。
 *  Task 16/26 增 providers.entries（源级分组，可选防旧 daemon） */
export interface SettingsView {
  keys: SettingsKeyRow[];
  permissions: { merged: PermissionsBlocks; project: PermissionsBlocks; global: PermissionsBlocks };
  providers: { choices: ProviderChoice[]; apiKeyPresent: Record<string, boolean>; warnings: string[]; entries?: ProviderEntry[] };
  warnings?: string[];
}

/** GET /settings/mcp 行（T4 两级遮蔽视图）：env/headers 打码折叠为键名列表（值不回传——PUT 结构化写
 *  全值回写、raw 面另有无打码原文）；transport 缺省归一显形 'stdio'；shadowed=被项目同名遮蔽 */
export interface McpRow {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  /** http/sse 请求头键名列表（值打码） */
  headerKeys: string[];
  enabled?: boolean;
  /** 停用工具短名清单（装配期过滤不注册） */
  disabledTools?: string[];
  source: 'project' | 'global';
  shadowed: boolean;
  /** 项目条目批准阀态（Task 15 GET /settings/mcp 增列）：approved/pending/denied——global 恒 'none'
   *  （用户手配不过阀）。可选防旧 daemon（无该字段时 GUI 按 'none' 显） */
  approval?: 'none' | 'approved' | 'pending' | 'denied';
}

/** PUT /settings/mcp servers 行（T4 结构化写输入）：与 McpRow 的差面=写面收 env/headers 全值（文件本就
 *  承载）、无 source/shadowed（写恒项目级、遮蔽是装载态）；transport 可缺省（daemon 归一 stdio） */
export interface McpRowInput {
  name: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  disabledTools?: string[];
}

/** PUT /settings/mcp/op 请求体（Task 15 单条目操作端点）：op 六值枚举；scope 必带（'project' 必带
 *  root，'global' 省参——服务端恒忽略）；name=目标服务器名；server=op:'add' 的条目对象（原样透传
 *  catalog upsertMcpServer，形状门 command/url 至少其一在 catalog）。错误语义（T15 裁定；hint
 *  按 code 分流见终审修复波 2026-10-28）：400=纯请求形状错误、409=内容/写面错误（COMMENTS →
 *  {error, hint:'use raw editor'} 引流 raw 编辑面；INVALID → {error} 无 hint）——均以 HTTP
 *  失败抛错；成功 200 {ok:true} */
export interface McpOpInput {
  op: 'add' | 'remove' | 'enable' | 'disable' | 'approve' | 'deny';
  scope: 'project' | 'global';
  /** scope='project' 必带（服务端 400 守卫）；'global' 缺省省参 */
  root?: string;
  name: string;
  /** op:'add' 必带（其余 op 不带） */
  server?: Record<string, unknown>;
}

/** POST /settings/mcp/probe 联合应答：ok:true 携 tools 清单（note=身份软提示——serverInfo.name 与
 *  配置键不同不再算失败）；ok:false 携 error（连接失败/超时截断文）——探测是诊断面，失败即结果，
 *  同为 200 非 HTTP 错误码 */
export type McpProbeResult =
  | { ok: true; tools: Array<{ name: string; description?: string }>; note?: string }
  | { ok: false; error: string };

/** GET /settings/agents builtins 行（T5 四预设角色平铺）：role=AgentRole 字面量（gui 侧宽化为
 *  string——呈现面不消费枚举闭包），name/framing 取 ROLE_PRESETS */
export interface BuiltinRole {
  role: string;
  name: string;
  framing: string;
}

/** GET /settings/agents view.entries 行（T5，对齐主仓 AgentEntryView 只读投影）：source 两级
 *  归因 + shadowed 被遮蔽标记 + bodyPreview 正文前 200 字符（防长正文击穿设置面板）。
 *  Task 23 富化面（可选键）：enabled：启停声明（frontmatter enabled 行）。契约=恒布尔（缺省 true
 *  由 daemon 显式化——富化 daemon 每行都带）；缺键=daemon 未富化，AgentsPane 开关不渲染（gating：
 *  字段在场才出开关，富化落地即自动点亮，GUI 侧零改动）。 */
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
  enabled?: boolean;
}

/** 两级扫描宽容清单（T5）：生效+被遮蔽全量 + 逐文件告警（畸形文件不抛死，路径入 warnings） */
export interface AgentsView {
  entries: AgentEntryView[];
  warnings: string[];
}

/** GET /settings/sunshine 响应（2026-11-05 设置页「全局规范」面板）：全局 SUNSHINE.md 原文 +
 *  绝对路径（env SUNSHINEX_GLOBAL_SUNSHINE 解析口径）+ 存在性（缺失不 404，content 为空串） */
export interface GlobalRulesView {
  content: string;
  path: string;
  exists: boolean;
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

/** PUT /settings/agents 请求体（T5 表单端点、Task 15 扩 op 四值 enable|disable——agents
 *  面无 mcp 式独立 /op 端点，daemon 路由表仅 PUT /settings/agents → handleAgentsPut 单点；
 *  op 四值判别联合——形状门逐 op 钉死）：
 *  - upsert/delete：scope 必带（'project' 必带 root——服务端 400 守卫，'global' 恒忽略省参）；
 *    upsert 携 frontmatter（name 必填）+ body（缺省空串）。
 *  - enable/disable：scope 必带 + id 定位；enabled 可选回显面（服务端校验须与 op 同义，op 是
 *    权威——矛盾体 400）。条目缺失 → 409 无 hint（写面只认标准两级——历史旧位置条目由清单/
 *    装载入口一次性迁移收口；INVALID 分流无 hint，终审修复波 2026-10-28）。
 *  错误语义（T15 裁定；hint 按 code 分流见终审修复波 2026-10-28）：400=纯请求形状、409=写面
 *  错误（INVALID → {error} 无 hint）——均以 HTTP 失败抛错；成功 200 {ok:true} */
export type AgentsOpInput =
  | { op: 'upsert'; scope: 'project' | 'global'; root?: string; id: string; frontmatter?: AgentFrontmatterInput; body?: string }
  | { op: 'delete'; scope: 'project' | 'global'; root?: string; id: string }
  | { op: 'enable' | 'disable'; scope: 'project' | 'global'; root?: string; id: string; enabled?: boolean };

/** GET /settings/teams view.entries 行（agents-teams P1 Task 3，对齐 serve handleTeamsGet 只读投影——
 *  镜像 AgentEntryView 排版）：source 两级归因 + shadowed 被遮蔽标记 + bodyPreview 章程前 200 字符
 *  （防长章程击穿设置面板，全文走 /settings/teams/body）。teams 特有面：members 成员 agent id 数组
 *  （接线裁定：wire 序 global→project——pane 侧排显示副本 project 先，仅显示序）；missing=members 中
 *  不在 agents 生效集∪内建四角色的 id 现算（GUI 以警示 chip 呈现）；lead 可选领队（∈ members）；version
 *  可选版本单行；enabled 启停声明（frontmatter enabled 行）——契约=恒布尔（缺省 true 由 daemon 显式化），
 *  enabled 恒由 serve 面携带（handleTeamsGet 恒发 `enabled: e.enabled`，catalog TeamEntry.enabled 非可选
 *  布尔）；TeamsPane 的 typeof 守卫仅为前向兼容防御（缺键面不会出现，守卫不裁行为）。 */
export interface TeamEntryView {
  id: string;
  name: string;
  description?: string;
  version?: string;
  members: string[];
  lead?: string;
  missing: string[];
  source: 'project' | 'global';
  shadowed: boolean;
  bodyPreview: string;
  enabled?: boolean;
}

/** 两级宽容清单（agents-teams P1 Task 2，对齐 serve handleTeamsGet 应答）：生效+被遮蔽全量 +
 *  逐文件告警（畸形文件不抛死，路径入 warnings）。teams 无 builtins（响应只设 view 键）。 */
export interface TeamsView {
  entries: TeamEntryView[];
  warnings: string[];
}

/** PUT /settings/teams upsert 的 frontmatter 面（agents-teams P1，对齐 serve parseTeamFrontmatterInput）：
 *  name/members 必填（members 非空 agent id 数组），可选键按需——字符串值须单行（frontmatter 是单行
 *  KV 词法，多行内容属 body 面；单行约束由 daemon 400 面守卫）；lead 须 ∈ members、去重由 catalog
 *  upsertTeam 层裁决（GUI 提交面预守卫：失效 lead 不落键）。 */
export interface TeamFrontmatterInput {
  name: string;
  description?: string;
  version?: string;
  members: string[];
  lead?: string;
  enabled?: boolean;
}

/** PUT /settings/teams 请求体（agents-teams P1 Task 2/3，TeamsPane 卡片化写面——镜像 AgentsOpInput
 *  排版）：op 四值判别联合——形状门逐 op 钉死：
 *  - upsert/delete：scope 必带（'project' 必带 root——服务端 400 守卫，'global' 恒忽略省参）；
 *    upsert 携 frontmatter（name+members 必填）+ body（缺省空串）。
 *  - enable/disable：scope 必带 + id 定位；enabled 可选回显面（服务端校验须与 op 同义，op 是
 *    权威——矛盾体 400）。条目缺失 → 409 无 hint；delete 缺失幂等 ok。
 *  id 词法=isValidTeamId 严格 kebab（AMENDMENT 2026-11-04：daemon 入口 400 同口径）。错误语义沿
 *  op 族裁定：400=纯请求形状、409=写面——以 HTTP 失败抛错；成功 200 {ok:true} */
export type TeamsOpInput =
  | { op: 'upsert'; scope: 'project' | 'global'; root?: string; id: string; frontmatter?: TeamFrontmatterInput; body?: string }
  | { op: 'delete'; scope: 'project' | 'global'; root?: string; id: string }
  | { op: 'enable' | 'disable'; scope: 'project' | 'global'; root?: string; id: string; enabled?: boolean };

/** 技能三源分组行（T6，对齐主仓 SkillsGroup）：source 三段 project/user/learned；组内去重沿装载
 *  序、跨组不去重（多源同名两组各在，遮蔽裁决属装配面）；无 frontmatter 的技能行只含 id。
 *  project=项目归属显示名（scope=all 跨项目视图携带——项目筛选数据面；常规视图不载）。
 *  Task 25 富化（可选键，daemon 响应侧附加——catalog listSkills 链上裁决，缺键=行未富化/无遮蔽）：
 *  - shadowedBy：同 id 被更高优先来源遮蔽时的胜者来源名（SkillsPane 据此灰显+角标；字段在场才
 *    渲染——gating 契约沿 T23）。
 *  - sourceDir：条目落盘目录（<链根>/<id>；id 悬停 tip）。 */
export interface SkillsGroup {
  source: 'project' | 'user' | 'learned';
  project?: string;
  skills: Array<{ id: string; name?: string; description?: string; shadowedBy?: string; sourceDir?: string; /** 停用标注(2026-11-07 加载开关;disabledSkills 绝对路径命中) */ disabled?: boolean; createdMs?: number; /** 原样正文(2026-11-01 learned 组专附:技能原文件全文,展开行直读) */ body?: string }>;
}

/** PUT /settings/permissions/op 请求体（Task 16 单条目操作端点，Task 25 PermissionsPane 消费）：
 *  op add|remove 两值；scope 两级（'project' 必带 root——服务端 400 守卫，'global' 省参——服务端
 *  恒忽略）；list=目标数组键（settings permissions 三数组）；value=权限规则串。错误语义（T15
 *  裁定；hint 按 code 分流见终审修复波 2026-10-28）：400=纯请求形状错误、409=内容/写面错误
 *  （注释 → COMMENTS {error, hint:'use raw editor'} 引流 raw 编辑面；value 空白/缺失条目 →
 *  INVALID {error} 无 hint）——均以 HTTP 失败抛错；成功 200 {ok:true}，add 幂等去重（已存在
 *  照常 ok），remove 缺失 409 */
export interface PermissionOpInput {
  op: 'add' | 'remove';
  scope: 'project' | 'global';
  /** scope='project' 必带（服务端 400 守卫）；'global' 缺省省参 */
  root?: string;
  list: 'deny' | 'allow' | 'additionalDirs';
  value: string;
}

/** PUT /settings/providers/op 请求体（Task 16 单条目操作端点，Task 26 ProvidersPane 消费）：
 *  op 七值 add|update|remove|modelAdd|modelRemove|modelMove|setKey；scope 两级（'project' 必带
 *  root——服务端 400 守卫，'global' 省参——服务端恒忽略）；name=目标提供方名。载荷按 op 分形
 *  （对齐 handleProvidersOp 形状门）：add|update 携 provider（upsert patch——add 必备 baseUrl+
 *  非空 models，update 增量未提字段不动、patch.name 改名）；modelAdd 携 entry（{model,...} 对象）；
 *  modelRemove|modelMove 携 model（modelMove 另携 direction:'up'|'down'）；setKey 携 apiKey
 *  （空串清槽；密钥零回显——响应恒 {ok:true}）。错误语义（T15 裁定；hint 按 code 分流见终审
 *  修复波 2026-10-28）：400=纯请求形状、409=内容/写面错误（COMMENTS → {error,
 *  hint:'use raw editor'}；INVALID → {error} 无 hint）——均以 HTTP 失败抛错 */
export interface ProviderOpInput {
  op: 'add' | 'update' | 'remove' | 'modelAdd' | 'modelRemove' | 'modelMove' | 'setKey';
  scope: 'project' | 'global';
  /** scope='project' 必带（服务端 400 守卫）；'global' 缺省省参 */
  root?: string;
  name: string;
  /** op:'add'|'update' 的 provider patch（原样透传 catalog upsertProvider） */
  provider?: Record<string, unknown>;
  /** op:'modelRemove'|'modelMove' 的目标模型名 */
  model?: string;
  /** op:'modelAdd' 的模型条目（{ model, tier?, contextWindow?, reasoningEffort?, supportsImages? }） */
  entry?: Record<string, unknown>;
  /** op:'modelMove' 方向 */
  direction?: 'up' | 'down';
  /** op:'setKey' 键值（空串清槽；GUI 侧仅用户当次键入值——零回显零播种） */
  apiKey?: string;
}

/** GET /settings/plugins 行（2026-10-26 插件面，对齐 daemon handlePluginsGet 载荷 = EffectivePlugin
 *  可视化拆解）：manifest 必填五元（id/name/version/description）+ 落位与启用态裁决（source 两级/
 *  enabled/platformSupported——装载层只标记不丢弃，platformSupported=false 照常列示供设置页置灰）
 *  + 装配面摘要（servers=mcpServers 名数组、skillsCount=skills 目录数）+ 设置语义键面（configSchema
 *  展示说明、config=settings plugins[id].config 原值）与逐插件 warnings（manifest 解析告警原值） */
export interface PluginRow {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'builtin' | 'user';
  enabled: boolean;
  platformSupported: boolean;
  servers: string[];
  skillsCount?: number;
  /** 设置页展示用 config 键说明（v1 仅展示不强校验；daemon 侧仅 manifest 在场时携带；
   *  options=枚举下拉面,multi=逗号多选勾选组） */
  configSchema?: Record<string, { type: string; description?: string; options?: string[]; multi?: boolean }>;
  /** 缺省暴露工具短名清单(2026-10-31 工具开关面:卡片计数+配置弹窗开关渲染源;旧 daemon 不带) */
  exposedTools?: string[];
  /** server 缺省配置(2026-10-31:表单显示「生效默认」的种子面;旧 daemon 不带) */
  configDefaults?: Record<string, unknown>;
  /** settings 语义键 plugins[id].config 原值（浅对象） */
  config?: Record<string, unknown>;
  warnings: string[];
}

/** 连接状态机：启动 connecting；建立 open；掉线 reconnecting；显式 close 恒 closed */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** WS 下行帧：`{kind:'event', sessionId, seq, e}`（T1 会话维）；G4 挂起/reset 帧无 seq 不入单调
 *  序列（approval/ask 带 pid+req，reset 只挂 sessionId）；P1 Task 7 batch 合帧（`?batch=1` 声明面，
 *  对齐 serve WsBatchFrame 线格式）内嵌事件帧数组序保持；其余 kind（hello 等）/无 seq/
 *  无 sessionId 帧不入单调序列，忽略 */
export interface WsFrame {
  kind: string;
  sessionId?: string;
  seq?: number;
  e?: SessionEvent;
  pid?: string;
  req?: unknown;
  frames?: Array<{ kind: string; sessionId?: string; seq?: number; e?: SessionEvent }>;
  /** Task 21 config-changed 下行帧（daemon 级无 sessionId——不 seq/不去重）：与 src/serve/
   *  daemon-wire.ts ConfigChangedFrame 同形；resource/scope 宽收 string（transport 轻归一后
   *  转 ConfigChangedInfo，未知资源由订阅侧过滤） */
  resource?: string;
  scope?: string;
  root?: string | null;
}

/** config-changed 通知帧载荷（Task 21 双向实时同步面，useConfigChanged 消费）：resource=资源
 *  种类（ResourceKind 字符串，未知值订阅侧忽略）、scope=作用域、root=项目根（null=全局） */
export interface ConfigChangedInfo {
  resource: string;
  scope: 'global' | 'project';
  root: string | null;
}

export interface ConnectionOpts {
  baseUrl: string;
  /** token(G10 起可选):在场=Bearer/bearer.<t> 鉴权;空=免鉴权(本地 serve 免鉴权档) */
  token?: string;
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
  /** 阶段三 plan-arm 计划审批挂起帧回调（同 approval/ask 通道加 kind 分支——pid 去重/重连重发
   *  幂等同口径；req={doc,items} 计划书+步骤，PlanCard 渲染载荷） */
  onPlanApproval?: (sessionId: string, pid: string, req: GuiPlanApprovalReq) => void;
  /** G4 会话 reset 通知帧回调（不去重——每帧都回调：一次 HTTP reset = 一次通知；上层清该
   *  会话投影重播种） */
  onResetSession?: (sessionId: string) => void;
  /** 状态机迁移回调（含初始 connecting） */
  onStateChange?: (s: ConnectionState) => void;
  /** 退避基数 ms（缺省 1000；delay = base×2^连续失败数，帽 30s）——测试注入 1 */
  backoffBaseMs?: number;
}
