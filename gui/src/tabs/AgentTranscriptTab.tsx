import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronRight, Copy, Wrench } from 'lucide-react';
import { t } from '../i18n';
import type { AgentActivity } from './agent-activity';
import type { Delegation, TaskBoardState } from '../projection';
import { CollapsibleBubble } from '../pages/Chat';
import { DELEGATION_STATUS_TEXT, resolveAgentName } from './AgentsTab';

/**
 * G14.175 子代理只读转录标签页（agent 类型标签体）v2——**完全继承主对话渲染方式，只去掉输入框**
 * （用户裁决；TUI 子代理面板同款实现）：
 * - 用户输入 = 任务内容（活动流 taskBand 优先，缺省回落开档参数 task——spawn 行带 prompt/看板行带任务标题）
 * - 正文/思考/工具流 = 活动流滑窗映射主对话三态：thinking→思考行 / token(连续合并)→assistant 正文 /
 *   tool→工具行（✓/✗ 回执吸附到前一条调用）
 * - 页签图标 = 机器人（Bot，TabStrip TAB_ICONS.agent）
 * 活动流是会话内存态：页面刷新后回退空态（无活动记录）。
 */

export interface AgentTranscriptTabProps {
  readonly label: string;
  readonly activities: AgentActivity | undefined;
  readonly delegations: readonly Delegation[];
  readonly board: TaskBoardState;
  /** 开档定格的任务内容（用户输入兜底；无 taskBand 时上屏） */
  readonly task?: string;
}

/** 委派终态徽标（若该 label 有委派条目，头部补一枚） */
function DelegationBadge({ delegations, label }: { delegations: readonly Delegation[]; label: string }): JSX.Element | null {
  const d = delegations.find((x) => x.label === label || x.id === label);
  if (d === undefined) return null;
  return <span className={`sx-subagent-status delegation-${d.status}`}>{DELEGATION_STATUS_TEXT[d.status] ?? d.status}</span>;
}

/** 滑窗行 → 主对话三态块：token 连续合并为 assistant；✓/✗ 吸附前一条 tool；thinking 独立行 */
interface ChatBlock {
  kind: 'assistant' | 'tool' | 'thinking';
  text: string;
  result?: 'ok' | 'fail';
}

function toBlocks(lines: AgentActivity['lines']): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const l of lines) {
    if (l.kind === 'token') {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'assistant') last.text += l.text;
      else blocks.push({ kind: 'assistant', text: l.text });
      continue;
    }
    if (l.kind === 'thinking') {
      blocks.push({ kind: 'thinking', text: l.text });
      continue;
    }
    // tool 行:✓/✗ 前缀=回执,吸附前一条 tool 块;否则即调用行
    if (l.text.startsWith('✓') || l.text.startsWith('✗')) {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === 'tool' && last.result === undefined) {
        last.result = l.text.startsWith('✓') ? 'ok' : 'fail';
        continue;
      }
      blocks.push({ kind: 'tool', text: '', result: l.text.startsWith('✓') ? 'ok' : 'fail' });
      continue;
    }
    blocks.push({ kind: 'tool', text: l.text });
  }
  return blocks;
}

/** 工具行:首词=动词(图标),其余=目标;✓/✗ 回执尾随 */
function ToolRow({ text, result }: { text: string; result?: 'ok' | 'fail' }): JSX.Element {
  const sp = text.indexOf(' ');
  const verb = sp > 0 ? text.slice(0, sp) : text;
  const rest = sp > 0 ? text.slice(sp + 1) : '';
  return (
    <div className={`entry entry-tool child-tool-row${result === 'fail' ? ' fail' : ''}`}>
      <div className="tool-row-line">
        {result !== undefined ? (
          result === 'ok' ? (
            <Check size={12} strokeWidth={2} className="child-tool-mark ok" aria-hidden="true" />
          ) : (
            <Wrench size={12} strokeWidth={1.75} className="child-tool-mark fail" aria-hidden="true" />
          )
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} className="child-tool-mark" aria-hidden="true" />
        )}
        {result === undefined ? (
          <>
            <span className="tool-verb">{verb}</span>
            {rest !== '' && <span className="tool-file-base tool-cmd">{' '}{rest}</span>}
          </>
        ) : (
          <span className="tool-file-base tool-cmd">
            {result === 'ok' ? '完成' : '失败'}
            {rest !== '' ? ` · ${rest.trim()}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentTranscriptTab({ label, activities, delegations, board, task }: AgentTranscriptTabProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const lines = activities?.lines ?? [];
  const blocks = toBlocks(lines);
  // 追行吸底:转录更新即滚到最底(只读面恒跟最新)
  useEffect(() => {
    const el = bodyRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [lines.length, activities?.currentTool]);

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
  return (
    <div className="sx-agent-page" aria-label="agent transcript">
      {/* G14.202 页头去除(名称与页签重复;状态/委派徽标与 tokens 同去——转录页只留内容) */}
      <div className="sx-agent-page-body sx-agent-thread" ref={bodyRef}>
        {userText !== '' && (
          <div className="entry entry-user child-user-entry">
            <CollapsibleBubble text={userText} render={(md) => <div className="child-user-text">{md}</div>} />
            {/* G14.202b 复制钮:气泡外右下,hover 行时显示(主对话 user-actions 同款方位) */}
            <button type="button" className="child-copy" aria-label={copied ? t('Copied', '已复制') : t('Copy', '复制')} data-tip={copied ? t('Copied', '已复制') : t('Copy', '复制')} onClick={copyText}>
              {copied ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </div>
        )}
        {activities === undefined || lines.length === 0 ? (
          userText === '' ? (
            <div className="board-empty-state" role="status">
              <p className="board-empty-title">无活动记录</p>
              <p className="board-empty-hint">该子 agent 的活动流在本会话内未产生（或页面刷新后已重置）。</p>
            </div>
          ) : null
        ) : (
          blocks.map((b, i) => {
            if (b.kind === 'assistant') {
              return (
                <div key={i} className="entry entry-assistant">
                  <div className="entry-md-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown>
                  </div>
                </div>
              );
            }
            if (b.kind === 'thinking') {
              return (
                <div key={i} className="entry entry-thinking">
                  <div className="child-thinking">💭 {b.text.length > 400 ? `${b.text.slice(0, 400)}…` : b.text}</div>
                </div>
              );
            }
            return <ToolRow key={i} text={b.text} result={b.result} />;
          })
        )}
      </div>
    </div>
  );
}
