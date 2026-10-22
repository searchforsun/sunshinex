import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, Copy } from 'lucide-react';
import { t } from '../i18n';
import { fmtTokens } from '../ui-util';
import type { AgentActivity } from './agent-activity';
import type { TaskBoardState } from '../projection';
import type { Connection } from '../connection';
import { ChatEntryView, CollapsibleBubble, ThinkingEntryView, ToolEntryView } from '../pages/Chat';
import { RunEntryView } from '../pages/chat/EntryViews';
import { ToolSegBlock } from '../pages/chat/ToolGroups';
import { useCopyFeedback } from '../use-copy-feedback';
import { runFooterMapOf, taskNameResolverOf } from '../pages/chat/use-chat-derived';
import { collapsedHiddenKeys } from '../pages/chat/use-chat-fold';
import type { ChatEntry } from '../chat-reducer';

/**
 * G14.175 子智能体只读转录标签页（agent 类型标签体）——**完全继承主对话渲染方式，只去掉输入框**
 * （用户裁决；TUI 子智能体面板同款实现）。G14.213 渲染组件整体换正：assistant→ChatEntryView /
 * thinking→ThinkingEntryView / tool→ToolEntryView（动词两字化、图标、折叠壳与主对话同一套），
 * 废弃页内自绘的 ToolRow/ReactMarkdown 直渲（此前 token/text 两路样式分裂、思考行自绘 💭）。
 * - 用户输入 = 任务内容（活动流 taskBand 优先，缺省回落开档参数 task——spawn 行带 prompt/看板行带任务标题）
 * - G14.2xx 转录=同源内核投影条目直渲（applySubagentChatEvent 与主对话 applyChatEvent 走同一
 *   applyEvent 实现,tool 行 name/input/result 全量在场)——旧有损文本滑窗反解析退役
 * - G14.2xx 用户裁定四项对齐主对话：①头部=主对话同款运行态行+分割线；②工具/思考段走 ToolSegBlock
 *   （同类型相邻已完成工具行聚合，点击平级展开）；③流区底部加边距；④右下角回到底部钮
 * - G14.2xx b 六项对标收口（实测截图反馈）：①run 条分派 RunEntryView（model-start 进投影后
 *   内容区自带「运行中 Ns/已运行 Xs」行——合成头部行与 agent-thread-sep 双分割线退役，run 条
 *   自带 border-bottom 与主对话单线同源）；②底部 run-live-line（spinner+本轮 steps+tokens，
 *   liveSteps/liveTokens 同 Chat 末个 streaming run 基线差值口径）；③工具行回调链补全
 *   （onOpenFile/onOpenDiff/onOpenAgent/onOpenTask/taskNameOf——read 行点击开文件标签、write
 *   ⇄ 开 diff、spawn 名开转录、create_task 名定位任务板，与主对话逐项同构）；④正文文件链接
 *   （ChatEntryView onOpenFile）与轮尾 RunFooter（复制+统计，无 fork）；⑤taskNameOf 走
 *   taskNameResolverOf 纯函数单点（与主对话 useChatDerived 同源）；⑥容器挂 .chat 类——间距
 *   系统（gap/工具行相邻收紧/入场动画）与主对话完全同源
 * 活动流是会话内存态：页面刷新后从 journal subagent 行帧重放重建（seedShadow 同一消费通道）。
 */

export interface AgentTranscriptTabProps {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly activities: AgentActivity | undefined;
  readonly board: TaskBoardState;
  /** 开档定格的任务内容（用户输入兜底；无 taskBand 时上屏） */
  readonly task?: string;
  /** 与主对话同构的回调链（App openTab 系注入；缺省=对应交互退化纯文本） */
  readonly onOpenFile?: (p: string) => void;
  readonly onOpenDiff?: (callId: string, p: string) => void;
  readonly onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  readonly onOpenTask?: (ref: string) => void;
}

/** G14.2xx 转录=同源内核投影条目直渲（agent-activity 卡挂 chat: ChatState,applySubagentChatEvent
 *  与主对话 applyChatEvent 走同一 applyEvent 实现）——tool 行 name/input/result 全量在场,与主对话
 *  逐字段同构;旧有损文本滑窗反解析退役（空名帧退化「…」行/孤儿回执病根） */

