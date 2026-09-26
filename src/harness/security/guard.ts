import { PolicyEngine } from './policy';
import { READONLY_WHITELIST, PermissionMode, DESTRUCTIVE_COMMANDS, DESTRUCTIVE_PIPE } from './modes';
import { resolveWebSearchEndpoint } from './websearch-endpoint';
import { ApprovalDecision, ApprovalRequest } from '../../types';
import { isWithin } from '../../paths';

export type GuardDecision =
  | { allowed: true; safePath?: string }
  | { allowed: false; reason: string; /** manual 模式 ask 标记：非硬底线拒绝，可被 asker 交互豁免 */ ask?: boolean; askDir?: string; safePath?: string };

/** PreToolUse 决策点（enforcement 层） */
export class SecurityGuard {
  constructor(
    private policy: PolicyEngine = new PolicyEngine(),
    private modeName: PermissionMode = 'manual',
    /** 已登记 MCP 服务器名（源自项目级 .sunshinex/mcp.json 与全局 ~/.sunshinex/mcp.json，项目遮蔽全局）；空 = mcp__ 工具全禁 */
    private mcpServers: string[] = [],
  ) {}

  preToolUse(tool: string, input: unknown): GuardDecision {
    const specifier = this.extractSpecifier(tool, input);
    const decision = this.policy.decide(tool, specifier);

    if (decision === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: deny rule matched' };
    if (tool === 'Bash' && this.isDestructiveCommand(specifier)) {
      return { allowed: false, reason: `COMMAND_DENIED: destructive command blocked by safety floor: ${specifier.slice(0, 80)}` };
    }
    // 类别硬底线与破坏性命令同级：先于 allow 规则求值，策略规则不可豁免；dontAsk 模式同样不豁免（免审批 ≠ 免策略）
    if (tool === 'WebFetch') {
      const denied = this.checkWebFetch(input);
      if (denied) return denied;
    }
    // WebSearch 无用户 URL 入参，判界对象是引擎端点主机（与 Provider 同源解析，见 checkWebSearch）
    if (tool === 'WebSearch') {
      const denied = this.checkWebSearch();
      if (denied) return denied;
    }
    if (tool.startsWith('mcp__')) {
      const server = tool.split('__')[1] ?? '';
      if (!this.mcpServers.includes(server)) {
        return { allowed: false, reason: `COMMAND_DENIED: MCP server not registered, external tools denied by default: ${server || '(empty)'}` };
      }
    }
    // ask_question 即问询通道本身（零 IO 副作用，AskQuestion 线 D4/D7）：三模式放行——
    // plan 下的澄清式提问是对标 CC AskUserQuestion 的核心场景；deny 规则与破坏性硬底线仍先行
    if (tool === 'ask_question') return { allowed: true };
    // todo_write（todo_write 规格 D4）：零 IO 副作用的进程内状态写，三模式放行（对标 ask_question/spawn 先例）；
    // deny 规则与破坏性硬底线仍先行
    if (tool === 'todo_write') return { allowed: true };
    // worktree 工具（规格 D7）：deny 规则仍先行；单发独占由 reactor 并行闸门承载；
    // 免审批对标 spawn 先例（建树/切换活动根产物全在数据目录，非破坏性副作用）；plan 只读闸门：
    // create/exit 拦截（写语义：建树+切换活动根），list 只读放行（与 Read/Grep/Glob 同列白名单语义）
    if (tool === 'worktree') {
      const action = typeof input === 'object' && input !== null ? String((input as { action?: unknown }).action ?? '') : '';
      if (action === 'list') return { allowed: true };
      if (this.modeName === 'plan') return { allowed: false, reason: 'COMMAND_DENIED: plan mode allows read-only operations only' };
      return { allowed: true };
    }
    // plan 只读闸门：先于 allow 短路求值——allow 免批规则不放宽 plan 只读（task 1 ⑤a）
    if (this.modeName === 'plan') {
      if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') {
        return { allowed: false, reason: 'COMMAND_DENIED: plan mode allows read-only operations only' };
      }
      return { allowed: true };
    }
    if (decision === 'allow') return { allowed: true };

    // decision === 'ask'
    // dontAsk：不询问用户，自动批准未 deny 的操作（deny 规则仍拦截），即「最大权限」
    if (this.modeName === 'dontAsk') return { allowed: true };
    // manual 模式：只读白名单放行，其余 ask（阶段一 CLI 未实现交互，ask 视为放行只读、拒绝写）
    if (tool === 'Bash' && this.isReadonlyCommand(specifier)) return { allowed: true };
    if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return { allowed: true };
    // 行为变更①（spec 5.1 写分支）：path 形态的 Write 直放——manual 审批下放安全链（链持归一路径与目录粒度会话放行）。
    // 仅限带 path 的路径写工具；无 path 的结构化入参（memory_write 同族形态）保留 guard 层 ask（同族非别名，逐字任务口径）
    if (tool === 'Write' && this.hasPathInput(input)) return { allowed: true };
    // spawn 无直接 IO 副作用（派生即编排；子代理内部每个工具调用独立过安全链），manual 下免审批放行
    if (tool === 'spawn') return { allowed: true };
    // task_stop：后台账本状态操作，零直接 IO 副作用（进程组终止经由账本已登记的 stop 句柄），manual 下免审批对齐 spawn 先例
    if (tool === 'task_stop') return { allowed: true };
    // task_wait：等待面回执读账本已登记的任务日志，零直接 IO 副作用，manual 下免审批对齐 task_stop 先例
    if (tool === 'task_wait') return { allowed: true };
    return { allowed: false, ask: true, reason: 'COMMAND_DENIED: manual mode requires interactive confirmation' };
  }

