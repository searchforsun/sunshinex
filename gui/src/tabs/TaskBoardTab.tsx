import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutBoard } from '../board-layout';
import type { TaskBoardState, Delegation, BoardTask } from '../projection';
import { DELEGATION_STATUS_TEXT } from './AgentsTab';
import { t } from '../i18n';

/**
 * G14.174 「任务板」页签体（原 Agents 页签重定位,用户裁决「Agents→任务板」+「任务面板也是卡片流,
 * 分两种卡片类型」+「切换按钮放卡片开头,每张卡独立切换」）:
 * 卡片流——任务按创建批次分卡(createdAt 间隔 >2min 即新批,时间由上到下、渲染最新在顶);
 * 每卡头部 = 视图切换(列表|流程图,逐卡独立)+ 关联轮次用户输入(单行省略) + 右侧创建时间;
 * 卡体两型——任务列表(状态点+任务名+执行子代理名,点击跳对应子代理页签;gated 行内 Approve/Deny)
 * | 流程图(完整 DAG:节点同信息+依赖曲线连线,节点点击同跳转)。
 * 测试钩子沿用:svg.board-dag/[data-task]/gated 类钩、.delegation-list/.delegation-main、
 * 行内 Approve/Deny 按钮、aria-label `${id} [${status}] ${title}`。
 *
 * DAG 选型:沿用仓内 layoutBoard(Kahn 分层,零新依赖)+自绘 svg——react-flow/elk 的交互壳与
 * 暗色 token 风格相性差且体积大;分层+状态色+曲线连线已满足「任务关联关系」主诉求。
 */

