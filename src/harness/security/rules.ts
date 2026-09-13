/** glob 转正则（支持 * 与 ?） */
export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp('^' + globToRegex(pattern) + '$');
  return re.test(s);
}

function globToRegex(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegExp(ch);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 解析 "Tool(specifier)" 规则 */
export function parseRule(rule: string): { tool: string; specifier: string | null } {
  const m = /^(\w+)\((.*)\)$/.exec(rule.trim());
  if (m) return { tool: m[1], specifier: m[2] || null };
  return { tool: rule.trim(), specifier: null };
}
