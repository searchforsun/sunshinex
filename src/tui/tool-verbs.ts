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

/** 工具 → 代表字段分派（spec §4.5）：按工具语义取 target，避免固定候选顺序误取 */
const TARGET_FIELD: Record<string, string> = {
  exec: 'command',
  read: 'path',
  write: 'path',
  grep: 'pattern',
  glob: 'pattern',
  webfetch: 'url',
  kb_search: 'query',
};

function extractTarget(tool: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const field = TARGET_FIELD[tool];
  let raw: string | undefined;
  if (field) {
    raw = strVal(obj[field]);
  } else {
    // 其它（含 mcp__*、未登记）按候选顺序尝试代表字段，找不到时回退 JSON 摘要
    const candidates: unknown[] = [obj.path, obj.pattern, obj.query, obj.url, obj.command];
    raw = candidates.find((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (!raw) {
    if (Object.keys(obj).length === 0) return '';
    return clip(JSON.stringify(input));
  }
  const one = tool === 'exec' ? raw.trim().split(/\s+/)[0] : raw.replace(/\s+/g, ' ').trim();
  return clip(one);
}

function strVal(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