export interface TaskBoardTabProps {
  readonly board: TaskBoardState;
  readonly delegations: readonly Delegation[];
  /** 关联轮次用户输入(Chat 上抛最近一条 user 行) */
  readonly turnGoal: string;
  /** 点击任务/节点跳对应子代理只读页签(App 注入 openTabInSession('agent',…)) */
  readonly onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** gate 行内审批(App 注入 conn.boardReview) */
  readonly onReview?: (taskId: string, approved: boolean) => void;
  /** G14.176 create_task 行点开的定位信号:ref=任务 id 或标题;nonce 变更即滚动+高亮对应行 */
  readonly focus?: { ref: string; nonce: number } | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** 批次切分间隔:相邻创建时刻超过该值即视为新一轮任务的卡片(ms) */
const BATCH_GAP_MS = 120_000;

function shortTime(ms: number): string {
  if (!(ms > 0)) return '--:--';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 任务 → 执行子代理:委派表按 delegationId/label 的 `task-<id>` 形态或 title 同文命中 */
function agentOfTask(task: BoardTask, delegations: readonly Delegation[]): Delegation | undefined {
  return (
    delegations.find((d) => d.id === `task-${task.id}` || d.label === `task-${task.id}`) ??
    delegations.find((d) => d.title !== undefined && d.title === task.title)
  );
}

/** 创建批次分组:createdAt 升序扫描,间隔超 BATCH_GAP_MS 即新批(批内保 id 序) */
function groupTasks(tasks: BoardTask[]): BoardTask[][] {
  const sorted = [...tasks].sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const groups: BoardTask[][] = [];
  for (const task of sorted) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (last === undefined || (prev !== undefined && task.createdAt - prev.createdAt > BATCH_GAP_MS)) groups.push([task]);
    else last!.push(task);
  }
  return groups;
}

type CardView = 'list' | 'dag';

/** 单卡:头部=视图切换+轮次输入+创建时间;体=列表|DAG 两型 */
function TaskCard({
  group,
  board,
  delegations,
  turnGoal,
  onOpenAgent,
  onReview,
}: {
  group: BoardTask[];
  board: TaskBoardState;
  delegations: readonly Delegation[];
  turnGoal: string;
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  onReview?: (taskId: string, approved: boolean) => void;
}): JSX.Element {
  const [view, setView] = useState<CardView>('list');
  const latestMs = group.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0);
  const byId = useMemo(() => new Map(group.map((x) => [x.id, x])), [group]);
  return (
    <section className="tb-card">
      <div className="tb-card-head">
        <span className="todo-card-goal">{turnGoal !== '' ? turnGoal : t('(no turn input)', '(未关联轮次输入)')}</span>
        <div className="view-toggle" role="group" aria-label="task card view">
          <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            {t('List', '列表')}
          </button>
          <button type="button" aria-pressed={view === 'dag'} className={view === 'dag' ? 'active' : ''} onClick={() => setView('dag')}>
            DAG
          </button>
        </div>
        <span className="todo-card-time">{shortTime(latestMs)}</span>
      </div>
      {view === 'list' ? (
        <>
          <ul className="tb-task-list" aria-label="task list">
            {group.map((task) => {
              const d = agentOfTask(task, delegations);
              const agentName = d !== undefined ? (d.title !== undefined && d.title !== '' ? d.title : d.label) : task.assignee !== undefined ? `@${task.assignee}` : '';
              return (
                <li key={task.id} className={`tb-task-row task-status-${task.status}${task.gated === true ? ' gated' : ''}`}>
                  <button
                    type="button"
                    className="tb-task-main" data-task-id={task.id} data-task-title={task.title}
                    aria-label={`${task.id} [${task.status}] ${task.title}`}
                    data-tip={agentName !== '' ? t('Open subagent transcript', '打开子代理转录') : undefined}
                    onClick={() => {
                      if (d !== undefined) {
                        const taskText = (task.title !== '' ? `${task.title}\n` : '') + task.spec;
                        onOpenAgent?.(d.label !== '' ? d.label : task.id, agentName !== '' ? agentName : task.title, taskText.slice(0, 2000));
                      }
                    }}
                  >
                    <span className={`tb-status-dot task-status-${task.status}`} aria-hidden="true" />
                    <span className="tb-task-title">
                      {task.title !== '' ? task.title : task.id}
                      {task.gated === true && <span className="sx-badge sx-badge-warn" role="img" aria-label="gate waiting">⚠</span>}
                    </span>
                    {agentName !== '' && <span className="tb-task-agent">{agentName}</span>}
                  </button>
                  {task.gated === true && (
                    <span className="gate-actions">
                      <button type="button" className="approve" onClick={() => onReview?.(task.id, true)}>
                        {`Approve ${task.id}`}
                      </button>
                      <button type="button" className="deny" onClick={() => onReview?.(task.id, false)}>
                        {`Deny ${task.id}`}
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {delegations.length > 0 && (
            <section className="delegations" aria-label="delegations">
              <h3>delegations</h3>
              <ul className="delegation-list">
                {delegations.map((d) => {
                  const name = d.title !== undefined && d.title !== '' ? d.title : d.label;
                  return (
                    <li key={d.id} className={`delegation delegation-${d.status}`}>
                      <button
                        type="button"
                        className="delegation-main"
                        aria-label={`open agent ${d.label}`}
                        data-tip={t('Open subagent transcript', '打开子代理转录')}
                        onClick={() => onOpenAgent?.(d.label, name, d.title)}
                      >
                          <span className="delegation-title">{name}</span>
                          <span className={`sx-subagent-status delegation-${d.status}`}>{DELEGATION_STATUS_TEXT[d.status] ?? d.status}</span>
                      </button>
                      {d.label !== name && <span className="delegation-id">{d.label}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      ) : (
        <TaskDag group={group} board={board} delegations={delegations} onOpenAgent={onOpenAgent} byId={byId} />
      )}
    </section>
  );
}

/** 流程图体(完整 DAG):节点=状态点+任务名+子代理名;依赖曲线连线(箭头指向下游) */
function TaskDag({
  group,
  board,
  delegations,
  onOpenAgent,
  byId,
}: {
  group: BoardTask[];
  board: TaskBoardState;
  delegations: readonly Delegation[];
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  byId: Map<string, BoardTask>;
}): JSX.Element {
  const nodes = useMemo(() => layoutBoard(group), [group]);
  const BOX_W = 190;
  const BOX_H = 54;
  const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  if (nodes.length === 0) return <p className="board-empty">{t('Task board is empty.', '任务板为空——尚无任务。')}</p>;
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const maxY = Math.max(...nodes.map((n) => n.y));
  return (
    <div className="board-dag-scroll">
      <svg className="board-dag" width={maxX + BOX_W + 40} height={maxY + BOX_H + 40} role="img" aria-label="task dag">
        <defs>
          <marker id="tb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" className="dag-arrow" />
          </marker>
        </defs>
        {nodes.flatMap((n) => {
          const task = byId.get(n.id) ?? board.tasks[n.id];
          if (task === undefined) return [];
          return task.dependsOn
            .filter((d) => pos.has(d))
            .map((d) => {
              const from = pos.get(d)!;
              const x1 = from.x + BOX_W;
              const y1 = from.y + BOX_H / 2;
              const x2 = n.x;
              const y2 = n.y + BOX_H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={`e-${d}-${n.id}`}
                  className={`dag-edge${task.status === 'done' ? ' done' : ''}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}`}
                  markerEnd="url(#tb-arrow)"
                />
              );
            });
        })}
        {nodes.flatMap((n) => {
          const task = byId.get(n.id) ?? board.tasks[n.id];
          if (task === undefined) return [];
          const d = agentOfTask(task, delegations);
          const agentName = d !== undefined ? (d.title !== undefined && d.title !== '' ? d.title : d.label) : task.assignee !== undefined ? `@${task.assignee}` : '';
          const cls = `task-box task-status-${task.status}${task.gated === true ? ' gated' : ''}${task.status === 'done' ? ' done' : ''}`;
          return (
            <g
              key={n.id}
              data-task={n.id}
              className={cls}
              role="button"
              aria-label={`${task.id} [${task.status}] ${task.title}`}
              onClick={() => {
                if (d !== undefined) {
                  const taskText = (task.title !== '' ? `${task.title}\n` : '') + task.spec;
                  onOpenAgent?.(d.label !== '' ? d.label : task.id, agentName !== '' ? agentName : task.title, taskText.slice(0, 2000));
                }
              }}
            >
              <rect x={n.x} y={n.y} width={BOX_W} height={BOX_H} rx={22} /> /* G14.204 */
              <circle cx={n.x + 16} cy={n.y + 17} r={4} className="dag-dot" />
              <text x={n.x + 26} y={n.y + 21} className="box-title">
                {trunc(task.title !== '' ? task.title : task.id, 14)}
              </text>
              <text x={n.x + 12} y={n.y + 40} className="box-agent">
                {trunc(agentName !== '' ? agentName : `${t('pending dispatch', '待派发')} · ${task.id}`, 20)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function TaskBoardTab({ board, delegations, turnGoal, onOpenAgent, onReview, focus }: TaskBoardTabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // G14.176 定位高亮:nonce 变更→按 id/标题找行→滚动居中+flash 高亮(1.8s 退场)
  useEffect(() => {
    if (focus === undefined || focus === null || focus.ref === '') return;
    const norm = focus.ref.replace(/^task-/, '');
    const rows = [...(rootRef.current?.querySelectorAll('.tb-task-main') ?? [])];
    const hit = rows.find((r) => {
      const id = r.getAttribute('data-task-id') ?? '';
      const title = r.getAttribute('data-task-title') ?? '';
      return id === focus.ref || id === norm || title === focus.ref;
    });
    if (hit === undefined) return;
    hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    hit.classList.add('flash');
    const t = setTimeout(() => hit.classList.remove('flash'), 1800);
    return () => clearTimeout(t);
  }, [focus?.nonce, focus?.ref]);
  const tasks = useMemo(() => Object.values(board.tasks), [board]);
  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  if (tasks.length === 0 && delegations.length === 0) {
    return (
      <div className="taskboard-cards" aria-label="task board" ref={rootRef}>
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">任务板为空</p>
          <p className="board-empty-hint">智能体创建任务后会显示在这里。</p>
        </div>
      </div>
    );
  }
  return (
    <div className="taskboard-cards" aria-label="task board">
      {/* G14.174 无任务但有委派(纯 fork 派发)也出一卡承载委派区 */}
      {(groups.length > 0 ? [...groups].reverse() : [[]]).map((group, i) => (
        <TaskCard
          key={group[0]?.id ?? `delegations-only-${i}`}
          group={group}
          board={board}
          delegations={delegations}
          turnGoal={turnGoal}
          onOpenAgent={onOpenAgent}
          onReview={onReview}
        />
      ))}
    </div>
  );
}
