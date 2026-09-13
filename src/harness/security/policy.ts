import { PermissionDecision } from '../../types';
import { globMatch, parseRule } from './rules';

interface RuleEntry {
  decision: PermissionDecision;
  tool: string;
  specifier: string | null;
}

/** 三态权限规则引擎：deny → ask → allow 求值顺序，首个匹配生效 */
export class PolicyEngine {
  private deny: RuleEntry[] = [];
  private ask: RuleEntry[] = [];
  private allow: RuleEntry[] = [];

  add(decision: PermissionDecision, rule: string): void {
    const { tool, specifier } = parseRule(rule);
    const entry = { decision, tool, specifier };
    if (decision === 'deny') this.deny.push(entry);
    else if (decision === 'ask') this.ask.push(entry);
    else this.allow.push(entry);
  }

  decide(tool: string, specifier: string): PermissionDecision {
    for (const e of this.deny) if (this.matches(e, tool, specifier)) return 'deny';
    for (const e of this.ask) if (this.matches(e, tool, specifier)) return 'ask';
    for (const e of this.allow) if (this.matches(e, tool, specifier)) return 'allow';
    return 'ask';
  }

  private matches(e: RuleEntry, tool: string, specifier: string): boolean {
    if (e.tool !== tool && e.tool !== '*') return false;
    if (e.specifier === null || e.specifier === '*') return true;
    return globMatch(e.specifier, specifier);
  }
}
