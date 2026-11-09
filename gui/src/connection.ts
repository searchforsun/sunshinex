import { SESSION_DELETED_EVENT, SESSION_ARCHIVED_EVENT, SESSION_ARCHIVE_CHANGED_EVENT } from './session-events';
import { createConnectionTransport, DEFAULT_BACKOFF_BASE_MS } from './connection-transport';

export { toWsUrl } from './connection-transport';
export * from './connection-types';
import type {
  AgentFrontmatterInput,
  AgentsOpInput,
  AgentsView,
  BuiltinRole,
  ConfigChangedInfo,
  ConnectionOpts,
  ConnectionState,
  DirPickerResp,
  DiffResp,
  FileResp,
  GuiAskAnswer,
  GuiPlanDecision,
  McpProbeResult,
  McpRow,
  McpRowInput,
  McpOpInput,
  PermissionOpInput,
  PluginRow,
  ProviderOpInput,
  SessionRow,
  SessionTaskRow,
  SettingsView,
  GlobalRulesView,
  SkillsGroup,
  SnapshotResponse,
  TeamsOpInput,
  TeamsView,
  TreeResp,
  TreeSearchResp,
  WorkspaceRow,
} from './connection-types';
import type { RestorePlan, RewindResult, RewindTarget } from './connection-types';
import type { SessionEvent } from '../../src/types';


