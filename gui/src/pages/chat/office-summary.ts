/**
 * 办公模式工具行动词头(ui-mode.ts 语境):非跳转工具行不显命令/目标原文,只显类动词——
 * 「查询了文件」「执行了命令」「搜索了网页」;内置电脑/浏览器插件工具显本地化名(截屏/点击…),
 * 接入的第三方 MCP 显「执行了 工具名」;其余(技能/等待等)保留本地化工具名。参数一律不显。
 */
import { t } from '../../i18n';
import { MCP_TOOL_LABELS, mcpToolParts, zhToolName } from './tool-entry-data';

const CATEGORY_LABEL: Record<string, () => string> = {
  read: () => t('Searched files', '查询了文件'),
  grep: () => t('Searched files', '查询了文件'),
  glob: () => t('Searched files', '查询了文件'),
  exec: () => t('Ran a command', '执行了命令'),
  websearch: () => t('Searched the web', '搜索了网页'),
  webfetch: () => t('Fetched a web page', '抓取了网页'),
  task_wait: () => t('Waited for tasks', '等待了任务'),
};

export function officeSingleLabel(name: string): string {
  const mcp = mcpToolParts(name);
  if (mcp !== null && MCP_TOOL_LABELS[mcp.tool] === undefined) return t(`Ran ${mcp.tool}`, `执行了 ${mcp.tool}`);
  return CATEGORY_LABEL[name]?.() ?? zhToolName(name);
}
