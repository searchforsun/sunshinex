import { createConnectionTransport, DEFAULT_BACKOFF_BASE_MS } from './connection-transport';
export { toWsUrl } from './connection-transport';
export * from './connection-types';
import type {
  AgentFrontmatterInput,
  AgentsView,
  BuiltinRole,
  ConnectionOpts,
  ConnectionState,
  DirPickerResp,
  DiffResp,
  FileResp,
  GuiAskAnswer,
  McpProbeResult,
  McpRow,
  McpRowInput,
  SessionRow,
  SettingsView,
  SkillsGroup,
  SnapshotResponse,
  TreeResp,
  WorkspaceRow,
} from './connection-types';
import type { SessionEvent } from '../../src/types';


export interface Connection {
  /** GET /workspaces：工作区注册表扫描（T2） */
  workspaces(): Promise<WorkspaceRow[]>;
  /** GET /sessions?root=：工作区会话（journal）列表（T2） */
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** GET /sessions/recent：跨工作区扁平最近会话（G10-C2 侧栏 Recents 区） */
  recentSessions(): Promise<Array<SessionRow & { root: string; slug: string }>>;
  /** GET /session/:id/model：模型 pill 数据源(G10-C4;choices 空=不可切) */
  sessionModel(id: string): Promise<{ current?: string; explicitDefault: boolean; choices: Array<{ id: string; model: string; baseUrl: string; effort?: string; contextWindow?: number }> }>;
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
  /** G14.69 原生选择定位:按标记文件全盘找所选目录绝对路径(超时/未找到 path:null) */
  locateWorkspace(body: { token: string; roots?: string[] }): Promise<{ path: string | null }>;
  /** POST /session/:id/model|tier|effort|mode:运行中切换(下一轮生效;G10-C1b/C2b) */
  setSessionModel(id: string, model?: string): Promise<void>;
  setSessionTier(id: string, tier?: 'small' | 'medium' | 'large'): Promise<void>;
  setSessionEffort(id: string, effort?: string): Promise<void>;
  setSessionMode(id: string, mode: 'dontAsk' | 'manual' | 'plan'): Promise<void>;
  /** POST /session/:id/steer/cancel:撤回排队插话(G10-C1d) */
  cancelSteer(id: string, seq: number): Promise<void>;
  /** G14.83 排队条目重排(拖拽排序)/置首(插入发送=下一轮立即注入) */
  moveSteer(id: string, from: number, to: number): Promise<void>;
  frontSteer(id: string, seq: number): Promise<void>;
  /** POST /session/:id/steer/edit:队列条目内联改写(P5 spec §12.2) */
  editSteer(id: string, seq: number, text: string): Promise<void>;
  /** POST /session/:id/rewind|fork(G10-C1d):turn=anchors 1-based */
  rewindSession(id: string, turn: number): Promise<void>;
  forkSession(id: string, turn: number, side?: boolean): Promise<{ sessionId: string }>;
  /** GET /session/:id/anchors:任务轮锚点(rewind/fork 寻址) */
  sessionAnchors(id: string): Promise<Array<{ turn: number; text: string }>>;
  /** POST /memory/rm:记忆删除(G10-C1d) */
  removeMemory(root: string, slugs: string[]): Promise<{ removed: string[]; failed: Array<{ slug: string; error: string }> }>;
  /** POST /session/:id/command:斜杠命令直跑(G10-C1c) */
  runCommand(id: string, line: string): Promise<void>;
  /** GET /commands:清单+双语描述+supported(G10-C4 命令面板数据源) */
  commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }>;
  /** G14.95 技能命令清单(会话维):GUI 命令面板混入技能项 */
  skillCommands(id: string): Promise<Array<{ id: string; description: string }>>;
  /** G14.99 工作区未提交变动面（Diff 标签数据源） */
  sessionChanges(id: string): Promise<{ branch: string; files: Array<{ path: string; status: string; added: number | null; deleted: number | null }> }>;
  /** G14.112 目录树 git 状态映射(含 ignored 目录折叠):path → modified/untracked/deleted/renamed/ignored */
  gitStatus(id: string): Promise<{ branch: string; map: Record<string, string> }>;
  /** G14.113 分支清单+切换(欢迎页分支选择弹窗;非 git 目录 branches 空) */
  gitBranches(root: string): Promise<{ current: string; branches: string[] }>;
  gitCheckout(root: string, branch: string): Promise<void>;
  /** G14.121 工作区文件索引(@ 面板数据源):posix 相对路径+mtime,倒序=最近改动优先;
   *  dirs=尾斜杠目录清单(@面板滤出文件夹/目录引用面;旧 daemon 无此字段 → undefined) */
  workspaceFiles(root: string): Promise<{ files: Array<{ path: string; mtime: number }>; dirs?: string[] }>;
  /** G14.2xx GUI 面私有态存取(标签页等,按会话键;daemon 落 <slug>/gui/sessions/<id>.json) */
  guiState(id: string): Promise<{ state: unknown }>;
  saveGuiState(id: string, state: object): Promise<void>;
  /** G14.2xx 应用级指针档(恢复现场入口;<projectsRoot>/gui/ui-state.json:lastRoot/lastJournalId) */
  appGuiState(): Promise<{ state: unknown }>;
  saveAppGuiState(state: object): Promise<void>;
  sessionChangeContent(id: string, path: string): Promise<{ path: string; oldContent?: string; newContent: string; truncated: boolean; deleted: boolean }>;
  commitChanges(id: string, message: string): Promise<void>;
  pushChanges(id: string): Promise<void>;
  /** G14.100 撤销单个变动文件(restore 回 HEAD/删除本轮新建) */
  restoreChange(id: string, path: string): Promise<void>;
  /** GET /session/:id/context:上下文分段构成(G10-C6 面板) */
  sessionContext(id: string): Promise<{ parts: Array<{ id: string; tokens: number; count: number }>; chainByAction: Array<{ action: string; tokens: number }>; total: number; window: number; free: number }>;
  /** GET /session/:id/shadow-events:journal 影子事件全量(board/delegation/subagent)+ cut 水位
   *  (G14.2xx b 影子投影水合——刷新/重连后会话打开时拉取清零重放;WS 环窗 512 对长会话子代理流
   *  必溢出,恢复唯一可靠入口)。cut=服务端读档时刻泵水位:在途缓冲帧按 seq>cut 重放,零丢帧零重复 */
  shadowEvents(id: string): Promise<{ events: SessionEvent[]; cut: number }>;
  /** GET /session/:id/tasks:后台任务账本行(G10-C6 面板)。G14.2xx 用户裁定:本面只记录 exec 类
   *  真后台执行——subagent/teammate 账本行退役(子代理/队友在任务板·agent 页签已有专面,双处
   *  同显重复);本方法单点过滤(顶栏计数与后台任务页签共用) */
  sessionTasks(id: string): Promise<Array<{ id: string; kind: string; label: string; status: string; startedAt: number; exitCode?: number }>>;
  /** GET /memory?root=:记忆清单(G10-C6 面板) */
  memoryList(root: string): Promise<Array<{ slug: string; type: string; created: string; modified: string; description: string; body: string }>>;
  /** GET /dirpicker?path=（缺省 home）：服务端目录浏览（T2） */
  dirpicker(path?: string): Promise<DirPickerResp>;
  /** POST /session/new {root, mode?}:按 root 装配新会话（并置激活）→ {sessionId};mode 可选
   *  ('manual' 审批问询挂起 / 'dontAsk' 缺省)——缺省不发 body 字段(旧 daemon 兼容) */
  newSession(root: string, mode?: 'dontAsk' | 'manual'): Promise<{ sessionId: string }>;
  /** POST /session/:id/attach {journalId}：恢复既有 journal 到该会话（并置激活） */
  /** attach:daemon 可能收编同 journal 在座会话(运行中刷新恢复)——返回**实际** sessionId(可能异于入参) */
  attach(sessionId: string, journalId: string): Promise<{ sessionId: string }>;
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
  fetchDiff(sessionId: string, callId: string, path?: string): Promise<DiffResp>;
  /** POST /session/:id/delete(2026-10-21 受控删除):须先归档(未归档 409);真清会话档全家 */
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
  /** all=true：跨项目视图（scope=all——user 全局 + 当前项目 project 组 + 全项目学习沉淀逐项目
   *  分组，组带 project 归属名）；缺省 = 当前 root 视图（T6 原语义，composer 技能清单消费） */
  skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }>;
  /** GET /settings/memory-stats?root=（T6）：主域记忆概览（root 缺省 = 零值非 400） */
  memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }>;
  close(): void;
  state(): ConnectionState;
  /** 测试钩子（e2e 断链注入专用）：当前底层 socket（无连接 undefined）——产品面勿消费 */
  debug: { socket(): WebSocket | undefined };
}