export interface Connection {
  /** GET /workspaces：工作区注册表扫描（T2） */
  workspaces(): Promise<WorkspaceRow[]>;
  /** GET /sessions?root=：工作区会话（journal）列表（T2） */
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** GET /sessions/recent：跨工作区扁平最近会话（G10-C2 侧栏 Recents 区） */
  recentSessions(): Promise<Array<SessionRow & { root: string; slug: string }>>;
  /** GET /session/:id/model：模型 pill 数据源(G10-C4;choices 空=不可切)。
   *  explicitDefault 位已退役（2026-10-28 spec §15 T11：providers 列表唯一事实源，服务端恒切
   *  choices[0]，响应不再携带该位）——契约面随服务端同步收窄 */
  sessionModel(id: string): Promise<{ current?: string; choices: Array<{ id: string; model: string; baseUrl: string; effort?: string; contextWindow?: number; supportsImages?: boolean }> }>;
  /** 模型总结会话标题(G10-C7):text=首条用户消息;daemon 一次 chat 调用回 ≤20 字标题(503=模型未接线) */
  sessionTitle(id: string, text: string): Promise<{ title: string }>;
  /** 会话名持久化(G14.16 标题统一流):POST /session/:id/rename 落旁车 meta——顶栏/侧栏同源 */
  /** G14.29 辅助问答(/btw /side):fork 旁路档上隔离跑一轮,主会话零污染 */
  btw(id: string, question: string): Promise<{ reply: string; sessionId: string }>;
  renameSession(id: string, title: string): Promise<{ ok: true; title: string }>;
  /** 自定义会话名回读(G14.16):GET /session/:id/title/get;title=undefined 即无自定义名 */
  getSessionTitle(id: string): Promise<{ title?: string }>;
  /** 建项目(G10-C11):原生文件选择器确认后注册/创建工作区。name=浏览器态(projectsRoot 下建)
   *  / path=桌面壳态(注册既有目录);同名幂等返回既有行 */
  createWorkspace(body: { name?: string; path?: string }): Promise<{ ok: true; root: string; slug: string }>;
  /** 移除工作区(2026-10-23):slug 入隐藏档——仅摘出侧栏,数据保留;重新 create 即原地加回 */
  hideWorkspace(slug: string): Promise<void>;
  /** G14.69 原生选择定位:按标记文件全盘找所选目录绝对路径(超时/未找到 path:null) */
  locateWorkspace(body: { token: string; roots?: string[] }): Promise<{ path: string | null }>;
  /** POST /session/:id/model|tier|effort|mode:运行中切换(下一轮生效;G10-C1b/C2b) */
  setSessionModel(id: string, model?: string): Promise<void>;
  setSessionTier(id: string, tier?: 'small' | 'medium' | 'large'): Promise<void>;
  setSessionEffort(id: string, effort?: string): Promise<void>;
  setSessionMode(id: string, mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'): Promise<void>;
  /** POST /session/:id/steer/cancel:撤回排队插话(G10-C1d) */
  cancelSteer(id: string, seq: number): Promise<void>;
  /** G14.83 排队条目重排(拖拽排序)/置首(插入发送=下一轮立即注入) */
  moveSteer(id: string, from: number, to: number): Promise<void>;
  frontSteer(id: string, seq: number): Promise<void>;
  /** POST /session/:id/steer/edit:队列条目内联改写(P5 spec §12.2) */
  editSteer(id: string, seq: number, text: string): Promise<void>;
  /** POST /session/:id/rewind(2026-11-05 编辑重发/回到此轮):restoreFiles=同时回退文件;
   *  成功后会话换到返回的 sessionId/journalId(换座同 fork) */
  rewindSession(id: string, target: RewindTarget, restoreFiles?: boolean): Promise<RewindResult>;
  forkSession(id: string, turn: number, side?: boolean): Promise<{ sessionId: string }>;
  /** GET /session/:id/anchors:任务轮锚点(rewind/fork 寻址) */
  sessionAnchors(id: string): Promise<Array<{ turn: number; text: string }>>;
  /** GET /session/:id/restore-plan(2026-11-05 二次确认弹窗):回退点之后的文件改动清单(只读) */
  restorePlan(id: string, target: RewindTarget): Promise<RestorePlan>;
  /** POST /memory/rm:记忆删除(G10-C1d) */
  removeMemory(root: string, slugs: string[]): Promise<{ removed: string[]; failed: Array<{ slug: string; error: string }> }>;
  /** POST /session/:id/command:斜杠命令直跑(G10-C1c) */
  runCommand(id: string, line: string): Promise<void>;
  /** GET /commands:清单+双语描述+supported(G10-C4 命令面板数据源) */
  commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }>;
  /** 辅助对话清单(2026-10-31 用户裁定「辅助对话持久化+编号页签」):主会话的 side 档;
   *  sessionId=在座会话 id(daemon 重启后缺席,页签恢复仅限同 daemon 生命周期) */
  sessionSides(id: string): Promise<Array<{ journalId: string; sessionId?: string; title: string; updatedAt: number }>>;
  /** G14.99 工作区未提交变动面（Diff 标签数据源） */
  sessionChanges(id: string): Promise<{ branch: string; files: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }> }>;
  /** G14.112 目录树 git 状态映射(含 ignored 目录折叠):path → modified/untracked/deleted/renamed/ignored */
  gitStatus(id: string): Promise<{ branch: string; map: Record<string, string> }>;
  /** G14.113 分支清单+切换(欢迎页分支选择弹窗;非 git 目录 branches 空) */
  gitBranches(root: string): Promise<{ current: string; branches: string[] }>;
  gitCheckout(root: string, branch: string, create?: boolean): Promise<void>;
  /** G14.121 工作区文件索引(@ 面板数据源):posix 相对路径+mtime,倒序=最近改动优先;
   *  dirs=尾斜杠目录清单(@面板滤出文件夹/目录引用面;旧 daemon 无此字段 → undefined) */
  workspaceFiles(root: string): Promise<{ files: Array<{ path: string; mtime: number }>; dirs?: string[] }>;
  /** 2026-10-25 Web 标签页名/站标(daemon 服务端代取——iframe 跨域拒访):title 空串=解析不出
   *  (GUI 退 host);icon 空串=无站标声明(退地球图标)。尽力而为展示面,失败不报错 */
  fetchWebMeta(url: string): Promise<{ title: string; icon: string }>;
  /** G14.2xx GUI 面私有态存取(标签页等,按会话键;daemon 落 <slug>/gui/sessions/<id>.json) */
  guiState(id: string): Promise<{ state: unknown }>;
  saveGuiState(id: string, state: object): Promise<void>;
  /** G14.2xx 应用级指针档(恢复现场入口;<projectsRoot>/gui/ui-state.json:lastRoot/lastJournalId) */
  appGuiState(): Promise<{ state: unknown }>;
  saveAppGuiState(state: object): Promise<void>;
  /** 置顶档(GET/PUT /app/pins;2026-10-21 GUI 专属会话置顶,机器级跨工作区) */
  appPins(): Promise<{ pins: Array<{ id: string; root: string; title?: string; updatedAt?: number }> }>;
  saveAppPins(pins: Array<{ id: string; root: string; title?: string; updatedAt?: number }>): Promise<void>;
  /** 已读档(GET/PUT /app/seen;2026-10-23 已读/未读态落底层,机器级 id→最近已读 updatedAt) */
  appSeen(): Promise<{ seen: Record<string, number> }>;
  saveAppSeen(seen: Record<string, number>): Promise<void>;
  /** 预设外部打开应用安装态(GET /app/editors;只列实际存在的,explorer 恒在) */
  editorsList(): Promise<{ editors: Array<{ id: string; name: string; exe: string }> }>;
  /** 应用原生图标(exe 资源段抽取,机器级缓存):{mime,data(base64)}——打开菜单品牌图标用 */
  editorIcon(id: string): Promise<{ mime: string; data: string }>;
  /** 以指定应用打开路径(POST /app/open;spawn detached,id 须在已装名单内) */
  openInEditor(path: string, id: string): Promise<void>;
  sessionChangeContent(id: string, path: string): Promise<{ path: string; oldContent?: string; newContent: string; truncated: boolean; deleted: boolean }>;
  commitChanges(id: string, message: string): Promise<void>;
  pushChanges(id: string): Promise<void>;
  /** G14.100 撤销单个变动文件(restore 回 HEAD/删除本轮新建) */
  restoreChange(id: string, path: string): Promise<void>;
  /** GET /session/:id/context:上下文分段构成(G10-C6 面板) */
  sessionContext(id: string): Promise<{ parts: Array<{ id: string; tokens: number; count: number }>; chainByAction: Array<{ action: string; tokens: number }>; total: number; window: number; free: number }>;
  /** GET /session/:id/shadow-events:journal 影子事件全量(board/delegation/subagent)+ cut 水位
   *  (G14.2xx b 影子投影水合——刷新/重连后会话打开时拉取清零重放;WS 环窗 512 对长会话子智能体流
   *  必溢出,恢复唯一可靠入口)。cut=服务端读档时刻泵水位:在途缓冲帧按 seq>cut 重放,零丢帧零重复 */
  shadowEvents(id: string): Promise<{ events: SessionEvent[]; cut: number }>;
  /** GET /session/:id/tasks:后台任务账本行(G10-C6 面板)。本面保留 exec + 后台 spawn(subagent)
   *  ——2026-11-02 用户裁定 spawn 行回归(停止=task_stop 打断线;行点击跳转录页);teammate 行仍滤
   *  (队卡/成员面专属)。本方法单点过滤(顶栏计数与后台任务页签共用)。行形 SessionTaskRow 单点 */
  sessionTasks(id: string): Promise<SessionTaskRow[]>;
  /** POST /session/:id/tasks/stop {id: taskId}：后台任务停止（2026-11-02 用户裁定「暂停=复用
   *  task_stop,撤恢复」）。task_stop 同语义（exec 杀进程树/subagent 打断线），终态 stopped 即
   *  task_wait 可见；404=会话/任务未知；幂等=已终态 200 */
  taskStop(id: string, taskId: string): Promise<void>;
  /** GET /session/:id/browser-key:内置浏览器会话键(=journalId,未建档即建档)——侧栏 webview
   *  持久分区 persist:sx-<key>,与浏览器插件 MCP 连接同键(浏览器状态按会话隔离) */
  browserKey?(id: string): Promise<string>;
  /** GET /memory?root=:记忆清单(G10-C6 面板) */
  memoryList(root: string): Promise<Array<{ slug: string; type: string; created: string; modified: string; description: string; body: string }>>;
  /** GET /dirpicker?path=（缺省 home）：服务端目录浏览（T2） */
  dirpicker(path?: string): Promise<DirPickerResp>;
  /** POST /session/new {root, mode?}:按 root 装配新会话（并置激活）→ {sessionId};mode 可选
   *  ('acceptEdits' 工作区编辑 / 缺省 'full-access')——缺省不发 body 字段(旧 daemon 兼容) */
  newSession(root: string, mode?: 'acceptEdits' | 'full-access'): Promise<{ sessionId: string }>;
  /** POST /session/:id/attach {journalId}：恢复既有 journal 到该会话（并置激活） */
  /** attach:daemon 可能收编同 journal 在座会话(运行中刷新恢复)——返回**实际** sessionId(可能异于入参) */
  attach(sessionId: string, journalId: string): Promise<{ sessionId: string }>;
  /** POST /session/:id/submit {goal}：会话提交（202 受理；409 拒二次提交）。
   *  images=随行图片附件(dataURL,≤8 张);空列不落字段——旧 daemon 按纯文本受理(兼容) */
  sessionSubmit(id: string, goal: string, images?: string[]): Promise<void>;
  /** POST /session/:id/steer {text}：运行中插话（排队语义）；HTTP 失败抛错（消息含 status）；images 同 submit */
  sessionSteer(id: string, text: string, images?: string[]): Promise<void>;
  /** POST /session/:id/interrupt：中止在跑 run（无在跑 409） */
  sessionInterrupt(id: string): Promise<void>;
  /** GET /session/:id/snapshot：会话全量快照；lastSeq 同源 seq 泵——本连接层以其抬高该会话
   *  过滤基线（种子替换投影后的迟到补发帧双应用防线） */
  sessionSnapshot(id: string, page?: { before?: number; limit?: number }, opts?: { bumpSeq?: boolean }): Promise<SnapshotResponse & { lastSeq: number }>;
  /** 2026-10-26 三期 §4.5:按需全量观测(快照分页剥 full 后,工具行展开按 seq 单条拉) */
  fetchObservation(id: string, seq: number): Promise<{ seq: number; text?: string; full?: string }>;
  /** POST /approval/:pid {decision}（G4）：decision ∈ 'allow'|'always'|'deny'——回执寻址用帧
   *  顶层 pid（非 req.id）；未知/已决/kind 不符 pid 404（GUI 侧失败也移卡） */
  replyApproval(pid: string, decision: string): Promise<void>;
  /** POST /ask/:pid/reply {answer}（G4）：answer 三态（GuiAskAnswer）；404 面同上 */
  replyAsk(pid: string, answer: GuiAskAnswer): Promise<void>;
  /** POST /plan-approval/:pid {approved,feedback?}（阶段三 plan-arm,spec §5.1）：planFlow 裁决
   *  回执——approved=true 批准(批准落工作区编辑自动解除),false(+feedback)拒绝保持 armed 进修订
   *  轮;未知/已决/kind 不符 pid 404（GUI 侧失败也移卡,approval 同口径） */
  replyPlanApproval(pid: string, decision: GuiPlanDecision): Promise<void>;
  /** POST /session/:id/board/stop {taskId}：pending|running → cancelled */
  boardStop(sessionId: string, taskId: string): Promise<void>;
  /** GET /session/:id/file?path=（G6 预览面）：path 相对会话 root 或绝对均可；403(越界)/404(不
   *  存在/目录)/415(二进制)以 HTTP 失败抛错（消息含 status）——Files 页错误态消费 */
  readFile(sessionId: string, path: string): Promise<FileResp>;
  /** GET /session/:id/plans(2026-11-04 计划页签):数据目录计划书清单——name=文件首行计划名,
   *  path=绝对路径(/session/:id/file 直开),mtime=末次生成时刻(ms,修订覆盖写即刷新);mtime 降序 */
  sessionPlans(sessionId: string): Promise<{ plans: Array<{ name: string; path: string; mtime: number }> }>;

  /** GET /app/file?root=&path=（2026-10-27 欢迎页全局草稿）:无会话文件读,信任域=注册工作区根+数据目录 */
  appFile(root: string, filePath: string, scope?: 'data'): Promise<FileResp>;
  /** GET /session/:id/diff?callId=（G7 diff 面）：write 调用双内容（见 DiffResp）；404（无快照/
   *  callId 无帧/会话）以 HTTP 失败抛错——Chat write 展开退单列现内容的判据 */
  fetchDiff(sessionId: string, callId: string, path?: string): Promise<DiffResp>;
  /** POST /session/:id/delete(2026-10-21 受控删除):须先归档(未归档 409);真清会话档全家 */
  deleteSession(id: string): Promise<void>;
  /** POST /session/:id/archive {archived}:归档/撤销(运行中照常受理,不停运行) */
  archiveSession(id: string, archived: boolean): Promise<void>;
  /** GET /sessions/archived:跨工作区归档列表(归档页数据源) */
  archivedSessions(): Promise<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number; liveSessionId?: string; awaiting?: boolean }>>;
  /** POST /session/:id/pty {cols?,rows?,prevPtyId?}（G8b T3）：按需开 pty → {ptyId}；cols/rows 缺省省字段
   *  （daemon 缺省 80×24）；Terminal 页（T6）持 ptyId 开专用 WS /session/:id/pty/:ptyId。
   *  prevPtyId=页签盘档里已死的旧 pty(daemon 重启):daemon 以其落盘回放回种新壳滚动区 */
  openPty(sessionId: string, cols?: number, rows?: number, prevPtyId?: string): Promise<{ ptyId: string }>;
  /** DELETE /session/:id/pty/:ptyId（G8b T3）：同步注销——kill 后新 WS 连入收 error
   *  'pty not found'（注销即失效，无宽限窗） */
  killPty(sessionId: string, ptyId: string): Promise<void>;
  /** POST /app/pty（2026-10-27 欢迎页全局草稿）:无会话 pty 分配（root 直供 cwd,owner '@app'） */
  openPtyAt(root: string, cols?: number, rows?: number, prevPtyId?: string): Promise<{ ptyId: string }>;
  /** DELETE /app/pty/:ptyId:App 级 pty 回收 */
  killPtyAt(ptyId: string): Promise<void>;
  /** Task 21 config-changed 帧订阅注册点（设置面双向实时同步——useConfigChanged 消费）：
   *  daemon 级下行帧（无 sessionId，不 seq/不去重）帧帧转发在册回调；返回退订函数。
   *  注册面单点——帧主流程（transport 分发）零扰动，未注册即静默 */
  onConfigChanged(cb: (f: ConfigChangedInfo) => void): () => void;
  /** GET /session/:id/tree?path=（G8b T4 目录面，path 缺省 = root 单层直读）：DirectoryTab 逐层
   *  惰拉的取数面；403 越界/404 不存在/400 非目录以 HTTP 失败抛错（消息含 status） */
  tree(sessionId: string, path?: string): Promise<TreeResp>;
  /** GET /session/:id/tree?query=（全层级搜索）：服务端项目路径索引（TTL 缓存，refresh=true 强制
   *  重建）内存过滤名包含（忽略集外全层级，100 命中有界，truncated 标截断）；403/404/400 同 tree */
  searchTree(sessionId: string, query: string, refresh?: boolean): Promise<TreeSearchResp>;
  /** G8c T7 设置面方法族（T8/T9 Settings 面全数据面；签名与 task-7 brief 逐字对齐）。root 缺省
   *  = 无项目上下文的仅全局面（服务端同裁定：query 参整体省略，空串 root 不可靠）；写面恒项目级
   *  （400 缺 root），全局编辑走 raw */
  /** GET /settings?root=（T2）：effective 视图（keys 来源分层/permissions 三面/providers 打码） */
  settings(root?: string): Promise<SettingsView>;
  /** PUT /settings {scope, root?, updates}（T2）：语义键结构化改写（null=delete）；scope 缺省
   *  'project'（必带 root），'global' 写用户级文件（root 省略）——GUI 逐项写回来源文件两面；
   *  400 未知键/类型坏、409 文件含注释/畸形（引流 raw 编辑面）以 HTTP 失败抛错 */
  putSettings(scope: 'project' | 'global', root: string | undefined, updates: Record<string, string | number | null>): Promise<void>;
  /** GET /settings/raw?scope=&root=&file=（T3）：原文逐字复读（JSONC 保真）；缺文件 {content:null}
   *  是编辑器空态判据；scope=project 必带 root（缺 400） */
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
  /** PUT /settings/raw {scope, root?, file, content}（T3）：服务端验证拒存+原子写；root 缺省省
   *  字段（scope=global 无锚只写盘不 reload，scope=project 缺 root 400） */
  putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
  /** PUT /settings/permissions/op（Task 16 单条目操作端点，Task 25 PermissionsPane 消费）：op
   *  add|remove；scope='project' 必带 root（缺 400）、'global' 省参；400=纯请求形状错误、409=
   *  内容/写面错误（COMMENTS 带 hint:'use raw editor' 引流 raw 编辑面，INVALID 无 hint——
   *  2026-10-28 终审修复波按 code 分流）以 HTTP 失败抛错；成功 200 {ok:true}
   *  （add 幂等去重，remove 缺失 409） */
  putPermissionOp(input: PermissionOpInput): Promise<void>;
  /** PUT /settings/providers/op（Task 16 单条目操作端点，Task 26 ProvidersPane 消费）：op 七值
   *  add|update|remove|modelAdd|modelRemove|modelMove|setKey；scope='project' 必带 root（缺 400）、
   *  'global' 省参；400=纯请求形状错误、409=内容/写面错误（COMMENTS 带 hint:'use raw editor'，
   *  INVALID 无 hint——2026-10-28 终审修复波按 code 分流）以 HTTP 失败抛错；成功 200 {ok:true}
   *  （setKey 密钥零回显——响应恒 {ok:true} 不携键值） */
  putProviderOp(input: ProviderOpInput): Promise<void>;
  /** GET /settings/mcp?root=（T4）：两级遮蔽清单（项目全量 source='project' + 全局逐名 shadowed 标记） */
  mcpServers(root?: string): Promise<{ servers: McpRow[] }>;
  /** POST /settings/mcp/probe {root?, name}（T4）：单台真探测联合应答（失败即结果非错误码，见
   *  McpProbeResult）；root 缺省 = 仅全局清单定位 */
  mcpProbe(root: string | undefined, name: string): Promise<McpProbeResult>;
  /** PUT /settings/mcp {root, servers}（T4）：项目级 mcp.json 整块结构化写（旧清单整块替换） */
  putMcpServers(root: string, servers: McpRowInput[]): Promise<void>;
  /** PUT /settings/mcp/op（Task 15 单条目操作端点）：add/remove/enable/disable/approve/deny 六值；
   *  scope='project' 必带 root（缺 400）、'global' 省参；400=纯请求形状错误、409=内容/写面错误
   *  （COMMENTS 带 hint:'use raw editor' 引流 raw 编辑面，INVALID 无 hint——2026-10-28 终审
   *  修复波按 code 分流）以 HTTP 失败抛错；成功 200 {ok:true} */
  putMcpOp(input: McpOpInput): Promise<void>;
  /** GET /settings/agents?root=（T5）：builtins 四预设 + 两级宽容清单（root 缺省 = 仅全局清单） */
  agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }>;
  /** PUT /settings/agents {root?, scope, op, id, frontmatter?, body?}（T5，AgentsPane 表单增删改）：
   *  input 原文即请求体（缺省字段不落 JSON）；scope=project 必带 root（缺 400），delete 不存在幂等 ok */
  putAgent(input: { root?: string; scope: 'project' | 'global'; op: 'upsert' | 'delete'; id: string; frontmatter?: AgentFrontmatterInput; body?: string }): Promise<void>;
  /** PUT /settings/agents（T5 表单端点、T15 扩 op 四值，Task 23 AgentsPane 卡片化写面）：op 四值
   *  判别联合（upsert/delete/enable/disable——agents 面无 mcp 式独立 /op 端点）；
   *  input 原文即请求体（global 省 root 不留空串伪参）；400=纯请求形状、
   *  409=写面（hint 引流 raw 编辑面），以 HTTP 失败抛错；成功 200 {ok:true} */
  putAgentOp(input: AgentsOpInput): Promise<void>;
  /** GET /settings/agents/body?scope=&id=&root=（G8d T3，AgentsPane 编辑全文装载）：agent.md
   *  frontmatter 后正文全文（bodyPreview 200 帽不适用）；root 缺省省查询参（scope=global 忽略
   *  root）；404（缺文件）/400（坏 id·scope=project 缺 root·畸形 frontmatter）以 HTTP 失败抛错 */
  agentBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }>;
  /** GET /settings/sunshine（2026-11-05 设置页「全局规范」面板）：全局 SUNSHINE.md 原文+绝对路径+存在性（缺失不 404——编辑器首开即可用） */
  sunshineGet(): Promise<GlobalRulesView>;
  /** PUT /settings/sunshine body {content}：全局规范原子写回（校验 400/网络失败抛错由面板呈现） */
  sunshinePut(content: string): Promise<void>;
  /** GET /settings/teams?root=（agents-teams P1 Task 2，TeamsPane 清单数据源）：两级宽容清单
   *  （root 缺省 = 仅全局清单；teams 无 builtins——响应只设 view 键；wire 序 global→project） */
  teamsView(root?: string): Promise<{ view: TeamsView }>;
  /** PUT /settings/teams {root?, scope, op, id, frontmatter?, body?}（agents-teams P1 Task 2/3，
   *  TeamsPane 卡片化写面）：op 四值判别联合（upsert/delete/enable/disable——agents putAgentOp 同款
   *  单端点形态，无独立 /op 路由）；input 原文即请求体（global 省 root 不留空串伪参）；id 词法=
   *  严格 kebab（daemon 入口 400 同口径）；400=纯请求形状、409=写面（hint 引流 raw 编辑面），
   *  以 HTTP 失败抛错；成功 200 {ok:true} */
  putTeamOp(input: TeamsOpInput): Promise<void>;
  /** GET /settings/teams/body?scope=&id=&root=（agents-teams P1 Task 2，TeamsPane 编辑章程全文
   *  装载——agentBody 同款）：team.md frontmatter 后章程原文全文（bodyPreview 200 帽不适用）；
   *  root 缺省省查询参（scope=global 忽略 root）；404（缺文件）/400（坏 id·scope=project 缺 root·
   *  畸形 frontmatter）以 HTTP 失败抛错 */
  teamBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }>;
  /** GET /settings/skills?root=（T6）：三源分组固定序 project/user/learned（root 缺省 = 仅 user 组） */
  /** all=true：跨项目视图（scope=all——user 全局 + 当前项目 project 组 + 全项目学习沉淀逐项目
   *  分组，组带 project 归属名）；缺省 = 当前 root 视图（T6 原语义，composer 技能清单消费） */
  skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }>;
  /** POST /settings/skills/rm {root, id}（2026-10-31 学习技能删除面）：只作用于学习根
   *  （learnedSkillsDir(root)——学习沉淀=机器产物可删）；404=学习根无此 id */
  skillsRemove(root: string, id: string): Promise<void>;
  /** GET /settings/skills/body:SKILL.md 原文(dir=清单行 sourceDir,服务端只放行已枚举技能目录) */
  skillBody(dir: string, root?: string): Promise<{ body: string }>;
  /** GET /settings/memory-stats?root=（T6）：主域记忆概览（root 缺省 = 零值非 400） */
  memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }>;
  /** GET /settings/plugins?root=（2026-10-26 插件面）：loadEffectivePlugins 两级清单 + 装载聚合警告
   *  （root 缺省 = 仅全局装载——与 /settings·/settings/mcp「无 root 仅全局面」同裁定） */
  plugins(root?: string): Promise<{ plugins: PluginRow[]; warnings: string[] }>;
  /** PUT /settings/plugins {root?, id, enabled?, config?}（插件面开关/配置写）：settings 语义键
   *  plugins.<id> 的结构化原子写——root 在场 = 项目级 <root>/.sunshinex/settings.json，缺省 = 全局
   *  settings；400（缺 id/坏形）/404（未知 id）/409（文件含注释·畸形·version 不符——引流 raw）以
   *  HTTP 失败抛错；生效语义 = 下次会话装配生效（GUI 开关成功后重拉清单） */
  putPlugin(root: string | undefined, id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<void>;
  close(): void;
  state(): ConnectionState;
  /** 测试钩子（e2e 断链注入专用）：当前底层 socket（无连接 undefined）——产品面勿消费 */
  debug: { socket(): WebSocket | undefined };
}

