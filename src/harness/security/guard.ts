import { PolicyEngine } from './policy';
import { READONLY_WHITELIST, PermissionMode, DESTRUCTIVE_COMMANDS, DESTRUCTIVE_PIPE } from './modes';

export type GuardDecision =
  | { allowed: true; safePath?: string }
  | { allowed: false; reason: string };

/** PreToolUse 决策点（enforcement 层） */
export class SecurityGuard {
  constructor(
    private policy: PolicyEngine = new PolicyEngine(),
    private mode: PermissionMode = 'manual',
    /** webfetch 域名白名单（源自 SUNSHINE.md「网络白名单」分区）；空 = 全禁（缺省安全） */
    private webAllowlist: string[] = [],
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
    return { allowed: false, reason: 'COMMAND_DENIED: manual 模式需交互确认（阶段一未实现）' };
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

  /** webfetch 三重闸门：URL 合法 → 仅 http/https → 域名白名单（空 = 全禁）；返回拒绝决策，放行返回 null */
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
    if (!this.webAllowlist.includes(parsed.hostname)) {
      return { allowed: false, reason: `COMMAND_DENIED: WebFetch 域名不在白名单：${parsed.hostname}` };
    }
    return null;
  }
}
