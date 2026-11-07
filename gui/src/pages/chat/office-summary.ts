/**
 * 办公模式工具行动词头(ui-mode.ts 语境):非跳转工具行不显命令/目标原文,只显类动词——
 * 「查询了文件」「执行了命令」「搜索了网页」;未归类工具(MCP/技能/等待等)保留本地化工具名。
 */
import { t } from '../../i18n';
import { zhToolName } from './tool-entry-data';

const CATEGORY_LABEL: Record<string, () => string> = {
  read: () => t('Searched files', '查询了文件'),
  grep: () => t('Searched files', '查询了文件'),
  glob: () => t('Searched files', '查询了文件'),
  exec: () => t('Ran a command', '执行了命令'),
  websearch: () => t('Searched the web', '搜索了网页'),
  webfetch: () => t('Fetched a web page', '抓取了网页'),
};

export function officeSingleLabel(name: string): string {
  return CATEGORY_LABEL[name]?.() ?? zhToolName(name);
}