export function AgentTranscriptTab({ conn, sessionId, activities, board, task, onOpenFile, onOpenDiff, onOpenAgent, onOpenTask }: AgentTranscriptTabProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** G14.2xx 回到底部钮:非贴底即显(同主对话 G14.74 口径;80px 阈值同贴底判定) */
  const [atBottom, setAtBottom] = useState(true);
  // G14.2xx 对齐主对话:直渲同源内核投影条目(chat-reducer 全量字段——tool 行 name/input/
  // result 与主对话逐字节同构),废旧有损文本滑窗反解析(空名帧退化「…」行病根)
  const chat = activities?.chat;
  const entries = chat?.entries ?? [];
  const taskNameOf = useMemo(() => taskNameResolverOf(entries, board), [entries, board]);
  // G14.2xx b 轮尾操作条(主对话同件):各段末条 assistant 挂复制+封段统计(runFooterMapOf 单点;
  // onFork 不传——只读转录面无分叉语义)
  const runFooterByEntry = useMemo(() => runFooterMapOf(entries, chat?.status ?? 'idle'), [entries, chat?.status]);
  // G14.2xx b 轮次折叠(主对话 G14.31 同款):sealed run 条点击折叠/展开其后工具与思考行——
  // collapsedRuns 本地态(只读面无恢复语义),hiddenKeys 走 collapsedHiddenKeys 纯函数单点
  // (与主对话 useChatFold 同源;段内中间 sealed assistant 一并随轮折叠)
  const [collapsedRuns, setCollapsedRuns] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRun = useCallback((key: string): void => {
    setCollapsedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const hiddenKeys = useMemo(() => collapsedHiddenKeys(entries, collapsedRuns), [entries, collapsedRuns]);
  // 追行吸底(主对话 G13 同款贴底判定):贴底(距底<80px)时每帧归底,上翻离底即放手、回底恢复跟随。
  // 依赖=entries 数组引用(mapEntries 语义:任一条目内容变——含流式 token 增量拼接——即新引用;
  // 零变化事件原引用透传不触发)。此前依赖 entries.length:流式是往现有条目追加内容,条目数不变
  // → effect 不跑 = 贴底时流式输出不跟滚的病根
  const stickRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, activities?.currentTool]);
  const onScroll = (): void => {
    const el = bodyRef.current;
    if (el !== null) {
      const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stickRef.current = stick;
      setAtBottom(stick);
    }
  };

  // G14.2xx b 底部运行态行数据面(主对话 Chat 同一口径):running=末个 streaming run 的基线差值
  // (「本轮」steps/tokens;无基线回退累计)——applyAgentEvent G14.2xx b 起 model-start/step 入投影,
  // 此处才有 run 条与 steps 可言
  const running = chat?.status === 'running';
  const lastLiveRun = running ? [...entries].reverse().find((e) => e.kind === 'run' && e.streaming === true) : undefined;
  const liveSteps =
    lastLiveRun?.stepsBase !== undefined && chat !== undefined ? Math.max(0, chat.steps - lastLiveRun.stepsBase) : (chat?.steps ?? 0);
  const liveTokens =
    lastLiveRun?.tokensBase !== undefined && chat !== undefined ? Math.max(0, chat.tokens - lastLiveRun.tokensBase) : (chat?.tokens ?? 0);

  const userText = activities?.taskBand ?? task ?? '';
  // G14.202 复制钮:右下角,hover 行时显示(参考主对话复制钮方位);点击回显已复制(useCopyFeedback 单点)
  const { status: copied, copy: copyText } = useCopyFeedback();
  /** G14.2xx 工具/思考段 = 主对话 ToolSegBlock 同件:同类型相邻已完成工具行聚合并可平级展开
   *  (buildSegNodes 单点),非同类行/思考行天然切断;closed=轮折叠态(主对话 G14.31 同款,
   *  hiddenKeys 折叠区间内的工具/思考行进 seg-collapse 平滑容器) */
  const nodes: JSX.Element[] = [];
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
            callId={e2.callId !== undefined && e2.callId.length > 0 ? e2.callId : undefined}
            onOpenFile={onOpenFile}
            onOpenDiff={onOpenDiff}
            onOpenAgent={onOpenAgent}
            onOpenTask={onOpenTask}
            taskNameOf={taskNameOf}
          />
        )}
        renderThinking={(e2) => <ThinkingEntryView key={e2.key} entry={e2} />}
        renderAssistant={(e2) => <ChatEntryView key={e2.key} entry={e2} onOpenDiff={onOpenDiff !== undefined ? (p) => onOpenDiff('', p) : undefined} />}
      />,
    );
    seg = [];
  };
  for (const e of entries) {
    // G14.136 同款:工具/思考行与折叠区间内的中间 sealed assistant 进段(轮折叠一起收合)
    if (e.kind === 'tool' || e.kind === 'thinking' || (e.kind === 'assistant' && hiddenKeys.has(e.key))) {
      seg.push(e);
      continue;
    }
    flushSeg();
    // G14.2xx b run 条走 RunEntryView(主对话同件:streaming=运行中秒针行,sealed=已运行 Xs;
    // 自带 border-bottom 分割线);sealed 行=轮折叠开关(collapsed/onToggle 主对话同款)
    if (e.kind === 'run') {
      nodes.push(
        <RunEntryView key={e.key} entry={e} collapsed={collapsedRuns.has(e.key)} onToggle={e.streaming === true ? undefined : toggleRun} />,
      );
      continue;
    }
    nodes.push(<ChatEntryView key={e.key} entry={e} footerRun={runFooterByEntry.get(e.key)} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff !== undefined ? (p) => onOpenDiff('', p) : undefined} />);
  }
  flushSeg();

  return (
    <div className="sx-agent-page" aria-label="agent transcript">
      {/* G14.202 页头去除(名称与页签重复;状态/委派徽标与 tokens 同去——转录页只留内容) */}
      <div className="sx-agent-page-body sx-agent-thread chat" ref={bodyRef} onScroll={onScroll}>
        {userText !== '' && (
          <div className="entry entry-user child-user-entry">
            <CollapsibleBubble text={userText} render={(md) => <div className="child-user-text">{md}</div>} />
            {/* G14.202b 复制钮:气泡外右下,hover 行时显示(主对话 user-actions 同款方位) */}
            <button type="button" className="child-copy" aria-label={copied === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')} data-tip={copied === 'ok' ? t('Copied', '已复制') : t('Copy', '复制')} onClick={() => copyText(userText)}>
              {copied === 'ok' ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </div>
        )}
        {activities === undefined || entries.length === 0 ? (
          userText === '' ? (
            <div className="board-empty-state" role="status">
              <p className="board-empty-title">{t('No agent activity', '无活动记录')}</p>
              <p className="board-empty-hint">{t('This agent produced no activity in the session (or the stream was reset after a refresh).', '该子智能体的活动流在本会话内未产生（或页面刷新后已重置）。')}</p>
            </div>
          ) : null
        ) : (
          nodes
        )}
        {/* G14.2xx b 运行状态行(主对话 MessageList 同件):spinner+本轮 steps+tokens,收轮即隐 */}
        {running && (
          <div className="run-live-line" role="status" aria-label="run status">
            <span className="run-spinner" aria-hidden="true" />
            <span>{`${liveSteps} steps`}</span>
            <span>{fmtTokens(liveTokens)}</span>
          </div>
        )}
      </div>
      {/* G14.2xx 回到底部钮(主对话 .jump-down 同款):本页无输入框,钉流区右下角 */}
      {!atBottom && (
        <button
          type="button"
          className="jump-down sx-agent-jump"
          aria-label="scroll to bottom"
          data-tip={t('Scroll to bottom', '回到底部')}
          onClick={() => {
            const el = bodyRef.current;
            if (el !== null) el.scrollTo({ top: el.scrollHeight });
          }}
        >
          <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
