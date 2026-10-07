import { useState } from 'react';
import type { AgentActivities, AgentActivity } from './agent-activity';

/**
 * G8d Agents 标签体（task-3）：子代理活动聚合卡的只读呈现——App 侧 applyAgentEvent 归约的
 * payload.subagent 标签流（services.agentActivities 注入，registry render 面）。空态文案；
 * 卡列表（label / status 徽标 / tokens / currentTool 行）+ 点卡头展开 mini 转录（滑窗 20 行
 * 等宽渲染）；running 卡 accent 动画点（sx-subagent-dot）。样式类 sx-agents-tab/sx-subagent-*
 * 已随 G8e-T1 落地 app.css——原 sx-agent-* 前缀与 G8c 设置面智能体卡既有定义碰撞,全量改名
 * sx-subagent-*（卡/头行/id/状态徽标/tokens/工具行/转录）;容器类 sx-agents-tab/list/empty
 * （复数,标签类型面）无碰撞保留。
 */

export interface AgentsTabProps {
  /** 聚合态（App 态经 services 注入；key = subagent 标签） */
  readonly activities: AgentActivities;
}

/** status 徽标文案 */
const STATUS_TEXT: Record<AgentActivity['status'], string> = { running: '运行中', done: '完成', error: '失败' };

/** mini 转录行前缀（视觉锚：工具行无前缀即原文，token 行缩进） */
const linePrefix = (kind: 'tool' | 'text' | 'token'): string => (kind === 'token' ? '  ' : '');

export function AgentsTab({ activities }: AgentsTabProps): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  const cards = Object.values(activities);
  if (cards.length === 0) {
    return (
      <div className="sx-agents-tab" aria-label="agents tab">
        <p className="sx-agents-empty">暂无子 agent 活动</p>
      </div>
    );
  }
  return (
    <div className="sx-agents-tab" aria-label="agents tab">
      <ul className="sx-agents-list">
        {cards.map((a) => (
          <li key={a.label} className={`sx-subagent-card status-${a.status}`}>
            <button
              type="button"
              className="sx-subagent-row"
              aria-label={`agent card ${a.label}`}
              aria-expanded={expanded === a.label}
              onClick={() => setExpanded(expanded === a.label ? null : a.label)}
            >
              {a.status === 'running' && <span className="sx-subagent-dot" aria-hidden="true" />}
              <span className="sx-subagent-id">{a.label}</span>
              <span className={`sx-subagent-status status-${a.status}`}>{STATUS_TEXT[a.status]}</span>
              <span className="sx-subagent-tokens">{`${a.tokens} tokens`}</span>
            </button>
            {a.currentTool !== undefined && <p className="sx-subagent-tool">{a.currentTool}</p>}
            {expanded === a.label && (
              <pre className="sx-subagent-lines">{a.lines.map((l) => `${linePrefix(l.kind)}${l.text}`).join('\n')}</pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
