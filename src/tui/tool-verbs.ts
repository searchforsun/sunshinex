/** 工具动词映射（英文步骤标识）：已登记工具映射为英文动词，未登记工具大写原名，MCP 工具统一 MCP */
const VERBS: Record<string, string> = {
  exec: 'EXEC',
  read: 'READ',
  write: 'WRITE',
  grep: 'GREP',
  glob: 'GLOB',
  webfetch: 'FETCH',
  kb_search: 'SEARCH',
};

/** 工具调用行文本：`VERB target`（无 target 时仅 VERB）；exec 取命令首段，其余取代表字段并截断 60 字符 */
export function toolCallLine(tool: string, input: unknown): string {
  const verb = tool.startsWith('mcp__') ? 'MCP' : (VERBS[tool] ?? tool.toUpperCase());
  const target = extractTarget(tool, input);
  return target ? `${verb} ${target}` : verb;
}

function extractTarget(tool: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const candidates = [obj.path, obj.pattern, obj.query, obj.url, obj.command];
  const raw = candidates.find((v) => typeof v === 'string' && v.length > 0) as string | undefined;
  if (!raw) {
    if (Object.keys(obj).length === 0) return '';
    return clip(JSON.stringify(input));
  }
  const one = tool === 'exec' ? raw.trim().split(/\s+/)[0] : raw.replace(/\s+/g, ' ').trim();
  return clip(one);
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
