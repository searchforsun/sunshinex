import type { MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import type { Connection } from '../../connection';
import { fmtTokens as fmtTokensShared } from '../../ui-util';
import { groupEntriesByDay } from '../../chat-groups';
import type { ChatEntry } from '../../chat-reducer';
function fmtTokens(n: number): string {
  return fmtTokensShared(n);
}

/** D48 尾部窗口:会话流只全量渲染尾部窗口条目,更早条目折叠为头部「显示更早」行渐进回放
 *  (对齐主仓 TUI tail-rewrite 上限口径;立项与切点回退设计见 docs/superpowers/plans/
 *  2026-10-23-messagelist-tail-window.md) */
const RENDER_WINDOW_DEFAULT = 300;
const RENDER_WINDOW_STEP = 300;
import { ChatEntryView, RunEntryView, ThinkingEntryView, UserEntryView } from './EntryViews';
import { ToolEntryView } from './ToolEntry';
import { ToolSegBlock } from './ToolGroups';

/** 会话流列表(D32 第六批批F-3 自 Chat.tsx 平移,行为零变化):空态/按日分组/段折叠聚合
 *  (ToolSegBlock)/run·user·assistant 行派发/运行状态行。滚动容器 ref 与贴底旁路 ref 留宿主
 *  (归底 effects 消费),onScroll 存档逻辑留宿主经 props 注入;P11 T7 起 tool 行全走 entry
 *  字段(callIdOf 寻址注入保留,info 旁路注入退役)。 */
export interface MessageListProps {
  readonly entries: ChatEntry[];
  readonly hiddenKeys: ReadonlySet<string>;
  readonly callIdOf: (entry: ChatEntry) => string | undefined;
  readonly conn: Connection;
  readonly sessionId: string;
  readonly onOpenFile?: (p: string) => void;
  readonly onOpenDiff?: (callId: string, p: string) => void;
  readonly onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  readonly onOpenTask?: (ref: string) => void;
  readonly taskNameOf: (id: string) => string;
  readonly collapsedRuns: ReadonlySet<string>;
  readonly toggleRun: (key: string) => void;
  readonly submitText: (text: string) => Promise<void>;
  readonly runFooterByEntry: ReadonlyMap<string, ChatEntry>;
  readonly onEntryOpenDiff: (p: string) => void;
  readonly onEntryRestore: (p: string) => void;
  readonly onFork?: () => void;
  readonly onEntryToggleClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
  readonly chatScrollRef: MutableRefObject<HTMLElement | null>;
  readonly onScroll: (e: { currentTarget: HTMLElement }) => void;
  /** G14.2xx 辅助对话空态文案(sidechat 页签) */
  readonly sideChat?: boolean;
  readonly running: boolean;
  readonly liveSteps: number;
  readonly liveTokens: number;
}

export function MessageList(props: MessageListProps): JSX.Element {
  const { entries, hiddenKeys, callIdOf, conn, sessionId, onOpenFile, onOpenDiff, onOpenAgent, onOpenTask, taskNameOf, collapsedRuns, toggleRun, submitText, runFooterByEntry, onEntryOpenDiff, onEntryRestore, onFork, onEntryToggleClick, chatScrollRef, onScroll, running, liveSteps, liveTokens, sideChat } = props;
  /** D48 尾部窗口:窗口外更早条目折叠为头部「显示更早」行;切点回退见下方 */
  const [visibleCount, setVisibleCount] = useState(RENDER_WINDOW_DEFAULT);
  /** 渐进回放视口锚定:展开前记 (scrollHeight, scrollTop),新内容渲染后按高度增量回钉——用户视口不动 */
  const expandAnchorRef = useRef<{ h: number } | null>(null);
  useLayoutEffect(() => {
    const saved = expandAnchorRef.current;
    if (saved === null) return;
    expandAnchorRef.current = null;
    const el = chatScrollRef.current;
    if (el === null) return;
    el.scrollTop += el.scrollHeight - saved.h;
  }, [visibleCount, chatScrollRef]);
  /** 切点回退:cut 落在 run 折叠隐区(Worked 头后的隐藏行)会劈开折叠组——回退到首个非隐藏边界,
   *  折叠组随头完整保留 */
  let cut = entries.length - visibleCount;
  if (cut > 0) {
    while (cut > 0 && hiddenKeys.has(entries[cut]!.key)) cut -= 1;
  }
  const visible = cut > 0 ? entries.slice(cut) : entries;
  const hiddenCount = entries.length - visible.length;
  const showEarlier = (): void => {
    const el = chatScrollRef.current;
    expandAnchorRef.current = { h: el?.scrollHeight ?? 0 };
    setVisibleCount((v) => v + RENDER_WINDOW_STEP);
  };
  /** 批2 滚动到顶自动回放:硬顶(scrollTop≤0)即触发步进回放——锚定回钉使展开后 scrollTop=Δ>0,
   *  不再贴顶即天然防循环;继续上滚到顶加载下一批。chat-earlier 按钮保留作显式入口 */
  const maybeReplayEarlier = (): void => {
    if (hiddenCount <= 0) return;
    const el = chatScrollRef.current;
    if (el !== null && el.scrollTop <= 0) showEarlier();
  };
  return (
    <main
      className="chat"
      aria-label="chat"
      ref={chatScrollRef}
      onClickCapture={onEntryToggleClick}
      onScroll={(e) => {
        onScroll(e);
        maybeReplayEarlier();
      }}
    >
        {entries.length === 0 && (
          <div className="chat-empty" aria-label="chat empty">
            <div className="chat-empty-title">{sideChat === true ? t('Side chat', '辅助对话') : t('Give sunshinex a task', '给 sunshinex 一个任务')}</div>
            <div className="chat-empty-hint">{sideChat === true ? t('Quick questions on the side; the main task stays untouched', '旁路快问,不打断主任务') : t('Describe the goal: streaming replies, live tool runs, writes need approval', '描述目标即可:模型流式作答,工具实时执行,写操作需审批')}</div>
          </div>
        )}
        {hiddenCount > 0 && (
          <button type="button" className="chat-earlier" onClick={showEarlier}>
            {t(`Show ${hiddenCount} earlier entries`, `显示更早的 ${hiddenCount} 条`)}
          </button>
        )}
        {/* 会话流按日分组:跨日插居中日期分隔(纯投影 groupEntriesByDay;无 ts 头组无标不渲染);
            G14.31 折叠轮:sealed run 头点击 → 其后工具/思考行隐藏(用户/回复/旁白保留) */}
        {groupEntriesByDay(visible).flatMap((g) => {
          const nodes: ReactNode[] = [];
          if (g.label !== '') {
            nodes.push(
              <div key={`day:${g.key}`} className="chat-day-sep" role="separator" aria-label={g.label}>
                {g.label}
              </div>,
            );
          }
          /** G14.73:连续的折叠区条目(工具/思考)聚成一段,包进 seg-collapse 平滑容器——
           *  展开与收合都是 grid 高度过渡,不再瞬切;G14.215 段内工具行聚合(ToolSegBlock 抽件) */
          let seg: ChatEntry[] = [];
          const flushSeg = (): void => {
            if (seg.length === 0) return;
            const segEntries = seg;
            nodes.push(
              <ToolSegBlock
                key={`seg:${segEntries[0]!.key}`}
                seg={segEntries}
                closed={hiddenKeys.has(segEntries[0]!.key)}
                renderTool={(e2) => (
                  <ToolEntryView
                    key={e2.key}
                    entry={e2}
                    conn={conn}
                    sessionId={sessionId}
                    callId={callIdOf(e2)}
                    onOpenFile={onOpenFile}
                    onOpenDiff={onOpenDiff}
                    onOpenAgent={onOpenAgent}
                    onOpenTask={onOpenTask}
                    taskNameOf={taskNameOf}
                  />
                )}
                renderThinking={(e2) => <ThinkingEntryView key={e2.key} entry={e2} />}
                renderAssistant={(e2) => <ChatEntryView key={e2.key} entry={e2} onOpenDiff={(p) => onOpenDiff?.('', p)} />}
              />,
            );
            seg = [];
          };
          for (const entry of g.entries) {
            // G14.136 折叠态的中间正文随工具/思考一起进 seg-collapse 平滑折叠
            if (entry.kind === 'tool' || entry.kind === 'thinking' || (entry.kind === 'assistant' && hiddenKeys.has(entry.key))) {
              seg.push(entry);
              continue;
            }
            flushSeg();
            if (entry.kind === 'run') {
              nodes.push(
                <RunEntryView
                  key={entry.key}
                  entry={entry}
                  collapsed={collapsedRuns.has(entry.key)}
                  onToggle={entry.streaming === true ? undefined : toggleRun}
                />,
              );
            } else if (entry.kind === 'user') {
              nodes.push(
                <UserEntryView
                  key={entry.key}
                  entry={entry}
                  onSend={submitText}
                  onOpenFile={onOpenFile} // G14.110 气泡内 @文件 token 点击开 file 标签
                />,
              );
            } else {
              nodes.push(
                <ChatEntryView
                  key={entry.key}
                  entry={entry}
                  footerRun={runFooterByEntry.get(entry.key)}
                  onOpenDiff={onEntryOpenDiff}
                  onRestore={onEntryRestore}
                  onFork={onFork}
                  onOpenFile={onOpenFile}
                />,
              );
            }
          }
          flushSeg();
          return nodes;
        })}
        {/* G14.52 运行状态行:常驻流区末行(圆圈+步数+tokens),轮次完成/停止即隐;
            原「尾参挂最后一个工具行」只在工具执行期可见且左缘随工具行缩进不齐——独立成行对齐 */}
        {running && (
          <div className="run-live-line" role="status" aria-label="run status">
            <span className="run-spinner" aria-hidden="true" />
            <span>{`${liveSteps} steps`}</span>
            <span>{fmtTokens(liveTokens)}</span>
          </div>
        )}
    </main>
  );
}