  private asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 会话级 always 登记面（内存态；会话结束由调用方 clearSessionAllows，不落盘）。键经 allowKey 归一 */
  private sessionAllows = new Set<string>();

  /** 放行登记键：Bash 归一为命令族（首 token basename，放行 npm run build 即放行本会话 npm 族），其余工具用 subject 原样（path/url）。
   *  空 subject 一律并入工具规范名（`<tool>:`）：键空间必须至少含工具身份——否则 `''` 成为跨工具族的公共键，
   *  一次 always（如无 path/url/query 入参的记忆写入或 MCP 工具）会连带放行本会话内所有「键同为空」的其它工具。 */
  private allowKey(tool: string, subject: string): string {
    if (subject === '') return `${tool}:`;
    if (tool !== 'Bash') return subject;
    const first = subject.trim().split(/\s+/)[0] ?? '';
    const base = first.split('/').pop() ?? first;
    return base === '' ? `${tool}:` : base;
  }
  private seq = 0;

  /** 终端化审批注入（TUI/GUI 装配点）；传 undefined 即卸载回阶段一语义 */
  private readonly sessionDirAllows = new Set<string>();

  /** 当前权限模式（链侧消费：读/写分支按档位定论，spec 5.1） */
  get mode(): PermissionMode {
    return this.modeName;
  }

  /** 'always' 目录登记（spec 5.1 会话放行集；链侧 realpath 归一后传入） */
  allowSessionDir(dir: string): void {
    this.sessionDirAllows.add(dir);
  }

  /** 会话目录放行判据：real 落在任一已登记目录内（含自身） */
  sessionDirAllowed(real: string): boolean {
    for (const dir of this.sessionDirAllows) {
      if (real === dir || isWithin(dir, real)) return true;
    }
    return false;
  }

  /** landlock 可写根消费（spec 5.4：工具面与 exec 面对齐同一目录集） */
  sessionDirList(): string[] {
    return [...this.sessionDirAllows];
  }

  /** 审批请求 id 单点（链侧发起的 ask 复用同一序号空间） */
  nextApprovalId(): string {
    return `ap-${++this.seq}`;
  }

  /** 链侧发起的 ask 决策通道（spec 5.1 写/读分支）：asker 缺失返回 null（宁停不误，调用方维持原拒绝） */
  async resolveAsk(req: ApprovalRequest): Promise<ApprovalDecision | null> {
    if (!this.asker) return null;
    try {
      return await this.asker(req);
    } catch {
      return null;
    }
  }

  setAsker(asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>): void {
    this.asker = asker;
  }

  clearSessionAllows(): void {
    this.sessionAllows.clear();
    this.sessionDirAllows.clear();
  }

