import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from 'react';
import { t } from '../../i18n';
import { zoomScale } from '../../ui-zoom';
import type { Connection } from '../../connection';
import { applyChatEvent } from '../../chat-reducer';
import type { ChatEntry, ChatState } from '../../chat-reducer';

/** 轮次折叠簇(D32 第六批批F-5 自 Chat.tsx 平移,行为零变化):collapsedRuns/G14.136 段内中间
 *  正文折叠 hiddenKeys/G14.48 展开折叠防闪动校正/entry 面回调稳定化(G14.211)。 */
/** G14.31 轮次折叠:collapsedRuns=被封段的 Worked 行 key 集;hiddenKeys=折叠区间内的
 *  工具/思考行 key(用户气泡/回复/旁白保留)。G14.73:隐藏条目保持挂载,渲染层包进
 *  seg-collapse 平滑容器(展开/收合高度过渡),不再瞬切。
 *  G14.136 折叠不显非最终正文:段内 sealed assistant 除末条(=最终回复)外一并随轮折叠
 *  (phase 叙述/中间解释默认不露),展开轮时照常可见。
 *  G14.2xx b:投影抽纯函数单点——主对话 hook 与子智能体转录页(本地折叠态)同源消费 */
export function collapsedHiddenKeys(entries: readonly ChatEntry[], collapsedRuns: ReadonlySet<string>): ReadonlySet<string> {
  const s = new Set<string>();
  let hide = false;
  /** 段内 sealed assistant 收集:段收口(run 再启/流尽)时除末条外入 hidden */
  let segAssistants: string[] = [];
  const closeSeg = (): void => {
    if (hide) for (let i = 0; i < segAssistants.length - 1; i += 1) s.add(segAssistants[i]!);
    segAssistants = [];
  };
  for (const e of entries) {
    if (e.kind === 'run') {
      closeSeg();
      hide = collapsedRuns.has(e.key);
      continue;
    }
    if (e.kind === 'assistant') {
      if (e.streaming !== true) segAssistants.push(e.key); // 流式条即当前段末条(实况),不折
      continue;
    }
    if (e.kind === 'user') {
      closeSeg();
      continue;
    }
    if (hide && (e.kind === 'tool' || e.kind === 'thinking')) s.add(e.key);
  }
  closeSeg();
  return s;
}

/** 2026-10-24 用户裁定「完成后自动折叠工具/思考行」:sealed(封段,streaming 非 true)run key 集
 *  ——主对话与子智能体转录页两处消费方各持 autoFolded ref,仅首见封段时并入折叠集(用户手动
 *  展开不回折;会话重开/重放全量首见=历史轮一并折叠) */
function sealedRunKeys(entries: readonly ChatEntry[]): string[] {
  return entries.filter((e) => e.kind === 'run' && e.streaming !== true).map((e) => e.key);
}

