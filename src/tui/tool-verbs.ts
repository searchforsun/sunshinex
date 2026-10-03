import { t } from '../i18n';
import type { ToolDisplayMeta } from '../harness/tools';

/** 工具呈现层（D26/J1 收敛为消费者）：动词/代表字段不再本文件硬编码，随工具注册表 display 元数据
 *  经 setToolDisplayMeta 装配期注入（产线接线 tui/runtime createRuntime）——harness 增改工具时
 *  呈现零跟表。本文件保留：注入注入口、fallback（未登记工具大写原名 + 候选字段序）、extractTarget
 *  的平台工具特殊 target 分支（多字段格式无法以 targetFields 表达）。 */

/** 装配期注入的呈现表（模块级单例）：缺省空表 = 纯 fallback（对齐现状中未登记工具的降级） */
let injectedMeta: Record<string, ToolDisplayMeta> = {};

/** 呈现表注入口（createRuntime 取得 harness 后、SessionController 构造前调用） */
export function setToolDisplayMeta(meta: Record<string, ToolDisplayMeta>): void {
  injectedMeta = meta;
  // 动词集合随表重建（导出绑定不变，组件零改动）：archived detail 行分流判据与注入表同步
  toolVerbs.clear();
  for (const m of Object.values(meta)) toolVerbs.add(m.verb);
}

/** 动词集合（呈现层判据复用）：archived detail 行按首词是否工具动词分流 call/text（ChildInspector 同构渲染）；
 *  导出绑定保持只读视图（组件零改动），内容随 setToolDisplayMeta 注入重建，缺省空集 = 未装配态（分类回落正文） */
const toolVerbs: Set<string> = new Set<string>();
export const TOOL_VERBS: ReadonlySet<string> = toolVerbs;

/** 工具调用行文本：`VERB target`（无 target 时仅 VERB）；动词取注入表 ?? 大写原名，MCP 工具统一 MCP；
 *  exec 取命令首段，其余取代表字段——零截断，超宽由呈现层按列宽自然省略 */
export function toolCallLine(tool: string, input: unknown): string {
  const meta = injectedMeta[tool];
  const verb = tool.startsWith('mcp__') ? 'MCP' : (meta?.verb ?? tool.toUpperCase());
  const target = extractTarget(tool, input, meta);
  return target ? `${verb} ${target}` : verb;
}

/** spawn 调用关联基名（规格 §4.4，D26/J1 收敛单点）：label ?? agent_id ?? 'subagent'
 *  （与 Runner 解析同源；消歧后缀不含入内）——extractTarget 的 spawn 分支与 chat-model 转发导出共用 */
export function spawnBaseLabel(input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return strVal(obj.label) ?? strVal(obj.agent_id) ?? 'subagent';
}

/** 工具 → target 分派（spec §4.5）：按工具语义取 target，避免固定候选顺序误取 */
function extractTarget(tool: string, input: unknown, meta: ToolDisplayMeta | undefined): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (tool === 'spawn') {
    // spawn target = 关联基名（规格 §6 调用行口径）
    return spawnBaseLabel(obj);
  }
  if (tool === 'todo_write') {
    const arr = Array.isArray(obj.todos) ? (obj.todos as unknown[]) : [];
    return `${arr.length} items`;
  }
  if (tool === 'task_wait') {
    // 平台专属工具（§87 另册）的可读 target（2026-09-30 用户裁决：参数不再以裸 JSON 兜底直出）：
    // taskIds 逗号连接（null=全部 running 任务），timeoutSeconds 尾追
    const ids = Array.isArray(obj.taskIds)
      ? (obj.taskIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0).join(',')
      : '';
    const timeout = typeof obj.timeoutSeconds === 'number' ? ` · ${obj.timeoutSeconds}s` : '';
    const base = ids.length > 0 ? ids : t('all running', '全部 running');
    return `${base}${timeout}`;
  }
  if (tool === 'task_stop') {
    return strVal(obj.taskId) ?? '';
  }
  const fields = meta?.targetFields;
  let raw: string | undefined;
  if (fields !== undefined) {
    // 已声明代表字段（注册表 display 下泄）：按声明序取首个非空字符串
    for (const field of fields) {
      raw = strVal(obj[field]);
      if (raw !== undefined) break;
    }
  } else {
    // 未登记/未声明代表字段（含 mcp__*）按候选顺序尝试代表字段，找不到时回退 JSON 摘要
    const candidates: unknown[] = [obj.path, obj.pattern, obj.query, obj.url, obj.command];
    raw = candidates.find((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (!raw) {
    if (Object.keys(obj).length === 0) return '';
    return JSON.stringify(input);
  }
  const one = raw.replace(/\s+/g, ' ').trim();
  return one;
}

function strVal(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
