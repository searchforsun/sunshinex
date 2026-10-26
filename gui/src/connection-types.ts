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
 * journalId 双寻址）供归档页删除与 /delete 命令消费；boardReview
 * （G5 看板服务面）供 Board 页 gate 行内审批。
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

/** 阶段三 plan-arm 计划审批挂起请求(对齐 serve PlanApprovalFrame.req 字面,spec §5.1):
 *  doc=计划书 markdown 全文,items=步骤清单——PlanCard 渲染载荷,回执寻址仍统一帧顶层 pid */
export interface GuiPlanApprovalReq {
  doc: string;
  items: string[];
}

/** 阶段三 plan-arm 决策体(与 serve harness PlanDecision 同构):approved=false 可携 feedback
 *  进修订轮;feedback 空=纯拒绝。POST /plan-approval/:pid 请求体字面 */
export interface GuiPlanDecision {
  approved: boolean;
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
  team?: Array<{ name: string; busy: boolean }>;
  /** 挂起段 kind 三值(阶段三 plan-arm 增 plan-approval):reseed 据此重建挂起卡(卡内容唯一来源) */
  pending?: Array<{ pid: string; kind: 'approval' | 'ask' | 'plan-approval'; req?: unknown }>;
  /** 2026-10-21 归档态:旁车 meta archived 回读(顶栏归档钮/徽标三态播种);可选防旧 daemon(无此字段=未归档面) */
  archived?: boolean;
}

/** GET /workspaces 行（T2 工作区注册表，对齐主仓 daemon.ts WorkspaceRow）：root 经 workspace.json
 *  反解——历史工作区（TUI 时代档）无此档 → root undefined（不可 attach，仅统计展示） */
export interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
}

/** GET /sessions?root= 行（T2，对齐主仓 session-journal.ts SessionMeta 实际返回）：id=journal id；
 *  title=自定义会话名 + 会话级统计（G14.17 旁车 meta：runs/steps/tokens/缓存/上文/模型档位，回溯面） */
export interface SessionRow {
  id: string;
  file: string;
  updatedAt: number;
  firstUser?: string;
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
  /** G14.2xx 目录路径回执:path 为目录时 type=directory(content 缺省)——Files 页移交目录页签定位 */
  type?: 'file' | 'directory';
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

/** GET /session/:id/tasks 行形（exec 类真后台执行账本，服务端已过滤 subagent/teammate 专面）：
 *  endedAt=终态时刻（时长计算）；outputTail=输出末 4KB 尾读（结果区直示），outputTruncated=头截断 */
export interface SessionTaskRow {
  id: string;
  kind: string;
  label: string;
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
 *  序、跨组不去重（多源同名两组各在，遮蔽裁决属装配面）；无 frontmatter 的技能行只含 id。
 *  project=项目归属显示名（scope=all 跨项目视图携带——项目筛选数据面；常规视图不载） */
export interface SkillsGroup {
  source: 'project' | 'user' | 'learned';
  project?: string;
  skills: Array<{ id: string; name?: string; description?: string }>;
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
  /** 设置页展示用 config 键说明（v1 仅展示不强校验；daemon 侧仅 manifest 在场时携带） */
  configSchema?: Record<string, { type: string; description?: string }>;
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
