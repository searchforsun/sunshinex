/** Connection 契约面(gui/src/connection 外提,D62 批J):daemon HTTP/WS 端点方法全声明——
 *  纯类型模块零运行时;连接装配与传输实现仍在 connection.ts(+connection-transport.ts),
 *  消费面 import 面({ Connection })原路径再导出零迁移。 */
import type {
  AgentFrontmatterInput,
  AgentsOpInput,
  AgentsView,
  BuiltinRole,
  ConfigChangedInfo,
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
  CacheClearResp,
  CacheStatusResp,
  ScheduleDraft,
  ScheduleJobView,
  ScheduleRecurrence,
  ScheduleRunView,
  SchedulesView,
  SessionRow,
  SessionTaskRow,
  SettingsView,
  GlobalRulesView,
  SkillsGroup,
  SnapshotResponse,
  SunxTemplatesView,
  TeamsOpInput,
  TeamsView,
  TreeResp,
  TreeSearchResp,
  WorkspaceRow,
} from './connection-types';
import type { RestorePlan, RewindResult, RewindTarget } from './connection-types';
import type { SessionEvent } from '../../src/types';
import type { ConnectionState } from './connection-types';

/** 通道面视图类型（2026-11-21 channels Task 11）：形状镜像 serve 侧 channels/model.ts 实裁
 *  （GUI 不 import serve 层——house 规矩，本地声明；SessionRow 复用 connection-types 既有行形）。
 *  ChannelConfigMsg=PUT /settings/channels 写面入参行（parseChannelsKey 归一形）、
 *  ChannelHealthRowMsg=GET /channels 健康快照行、ChannelBindingMsg=GET /channels/bindings 绑定行
 *  （行含 rootOverride——channels Task 9 handlers 实装，供聊天信息条回显） */
/** 通道权限自检行（与 serve adapters/types ChannelPermissionRow 同构） */
export interface ChannelPermissionRowMsg {
  scope: string;
  label: string;
  required: boolean;
  granted: boolean | null;
  fallback: string;
}

export interface ChannelConfigMsg {
  id: string;
  platform: 'feishu' | 'dingtalk' | 'wecom' | 'telegram' | 'mock';
  enabled: boolean;
  /** 应用名称（2026-11-22 spec §8 终形态）：用户自定义展示名，1..80 trim；缺席=UI 回退平台名
   *  （镜像 serve/channels/model.ts ChannelConfig.name——parseChannelsKey 宽容口径：坏值 warning 跳字段） */
  name?: string;
  /** 通道密钥（2026-11-22 内联裁定推翻 D6）：随条目存放、GET 可回显（密钥框显隐切换） */
  secret?: string;
  root: string;
  mode: 'read-only' | 'acceptEdits' | 'full-access';
  model?: string;
  ident?: Record<string, string>;
  /** 开放的聊天命令（2026-11-22 用户裁定「聊天命令配置化,下拉多选」）：子集出自
   *  CHANNEL_COMMANDS 目录；缺席=全部开放（镜像 serve/channels/model.ts ChannelConfig.commands） */
  commands?: string[];
  /** 思考强度（2026-11-23 用户裁定「可以选择默认的模型和强度」）：EFFORT_ORDER 子集；
   *  缺席=跟随全局默认（镜像 serve/channels/model.ts ChannelConfig.effort） */
  effort?: string;
  /** 会话模式（2026-11-24 用户裁定「普通会话还是 Sunx」）：'sunx'=各聊天建 Sunx 编排会话;
   *  缺席=普通会话（镜像 serve/channels/model.ts ChannelConfig.sessionKind） */
  sessionKind?: 'sunx';
  /** Sunx 品性原文（sessionKind==='sunx' 消费;/new 仅品性复用）：逐字保存（镜像 charter） */
  charter?: string;
  allow: { kind: 'first-user' | 'list' | 'all'; userIds?: string[]; chatIds?: string[] };
}
export interface ChannelHealthRowMsg { id: string; platform: string; enabled: boolean; connected: boolean; detail?: string }
export interface ChannelBindingMsg {
  key: string;
  sessionId: string;
  journalId?: string;
  lockedUserId?: string;
  /** 绑定工作区切换覆盖(spec §9.3 聊天信息条写入):下次 /new 生效,当前会话不动 */
  rootOverride?: string;
  /** 聊天形态(单聊/群聊,Task 13 信息条只读面):可选防旧 daemon——wire 暂未透出时信息条
   *  只示聊天 id 不示单聊群聊标(GUI 无平台无关推导法,如实缺省) */
  chatKind?: 'direct' | 'group';
  updatedAt: number;
}

