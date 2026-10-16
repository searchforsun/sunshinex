import type { AgentActivities, AgentActivity } from './agent-activity';
import type { Delegation, TaskBoardState } from '../projection';

/**
 * G8d Agents 标签体（task-3）·G14.164 重做：子代理聚合卡只读呈现 + 点卡开「agent 只读标签页」
 * （对齐辅助对话的被动开页模型——无输入框，转录整读）。展示口径修正（用户裁决「没有显示子 agent
 * 名称」）：卡面主行 = agent 名称（解析序 delegation.title → 任务板 assignee 命中 → 任务板 title →
 * 原始 label），raw label 降为次行 mono 小字；状态徽标/工具行/tokens 沿用。样式类 sx-agents-tab/
 * sx-subagent-* 落 app.css。
 */

export interface AgentsTabProps {
  /** 聚合态（App 态经 services 注入；key = subagent 标签） */
  readonly activities: AgentActivities;
  /** 名称解析材料：delegations（teammate 委派带 title）与任务板（task-前缀标签按 id 命中 title/assignee） */
  readonly delegations: readonly Delegation[];
  readonly board: TaskBoardState;
  /** 点卡开只读转录页（App 注入 openTabInSession('agent', { label, agentTitle })——同 agent 重开=聚焦） */
  readonly onOpenAgent: (label: string, agentTitle: string) => void;
}

/** status 徽标文案 */
const STATUS_TEXT: Record<AgentActivity['status'], string> = { running: '运行中', done: '完成', error: '失败' };

/** delegation 状态 → 徽标文案（openAgent 面头/卡面共用口径） */
export const DELEGATION_STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  paused: '已暂停',
};

/**
 * agent 显示名解析单点（AgentsTab 卡面与 agent 标签页头共用）：
 * delegation.title（teammate 委派带）→ 任务板同名任务的 title → 原始 label（graph-node 等无题面兜底）。
 */
export function resolveAgentName(
  label: string,
  delegations: readonly Delegation[],
  board: TaskBoardState,
): string {
  const byDelegation = delegations.find((d) => d.label === label || d.id === label);
  if (byDelegation?.title !== undefined && byDelegation.title !== '') return byDelegation.title;
  const task = board.tasks[label];
  if (task !== undefined && task.title !== '') return task.title;
  return label;
}

/** 卡面当前活动行（running 才有「正在做」语义） */
function CurrentTool({ a }: { a: AgentActivity }): JSX.Element | null {
  if (a.currentTool === undefined) return null;
  return (
    <p className="sx-subagent-tool">
      <span className="sx-subagent-tool-verb">{a.status === 'running' ? '正在' : '最后'}</span>
      {a.currentTool}
    </p>
  );
}

export function AgentsTab({ activities, delegations, board, onOpenAgent }: AgentsTabProps): JSX.Element {
  const cards = Object.values(activities);
  if (cards.length === 0) {
    return (
      <div className="sx-agents-tab" aria-label="agents tab">
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">暂无子 agent 活动</p>
          <p className="board-empty-hint">智能体委派子任务后，各子 agent 的实时活动会显示在这里。</p>
        </div>
      </div>
    );
  }
  return (
    <div className="sx-agents-tab" aria-label="agents tab">
      <ul className="sx-agents-list">
        {cards.map((a) => {
          const name = resolveAgentName(a.label, delegations, board);
          return (
            <li key={a.label} className={`sx-subagent-card status-${a.status}`}>
              <button
                type="button"
                className="sx-subagent-row"
                aria-label={`open agent ${name}`}
                onClick={() => onOpenAgent(a.label, name)}
                data-tip="打开只读转录"
              >
                <span className="sx-subagent-main">
                  <span className="sx-subagent-headline">
                    {a.status === 'running' && <span className="sx-subagent-dot" aria-hidden="true" />}
                    <span className="sx-subagent-name">{name}</span>
                    <span className={`sx-subagent-status status-${a.status}`}>{STATUS_TEXT[a.status]}</span>
                  </span>
                  <span className="sx-subagent-subline">
                    <span className="sx-subagent-id">{a.label}</span>
                    <span className="sx-subagent-tokens">{`${a.tokens} tokens`}</span>
                  </span>
                </span>
                <span className="sx-subagent-open" aria-hidden="true">›</span>
              </button>
              <CurrentTool a={a} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
