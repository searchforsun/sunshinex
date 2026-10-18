import type { MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from 'react';
import { t } from '../../i18n';
import type { Connection } from '../../connection';
import { fmtTokens as fmtTokensShared } from '../../ui-util';
import { groupEntriesByDay } from '../../chat-groups';
import type { ChatEntry } from '../../chat-reducer';
function fmtTokens(n: number): string {
  return fmtTokensShared(n);
}
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
  readonly running: boolean;
  readonly liveSteps: number;
  readonly liveTokens: number;
}

export function MessageList(props: MessageListProps): JSX.Element {
  const { entries, hiddenKeys, callIdOf, conn, sessionId, onOpenFile, onOpenDiff, onOpenAgent, onOpenTask, taskNameOf, collapsedRuns, toggleRun, submitText, runFooterByEntry, onEntryOpenDiff, onEntryRestore, onFork, onEntryToggleClick, chatScrollRef, onScroll, running, liveSteps, liveTokens } = props;
  return (
    <main
      className="chat"
      aria-label="chat"
      ref={chatScrollRef}
      onClickCapture={onEntryToggleClick}
      onScroll={onScroll}
    >
        {entries.length === 0 && (
          <div className="chat-empty" aria-label="chat empty">
            <div className="chat-empty-title">{t('Give sunshinex a task', '给 sunshinex 一个任务')}</div>
            <div className="chat-empty-hint">{t('Describe the goal: streaming replies, live tool runs, writes need approval', '描述目标即可:模型流式作答,工具实时执行,写操作需审批')}</div>
          </div>
        )}
        {/* 会话流按日分组:跨日插居中日期分隔(纯投影 groupEntriesByDay;无 ts 头组无标不渲染);
            G14.31 折叠轮:sealed run 头点击 → 其后工具/思考行隐藏(用户/回复/旁白保留) */}
        {groupEntriesByDay(entries).flatMap((g) => {
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
