import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Check, Copy } from 'lucide-react';
import { t } from '../i18n';
import type { AgentActivity } from './agent-activity';
import type { Delegation, TaskBoardState } from '../projection';
import type { Connection } from '../connection';
import { ChatEntryView, CollapsibleBubble, ThinkingEntryView, ToolEntryView } from '../pages/Chat';
import { RunEntryView } from '../pages/chat/EntryViews';
import { ToolSegBlock } from '../pages/chat/ToolGroups';
import type { ChatEntry } from '../chat-reducer';

/**
 * G14.175 子代理只读转录标签页（agent 类型标签体）——**完全继承主对话渲染方式，只去掉输入框**
 * （用户裁决；TUI 子代理面板同款实现）。G14.213 渲染组件整体换正：assistant→ChatEntryView /
 * thinking→ThinkingEntryView / tool→ToolEntryView（动词两字化、图标、折叠壳与主对话同一套），
 * 废弃页内自绘的 ToolRow/ReactMarkdown 直渲（此前 token/text 两路样式分裂、思考行自绘 💭）。
 * - 用户输入 = 任务内容（活动流 taskBand 优先，缺省回落开档参数 task——spawn 行带 prompt/看板行带任务标题）
 * - 滑窗行 → ChatEntry：token 连续合并为 assistant；text 行=独立 assistant 段；thinking→思考行；
 *   tool→工具行（✓/✗ 回执吸附为 ⎿ 行）
 * - G14.2xx 用户裁定四项对齐主对话：①头部=主对话同款运行态行（委派在场即示：running=「运行中」
 *   秒针 live 行/结束=「已运行 Xs」sealed 行）+ 分割线；②工具/思考段走 ToolSegBlock——同类型相邻
 *   已完成工具行聚合（「查询了 N 次文件」形，点击平级展开），与主对话同一聚合件；③流区底部加边距；
 *   ④右下角回到底部钮（.jump-down 同款，非贴底即显）
 * 活动流是会话内存态：页面刷新后回退空态（无活动记录）。
 */

export interface AgentTranscriptTabProps {
  readonly label: string;
  readonly conn: Connection;
  readonly sessionId: string;
  readonly activities: AgentActivity | undefined;
  readonly delegations: readonly Delegation[];
  readonly board: TaskBoardState;
  /** 开档定格的任务内容（用户输入兜底；无 taskBand 时上屏） */
  readonly task?: string;
}

/** 滑窗行 → 主对话 ChatEntry：token 连续合并 assistant；text=独立 assistant 段；
 *  thinking 独立行；tool 调用行 `● verb target`（name/input 字段直挂——P11 T7 渲染中立,
 *  ToolEntryView 全走 entry 字段），✓/✗ 回执吸附为 `⎿ 完成/失败` */
function toEntries(lines: AgentActivity['lines']): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const push = (kind: ChatEntry['kind'], md: string): void => {
    entries.push({ key: `ag${entries.length}`, kind, md });
  };
  /** 动词条 → 字段化 tool 条:首词=动词,余文按动词键位入 input——折叠行 target 与主对话
   *  toolTargetOf 同口径(read/write/glob→path,exec→command,grep/glob→pattern 兜底 path) */
  const toolEntry = (head: string, md: string): ChatEntry => {
    const sp = head.indexOf(' ');
    const name = (sp > 0 ? head.slice(0, sp) : head).trim();
    const rest = sp > 0 ? head.slice(sp + 1).trim() : '';
    const input: Record<string, unknown> =
      name === 'exec'
        ? { command: rest }
        : name === 'grep' || name === 'glob'
          ? { pattern: rest }
          : name === 'websearch'
            ? { query: rest }
            : name === 'webfetch'
              ? { url: rest }
              : name === 'skill'
                ? { id: rest }
                : { path: rest };
    return { key: `ag${entries.length}`, kind: 'tool', md, name, input };
  };
  for (const l of lines) {
    if (l.kind === 'token') {
      const last = entries[entries.length - 1];
      if (last !== undefined && last.kind === 'assistant') last.md += l.text;
      else push('assistant', l.text);
      continue;
    }
    if (l.kind === 'text') {
      push('assistant', l.text);
      continue;
    }
    if (l.kind === 'thinking') {
      push('thinking', l.text);
      continue;
    }
    // tool 行:✓/✗ 前缀=回执,吸附前一条未收执 tool 的 ⎿ 行;否则孤儿回执独立成条
    if (l.text.startsWith('✓') || l.text.startsWith('✗')) {
      const last = entries[entries.length - 1];
      const receipt = l.text.startsWith('✓') ? '完成' : '失败';
      if (last !== undefined && last.kind === 'tool' && !last.md.includes('\n⎿ ')) {
        last.md += `\n⎿ ${receipt}`;
        continue;
      }
      entries.push(toolEntry('…', `● …\n⎿ ${receipt}`));
      continue;
    }
    entries.push(toolEntry(l.text, `● ${l.text}`));
  }
  return entries;
}

