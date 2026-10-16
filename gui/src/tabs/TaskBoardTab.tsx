import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { layoutBoard } from '../board-layout';
import type { TaskBoardState, Delegation, BoardTask } from '../projection';
import { t } from '../i18n';
import { shortStampMs } from '../ui-util';

/**
 * G14.174 「任务板」页签体(原 Agents 页签重定位):卡片流——任务按创建批次分卡(≈每轮一卡,
 * createdAt 间隔 >2min 即新批,时间由上到下、渲染最新在顶)。
 * G14.213 按用户设计重构:
 * - 卡头 = [列表|流程图 切换(左)] + 轮次用户输入(单行省略) + 时间(右)
 * - 只显示任务:页内 DELEGATIONS 委派段去除(委派状态走右侧徽标面);行=状态图标+任务名+
 *   执行子代理名(仅执行/完成态显,等待态不显)→ 点击跳对应子 agent 页签(等待态不跳)
 * - 状态图标三态:运行(claimed/in_review)=转圈;完成=蓝点;等待(pending)=灰点;失败=红点
 * - DAG:预设高度滚动,右上角放大钮 → 弹窗大图(同一 svg 复用);节点同列表行语义
 * 测试钩子沿用:svg.board-dag/[data-task]/gated 类钩、行内 Approve/Deny 按钮、
 * aria-label `${id} [${status}] ${title}`。DAG 选型:仓内 layoutBoard(Kahn 分层,零新依赖)+自绘 svg。
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

/** 批次切分间隔:相邻创建时刻超过该值即视为新一轮任务的卡片(ms) */
const BATCH_GAP_MS = 120_000;

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

/** 单卡:头部=[列表|流程图(左)]+轮次输入(单行省略)+时间;体=列表|DAG 两型;DAG 可放大弹窗 */
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
  const [zoom, setZoom] = useState(false);
  const latestMs = group.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0);
  const byId = useMemo(() => new Map(group.map((x) => [x.id, x])), [group]);
  const dagEl = (
    <TaskDag group={group} board={board} delegations={delegations} onOpenAgent={onOpenAgent} byId={byId} />
  );
  return (
    <section className="tb-card">
      <div className="tb-card-head">
        <div className="view-toggle" role="group" aria-label="task card view">
          <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            {t('List', '列表')}
          </button>
          <button type="button" aria-pressed={view === 'dag'} className={view === 'dag' ? 'active' : ''} onClick={() => setView('dag')}>
            DAG
          </button>
        </div>
        <span className="todo-card-goal">{turnGoal !== '' ? turnGoal : t('(no turn input)', '(未关联轮次输入)')}</span>
        <span className="todo-card-time">{shortStampMs(latestMs)}</span>
      </div>
      {view === 'list' ? (
        <ul className="tb-task-list" aria-label="task list">
          {group.map((task) => {
            const d = agentOfTask(task, delegations);
            // G14.213 子代理名仅执行/完成态显(等待态无委派不显);点击仅委派在场可跳
            const agentName = d !== undefined ? (d.label !== '' ? d.label : (d.title ?? '')) : '';
            return (
              <li key={task.id} className={`tb-task-row task-status-${task.status}${task.gated === true ? ' gated' : ''}`}>
                <button
                  type="button"
                  className="tb-task-main" data-task-id={task.id} data-task-title={task.title}
                  aria-label={`${task.id} [${task.status}] ${task.title}`}
                  data-tip={agentName !== '' ? t('Open subagent transcript', '打开子代理转录') : undefined}
                  onClick={() => {
                    if (d === undefined) return; // 等待态:无执行子代理,不跳转
                    const taskText = (task.title !== '' ? `${task.title}\n` : '') + task.spec;
                    onOpenAgent?.(d.label !== '' ? d.label : task.id, agentName !== '' ? agentName : task.title, taskText.slice(0, 2000));
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
      ) : (
        <div className="tb-dag-wrap">
          <div className="board-dag-scroll tb-dag-scroll">{dagEl}</div>
          {/* G14.213 右上角放大钮:弹窗大图(同一 DAG 复用) */}
          <button type="button" className="tb-dag-zoom" aria-label={t('Zoom DAG', '放大流程图')} data-tip={t('Zoom', '放大')} onClick={() => setZoom(true)}>
            <Maximize2 size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}
      {zoom && (
        <div className="dag-zoom-overlay" onClick={() => setZoom(false)}>
          <div className="dag-zoom-body" onClick={(e) => e.stopPropagation()}>
            <div className="dag-zoom-head">
              <span className="todo-card-goal">{turnGoal !== '' ? turnGoal : t('(no turn input)', '(未关联轮次输入)')}</span>
              <button type="button" className="tb-dag-zoom-close" aria-label={t('Close', '关闭')} onClick={() => setZoom(false)}>
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <div className="board-dag-scroll dag-zoom-scroll">{dagEl}</div>
          </div>
        </div>
      )}
    </section>
  );
}

/** 流程图体(完整 DAG):节点=状态点+任务名(+执行子代理名,等待态不显);依赖曲线连线(箭头指向下游);
 *  节点点击同列表行——仅委派在场(执行/完成态)跳对应子 agent,等待态不跳 */
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
          // G14.213 子代理名仅执行/完成态显(等待态不显);点击仅委派在场可跳(等待态不跳)
          const agentName = d !== undefined ? (d.label !== '' ? d.label : (d.title ?? '')) : '';
          const cls = `task-box task-status-${task.status}${task.gated === true ? ' gated' : ''}${task.status === 'done' ? ' done' : ''}`;
          return (
            <g
              key={n.id}
              data-task={n.id}
              className={cls}
              role="button"
              aria-label={`${task.id} [${task.status}] ${task.title}`}
              onClick={() => {
                if (d === undefined) return; // 等待态:无执行子代理,不跳转
                const taskText = (task.title !== '' ? `${task.title}\n` : '') + task.spec;
                onOpenAgent?.(d.label !== '' ? d.label : task.id, agentName !== '' ? agentName : task.title, taskText.slice(0, 2000));
              }}
            >
              <rect x={n.x} y={n.y} width={BOX_W} height={BOX_H} rx={22} /> /* G14.204 */
              <circle cx={n.x + 16} cy={n.y + 17} r={4} className="dag-dot" />
              <text x={n.x + 26} y={n.y + 21} className="box-title">
                {trunc(task.title !== '' ? task.title : task.id, 14)}
              </text>
              {agentName !== '' && (
                <text x={n.x + 12} y={n.y + 40} className="box-agent">
                  {trunc(agentName, 20)}
                </text>
              )}
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
  if (tasks.length === 0) {
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
    <div className="taskboard-cards" aria-label="task board" ref={rootRef}>
      {[...groups].reverse().map((group) => (
        <TaskCard
          key={group[0]?.id ?? `group-${group.length}`}
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