  /** 异步决策：与 preToolUse 同口径；仅 manual ask 标记拒绝接入 asker（deny/硬底线不被交互豁免，宁停不误） */
  async preToolUseAsync(tool: string, input: unknown): Promise<GuardDecision> {
    const sync = this.preToolUse(tool, input);
    if (sync.allowed) return sync;
    if (!sync.ask) return sync;
    const subject = this.approvalSubject(tool, input);
    // 会话级放行对所有审批类工具生效（此前仅 Bash 且按完整命令行匹配，'a' 后同族命令仍逐步询问）
    if (this.sessionAllows.has(this.allowKey(tool, subject))) return { allowed: true };
    if (!this.asker) return sync;
    const req: ApprovalRequest = {
      id: this.nextApprovalId(),
      kind: tool === 'Bash' ? 'command' : tool.startsWith('mcp__') ? 'mcp' : tool === 'WebFetch' ? 'webfetch' : tool === 'WebSearch' ? 'websearch' : 'write',
      subject,
      reason: 'manual mode requires interactive confirmation',
    };
    let d: ApprovalDecision;
    try {
      d = await this.asker(req);
    } catch (e) {
      return { allowed: false, reason: `COMMAND_DENIED: asker failed (${e instanceof Error ? e.message : String(e)})` };
    }
    if (d === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: rejected by user' };
    if (d === 'always') this.sessionAllows.add(this.allowKey(tool, subject));
    return { allowed: true };
  }

  /** 审批 subject 提取：Bash 取命令行，write 类取 path，webfetch 取 url，websearch 取 query；
   *  path/url/query 三者全缺时退到结构化入参摘要（`<type>: <description|正文首行>`）——memory_write 一类无路径入参的写工具
   *  必须给出非空且看得出「在写什么」的 subject（空 subject 的卡片只有一行空白，空键的会话放行又会跨内容命中）。 */
  private approvalSubject(tool: string, input: unknown): string {
    if (tool === 'Bash') return this.extractSpecifier(tool, input);
    if (typeof input === 'object' && input !== null) {
      const p = (input as { path?: unknown }).path;
      if (typeof p === 'string') return p;
      const u = (input as { url?: unknown }).url;
      if (typeof u === 'string') return u;
      const q = (input as { query?: unknown }).query;
      if (typeof q === 'string') return q;
      const structured = structuredSubject(input);
      if (structured !== '') return structured;
    }
    return this.extractSpecifier(tool, input);
  }

  private extractSpecifier(tool: string, input: unknown): string {
    if (tool === 'Bash' && typeof input === 'object' && input !== null) {
      const cmd = (input as { command?: unknown }).command;
      return typeof cmd === 'string' ? cmd : '';
    }
    if (typeof input === 'string') return input;
    return '';
  }

  /** Write 直放分支的入参形态判定：入参含 string path 字段即视为路径写工具（builtin write/webfetch 形态）；
   *  memory_write 一类无 path 的结构化入参不命中，保留 guard 层审批（会话放行键为 type:description，不跨内容） */
  private hasPathInput(input: unknown): boolean {
    return typeof input === 'object' && input !== null && typeof (input as { path?: unknown }).path === 'string';
  }

  private isReadonlyCommand(specifier: string): boolean {
    const first = specifier.trim().split(/\s+/)[0] ?? '';
    const base = first.split('/').pop() ?? first;
    return READONLY_WHITELIST.includes(base);
  }

  /** 破坏性命令底线：首 token basename 归一（防 /bin/rm 绕过）；递归删除/写盘/电源/下载执行管道即拒（spec 2.2） */
  private isDestructiveCommand(cmd: string): boolean {
    const tokens = cmd.trim().split(/\s+/);
    const first = tokens[0] ?? '';
    const base = first.split('/').pop() ?? first;
    if (base === 'rm') {
      const recursive = tokens.slice(1).some((t) => t === '--recursive' || /^-[a-zA-Z]*[rR]/.test(t));
      if (recursive) return true;
    }
    if (base.startsWith('mkfs')) return true;
    if (DESTRUCTIVE_COMMANDS.includes(base)) return true;
    return DESTRUCTIVE_PIPE.test(cmd);
  }

  /** webfetch 卫生底线：URL 合法 → 仅 http/https（不做域名限制）；返回拒绝决策，放行返回 null */
  private checkWebFetch(input: unknown): GuardDecision | null {
    let raw = '';
    if (typeof input === 'object' && input !== null) raw = String((input as { url?: unknown }).url ?? '');
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { allowed: false, reason: 'COMMAND_DENIED: invalid WebFetch URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: `COMMAND_DENIED: WebFetch allows http/https only: ${parsed.protocol}` };
    }
    return null;
  }

  /** websearch 卫生底线：判界对象是引擎端点（与 Provider 同源解析，见 websearch-endpoint）——端点非法或非 http/https 即拒 */
  private checkWebSearch(): GuardDecision | null {
    let parsed: URL;
    try {
      parsed = new URL(resolveWebSearchEndpoint());
    } catch {
      return { allowed: false, reason: 'COMMAND_DENIED: invalid WebSearch endpoint' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: `COMMAND_DENIED: WebSearch allows http/https endpoints only: ${parsed.protocol}` };
    }
    return null;
  }
}

/**
 * 结构化入参摘要（approvalSubject 的无 path/url/query 兜底单点）：`<type>: <摘要>`，摘要取 description、缺省取 content 首行；
 * 截 80 字符且只取首行——审批卡片单行展示，subject 同时充当会话放行键，须看得出「在写什么」。
 * 三字段全缺返回 `''`（调用方退回既有 extractSpecifier 语义，空 subject 的跨族风险由 allowKey 的 `<tool>:` 兜住）。
 */
function structuredSubject(input: object): string {
  const obj = input as { type?: unknown; description?: unknown; content?: unknown };
  const type = typeof obj.type === 'string' ? obj.type.trim() : '';
  const raw =
    typeof obj.description === 'string' && obj.description.trim() !== ''
      ? obj.description
      : typeof obj.content === 'string'
        ? obj.content
        : '';
  const summary = (raw.trim().split('\n')[0] ?? '').trim();
  return [type, summary].filter((s) => s !== '').join(': ').slice(0, 80);
}
