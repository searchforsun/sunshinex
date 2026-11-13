import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, FolderSearch, Globe, Hourglass, type LucideIcon } from 'lucide-react';
import { t } from '../../i18n';
import type { ChatEntry } from '../../chat-reducer';
/** G14.215 工具聚合行（用户裁决；2026-10-25 再裁定「聚合计数不小于 2」——单条（含运行中）恒原生
 *  行,第二个同类工具行出牌才成组,组头流光/计数随出牌实时递增;「编辑/写入行不聚合」不变）：同类型
 *  相邻工具行折为一条聚合头（「查阅了 N 次」形,N≥2）;点击展开=成员工具行平级铺开（成员即原生
 *  工具行,非嵌套壳——展开容器仅作高度动画用,零视觉盒子）;禁止重排——分组只在相邻段内做、
 *  成员保持出牌顺序,非同类行/思考行天然切断分组;编辑/写入行携 diff 统计与文件身份,恒独立
 *  不聚合（2026-10-22 用户裁定）。
 *  2026-11-13 用户裁定分组 taxonomy(「查阅 还是 执行…影响大的不能折叠,有交互的不能折叠」):
 *  - 查阅组 inspect=read/grep/glob/exec(kind='inspect' 显式声明)——「查阅了 N 次」
 *  - 网页搜索组 websearch=webfetch/websearch——「搜索了 N 次网页」
 *  - 等待组 wait=task_wait——「等待了 N 次任务」(不变)
 *  - **执行类 exec(kind='execute'/缺声明)不折叠**:产生副作用的命令影响大,每条独立原生行;
 *    类型由模型在调用时声明(schema kind 枚举),前端零文本猜测 */
export type ToolGroupKind = 'inspect' | 'websearch' | 'wait';

/** 聚合面工具清单（查阅/网页搜索/等待三类高频噪声行；spawn、task 系、ask 等语义行与编辑/写入行
 *  （携 diff 统计）与**执行类 exec** 保持独立不聚合） */
const GROUP_KIND_OF: Record<string, ToolGroupKind> = {
  read: 'inspect', grep: 'inspect', glob: 'inspect',
  webfetch: 'websearch', websearch: 'websearch',
  task_wait: 'wait',
};

const GROUP_META: Record<ToolGroupKind, { icon: LucideIcon; label: (n: number) => [string, string] }> = {
  inspect: { icon: FolderSearch, label: (n) => [`Inspected ×${n}`, `查阅了 ${n} 次`] },
  websearch: { icon: Globe, label: (n) => [`Searched the web ×${n}`, `搜索了 ${n} 次网页`] },
  wait: { icon: Hourglass, label: (n) => [`Waited on tasks ×${n}`, `等待了 ${n} 次任务`] },
};

/** 执行中判定(P11 与 ToolEntryView 折叠行同口径:三态 status 直读——md 占位判定退役) */
function executingOf(entry: ChatEntry): boolean {
  return entry.status === 'pending' || entry.status === 'running';
}

function groupKindOf(entry: ChatEntry): ToolGroupKind | undefined {
  if (entry.name === undefined) return undefined;
  if (entry.name === 'exec') {
    // exec 分组读**模型显式声明**(2026-11-13 用户裁定「让模型自己调用 exec 时指定类型」):schema
    // kind='inspect' 只读→并入查阅组;kind='execute' 或缺声明(旧档/旧调用)→不折叠(影响大者恒独立)
    const declared = entry.input !== undefined ? (entry.input as Record<string, unknown>).kind : undefined;
    return declared === 'inspect' ? 'inspect' : undefined;
  }
  return GROUP_KIND_OF[entry.name];
}

/** 段内相邻折叠节点：entry=思考/隐正文（切断相邻性），tool=单行（非聚合面/完成段计数 1），group=聚合 */
type SegNode =
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'tool'; entry: ChatEntry }
  | { type: 'group'; kind: ToolGroupKind; gkey: string; entries: ChatEntry[] };

/** 段内相邻折叠（纯函数，出牌顺序即成员顺序）：连续同类工具行 >1 折成组，其余保持单行。
 *  2026-10-25 用户裁定（替代「运行中段 1 条即成组」）：单条（含运行中）恒原生行——执行中单行
 *  自带流光标签；第二个同类工具行出牌才成组，聚合计数不小于 2 */
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

/** 聚合头锚定窗口（ms，覆盖 grid 0fr→1fr 高度过渡 --dur-relaxed=0.3s + 余量）：窗口内贴底跟随
 *  挂起（滚动容器 dataset.groupAnchor 旗，use-chat-scroll 贴底 effect 读），聚合头逐帧回钉视口位
 *  ——折叠/展开只动头下内容，头部视口位恒定（用户裁定：上侧不动、下侧工具行向上吸附） */
const ANCHOR_MS = 420;

/** P1 seg 逐位判等(Task 3):seg 数组每帧新身份,条目对象身份才是真身份——viewCache 契约
 *  (chat-reducer WeakMap)未变行引用恒定、内容变更行(key 同)换新对象,身份逐位相等即
 *  「成员集与内容双重未变」;closed 变化=折叠切换必须重渲;三个 render 回调引用由 MessageList
 *  ref 稳定化保证跨帧恒定——全等即整段 bail-out,段内成员行(renderTool 逐员执行)零重跑。
 *  (按 key 判等会把「运行中→完成」的内容更新一并 bail-out,错误——身份才是内容指纹) */