export function AgentTranscriptTab({ label, conn, sessionId, activities, delegations, task }: AgentTranscriptTabProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  /** G14.2xx 回到底部钮:非贴底即显(同主对话 G14.74 口径;80px 阈值同贴底判定) */
  const [atBottom, setAtBottom] = useState(true);
  const lines = activities?.lines ?? [];
  const entries = toEntries(lines);
  // 追行吸底:转录更新即滚到最底(只读面恒跟最新)
  useEffect(() => {
    const el = bodyRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines.length, activities?.currentTool]);
  const onScroll = (): void => {
    const el = bodyRef.current;
    if (el !== null) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  // G14.2xx 头部运行态行(主对话 RunEntryView 同件):委派在场即示——running=live「运行中」秒针,
  // 结束=sealed「已运行 Xs」;委派缺失(页面刷新丢活动流/无委派面)不示
  const delegation = delegations.find((d) => d.label === label);
  const runEntry: ChatEntry | undefined =
    delegation === undefined
      ? undefined
      : delegation.status === 'running'
        ? { key: 'ag-run-head', kind: 'run', md: '', streaming: true, ts: delegation.startedAt }
        : {
            key: 'ag-run-head',
            kind: 'run',
            md: '',
            ...(delegation.endedAt !== undefined
              ? { seconds: Math.max(0, Math.round((delegation.endedAt - delegation.startedAt) / 1000)) }
              : {}),
          };

  const userText = activities?.taskBand ?? task ?? '';
  // G14.202 复制钮:右下角,hover 行时显示(参考主对话复制钮方位);点击回显已复制
  const copyText = (): void => {
    navigator.clipboard?.writeText(userText).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  /** G14.2xx 工具/思考段 = 主对话 ToolSegBlock 同件:同类型相邻已完成工具行聚合并可平级展开
   *  (buildSegNodes 单点),非同类行/思考行天然切断;closed 恒 false(本页无轮折叠语义) */
  const nodes: JSX.Element[] = [];
  let seg: ChatEntry[] = [];
  const flushSeg = (): void => {
    if (seg.length === 0) return;
    const segEntries = seg;
    nodes.push(
      <ToolSegBlock
        key={`seg:${segEntries[0]!.key}`}
        seg={segEntries}
        closed={false}
        renderTool={(e2) => <ToolEntryView key={e2.key} entry={e2} conn={conn} sessionId={sessionId} />}
        renderThinking={(e2) => <ThinkingEntryView key={e2.key} entry={e2} />}
        renderAssistant={(e2) => <ChatEntryView key={e2.key} entry={e2} />}
      />,
    );
    seg = [];
  };
  for (const e of entries) {
    if (e.kind === 'tool' || e.kind === 'thinking') {
      seg.push(e);
      continue;
    }
    flushSeg();
    nodes.push(<ChatEntryView key={e.key} entry={e} />);
  }
  flushSeg();

  return (
    <div className="sx-agent-page" aria-label="agent transcript">
      {/* G14.202 页头去除(名称与页签重复;状态/委派徽标与 tokens 同去——转录页只留内容) */}
      <div className="sx-agent-page-body sx-agent-thread" ref={bodyRef} onScroll={onScroll}>
        {userText !== '' && (
          <div className="entry entry-user child-user-entry">
            <CollapsibleBubble text={userText} render={(md) => <div className="child-user-text">{md}</div>} />
            {/* G14.202b 复制钮:气泡外右下,hover 行时显示(主对话 user-actions 同款方位) */}
            <button type="button" className="child-copy" aria-label={copied ? t('Copied', '已复制') : t('Copy', '复制')} data-tip={copied ? t('Copied', '已复制') : t('Copy', '复制')} onClick={copyText}>
              {copied ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </div>
        )}
        {runEntry !== undefined && (
          <>
            <RunEntryView entry={runEntry} />
            <div className="agent-thread-sep" role="separator" />
          </>
        )}
        {activities === undefined || lines.length === 0 ? (
          userText === '' ? (
            <div className="board-empty-state" role="status">
              <p className="board-empty-title">无活动记录</p>
              <p className="board-empty-hint">该子 agent 的活动流在本会话内未产生（或页面刷新后已重置）。</p>
            </div>
          ) : null
        ) : (
          nodes
        )}
      </div>
      {/* G14.2xx 回到底部钮(主对话 .jump-down 同款):本页无输入框,钉流区右下角 */}
      {!atBottom && (
        <button
          type="button"
          className="jump-down sx-agent-jump"
          aria-label="scroll to bottom"
          title={t('Scroll to bottom', '回到底部')}
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
