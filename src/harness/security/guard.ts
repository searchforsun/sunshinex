import { PolicyEngine } from './policy';
import { READONLY_WHITELIST, PermissionMode } from './modes';

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/** PreToolUse 决策点（enforcement 层） */
export class SecurityGuard {
  constructor(
    private policy: PolicyEngine = new PolicyEngine(),
    private mode: PermissionMode = 'manual',
  ) {}

  preToolUse(tool: string, input: unknown): GuardDecision {
    const specifier = this.extractSpecifier(tool, input);
    const decision = this.policy.decide(tool, specifier);

    if (decision === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: deny 规则匹配' };
    if (decision === 'allow') return { allowed: true };

    // decision === 'ask'
    if (this.mode === 'dontAsk') return { allowed: false, reason: 'COMMAND_DENIED: dontAsk 模式拒绝未批准操作' };
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
}
