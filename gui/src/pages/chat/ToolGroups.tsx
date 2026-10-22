import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, FolderSearch, Hourglass, PenLine, SquareTerminal, type LucideIcon } from 'lucide-react';
import { t } from '../../i18n';
import type { ChatEntry } from '../../chat-reducer';

/** G14.215 工具聚合行（用户裁决）：同类型相邻已完成工具行 >1 折为一条聚合头（「查询了 N 次文件」形），
 *  点击展开=成员工具行平级铺开（成员即原生工具行，非嵌套壳——展开容器仅作高度动画用，零视觉盒子）；
 *  运行中不进组——执行完成后才归入上方同类聚合行（ghost 渐收动画，到点卸载）；禁止重排——
 *  分组只在相邻段内做、成员保持出牌顺序，非同类行/思考行天然切断分组 */
export type ToolGroupKind = 'query' | 'edit' | 'exec' | 'wait';

/** 聚合面工具清单（四类高频噪声行；spawn、task 系、ask 等语义行保持独立不聚合） */
const GROUP_KIND_OF: Record<string, ToolGroupKind> = {
  read: 'query', grep: 'query', glob: 'query',
  write: 'edit',
  exec: 'exec',
  task_wait: 'wait',
};

const GROUP_META: Record<ToolGroupKind, { icon: LucideIcon; label: (n: number) => [string, string] }> = {
  query: { icon: FolderSearch, label: (n) => [`Queried files ×${n}`, `查询了 ${n} 次文件`] },
  edit: { icon: PenLine, label: (n) => [`Edited files ×${n}`, `编辑了 ${n} 次文件`] },
  exec: { icon: SquareTerminal, label: (n) => [`Ran commands ×${n}`, `执行了 ${n} 次命令`] },
  wait: { icon: Hourglass, label: (n) => [`Waited on tasks ×${n}`, `等待了 ${n} 次任务`] },
};

/** 执行中判定(P11 与 ToolEntryView 折叠行同口径:三态 status 直读——md 占位判定退役) */
function executingOf(entry: ChatEntry): boolean {
  return entry.status === 'pending' || entry.status === 'running';
}

function groupKindOf(entry: ChatEntry): ToolGroupKind | undefined {
  if (executingOf(entry)) return undefined; // 运行中不进组（完成后的重建帧才可归组）
  return entry.name === undefined ? undefined : GROUP_KIND_OF[entry.name];
}

/** 段内相邻折叠节点：entry=思考/隐正文（切断相邻性），tool=单行（执行中/非聚合面/计数 1），group=聚合 */
type SegNode =
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'tool'; entry: ChatEntry }
  | { type: 'group'; kind: ToolGroupKind; gkey: string; entries: ChatEntry[] };

/** 段内相邻折叠（纯函数，出牌顺序即成员顺序）：连续同类已完成工具行 >1 折成组，其余保持单行 */
export function buildSegNodes(seg: ChatEntry[]): SegNode[] {
  const nodes: SegNode[] = [];
  let open: { kind: ToolGroupKind; entries: ChatEntry[] } | null = null;
  const flush = (): void => {
    if (open === null) return;
    if (open.entries.length > 1) {
      nodes.push({ type: 'group', kind: open.kind, gkey: `group:${open.kind}:${open.entries[0]!.key}`, entries: open.entries });
    } else {
      nodes.push({ type: 'tool', entry: open.entries[0]! });
    }
    open = null;
  };
  for (const entry of seg) {
    if (entry.kind !== 'tool') {
      flush();
      nodes.push({ type: 'entry', entry });
      continue;
    }
    const kind = groupKindOf(entry);
    if (kind !== undefined && open !== null && open.kind === kind) {
      open.entries.push(entry);
      continue;
    }
    flush();
    if (kind !== undefined) open = { kind, entries: [entry] };
    else nodes.push({ type: 'tool', entry });
  }
  flush();
  return nodes;
}

/** ghost 渐收时长（CSS tool-merge-up 0.36s + 卸载余量） */
const GHOST_MS = 420;

/** 聚合头锚定窗口（ms，覆盖 grid 0fr→1fr 高度过渡 --dur-relaxed=0.3s + 余量）：窗口内贴底跟随
 *  挂起（滚动容器 dataset.groupAnchor 旗，use-chat-scroll 贴底 effect 读），聚合头逐帧回钉视口位
 *  ——折叠/展开只动头下内容，头部视口位恒定（用户裁定：上侧不动、下侧工具行向上吸附） */
const ANCHOR_MS = 420;

/** 会话折叠段块（Chat flushSeg 抽件，G14.73 seg-collapse 壳不变）：段内条目经 buildSegNodes 聚合——
 *  聚合头（图标+计数文案+chevron）点击展开/收起；归并动画=上一帧单行/执行中、本帧成组员的条目
 *  在组尾渲染渐收 ghost（挂载即播收合动画，到点卸载；首帧/种子回放批量落位不动画） */