export interface Connection {
  /** GET /workspaces：工作区注册表扫描（T2） */
  workspaces(): Promise<WorkspaceRow[]>;
  /** GET /sessions?root=：工作区会话（journal）列表（T2） */
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** GET /sunx/sessions（2026-11-15 sunx P3 Task 3 数据源改向）：sunx 域容器全域枚举——
   *  SUNX 组/总览页数据源单点（kind 恒 'sunx'，行附 liveSessionId/awaiting/status 标注） */
  sunxSessions(): Promise<SessionRow[]>;
  /** 定时任务面（2026-11-20 scheduled-tasks Task 7）：daemon /schedules* 端点全声明——
   *  GET 清单 / POST 创建 / PUT 更新 / DELETE 删除 / POST run 立即运行 / POST enabled 启停 /
   *  GET runs 运行史（limit 可选）/ POST preview 预览 next 时刻。写面 body=ScheduleDraft 直发 */
  schedules(): Promise<SchedulesView>;
  createSchedule(body: ScheduleDraft): Promise<ScheduleJobView>;
  updateSchedule(id: string, body: ScheduleDraft): Promise<ScheduleJobView>;
  deleteSchedule(id: string): Promise<{ ok: true }>;
  runScheduleNow(id: string): Promise<{ ok: true; runId: string }>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleJobView>;
  scheduleRuns(id: string, limit?: number): Promise<{ runs: ScheduleRunView[] }>;
  previewSchedule(body: { recurrence: ScheduleRecurrence; startAt: number; until?: number }): Promise<{ next: number[] }>;
  /** 通道面（2026-11-21 channels Task 11）：daemon /channels* 运维面 + /settings/channels 配置写面
   *  全封装——健康快照 / 配置整键写（daemon 写盘后 engine.applyConfigs 热生效）/ dry-run 测试 /
   *  绑定档读·解除 / 通道域会话枚举（Task 12 ChannelsPane 与 Task 13 侧栏「通道」组数据源） */
  channelsView(): Promise<{ channels: ChannelHealthRowMsg[] }>;
  /** GET /settings/channels（2026-11-21 channels Task 12 修复波补缺）：全局档 channels 配置读面
   *  （serve handleChannelsGet 实装 {channels,warnings}——Task 11 方法清单漏列,上游裁定补缺）；
   *  ChannelsPane 编辑已有通道的草稿回填数据源（无此读面时细粒度字段 root/mode/allow 读不回） */
  settingsChannels(): Promise<{ channels: ChannelConfigMsg[]; warnings: string[] }>;
  /** PUT /settings/channels body {channels}：channels 键全局豁免单档（带 root 一律 400）——成功
   *  200 {ok:true,warnings:[]}（写面校验从严：warnings 非空走 400 error 回显，成功帽恒空列——
   *  serve 实装应答含 warnings 键，契约面按实装形状声明）；409 注释档/畸形引流 raw 编辑面 */
  putChannels(channels: ChannelConfigMsg[]): Promise<{ ok: true; warnings: string[] }>;
  /** POST /channels/:id/test：dry-run 测试连接（独立起停适配器，不动在座表）——失败恒 200
   *  {ok:false,error,code}（诊断面失败即结果非错误码，mcp probe 同裁定；code=结构化失败档
   *  not-found/secret-missing/ident-invalid/connect-failed/start-failed，D111：GUI 按码映射文案
   *  免 daemon 文案子串耦合），成功 {ok:true,botId} */
  testChannel(id: string): Promise<{ ok: boolean; botId?: string; error?: string; code?: string }>;
  /** GET /channels/:id/permissions（2026-11-25 用户裁定「创建通道时主动检测缺少哪些权限,给弹窗
   *  说明,哪些必须/哪些可选,缺失时兜底显示什么」）：dry-run 独立实例探测；rows 平台无关口径
   *  （granted null=无法在空聊天态探测，需自行确认） */
  channelPermissions(id: string): Promise<{ ok: boolean; rows: ChannelPermissionRowMsg[]; error?: string }>;
  /** GET /channels/bindings：绑定档全列（行含 rootOverride 供聊天信息条回显——Task 13 消费） */
  channelBindings(): Promise<{ bindings: ChannelBindingMsg[] }>;
  /** DELETE /channels/bindings/:key：解除绑定（journal 留盘；缺失 404 非幂等，写面从严）——
   *  key=`channelId:chatId` 绑定键，恒 encodeURIComponent（chatId 可含 ':' 等保留字） */
  /** GET /models：全局模型清单（daemon ModelSwitcher choices；单模型装配=空列）——
   *  通道弹窗「默认模型」下拉数据源（2026-11-23 用户裁定） */
  models(): Promise<{ choices: Array<{ id: string; model: string }> }>;
  deleteChannelBinding(key: string): Promise<{ ok: true }>;
  /** DELETE /channels/:id（2026-11-23 用户裁定「删除弹窗确认,真正的删除各种配置和目录」）：
   *  通道真删除——settings 条目移除+绑定解绑+在座释放+聊天域目录(im-<slug>-*)真删 */
  deleteChannel(id: string): Promise<{ ok: true; removedSessionIds?: string[] }>;
  /** PUT /channels/bindings/:key body {rootOverride?: string|null}（2026-11-21 channels Task 13
   *  聊天信息条「绑定工作区切换」写面）：绑定不存在 404、空串/非串 400（写面从严）；null/缺席=
   *  清除、非空字符串=设置（trim 归一）——每次 PUT 完全决定 rootOverride 态；生效语义=下次
   *  /new（或解绑重聊），当前会话不动（spec §9.3） */
  putChannelBinding(key: string, patch: { rootOverride?: string | null }): Promise<{ ok: true }>;
  /** GET /channels/sessions：通道域会话枚举（侧栏「通道」组数据源）——应答=裸 SessionRow[]
   *  （GET /sunx/sessions 同款无信封；行 root=域目录 GUI attach 直寻址，kind 钉 'channel'） */
  channelSessions(): Promise<SessionRow[]>;
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
  getSessionTitle(id: string): Promise<{ title?: string; kind?: string }>;
  /** GET /session/:id/charter(sunx P2 Task 7 读面):当前品性全文+rev——CharterDialog 预填数据源
   *  (append-only 替代行语义=全文替换,预填必须反映编辑后文本,非出生冻结层旧文)。409=非 sunx */
  sessionCharter(id: string): Promise<{ text: string | null; charterRev: number }>;
  /** POST /session/:id/charter {text}(sunx P1 Task 4 端点;P2 Task 7 封装):品性全文替换
   *  (append-only 替代行进链+charterRev 递增)——成功回新 rev;空白 text 400、非 sunx 409 抛错 */
  editCharter(id: string, text: string): Promise<{ ok: true; charterRev: number }>;
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
  sessionChanges(id: string): Promise<{ branch: string; files: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>; staged?: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>; unstaged?: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }> }>;
  /** G14.112 目录树 git 状态映射(含 ignored 目录折叠):path → modified/untracked/deleted/renamed/ignored */
  gitStatus(id: string): Promise<{ branch: string; map: Record<string, string> }>;
  /** G14.113 分支清单+切换(欢迎页分支选择弹窗;非 git 目录 branches 空) */
  gitBranches(root: string): Promise<{ current: string; branches: string[]; occupied?: Record<string, string> }>;
  /** 新建分支不切换(2026-11-10 用户裁定「欢迎页创建分支只创建」) */
  gitBranchCreate(root: string, branch: string): Promise<void>;
  /** 拉取远程分支到本地(2026-11-13 分支弹窗 fetch 按钮):fetch --all --prune+仅远程分支建本地跟踪分支 */
  gitFetchRemote(root: string): Promise<{ fetched: string[] }>;
  /** 切换代价面(2026-11-10):numstat 汇总+未提交改动数;missing=目标分支不存在(新建面) */
  branchDiffStat(root: string, branch: string): Promise<{ files: number; added: number; deleted: number; dirty: number; dirtyAdded: number; dirtyDeleted: number; missing: boolean }>;
  /** 切换/新建分支;未提交改动阻断时抛 code='DIRTY_TREE' 的 Error(前端弹「提交并切换」确认) */
  gitCheckout(root: string, branch: string, create?: boolean): Promise<void>;
  /** 提交全部未提交改动后切换(脏树确认框「提交并切换」) */
  gitCommitCheckout(root: string, branch: string, create?: boolean, message?: string): Promise<void>;
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
  /** 置顶档(GET/PUT /app/pins;2026-10-21 GUI 专属会话置顶,机器级跨工作区)。kind=sunx 形态快照
   *  (sunx P2 Task 7 徽标透传;老钉缺省) */
  appPins(): Promise<{ pins: Array<{ id: string; root: string; title?: string; updatedAt?: number; kind?: string }> }>;
  saveAppPins(pins: Array<{ id: string; root: string; title?: string; updatedAt?: number; kind?: string }>): Promise<void>;
  /** 已读档(GET/PUT /app/seen;2026-10-23 已读/未读态落底层,机器级 id→最近已读 updatedAt) */
  appSeen(): Promise<{ seen: Record<string, number> }>;
  saveAppSeen(seen: Record<string, number>): Promise<void>;
  /** 预设外部打开应用安装态(GET /app/editors;只列实际存在的,explorer 恒在) */
  editorsList(): Promise<{ editors: Array<{ id: string; name: string; exe: string }> }>;
  /** 应用原生图标(exe 资源段抽取,机器级缓存):{mime,data(base64)}——打开菜单品牌图标用 */
  editorIcon(id: string): Promise<{ mime: string; data: string }>;
  /** 以指定应用打开路径(POST /app/open;spawn detached,id 在已装名单或 'default';root=相对路径解析根) */
  openInEditor(path: string, id: string, root?: string): Promise<void>;
  /** GET /session/:id/artifacts(产物库聚合;跨 run 按 path 去重保最新,含子 run) */
  artifacts(sessionId: string): Promise<{ items: import('./artifacts').ArtifactRow[] }>;
  sessionChangeContent(id: string, path: string, area?: 'staged' | 'unstaged'): Promise<{ path: string; oldContent?: string; newContent: string; truncated: boolean; deleted: boolean }>;
  commitChanges(id: string, message: string, stagedOnly?: boolean): Promise<void>;
  /** 审查页两区操作(paths 缺省=该区全部):暂存/取消暂存(改动退回工作区)/丢弃未暂存(不可恢复) */
  stageChanges(id: string, paths?: string[]): Promise<void>;
  unstageChanges(id: string, paths?: string[]): Promise<void>;
  discardUnstaged(id: string, paths?: string[]): Promise<void>;
  pushChanges(id: string): Promise<void>;
  /** G14.100 撤销单个变动文件(restore 回 HEAD/删除本轮新建) */
  restoreChange(id: string, path: string): Promise<void>;
  /** 轮次 checkpoint(2026-11-10):冻结前像/后像 diff 内容 + staleness 闸门撤销 */
  turnDiff(id: string, run: number, path: string): Promise<{ path: string; oldContent?: string; newContent: string; truncated?: boolean; deleted?: boolean }>;
  turnRestore(id: string, run: number, paths: string[]): Promise<{ results: Array<{ path: string; ok: boolean; stale?: boolean; noCheckpoint?: boolean }> }>;
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
   *  ('acceptEdits' 工作区编辑 / 缺省 'full-access')——缺省不发 body 字段(旧 daemon 兼容)。
   *  第 5 参 opts（2026-11-15 sunx P1 Task 4）：kind/name/charter 透传 body——缺席时 body 与今日
   *  逐字节相同（向后兼容锚）;kind='sunx'=编排会话（出生 meta 落 kind/title/charterRev:1）,
   *  name=自定义会话名（meta.title）,charter=品性原文。GUI 弹窗（Task 6）只消费本签名 */
  newSession(root: string, mode?: 'acceptEdits' | 'full-access', worktree?: boolean, branch?: string, opts?: { kind?: 'sunx'; name?: string; charter?: string }): Promise<{ sessionId: string; worktree?: { name: string; path: string; branch: string } }>;
  /** POST /session/:id/attach {journalId}：恢复既有 journal 到该会话（并置激活） */
  /** attach:daemon 可能收编同 journal 在座会话(运行中刷新恢复)——返回**实际** sessionId(可能异于入参) */
  attach(sessionId: string, journalId: string): Promise<{ sessionId: string; root: string; kind?: string }>;
  /** POST /sunx/attach {journalId}（2026-11-15 sunx P3 Task 2 端点封装）：按 journalId 直开 sunx
   *  域会话——daemon 侧自铸壳（kind='sunx'/dataDir=域）+attachSessionIn 全链（reCast/播种/重布防/
   *  恢复轮）。SUNX 组/总览页数据源切换消费本封装=Task 3 */
  attachSunx(journalId: string): Promise<{ sessionId: string; root: string; kind?: string }>;
  /** POST /session/:id/submit {goal}：会话提交（202 受理；409 拒二次提交）。
   *  images=随行图片附件(dataURL,≤8 张);空列不落字段——旧 daemon 按纯文本受理(兼容) */
  sessionSubmit(id: string, goal: string, images?: string[]): Promise<void>;
  /** POST /session/:id/steer {text}：运行中插话（排队语义）；HTTP 失败抛错（消息含 status）；images 同 submit */
  sessionSteer(id: string, text: string, images?: string[]): Promise<void>;
  /** POST /session/:id/interrupt：中止在跑 run（无在跑 409） */
  sessionInterrupt(id: string): Promise<void>;
  /** 队列暂停（2026-11-23 用户裁定「中断同时暂停队列」）：置 daemon 暂停态,轮收束不自动发出 */
  queuePause(id: string): Promise<void>;
  /** 队列恢复：解除暂停；idle 即按序自动发送待发条目（横幅「继续」按钮） */
  queueResume(id: string): Promise<void>;
  /** GET /session/:id/snapshot：会话全量快照；lastSeq 同源 seq 泵——本连接层以其抬高该会话
   *  过滤基线（种子替换投影后的迟到补发帧双应用防线） */
  sessionSnapshot(id: string, page?: { before?: number; limit?: number; tail?: number }, opts?: { bumpSeq?: boolean }): Promise<SnapshotResponse & { lastSeq: number }>;
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
  /** GET /sessions/archived:跨工作区归档列表(归档页数据源)。kind=sunx 形态透出(归档行徽标) */
  archivedSessions(): Promise<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number; liveSessionId?: string; awaiting?: boolean; kind?: string }>>;
  /** GET /cache(2026-11-21 缓存清理):登记表逐类体积+保留期信息 */
  cacheStatus(): Promise<CacheStatusResp>;
  /** POST /cache/clear {categories?}:受控清理——ids 缺省=daemon safe 全档(http-cache 归壳桥) */
  clearCache(categories?: string[]): Promise<CacheClearResp>;
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
  /** 提供方连通探测(2026-11-17 模型列表测试钮):daemon 侧 GET {baseUrl}/models,零 token */
  probeProvider(name: string): Promise<{ ok: boolean; status?: number; count?: number; error?: string }>;
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
  /** GET /settings/sunx-templates?root=（sunx P2 Task 6，NewSunxDialog 模板挑选数据源）：品性模板
   *  两级宽容清单（root 缺省=仅全局清单；charter 全文随行——弹窗选中即回填）。只读面无写端点；
   *  弹窗打开时惰拉一次，失败静默=无模板态（不打扰创建主流程） */
  sunxTemplates(root?: string): Promise<SunxTemplatesView>;
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