export function createConnection(opts: ConnectionOpts): Connection {
  const { baseUrl, token, onEvent, onReset } = opts;
  /** 鉴权头(G10:token 空=免鉴权档,不发 authorization) */
  const authHeaders: Record<string, string> = token === '' || token === undefined ? {} : { authorization: `Bearer ${token}` };
  const { onApproval, onAsk, onResetSession } = opts;
  const onStateChange = opts.onStateChange;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const base = baseUrl.replace(/\/+$/, '');

  const transport = createConnectionTransport(base, token, backoffBaseMs, {
    onEvent,
    onApproval,
    onAsk,
    onReset,
    onResetSession,
    onStateChange,
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

  /** sessionSnapshot 单点：GET + 代次守卫下的基线抬高（慢到应答不污新连接的全量重放窗） */
  async function fetchSessionSnapshot(id: string): Promise<SnapshotResponse & { lastSeq: number }> {
    const gen = transport.generation();
    const resp = await getJson<SnapshotResponse & { lastSeq: number }>(`/session/${encodeURIComponent(id)}/snapshot`);
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
    async setSessionMode(id: string, mode: 'dontAsk' | 'manual' | 'plan'): Promise<void> {
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
    async rewindSession(id: string, turn: number): Promise<void> {
      await post('/session/' + encodeURIComponent(id) + '/rewind', { turn });
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
    sessionAnchors(id: string) {
      return getJson('/session/' + encodeURIComponent(id) + '/anchors');
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
    commands() {
      return getJson('/commands');
    },
    skillCommands(id: string) {
      return getJson<Array<{ id: string; description: string }>>(`/session/${encodeURIComponent(id)}/skill-commands`);
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
    async gitCheckout(root: string, branch: string) {
      await post('/git/checkout', { root, branch });
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
    sessionChangeContent(id: string, path: string) {
      return getJson(`/session/${encodeURIComponent(id)}/changes/content?path=${encodeURIComponent(path)}`);
    },
    async commitChanges(id: string, message: string) {
      await post('/session/' + encodeURIComponent(id) + '/changes/commit', { message });
    },
    async pushChanges(id: string) {
      await post('/session/' + encodeURIComponent(id) + '/changes/push', {});
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
    sessionTasks(id: string) {
      // 白名单:只留 exec 类真后台执行(subagent/teammate 各有专面)——见接口注
      return getJson<Array<{ id: string; kind: string; label: string; status: string; startedAt: number; exitCode?: number }>>(
        '/session/' + encodeURIComponent(id) + '/tasks',
      ).then((rows) => rows.filter((r) => r.kind === 'exec'));
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
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(mode === undefined ? { root } : { root, mode }),
      });
      if (!res.ok) throw new Error(`/session/new -> ${res.status}`);
      return (await res.json()) as { sessionId: string };
    },
    async attach(sessionId: string, journalId: string): Promise<{ sessionId: string }> {
      return postJson<{ sessionId: string }>(`/session/${encodeURIComponent(sessionId)}/attach`, { journalId });
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
    fetchDiff(sessionId: string, callId: string, path?: string): Promise<DiffResp> {
      // path 随参(G14.4):callId 未中(重放会话)时 daemon 按 journal snapshots 行回退真 pre-image
      const p = path !== undefined && path !== '' ? `&path=${encodeURIComponent(path)}` : '';
      return getJson<DiffResp>(`/session/${encodeURIComponent(sessionId)}/diff?callId=${encodeURIComponent(callId)}${p}`);
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
        headers: { ...authHeaders, 'content-type': 'application/json' },
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
    skillsGroups(root?: string, all?: boolean): Promise<{ groups: SkillsGroup[] }> {
      const parts = [root === undefined ? '' : `root=${encodeURIComponent(root)}`, ...(all === true ? ['scope=all'] : [])].filter(Boolean);
      return getJson<{ groups: SkillsGroup[] }>(parts.length === 0 ? '/settings/skills' : `/settings/skills?${parts.join('&')}`);
    },
    memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }> {
      return getJson<{ entries: number; lastWriteAt: number | null }>(
        root === undefined ? '/settings/memory-stats' : `/settings/memory-stats?root=${encodeURIComponent(root)}`,
      );
    },
    close: () => transport.close(),
    state(): ConnectionState {
      return transport.state();
    },
    debug: { socket: (): WebSocket | undefined => transport.currentSocket() },
  };
}
