import { SESSION_DELETED_EVENT, SESSION_ARCHIVED_EVENT, SESSION_ARCHIVE_CHANGED_EVENT } from './session-events';
import { t } from './i18n';
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


import type { ChannelBindingMsg, ChannelConfigMsg, ChannelHealthRowMsg } from './connection-api';
import type { Connection } from './connection-api';
export type { Connection } from './connection-api';

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
  /** 审查页两区操作单点(stage/unstage/discard):失败读应答体 error 透出 */
  async function changesOp(id: string, op: 'stage' | 'unstage' | 'discard', paths?: string[]): Promise<void> {
    const p = `/session/${encodeURIComponent(id)}/changes/${op}`;
    const res = await fetch(`${base}${p}`, {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(paths !== undefined ? { paths } : {}),
    });
    if (!res.ok) throw await opError(p, res);
  }

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

  /** PUT 带 JSON 应答（scheduled-tasks Task 7:POST 同款形——schedule 更新回任务行）。
   *  失败读应答体 error/hint（终审 minor:与 op 族同纪律,服务端真因直达 GUI 错误条） */
  async function putJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await opError(path, res);
    return (await res.json()) as T;
  }

  /** DELETE 无应答体（scheduled-tasks Task 7:schedule 删除,成功 200 {ok:true} 只作成功信号；
   *  失败同 putJson 走 opError 透出服务端 error/hint） */
  async function del(path: string): Promise<void> {
    const res = await fetch(`${base}${path}`, { method: 'DELETE', headers: authHeaders });
    if (!res.ok) throw await opError(path, res);
  }

  /** sessionSnapshot 单点：GET + 代次守卫下的基线抬高（慢到应答不污新连接的全量重放窗）。
   *  bumpSeq=false 供辅助拉取（批准后的 mode 轻同步等）——只读数据不动 seq 门（2026-11-04 实测
   *  根修:批准回执落定→executor 同拍恢复→tool-result 帧在途;此刻辅助快照应答先行处理即把
   *  lastSeq 抬过在途帧序,帧落门内被当重放丢=交稿行永卡「正在提交」） */
  async function fetchSessionSnapshot(id: string, page?: { before?: number; limit?: number; tail?: number }, opts?: { bumpSeq?: boolean }): Promise<SnapshotResponse & { lastSeq: number }> {
    const gen = transport.generation();
    // tail 与 before 互斥(daemon 400):tail=尾窗条数(2026-11-19 刻度一次加载轮——
    // reseed 取全量尾窗 2000=kernel 档面上限,免分页补历史致刻度/正文两段加载)
    const q = page === undefined
      ? ''
      : page.tail !== undefined
        ? `?tail=${page.tail}`
        : `?before=${page.before}&limit=${page.limit}`;
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
    // sunx P2 Task 7 品性读写面:读=GET 当前全文+rev(CharterDialog 预填);写=POST 全文替换回新 rev
    sessionCharter(id: string) {
      return getJson<{ text: string | null; charterRev: number }>('/session/' + encodeURIComponent(id) + '/charter');
    },
    editCharter(id: string, text: string) {
      return postJson<{ ok: true; charterRev: number }>('/session/' + encodeURIComponent(id) + '/charter', { text });
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
    async gitBranchCreate(root: string, branch: string) {
      await post('/git/branch-create', { root, branch });
    },
    async gitFetchRemote(root: string) {
      // 错误面读响应体(2026-11-13 用户实测「拉取500」:通用 postJson 只抛 '->status',用户看不到
      // 原因)——daemon 回 {error,code} 时透出可读消息,网络/凭据失败照常抛
      const res = await fetch(`${base}/git/fetch`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error !== undefined && body.error !== '' ? body.error : `${t('Fetch failed', '拉取失败')} (${res.status})`);
      }
      return (await res.json()) as { fetched: string[]; warning?: string };
    },
    /** 切换代价面(2026-11-10):numstat 汇总+未提交改动数;missing=目标分支不存在(新建面) */
    branchDiffStat(root: string, branch: string): Promise<{ files: number; added: number; deleted: number; dirty: number; dirtyAdded: number; dirtyDeleted: number; missing: boolean }> {
      return getJson(`/git/branch-diff?root=${encodeURIComponent(root)}&branch=${encodeURIComponent(branch)}`);
    },
    workspaceFiles(root: string) {
      return getJson(`/workspace/files?root=${encodeURIComponent(root)}`);
    },
    fetchWebMeta(url: string) {
      return getJson<{ title: string; icon: string }>(`/web/meta?url=${encodeURIComponent(url)}`);
    },
    async gitCheckout(root: string, branch: string, create?: boolean) {
      const res = await fetch(`${base}/git/checkout`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ root, branch, ...(create === true ? { create: true } : {}) }),
      });
      if (res.ok) return;
      const err = await opError('/git/checkout', res);
      throw res.status === 409 ? Object.assign(err, { code: 'DIRTY_TREE' }) : err;
    },
    async gitCommitCheckout(root: string, branch: string, create?: boolean, message?: string) {
      const res = await fetch(`${base}/git/commit-checkout`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ root, branch, ...(create === true ? { create: true } : {}), ...(typeof message === 'string' && message.trim() !== '' ? { message: message.trim() } : {}) }),
      });
      if (!res.ok) throw await opError('/git/commit-checkout', res);
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
    async openInEditor(path: string, id: string, root?: string) {
      await post('/app/open', { path, id, ...(root !== undefined ? { root } : {}) });
    },
    sessionChangeContent(id: string, path: string, area?: 'staged' | 'unstaged') {
      return getJson(`/session/${encodeURIComponent(id)}/changes/content?path=${encodeURIComponent(path)}${area !== undefined ? `&area=${area}` : ''}`);
    },
    async stageChanges(id: string, paths?: string[]) {
      await changesOp(id, 'stage', paths);
    },
    async unstageChanges(id: string, paths?: string[]) {
      await changesOp(id, 'unstage', paths);
    },
    async discardUnstaged(id: string, paths?: string[]) {
      await changesOp(id, 'discard', paths);
    },
    async commitChanges(id: string, message: string, stagedOnly?: boolean) {
      // 失败读应答体 error 透出(2026-10-31 用户实测 push 400 裸显——服务端 git 真因直达审查页)
      const res = await fetch(`${base}/session/${encodeURIComponent(id)}/changes/commit`, {
        method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ message, ...(stagedOnly === true ? { staged: true } : {}) }),
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
    turnDiff(id: string, run: number, path: string) {
      return getJson(`/session/${encodeURIComponent(id)}/turn-diff?run=${run}&path=${encodeURIComponent(path)}`);
    },
    async turnRestore(id: string, run: number, paths: string[]) {
      return postJson(`/session/${encodeURIComponent(id)}/turn-restore`, { run, paths });
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
    async newSession(root: string, mode?: 'acceptEdits' | 'full-access', worktree?: boolean, branch?: string, opts?: { kind?: 'sunx'; name?: string; charter?: string }): Promise<{ sessionId: string; worktree?: { name: string; path: string; branch: string } }> {
      const res = await fetch(`${base}/session/new`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        // 缺省字段省发（mode/worktree/branch 既有纪律延续）：opts 缺席时 body 与今日逐字节相同（向后兼容锚）；
        // charter 原样透传不 trim（用户自撰物料逐字进冻结层）,name trim 后透传
        body: JSON.stringify({
          root,
          ...(mode !== undefined ? { mode } : {}),
          ...(worktree === true ? { worktree: true } : {}),
          ...(typeof branch === 'string' && branch.trim() !== '' ? { branch: branch.trim() } : {}),
          ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
          ...(opts?.name !== undefined && opts.name.trim() !== '' ? { name: opts.name.trim() } : {}),
          ...(opts?.charter !== undefined && opts.charter.trim() !== '' ? { charter: opts.charter } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        throw Object.assign(new Error(body?.error ?? `/session/new -> ${res.status}`), body?.code !== undefined ? { code: body.code } : {});
      }
      return (await res.json()) as { sessionId: string; worktree?: { name: string; path: string; branch: string } };
    },
    async attach(sessionId: string, journalId: string): Promise<{ sessionId: string; root: string; kind?: string }> {
      return postJson<{ sessionId: string; root: string; kind?: string }>(`/session/${encodeURIComponent(sessionId)}/attach`, { journalId });
    },
    async attachSunx(journalId: string): Promise<{ sessionId: string; root: string; kind?: string }> {
      return postJson<{ sessionId: string; root: string; kind?: string }>(`/sunx/attach`, { journalId });
    },
    sunxSessions() {
      return getJson<SessionRow[]>('/sunx/sessions');
    },
    // 定时任务面（2026-11-20 scheduled-tasks Task 7）：路径/形状与 brief 逐字对齐；id 恒 encodeURIComponent
    schedules() {
      return getJson<SchedulesView>('/schedules');
    },
    createSchedule(body: ScheduleDraft) {
      return postJson<ScheduleJobView>('/schedules', body);
    },
    updateSchedule(id: string, body: ScheduleDraft) {
      return putJson<ScheduleJobView>(`/schedules/${encodeURIComponent(id)}`, body);
    },
    async deleteSchedule(id: string): Promise<{ ok: true }> {
      await del(`/schedules/${encodeURIComponent(id)}`);
      return { ok: true };
    },
    runScheduleNow(id: string) {
      return postJson<{ ok: true; runId: string }>(`/schedules/${encodeURIComponent(id)}/run`, {});
    },
    setScheduleEnabled(id: string, enabled: boolean) {
      return postJson<ScheduleJobView>(`/schedules/${encodeURIComponent(id)}/enabled`, { enabled });
    },
    scheduleRuns(id: string, limit?: number) {
      return getJson<{ runs: ScheduleRunView[] }>(
        `/schedules/${encodeURIComponent(id)}/runs${limit !== undefined ? `?limit=${limit}` : ''}`,
      );
    },
    previewSchedule(body: { recurrence: ScheduleRecurrence; startAt: number; until?: number }) {
      return postJson<{ next: number[] }>('/schedules/preview', body);
    },
    // ---- 通道面（2026-11-21 channels Task 11）：路径/应答形状与 channels Task 9 serve 实装逐字对齐 ----
    channelsView() {
      return getJson<{ channels: ChannelHealthRowMsg[] }>('/channels');
    },
    // GET /settings/channels（2026-11-21 channels Task 12 修复波补缺）：配置读面——serve
    // handleChannelsGet 应答 {channels,warnings} 逐字对齐；ChannelsPane 草稿回填数据源
    settingsChannels() {
      return getJson<{ channels: ChannelConfigMsg[]; warnings: string[] }>('/settings/channels');
    },
    putChannels(channels: ChannelConfigMsg[]) {
      // putJson（失败 opError 透出 error/hint——400 校验回显/409 注释档·畸形 引流 raw 编辑面）
      return putJson<{ ok: true; warnings: string[] }>('/settings/channels', { channels });
    },
    testChannel(id: string) {
      return postJson<{ ok: boolean; botId?: string; error?: string; code?: string }>(`/channels/${encodeURIComponent(id)}/test`, {});
    },
    channelBindings() {
      return getJson<{ bindings: ChannelBindingMsg[] }>('/channels/bindings');
    },
    async putChannelBinding(key: string, patch: { rootOverride?: string | null }): Promise<{ ok: true }> {
      // key=`channelId:chatId` 绑定键（chatId 可含 ':'）——patch 原样作 body（null=清除/缺席=
      // 清除、非空串=设置，全量定态；404 unknown binding/400 空串经 opError 透出）
      await putJson<{ ok: true }>(`/channels/bindings/${encodeURIComponent(key)}`, patch);
      return { ok: true };
    },
    async deleteChannelBinding(key: string): Promise<{ ok: true }> {
      // key=`channelId:chatId` 绑定键（chatId 可含 ':'）——deleteSchedule 同款 del+组装 ok
      // （200 {ok:true} 只作成功信号；404 unknown binding 经 opError 透出）
      await del(`/channels/bindings/${encodeURIComponent(key)}`);
      return { ok: true };
    },
    async deleteChannel(id: string): Promise<{ ok: true }> {
      // DELETE /channels/:id(2026-11-23 用户裁定「真正的删除各种配置和目录」):条目移除+解绑+
      // 聊天域目录真删(404 unknown channel 经 opError 透出)
      await del(`/channels/${encodeURIComponent(id)}`);
      return { ok: true };
    },
    channelSessions() {
      // 裸 SessionRow[]（sunxSessions 同款消费形，无信封）
      return getJson<SessionRow[]>('/channels/sessions');
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
    queuePause(id: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/queue/pause`, {});
    },
    queueResume(id: string): Promise<void> {
      return post(`/session/${encodeURIComponent(id)}/queue/resume`, {});
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
    artifacts(sessionId: string) {
      return getJson(`/session/${encodeURIComponent(sessionId)}/artifacts`);
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
    cacheStatus(): Promise<CacheStatusResp> {
      return getJson<CacheStatusResp>('/cache');
    },
    clearCache(categories?: string[]): Promise<CacheClearResp> {
      // categories 缺省=daemon safe 全档;http-cache 归壳侧(clearHttpCache 桥),不经本端点
      return postJson<CacheClearResp>('/cache/clear', { ...(categories === undefined ? {} : { categories }) });
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
    /** 提供方连通探测（2026-11-17 模型列表测试钮）：daemon 侧 GET {baseUrl}/models，零 token */
    probeProvider(name: string): Promise<{ ok: boolean; status?: number; count?: number; error?: string }> {
      return postJson('/settings/providers/probe', { name });
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
    // sunx P2 Task 6 模板清单:teamsView 同款——root 缺省省查询参(仅全局清单)
    sunxTemplates(root?: string): Promise<SunxTemplatesView> {
      return getJson<SunxTemplatesView>(root === undefined ? '/settings/sunx-templates' : `/settings/sunx-templates?root=${encodeURIComponent(root)}`);
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
