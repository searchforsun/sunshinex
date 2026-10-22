import { useEffect } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { shortLocalTime } from '../ui-util';
import { t } from '../i18n';

/** ProjectMenu 纯助手层（D32 中口径件批 PM-1 平移源,行为零变化）:
 *  模糊匹配/添加工作区图标/已读持久化/显示名与统计行/工作区可见性。 */

/** G14.75 模糊匹配:大小写不敏感子序列(字符依次命中即过);空查询恒真 */
export function fuzzyHit(text: string, query: string): boolean {
  if (query.trim() === '') return true;
  let i = 0;
  const t = text.toLowerCase();
  for (const ch of query.trim().toLowerCase()) {
    i = t.indexOf(ch, i);
    if (i < 0) return false;
    i += 1;
  }
  return true;
}

/** 添加工作区图标(2026-10-22 用户裁定:参考 deepseek-ai/deepseek-harness 的新增项目实现——
 *  纯加号语言,packages/client/ui-primitives IconPlusOutlineRegular 16 盒 M8 2V14/M2 8H14;
 *  此处 24 盒同构对齐本仓 lucide stroke 体系,文件夹形退役) */
export function FolderAddIcon({ size = 16, strokeWidth = 1.75 }: { size?: number; strokeWidth?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v16" />
      <path d="M4 12h16" />
    </svg>
  );
}

/** G14.195 已读会话持久化(localStorage `sunshinex.seen-sessions`):id → 最近已读 updatedAt。
 *  刷新不再全员亮蓝点(原内存 Set「本次运行内」即清空);行 updatedAt 新于已读时刻即重新视为
 *  未读(真·未读)。容量封顶 200(超出丢最旧),存储满/禁用静默。 */
const SEEN_KEY = 'sunshinex.seen-sessions';
export type SeenMap = Record<string, number>;
export function loadSeenMap(): SeenMap {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) return {};
    const obj = JSON.parse(raw) as SeenMap;
    return obj !== null && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
export function persistSeenMap(m: SeenMap): void {
  try {
    const entries = Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 存储满/禁用:静默 */
  }
}

/** 遗留档(无 root)显示名:去尾部 hash、dash→空格——slug 是给机器的,人读的是路径词 */
function legacyName(slug: string): string {
  return slug.replace(/-[0-9a-f]{8}$/i, '').replace(/-/g, ' ');
}

/** G14.115 RECENTS 分页显形:默认 10 条(约近 3 天窗),「显示更多」步进 10,上限=全量;收起复位 */
export const RECENT_VISIBLE_DEFAULT = 10;
export const RECENT_VISIBLE_STEP = 10;

/** 会话统计行(G14.17 回溯面):旁车 meta 有几段拼几段——轮/步/tokens/缓存/上文占比/模型·档位/
 *  建档时刻;RECENTS 与搜索行 tooltip 消费,空 meta 返回 ''(行 tooltip 退化为标题+id) */
export function sessionMetaLine(r: SessionRow & { root: string; slug: string }): string {
  // G14.106 会话行 tooltip 收敛两行:会话名称(调用方拼)+「N 轮 M 步 · 创建于 时间」——
  // tokens/缓存/上文/模型/孤立 id 等全家桶退役
  const parts: string[] = [];
  if (r.runs !== undefined) parts.push(t(`${r.runs} run${r.runs === 1 ? '' : 's'}`, `${r.runs} 轮`));
  if (r.steps !== undefined) parts.push(t(`${r.steps} step${r.steps === 1 ? '' : 's'}`, `${r.steps} 步`));
  if (r.createdAt !== undefined) parts.push(t(`created ${shortLocalTime(r.createdAt)}`, `创建于 ${shortLocalTime(r.createdAt)}`));
  return parts.join(' · ');
}

/** 工作区显示名:真实项目目录名(basename),路径 slug 仅兜底/悬浮(2026-10-08 可读性裁定:
 *  路径 slug「D-project-bi-mammoth-internal-410e80d4」换行破碎不可读——目录名才是用户心智的项目名) */
/** default 锚点唯一化(G14.10):临时锚 <tmp>/sunshinex-default 在场时,旧仓库内 default
 *  工作区行隐藏(目录与历史会话保留,RECENTS/搜索仍可达)——两个「default」行只示其一 */
export function visibleWorkspaces(rows: WorkspaceRow[]): WorkspaceRow[] {
  const baseOf = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? '';
  // G14.34:默认锚点工作区(sunshinex-default,非项目会话的落点)不再入 PROJECTS 列表——
  // 其会话仍经 RECENTS 可达(attach 只需 root/slug,与工作区行在场与否无关)
  return rows.filter((r) => {
    if (r.root === undefined) return true;
    const base = baseOf(r.root);
    if (base === 'sunshinex-default') return false; // G14.34:默认锚点不入 PROJECTS(会话走 RECENTS)
    return true;
  });
}

export function wsName(row: { root?: string; slug: string }): string {
  if (row.root !== undefined && row.root !== '') {
    const base = row.root.split(/[\\/]/).filter(Boolean).pop();
    if (base !== undefined && base !== '') return base;
  }
  return legacyName(row.slug);
}

/** 行内「确认」morph 点外部取消(2026-10-21 用户裁定:归档/删除二次确认,点击其他地方即取消):
 *  confirmId 非空时挂 document mousedown——点击落在确认行(data-row-id=confirmId)外即清;
   mousedown 先于 click,点他行「归档/删除」时先取消旧再入列新,时序自洽。三面共用
   (归档层删除/项目组行归档/最近会话行归档) */
export function useConfirmOutsideCancel(confirmId: string, cancel: () => void): void {
  useEffect(() => {
    if (confirmId === '') return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target.closest(`[data-row-id="${confirmId}"]`) : null;
      if (target !== null) return; // 确认行内点击(含「确认」钮本体)不取消
      cancel();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [confirmId, cancel]);
}