/** 自动折叠共用 hook:sealed run 首见并入 collapsedRuns(ref 去重防手动展开被回折) */
export function useAutoCollapseRuns(
  entries: readonly ChatEntry[],
  setCollapsedRuns: Dispatch<SetStateAction<ReadonlySet<string>>>,
): void {
  const autoFoldedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const sealed = sealedRunKeys(entries).filter((k) => !autoFoldedRef.current.has(k));
    if (sealed.length === 0) return;
    for (const k of sealed) autoFoldedRef.current.add(k);
    setCollapsedRuns((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const k of sealed) {
        if (!next.has(k)) {
          next.add(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entries, setCollapsedRuns]);
}

export function useChatFold(deps: {
  readonly chat: ChatState;
  readonly setChat: Dispatch<SetStateAction<ChatState>>;
  readonly conn: Connection;
  readonly sessionId: string;
  readonly onOpenDiff?: (callId: string, path: string) => void;
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly chatStickRef: MutableRefObject<boolean>;
}): {
  collapsedRuns: ReadonlySet<string>;
  toggleRun: (key: string) => void;
  hiddenKeys: ReadonlySet<string>;
  onEntryToggleClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onEntryOpenDiff: (p: string) => void;
  onEntryRestore: (p: string) => void;
} {
  const { chat, setChat, conn, sessionId, onOpenDiff, chatScrollRef, chatStickRef } = deps;
/** G14.31 轮次折叠:collapsedRuns=被封段的 Worked 行 key 集;hiddenKeys=折叠区间内的
 *  工具/思考行 key(用户气泡/回复/旁白保留)。G14.73:隐藏条目保持挂载,渲染层包进
 *  seg-collapse 平滑容器(展开/收合高度过渡),不再瞬切。
 *  G14.136 折叠不显非最终正文:段内 sealed assistant 除末条(=最终回复)外一并随轮折叠
 *  (phase 叙述/中间解释默认不露),展开轮时照常可见 */
const [collapsedRuns, setCollapsedRuns] = useState<ReadonlySet<string>>(new Set());
// 2026-10-24 用户裁定:轮次完成(sealed)自动折叠工具/思考行——手动展开不回折
useAutoCollapseRuns(chat.entries, setCollapsedRuns);
const toggleRun = useCallback((key: string): void => {
  setCollapsedRuns((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}, []);
const hiddenKeys = useMemo(() => collapsedHiddenKeys(chat.entries, collapsedRuns), [chat.entries, collapsedRuns]);

/** G14.48 展开/折叠不闪动:贴地(阅读位在底)→ 钉底,内容整体上移;未贴地 → 锚定被点行,
 *  内容整体下移——两侧永不同时动。capture 先于行内 toggle 记 preTop,动画收尾后再校正一次;
 *  原生 scroll-anchor 关闭(overflow-anchor:none)防与本校正互搏 */
const onEntryToggleClick = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
  const target = e.target instanceof Element ? e.target.closest('.thinking-summary, .tool-summary, .entry-run.sealed') : null;
  const row = target !== null ? target.closest('.entry') : null;
  const el = chatScrollRef.current;
  if (target === null || row === null || el === null) return;
  el.style.overflowAnchor = 'none'; // G14.211 校正窗口内关原生锚定(防互搏),收窗即还原恒 auto
  const preTop = row.getBoundingClientRect().top;
  const stick = chatStickRef.current;
  // G14.64:贴地时贯穿整个展开/收合动画(0.22s grid)逐帧钉底——单次校正会让视口随动画
  // 增高先下滑、兜底再上跳;未贴地锚定被点行(行自身展开,行顶不动,单次校正已足)
  const restore = (): void => {
    if (stick) {
      const t0 = performance.now();
      const pin = (): void => {
        el.scrollTop = el.scrollHeight;
        if (performance.now() - t0 < 300) requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
      return;
    }
    if (!row.isConnected) return;
    el.scrollTop += (row.getBoundingClientRect().top - preTop) / zoomScale(); // gBCR 视觉差→scrollTop 本地空间
  };
  requestAnimationFrame(restore);
  if (!stick) setTimeout(restore, 240); // 0.22s grid 动画收尾后再校正一次(非贴地路径)
  setTimeout(() => { el.style.overflowAnchor = ''; }, 320);
}, []);
/** G14.211 entry 面回调稳定化(memo 生效前提):内联闭包每次渲染换新,任一 prop 变即
 *  全量 entry 重渲染——点一次文件=整列表闪帧(正文抖动源之一) */
const onEntryOpenDiff = useCallback((p: string): void => { onOpenDiff?.('', p); }, [onOpenDiff]);
const onEntryRestore = useCallback((p: string): void => {
  conn.restoreChange(sessionId, p).catch(() => {
    setChat((c) => applyChatEvent(c, { type: 'error', text: t('Revert failed', '撤销失败'), ts: Date.now() }));
  });
}, [conn, sessionId]);
  return { collapsedRuns, toggleRun, hiddenKeys, onEntryToggleClick, onEntryOpenDiff, onEntryRestore };
}
