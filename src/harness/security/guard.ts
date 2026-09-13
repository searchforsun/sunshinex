import { PolicyEngine } from './policy';
import { READONLY_WHITELIST, PermissionMode, DESTRUCTIVE_COMMANDS, DESTRUCTIVE_PIPE } from './modes';
import { resolveWebSearchEndpoint } from './websearch-endpoint';
import { ApprovalDecision, ApprovalRequest } from '../../types';

export type GuardDecision =
  | { allowed: true; safePath?: string }
  | { allowed: false; reason: string; /** manual 模式 ask 标记：非硬底线拒绝，可被 asker 交互豁免 */ ask?: boolean };

/** PreToolUse 决策点（enforcement 层） */
export class SecurityGuard {
  constructor(
    private policy: PolicyEngine = new PolicyEngine(),
    private mode: PermissionMode = 'manual',
    /** 已登记 MCP 服务器名（源自 SUNSHINE.md「MCP 服务器」分区）；空 = mcp__ 工具全禁 */
    private mcpServers: string[] = [],
  ) {}

  preToolUse(tool: string, input: unknown): GuardDecision {
    const specifier = this.extractSpecifier(tool, input);
    const decision = this.policy.decide(tool, specifier);

    if (decision === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: deny 规则匹配' };
    if (tool === 'Bash' && this.isDestructiveCommand(specifier)) {
      return { allowed: false, reason: `COMMAND_DENIED: 破坏性命令被安全底线拦截：${specifier.slice(0, 80)}` };
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
        return { allowed: false, reason: `COMMAND_DENIED: MCP 服务器未登记，外部工具默认拒绝：${server || '(空)'}` };
      }
    }
    if (decision === 'allow') return { allowed: true };

    // decision === 'ask'
    // dontAsk：不询问用户，自动批准未 deny 的操作（deny 规则仍拦截），即「最大权限」
    if (this.mode === 'dontAsk') return { allowed: true };
    if (this.mode === 'plan') {
      if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') {
        return { allowed: false, reason: 'COMMAND_DENIED: plan 模式仅允许只读操作' };
      }
      return { allowed: true };
    }
    // manual 模式：只读白名单放行，其余 ask（阶段一 CLI 未实现交互，ask 视为放行只读、拒绝写）
    if (tool === 'Bash' && this.isReadonlyCommand(specifier)) return { allowed: true };
    if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return { allowed: true };
    return { allowed: false, ask: true, reason: 'COMMAND_DENIED: manual 模式需交互确认（阶段一未实现）' };
  }

  private asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 会话级 always 登记面（内存态；会话结束由调用方 clearSessionAllows，不落盘）。键经 allowKey 归一 */
  private sessionAllows = new Set<string>();

  /** 放行登记键：Bash 归一为命令族（首 token basename，放行 npm run build 即放行本会话 npm 族），其余工具用 subject 原样（path/url） */
  private allowKey(tool: string, subject: string): string {
    if (tool !== 'Bash') return subject;
    const first = subject.trim().split(/\s+/)[0] ?? '';
    return first.split('/').pop() ?? first;
  }
  private seq = 0;

  /** 终端化审批注入（TUI/GUI 装配点）；传 undefined 即卸载回阶段一语义 */
  setAsker(asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>): void {
    this.asker = asker;
  }

  clearSessionAllows(): void {
    this.sessionAllows.clear();
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
      id: `ap-${++this.seq}`,
      kind: tool === 'Bash' ? 'command' : tool.startsWith('mcp__') ? 'mcp' : tool === 'WebFetch' ? 'webfetch' : tool === 'WebSearch' ? 'websearch' : 'write',
      subject,
      reason: 'manual 模式需交互确认',
    };
    let d: ApprovalDecision;
    try {
      d = await this.asker(req);
    } catch (e) {
      return { allowed: false, reason: `COMMAND_DENIED: asker 异常（${e instanceof Error ? e.message : String(e)}）` };
    }
    if (d === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: 用户拒绝' };
    if (d === 'always') this.sessionAllows.add(this.allowKey(tool, subject));
    return { allowed: true };
  }

  /** 审批 subject 提取：Bash 取命令行，write 类取 path，webfetch 取 url */
  private approvalSubject(tool: string, input: unknown): string {
    if (tool === 'Bash') return this.extractSpecifier(tool, input);
    if (typeof input === 'object' && input !== null) {
      const p = (input as { path?: unknown }).path;
      if (typeof p === 'string') return p;
      const u = (input as { url?: unknown }).url;
      if (typeof u === 'string') return u;
      const q = (input as { query?: unknown }).query;
      if (typeof q === 'string') return q;
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
      return { allowed: false, reason: 'COMMAND_DENIED: WebFetch URL 非法' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: `COMMAND_DENIED: WebFetch 仅允许 http/https：${parsed.protocol}` };
    }
    return null;
  }

  /** websearch 卫生底线：判界对象是引擎端点（与 Provider 同源解析，见 websearch-endpoint）——端点非法或非 http/https 即拒 */
  private checkWebSearch(): GuardDecision | null {
    let parsed: URL;
    try {
      parsed = new URL(resolveWebSearchEndpoint());
    } catch {
      return { allowed: false, reason: 'COMMAND_DENIED: WebSearch 引擎端点非法' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: `COMMAND_DENIED: WebSearch 仅允许 http/https 端点：${parsed.protocol}` };
    }
    return null;
  }
}