function segPropsEqual(prev: ToolSegBlockProps, next: ToolSegBlockProps): boolean {
  return prev.seg.length === next.seg.length
    && prev.seg.every((e, i) => e === next.seg[i])
    && prev.closed === next.closed
    && prev.renderTool === next.renderTool
    && prev.renderThinking === next.renderThinking
    && prev.renderAssistant === next.renderAssistant
    && prev.renderEntry === next.renderEntry;
}

interface ToolSegBlockProps {
  seg: ChatEntry[];
  closed: boolean;
  renderTool: (e: ChatEntry) => ReactNode;
  renderThinking: (e: ChatEntry) => ReactNode;
  renderAssistant: (e: ChatEntry) => ReactNode;
  /** 轮内插入用户条/成员消息等随折条目(缺省走 renderAssistant——ChatEntryView 可渲 notice) */
  renderEntry?: (e: ChatEntry) => ReactNode;
}

/** 会话折叠段块（Chat flushSeg 抽件，G14.73 seg-collapse 壳不变）：段内条目经 buildSegNodes 聚合——
 *  聚合头（图标+计数文案+chevron）点击展开/收起。2026-10-27 用户裁定:成组原地显示,不出现进入态
 *  过程(ghost 渐收行退役,防上下正文抖动)——组形成即最终形,无帧间过渡动画。
 *  P1 行级 memo(Task 3):segPropsEqual 逐位判等——token 帧重渲染时段块整体 bail-out */
export const ToolSegBlock = memo(function ToolSegBlock({
  seg,
  closed,
  renderTool,
  renderThinking,
  renderAssistant,
  renderEntry,
}: ToolSegBlockProps): JSX.Element {
  const nodes = buildSegNodes(seg);
  /** 展开态（聚合头点击）：gkey 集合——键含首成员 key，计数增长键不变、展开态跨渲染保持 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** 聚合头锚定 rAF 句柄（卸载清理；窗口自终止） */
  const anchorRafs = useRef<number[]>([]);
  /** 锚定中的滚动容器(2026-10-31 贴底不滚 bug 修复面):卸载清理时同步摘旗用——rAF 循环可被
   *  卸载打断(流式重排重键致组件换实例),旗留在 dataset 上则 use-chat-scroll 贴底 effect
   *  永久让位=「贴地时不自动往下滚」 */
  const anchorContainerRef = useRef<HTMLElement | null>(null);

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
    anchorContainerRef.current = container;
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

  useEffect(() => () => {
    for (const id of anchorRafs.current) cancelAnimationFrame(id);
    // 卸载破窗守卫:rAF 取消时同步摘旗——旗若残留,贴底跟随(每渲染归底 effect)永久让位
    // (2026-10-31 用户报障「贴地时不自动往下滚」根因:流式重排打断锚定循环,旗漏清)
    if (anchorContainerRef.current !== null) {
      delete anchorContainerRef.current.dataset.groupAnchor;
      anchorContainerRef.current = null;
    }
  }, []);

  return (
    <div className={`seg-collapse${closed ? '' : ' open'}`}>
      <div className="seg-inner">
        {nodes.map((n) => {
          if (n.type === 'entry') {
            if (n.entry.kind === 'thinking') return renderThinking(n.entry);
            if (n.entry.kind === 'assistant') return renderAssistant(n.entry);
            return (renderEntry ?? renderAssistant)(n.entry);
          }
          if (n.type === 'tool') return renderTool(n.entry);
          const isOpen = expanded.has(n.gkey);
          const meta = GROUP_META[n.kind];
          const Icon = meta.icon;
          const [en, zh] = meta.label(n.entries.length);
          // 任一成员在跑 = 组头流光（用户裁定:有一个文件显示运行中,折叠行即显流光状态）
          const executing = n.entries.some((e) => executingOf(e));
          return (
            <div key={n.gkey} className={`tool-group${executing ? ' executing' : ''}`}>
              <button
                type="button"
                className={`tool-group-head${isOpen ? ' open' : ''}`}
                aria-expanded={isOpen}
                onClick={(e) => toggleGroup(n.gkey, e.currentTarget)}
              >
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
                {/* key=计数：计数增长即重挂重播 pop 动画（语言切换不换 key 不重播）;运行中=流光文字 */}
                <span className="tool-group-label" key={n.entries.length}>
                  <span className={executing ? 'exec-running-text' : undefined}>{t(en, zh)}</span>
                </span>
                <ChevronRight className="tool-chev" size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {/* 成员平级铺开：透明网格容器仅作 0fr→1fr 高度动画（与 tool-body 同配方），零视觉嵌套 */}
              <div className={`tool-group-members${isOpen ? ' open' : ''}`} aria-hidden={!isOpen}>
                <div className="tool-group-members-inner">{n.entries.map((e) => renderTool(e))}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}, segPropsEqual);
