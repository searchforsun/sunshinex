import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '../i18n';
import type { AgentActivity } from './agent-activity';
import type { Delegation, TaskBoardState } from '../projection';
import type { Connection } from '../connection';
import { ChatEntryView, CollapsibleBubble, ThinkingEntryView, ToolEntryView } from '../pages/Chat';
import type { ChatEntry } from '../chat-reducer';

/**
 * G14.175 子代理只读转录标签页（agent 类型标签体）——**完全继承主对话渲染方式，只去掉输入框**
 * （用户裁决；TUI 子代理面板同款实现）。G14.213 渲染组件整体换正：assistant→ChatEntryView /
 * thinking→ThinkingEntryView / tool→ToolEntryView（动词两字化、图标、折叠壳与主对话同一套），
 * 废弃页内自绘的 ToolRow/ReactMarkdown 直渲（此前 token/text 两路样式分裂、思考行自绘 💭）。
 * - 用户输入 = 任务内容（活动流 taskBand 优先，缺省回落开档参数 task——spawn 行带 prompt/看板行带任务标题）
 * - 滑窗行 → ChatEntry：token 连续合并为 assistant；text 行=独立 assistant 段；thinking→思考行；
 *   tool→工具行（✓/✗ 回执吸附为 ⎿ 行）
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
 *  thinking 独立行；tool 调用行 `● verb target`,✓/✗ 回执吸附为 `⎿ 完成/失败` */
function toEntries(lines: AgentActivity['lines']): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const push = (kind: ChatEntry['kind'], md: string): void => {
    entries.push({ key: `ag${entries.length}`, kind, md });
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
      push('tool', `● …\n⎿ ${receipt}`);
      continue;
    }
    push('tool', `● ${l.text}`);
  }
  return entries;
}

/** 活动行文本 → ToolEntryView 的 info(name+input):首词=动词,余文按动词键位入 input——
 *  折叠行 target 与主对话同口径(read/write/glob→path,exec→command,grep/glob→pattern 兜底 path) */
function toolInfoOf(text: string): { name: string; input: Record<string, unknown> } {
  const sp = text.indexOf(' ');
  const name = (sp > 0 ? text.slice(0, sp) : text).trim();
  const rest = sp > 0 ? text.slice(sp + 1).trim() : '';
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
  return { name, input };
}

export function AgentTranscriptTab({ conn, sessionId, activities, task }: AgentTranscriptTabProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const lines = activities?.lines ?? [];
  const entries = toEntries(lines);
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
          entries.map((e) => {
            if (e.kind === 'thinking') return <ThinkingEntryView key={e.key} entry={e} />;
            if (e.kind === 'tool') {
              const head = e.md.startsWith('● ') ? (e.md.slice(2).split('\n')[0] ?? '') : e.md;
              return <ToolEntryView key={e.key} entry={e} info={toolInfoOf(head)} conn={conn} sessionId={sessionId} />;
            }
            return <ChatEntryView key={e.key} entry={e} />;
          })
        )}
      </div>
    </div>
  );
}