export function ToolSegBlock({
  seg,
  closed,
  renderTool,
  renderThinking,
  renderAssistant,
}: {
  seg: ChatEntry[];
  closed: boolean;
  renderTool: (e: ChatEntry) => ReactNode;
  renderThinking: (e: ChatEntry) => ReactNode;
  renderAssistant: (e: ChatEntry) => ReactNode;
}): JSX.Element {
  const nodes = buildSegNodes(seg);
  /** 展开态（聚合头点击）：gkey 集合——键含首成员 key，计数增长键不变、展开态跨渲染保持 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** 归并 ghost（渐收行）：帧间 diff 得出，到点移除；上限 3 防大批量落位堆积 */
  const [ghosts, setGhosts] = useState<ChatEntry[]>([]);
  const ghostTimers = useRef<number[]>([]);
  /** 上一帧条目态快照（key → 执行中/单行/组员）：null=首帧不动画 */
  const prevStates = useRef<Map<string, 'executing' | 'standalone' | 'member'> | null>(null);
  /** 聚合头锚定 rAF 句柄（卸载清理；窗口自终止） */
  const anchorRafs = useRef<number[]>([]);

  /** 聚合头锚定 toggle（用户裁定「上侧不动、下侧向上吸附」）：记点击时头钮视口位，展开/收合后
   *  逐帧把头钮差值回钉到滚动容器——头在动画区上方，布局本身不动它，动的只有贴底跟随的
   *  scrollTop 写入（同渲染的贴底 effect）与原生滚动锚定；窗口内挂起贴底（dataset 旗）+逐帧
   *  回钉即稳。窗口后旗自摘，贴底语义交还 onScroll 距底判定（锚定后不再贴底=放手，正解） */
  const toggleGroup = (gkey: string, headEl: HTMLButtonElement): void => {
    const container = headEl.closest<HTMLElement>('.chat');
    const before = headEl.getBoundingClientRect().top;
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(gkey)) next.delete(gkey);
      else next.add(gkey);
      return next;
    });
    if (container === null) return;
    container.dataset.groupAnchor = '1';
    const t0 = Date.now();
    const step = (): void => {
      const delta = headEl.getBoundingClientRect().top - before;
      if (delta !== 0) container.scrollTop += delta;
      if (Date.now() - t0 < ANCHOR_MS) {
        anchorRafs.current.push(requestAnimationFrame(step));
      } else {
        delete container.dataset.groupAnchor;
      }
    };
    anchorRafs.current.push(requestAnimationFrame(step));
  };

  useLayoutEffect(() => {
    const cur = new Map<string, 'executing' | 'standalone' | 'member'>();
    for (const n of nodes) {
      if (n.type === 'group') for (const e of n.entries) cur.set(e.key, 'member');
      else if (n.type === 'tool') cur.set(n.entry.key, executingOf(n.entry) ? 'executing' : 'standalone');
    }
    const prev = prevStates.current;
    prevStates.current = cur;
    if (prev === null) return;
    const merged: ChatEntry[] = [];
    for (const n of nodes) {
      if (n.type !== 'group') continue;
      for (const e of n.entries) {
        const was = prev.get(e.key);
        if ((was === 'executing' || was === 'standalone') && cur.get(e.key) === 'member') merged.push(e);
      }
    }
    if (merged.length === 0) return;
    setGhosts((g) => [...g.filter((x) => !merged.some((m) => m.key === x.key)), ...merged].slice(-3));
    for (const m of merged) {
      ghostTimers.current.push(window.setTimeout(() => setGhosts((g) => g.filter((x) => x.key !== m.key)), GHOST_MS));
    }
    // 无依赖：每帧 diff（nodes 随渲染重建，无稳定引用可依赖）
  });
  useEffect(() => () => {
    for (const id of ghostTimers.current) clearTimeout(id);
    for (const id of anchorRafs.current) cancelAnimationFrame(id);
  }, []);

  /** 各组的 ghost（组尾渐收行）：按成员归属分流 */
  const ghostsOf = (n: SegNode & { type: 'group' }): ChatEntry[] => ghosts.filter((g) => n.entries.some((e) => e.key === g.key));

  return (
    <div className={`seg-collapse${closed ? '' : ' open'}`}>
      <div className="seg-inner">
        {nodes.map((n) => {
          if (n.type === 'entry') {
            return n.entry.kind === 'thinking' ? renderThinking(n.entry) : renderAssistant(n.entry);
          }
          if (n.type === 'tool') return renderTool(n.entry);
          const isOpen = expanded.has(n.gkey);
          const meta = GROUP_META[n.kind];
          const Icon = meta.icon;
          const [en, zh] = meta.label(n.entries.length);
          return (
            <div key={n.gkey} className="tool-group">
              <button
                type="button"
                className={`tool-group-head${isOpen ? ' open' : ''}`}
                aria-expanded={isOpen}
                onClick={(e) => toggleGroup(n.gkey, e.currentTarget)}
              >
                <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
                {/* key=计数：计数增长即重挂重播 pop 动画（语言切换不换 key 不重播） */}
                <span className="tool-group-label" key={n.entries.length}>{t(en, zh)}</span>
                <ChevronRight className="tool-chev" size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {/* 成员平级铺开：透明网格容器仅作 0fr→1fr 高度动画（与 tool-body 同配方），零视觉嵌套 */}
              <div className={`tool-group-members${isOpen ? ' open' : ''}`} aria-hidden={!isOpen}>
                <div className="tool-group-members-inner">{n.entries.map((e) => renderTool(e))}</div>
              </div>
              {ghostsOf(n).map((g) => (
                <div key={`ghost:${g.key}`} className="tool-ghost">
                  <div className="tool-ghost-clip">{renderTool(g)}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