export function createConnection(opts: ConnectionOpts): Connection {
  const { baseUrl, token, onEvent, onReset } = opts;
  /** 鉴权头(G10:token 空=免鉴权档,不发 authorization) */
  const authHeaders: Record<string, string> = token === '' || token === undefined ? {} : { authorization: `Bearer ${token}` };
  const { onApproval, onAsk, onPlanApproval, onResetSession } = opts;
  const onStateChange = opts.onStateChange;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const base = baseUrl.replace(/\/+$/, '');

  /** Task 21 config-changed 订阅注册表：transport 可选回调单点 → 全部在册订阅者（退订=Set 摘除）。
   *  挂钩面最小化——帧分发（connection-transport）只多一个可选回调分支，主流程不动 */
  const configChangedSubs = new Set<(f: ConfigChangedInfo) => void>();

  const transport = createConnectionTransport(base, token, backoffBaseMs, {
    onEvent,
    onApproval,
    onAsk,
    onPlanApproval,
    onReset,
    onResetSession,
    onStateChange,
    onConfigChanged: (f) => {
      for (const sub of configChangedSubs) sub(f);
    },
  });

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: authHeaders });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  async function post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...authHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }

  /** PUT 恒带 JSON body（G8c 设置写面）；void 面不读应答体——服务端 200 {ok:true} 只作成功信号，
   *  不解析（空体 200 同过，也为服务端留改 204 的余地） */
  async function put(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }

  /** 非 2xx → Error（2026-10-29 用户裁定:op 族失败透出服务端 {error,hint}——GUI 行内错误条
   *  呈服务端真因,不再裸显 `<path> -> <status>` 连接层格式;hint 在场拼随原文引流）。体缺/
   *  非 JSON/无 error 字段 → 回落 `<path> -> <status>` 旧格式（非 op 形状应答容错面） */
  async function opError(path: string, res: Response): Promise<Error> {
    let doc: unknown;
    try {
      doc = await res.json();
    } catch {
      return new Error(`${path} -> ${res.status}`); // 体不可解析(空体/HTML):回落旧格式
    }
    const err = typeof (doc as { error?: unknown })?.error === 'string' ? ((doc as { error: string }).error.trim()) : '';
    if (err === '') return new Error(`${path} -> ${res.status}`);
    const hint = typeof (doc as { hint?: unknown })?.hint === 'string' ? ((doc as { hint: string }).hint.trim()) : '';
    return new Error(hint !== '' ? `${err} — ${hint}` : err);
  }

  /** PUT op 族（设置 op 端点写面:providers/mcp/permissions/agents op;失败读应答体 error/hint
   *  组装透出,见 opError——普通 put 的裸 status 格式仅连接层兜底）。成功面与 put 同纪律:
   *  200 {ok:true} 只作成功信号不解析应答体 */
  async function putOp(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await opError(path, res);
  }

  /** POST 带 JSON 应答（G8c mcpProbe——联合应答 200 两态均正常落定，非 2xx 才是错误） */
  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** sessionSnapshot 单点：GET + 代次守卫下的基线抬高（慢到应答不污新连接的全量重放窗）。
   *  bumpSeq=false 供辅助拉取（批准后的 mode 轻同步等）——只读数据不动 seq 门（2026-11-04 实测
   *  根修:批准回执落定→executor 同拍恢复→tool-result 帧在途;此刻辅助快照应答先行处理即把
   *  lastSeq 抬过在途帧序,帧落门内被当重放丢=交稿行永卡「正在提交」） */
  async function fetchSessionSnapshot(id: string, page?: { before?: number; limit?: number }, opts?: { bumpSeq?: boolean }): Promise<SnapshotResponse & { lastSeq: number }> {
    const gen = transport.generation();
    const q = page !== undefined ? `?before=${page.before}&limit=${page.limit}` : '';
    const resp = await getJson<SnapshotResponse & { lastSeq: number }>(`/session/${encodeURIComponent(id)}/snapshot${q}`);
    if (opts?.bumpSeq === false) return resp;
    if (gen === transport.generation() && resp.lastSeq > (transport.lastSeqBySession.get(id) ?? 0)) {
      transport.lastSeqBySession.set(id, resp.lastSeq);
    }
    return resp;
  }



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
    sessionTitle(id: string, text: string) {
      return postJson<{ ok: true; title: string }>('/session/' + encodeURIComponent(id) + '/title', { text });
    },
    btw(id: string, question: string) {
      return postJson<{ reply: string; sessionId: string }>('/session/' + encodeURIComponent(id) + '/btw', { question });
    },
    renameSession(id: string, title: string) {
      return postJson<{ ok: true; title: string }>('/session/' + encodeURIComponent(id) + '/rename', { title });
    },
    getSessionTitle(id: string) {
      return getJson<{ title?: string }>('/session/' + encodeURIComponent(id) + '/title/get');
    },
    createWorkspace(body: { name?: string; path?: string }) {
      return postJson<{ ok: true; root: string; slug: string }>('/workspace/create', body);
    },
    /** 移除工作区(2026-10-23):slug 入隐藏档——仅摘出侧栏,数据保留;重新 create 即原地加回 */
    async hideWorkspace(slug: string) {
      await postJson<{ ok: true }>('/workspace/hide', { slug });
    },
    locateWorkspace(body: { token: string; roots?: string[] }) {
      return postJson<{ path: string | null }>('/workspace/locate', body);
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
    async setSessionMode(id: string, mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/mode', { mode });
    },
    async cancelSteer(id: string, seq: number): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/steer/cancel', { seq });
    },
    async moveSteer(id: string, from: number, to: number): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/steer/move', { from, to });
    },
    async frontSteer(id: string, seq: number): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/steer/front', { seq });
    },
    async editSteer(id: string, seq: number, text: string): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/steer/edit', { seq, text });
    },
    async rewindSession(id: string, target: RewindTarget, restoreFiles?: boolean): Promise<RewindResult> {
      const res = await fetch(`${base}/session/${encodeURIComponent(id)}/rewind`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ ...target, ...(restoreFiles === true ? { restoreFiles: true } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `/session/${id}/rewind -> ${res.status}`);
      }
      return (await res.json()) as RewindResult;
    },
    restorePlan(id: string, target: RewindTarget): Promise<RestorePlan> {
      const q = 'turn' in target ? `turn=${target.turn}` : `userFromEnd=${target.userFromEnd}`;
      return getJson(`/session/${encodeURIComponent(id)}/restore-plan?${q}`);
    },
    async forkSession(id: string, turn: number, side?: boolean): Promise<{ sessionId: string }> {
      const res = await fetch(`${base}/session/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ turn, ...(side === true ? { side: true } : {}) }),
      });
      if (!res.ok) throw new Error(`/session/${id}/fork -> ${res.status}`);
      return (await res.json()) as { sessionId: string };
    },
    async sessionAnchors(id: string) {
      const r = await getJson<{ anchors: Array<{ turn: number; text: string }> }>('/session/' + encodeURIComponent(id) + '/anchors');
      return r.anchors;
    },
    async removeMemory(root: string, slugs: string[]) {
      const res = await fetch(`${base}/memory/rm`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ root, slugs }),
      });
      if (!res.ok) throw new Error(`/memory/rm -> ${res.status}`);
      return (await res.json()) as { removed: string[]; failed: Array<{ slug: string; error: string }> };
    },
    async runCommand(id: string, line: string): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/command', { line });
    },
    sessionSides(id: string) {
      return getJson(`/session/${encodeURIComponent(id)}/sides`);
    },
    commands() {
      return getJson('/commands');
    },
    sessionChanges(id: string) {
      return getJson(`/session/${encodeURIComponent(id)}/changes`);
    },
    gitStatus(id: string) {
      return getJson(`/session/${encodeURIComponent(id)}/git-status`);
    },
    gitBranches(root: string) {
      return getJson(`/git/branches?root=${encodeURIComponent(root)}`);
    },
    workspaceFiles(root: string) {
      return getJson(`/workspace/files?root=${encodeURIComponent(root)}`);
    },
    fetchWebMeta(url: string) {
      return getJson<{ title: string; icon: string }>(`/web/meta?url=${encodeURIComponent(url)}`);
    },
    async gitCheckout(root: string, branch: string, create?: boolean) {
      await post('/git/checkout', { root, branch, ...(create === true ? { create: true } : {}) });
    },
    guiState(id: string) {
      return getJson<{ state: unknown }>(`/session/${encodeURIComponent(id)}/gui-state`);
    },
    async saveGuiState(id: string, state: object) {
      await put(`/session/${encodeURIComponent(id)}/gui-state`, { state });
    },
    appGuiState() {
      return getJson<{ state: unknown }>('/app/gui-state');
    },
    async saveAppGuiState(state: object) {
      await put('/app/gui-state', { state });
    },
    appPins() {
      return getJson('/app/pins');
    },
    async saveAppPins(pins) {
      await put('/app/pins', { pins });
    },
    appSeen() {
      return getJson('/app/seen');
    },
    async saveAppSeen(seen) {
      await put('/app/seen', { seen });
    },
    /** 外部打开应用族(2026-10-27 顶栏「打开」分体钮):安装态探测 + 以指定应用打开路径 */
    editorsList() {
      return getJson('/app/editors');
    },
    editorIcon(id: string) {
      return getJson(`/app/editors/icon/${encodeURIComponent(id)}`);
    },
    async openInEditor(path: string, id: string) {
      await post('/app/open', { path, id });
    },
    sessionChangeContent(id: string, path: string) {
      return getJson(`/session/${encodeURIComponent(id)}/changes/content?path=${encodeURIComponent(path)}`);
    },
    async commitChanges(id: string, message: string) {
      // 失败读应答体 error 透出(2026-10-31 用户实测 push 400 裸显——服务端 git 真因直达审查页)
      const res = await fetch(`${base}/session/${encodeURIComponent(id)}/changes/commit`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ message }),
      });
      if (!res.ok) throw await opError(`/session/${encodeURIComponent(id)}/changes/commit`, res);
    },
    async pushChanges(id: string) {
      const res = await fetch(`${base}/session/${encodeURIComponent(id)}/changes/push`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}',
      });
      if (!res.ok) throw await opError(`/session/${encodeURIComponent(id)}/changes/push`, res);
    },
    async restoreChange(id: string, path: string) {
      await post('/session/' + encodeURIComponent(id) + '/changes/restore', { path });
    },
    sessionContext(id: string) {
      return getJson('/session/' + encodeURIComponent(id) + '/context');
    },
    shadowEvents(id: string) {
      return getJson<{ events: SessionEvent[]; cut: number }>('/session/' + encodeURIComponent(id) + '/shadow-events');
    },
    browserKey(id: string) {
      return getJson<{ key: string }>('/session/' + encodeURIComponent(id) + '/browser-key').then((r) => r.key);
    },
    sessionTasks(id: string) {
      // exec + 后台 spawn(subagent);teammate 走队卡专面——见接口注
      return getJson<SessionTaskRow[]>(
        '/session/' + encodeURIComponent(id) + '/tasks',
      ).then((rows) => rows.filter((r) => r.kind === 'exec' || r.kind === 'subagent'));
    },
    async taskStop(id: string, taskId: string): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/tasks/stop', { id: taskId });
    },
    memoryList(root: string) {
      return getJson('/memory?root=' + encodeURIComponent(root));
    },
    dirpicker(path?: string): Promise<DirPickerResp> {
      return getJson<DirPickerResp>(path === undefined ? '/dirpicker' : `/dirpicker?path=${encodeURIComponent(path)}`);
    },
    async newSession(root: string, mode?: 'acceptEdits' | 'full-access'): Promise<{ sessionId: string }> {
      const res = await fetch(`${base}/session/new`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(mode === undefined ? { root } : { root, mode }),
      });
      if (!res.ok) throw new Error(`/session/new -> ${res.status}`);
      return (await res.json()) as { sessionId: string };
    },
    async attach(sessionId: string, journalId: string): Promise<{ sessionId: string }> {
      return postJson<{ sessionId: string }>(`/session/${encodeURIComponent(sessionId)}/attach`, { journalId });
    },
    sessionSubmit(id: string, goal: string, images?: string[]): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/submit`, { goal, ...(images !== undefined && images.length > 0 ? { images } : {}) });
    },
    sessionSteer(id: string, text: string, images?: string[]): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/steer`, { text, ...(images !== undefined && images.length > 0 ? { images } : {}) });
    },
    sessionInterrupt(id: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/interrupt`);
    },
    sessionSnapshot(id: string, page?: { before?: number; limit?: number }, opts?: { bumpSeq?: boolean }): Promise<SnapshotResponse & { lastSeq: number }> {
      return fetchSessionSnapshot(id, page, opts);
    },
    fetchObservation(id: string, seq: number) {
      return getJson<{ seq: number; text?: string; full?: string }>(`/session/${encodeURIComponent(id)}/entry/${seq}/observation`);
    },
    replyApproval(pid: string, decision: string): Promise<void> {
      return post(`/approval/${encodeURIComponent(pid)}`, { decision });
    },
    replyAsk(pid: string, answer: GuiAskAnswer): Promise<void> {
      return post(`/ask/${encodeURIComponent(pid)}/reply`, { answer });
    },
    replyPlanApproval(pid: string, decision: GuiPlanDecision): Promise<void> {
      return post(`/plan-approval/${encodeURIComponent(pid)}`, decision);
    },
    boardStop(sessionId: string, taskId: string): Promise<void> {
      return post(`/session/${encodeURIComponent(sessionId)}/board/stop`, { taskId });
    },
    readFile(sessionId: string, filePath: string): Promise<FileResp> {
      return getJson<FileResp>(`/session/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}`);
    },
    sessionPlans(sessionId: string): Promise<{ plans: Array<{ name: string; path: string; mtime: number }> }> {
      return getJson(`/session/${encodeURIComponent(sessionId)}/plans`);
    },
    fetchDiff(sessionId: string, callId: string, path?: string): Promise<DiffResp> {
      // path 随参(G14.4):callId 未中(重放会话)时 daemon 按 journal snapshots 行回退真 pre-image
      const p = path !== undefined && path !== '' ? `&path=${encodeURIComponent(path)}` : '';
      return getJson<DiffResp>(`/session/${encodeURIComponent(sessionId)}/diff?callId=${encodeURIComponent(callId)}${p}`);
    },
    deleteSession(id: string): Promise<void> {
      // 删除成功广播(id=运行时 id 或 journalId,daemon 双寻址):浏览器页签池据此卸载该会话的常驻 webview
      return post(`/session/${encodeURIComponent(id)}/delete`).then(() => {
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SESSION_DELETED_EVENT, { detail: id }));
      });
    },
    archiveSession(id: string, archived: boolean): Promise<void> {
      // 归档成功广播(仅真归档;撤销不发):App 据此把正开着的该会话主对话送回欢迎页
      return postJson(`/session/${encodeURIComponent(id)}/archive`, { archived }).then(() => {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent(SESSION_ARCHIVE_CHANGED_EVENT, { detail: { id, archived } }));
        if (archived) window.dispatchEvent(new CustomEvent(SESSION_ARCHIVED_EVENT, { detail: id }));
      });
    },
    archivedSessions() {
      return getJson('/sessions/archived');
    },
    async openPty(sessionId: string, cols?: number, rows?: number, prevPtyId?: string): Promise<{ ptyId: string }> {
      const path = `/session/${encodeURIComponent(sessionId)}/pty`;
      // 缺省尺寸省字段(newSession mode 同款——旧 daemon 兼容;daemon 缺省 80×24)
      const body: { cols?: number; rows?: number; prevPtyId?: string } = {};
      if (cols !== undefined) body.cols = cols;
      if (rows !== undefined) body.rows = rows;
      if (prevPtyId !== undefined) body.prevPtyId = prevPtyId;
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      return (await res.json()) as { ptyId: string };
    },
    async appFile(root: string, filePath: string, scope?: 'data'): Promise<FileResp> {
      return getJson<FileResp>(`/app/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}${scope === 'data' ? '&scope=data' : ''}`);
    },

    async openPtyAt(root: string, cols?: number, rows?: number, prevPtyId?: string): Promise<{ ptyId: string }> {
      const body: { root: string; cols?: number; rows?: number; prevPtyId?: string } = { root };
      if (cols !== undefined) body.cols = cols;
      if (rows !== undefined) body.rows = rows;
      if (prevPtyId !== undefined) body.prevPtyId = prevPtyId;
      // post 助手无应答体面(newSession 同款 fetch+json)——ptyId 在 200 应答体内
      const res = await fetch(`${base}/app/pty`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`/app/pty -> ${res.status}`);
      return (await res.json()) as { ptyId: string };
    },
    async killPtyAt(ptyId: string): Promise<void> {
      await post(`/app/pty/${encodeURIComponent(ptyId)}`, {});
    },
    onConfigChanged(cb: (f: ConfigChangedInfo) => void): () => void {
      configChangedSubs.add(cb);
      return () => {
        configChangedSubs.delete(cb);
      };
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
    searchTree(sessionId: string, query: string, refresh?: boolean): Promise<TreeSearchResp> {
      const qp = new URLSearchParams({ query });
      if (refresh === true) qp.set('refresh', '1'); // 强制索引重建(刷新钮)
      return getJson<TreeSearchResp>(`/session/${encodeURIComponent(sessionId)}/tree?${qp.toString()}`);
    },
    // ---- G8c T7 设置面：root 缺省省查询参（tree/dirpicker 同款——空串 root 服务端不可靠）；写面
    // root 缺省省 body 字段（newSession mode 同款）----
    settings(root?: string): Promise<SettingsView> {
      return getJson<SettingsView>(root === undefined ? '/settings' : `/settings?root=${encodeURIComponent(root)}`);
    },
    putSettings(scope: 'project' | 'global', root: string | undefined, updates: Record<string, string | number | null>): Promise<void> {
      // scope=global 时 root 定位面被服务端忽略——undefined 即省参（不留 root 空串伪参，raw 写同款）
      return put('/settings', { scope, ...(root === undefined ? {} : { root }), updates });
    },
    settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }> {
      // scope=global 时 root 定位面被服务端忽略——undefined 即省参（不留 root= 空串伪参）
      const query = `scope=${scope}${root === undefined ? '' : `&root=${encodeURIComponent(root)}`}&file=${file}`;
      return getJson<{ content: string | null }>(`/settings/raw?${query}`);
    },
    putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void> {
      return put('/settings/raw', { scope, ...(root === undefined ? {} : { root }), file, content });
    },
    putPermissionOp(input: PermissionOpInput): Promise<void> {
      // input 原文即请求体（putMcpOp/putAgentOp 同款——scope=global 省参不留 root 空串伪参）
      return putOp('/settings/permissions/op', input);
    },
    putProviderOp(input: ProviderOpInput): Promise<void> {
      // input 原文即请求体（putMcpOp/putPermissionOp 同款——scope=global 省参不留 root 空串伪参）
      return putOp('/settings/providers/op', input);
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
    putMcpOp(input: McpOpInput): Promise<void> {
      // input 原文即请求体（putAgent 同款——scope=global 省参不留 root 空串伪参）
      return putOp('/settings/mcp/op', input);
    },
    agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }> {
      return getJson<{ builtins: BuiltinRole[]; view: AgentsView }>(
        root === undefined ? '/settings/agents' : `/settings/agents?root=${encodeURIComponent(root)}`,
      );
    },
    putAgent(input: { root?: string; scope: 'project' | 'global'; op: 'upsert' | 'delete'; id: string; frontmatter?: AgentFrontmatterInput; body?: string }): Promise<void> {
      // op 族端点(agents 唯一写面,op 字段随身)——错误组装走 putOp(error/hint 透出,2026-10-29)
      return putOp('/settings/agents', input);
    },
    putAgentOp(input: AgentsOpInput): Promise<void> {
      // input 原文即请求体（putAgent/putMcpOp 同款——scope=global 省参不留 root 空串伪参）。
      // 端点=既有 PUT /settings/agents（T15 在 handleAgentsPut 上扩 op 四值——
      // agents 面无 mcp 式独立 /op 端点，daemon 路由表无 /settings/agents/op）
      return putOp('/settings/agents', input);
    },
    // G8d T3 全文面:root 缺省省查询参(settings 系同款);scope=global 时 root 定位面被服务端忽略
    agentBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }> {
      const query = `scope=${scope}&id=${encodeURIComponent(id)}${root === undefined ? '' : `&root=${encodeURIComponent(root)}`}`;
      return getJson<{ body: string }>(`/settings/agents/body?${query}`);
    },
    // ---- 全局规范(2026-11-05 设置页「全局规范」面板):全局 SUNSHINE.md 读写两方法 ----
    sunshineGet(): Promise<GlobalRulesView> {
      return getJson<GlobalRulesView>('/settings/sunshine');
    },
    sunshinePut(content: string): Promise<void> {
      return putOp('/settings/sunshine', { content });
    },
    // ---- agents-teams P1：teams 三端点镜像 agents 三面（Task 2 serve 落地，Task 3 GUI 接线）----
    teamsView(root?: string): Promise<{ view: TeamsView }> {
      return getJson<{ view: TeamsView }>(root === undefined ? '/settings/teams' : `/settings/teams?root=${encodeURIComponent(root)}`);
    },
    putTeamOp(input: TeamsOpInput): Promise<void> {
      // input 原文即请求体（putAgentOp/putMcpOp 同款——scope=global 省参不留 root 空串伪参）。
      // 端点=PUT /settings/teams（agents-teams P1 Task 2——teams 面无独立 /op 端点，handleTeamsPut
      // 单点收 op 四值），错误组装走 putOp（error/hint 透出）
      return putOp('/settings/teams', input);
    },
    // 章程全文面:agentBody 同款——root 缺省省查询参;scope=global 时 root 定位面被服务端忽略
    teamBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }> {
      const query = `scope=${scope}&id=${encodeURIComponent(id)}${root === undefined ? '' : `&root=${encodeURIComponent(root)}`}`;
      return getJson<{ body: string }>(`/settings/teams/body?${query}`);
    },
    skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }> {
      const parts = [root === undefined ? '' : `root=${encodeURIComponent(root)}`, ...(all === true ? ['scope=all'] : [])].filter(Boolean);
      return getJson<{ groups: SkillsGroup[] }>(parts.length === 0 ? '/settings/skills' : `/settings/skills?${parts.join('&')}`);
    },
    skillBody(dir: string, root?: string): Promise<{ body: string }> {
      return getJson<{ body: string }>(`/settings/skills/body?dir=${encodeURIComponent(dir)}${root === undefined ? '' : `&root=${encodeURIComponent(root)}`}`);
    },
    async skillsRemove(root: string, id: string): Promise<void> {
      await post('/settings/skills/rm', { root, id });
    },
    memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }> {
      return getJson<{ entries: number; lastWriteAt: number | null }>(
        root === undefined ? '/settings/memory-stats' : `/settings/memory-stats?root=${encodeURIComponent(root)}`,
      );
    },
    // ---- 2026-10-26 插件面：root 缺省省查询参/省 body 字段（settings 系同款——空串 root 不可靠）----
    plugins(root?: string): Promise<{ plugins: PluginRow[]; warnings: string[] }> {
      return getJson<{ plugins: PluginRow[]; warnings: string[] }>(root === undefined ? '/settings/plugins' : `/settings/plugins?root=${encodeURIComponent(root)}`);
    },
    putPlugin(root: string | undefined, id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<void> {
      return put('/settings/plugins', { ...(root === undefined ? {} : { root }), id, ...patch });
    },
    close: () => transport.close(),
    state(): ConnectionState {
      return transport.state();
    },
    debug: { socket: (): WebSocket | undefined => transport.currentSocket() },
  };
}
