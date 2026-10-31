import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, RefreshCw, Square } from 'lucide-react';
import type { TaskBoardState, Delegation, BoardTask } from '../projection';
import { t } from '../i18n';
import { shortStampMs } from '../ui-util';

/** DAG 视图懒载面(React Flow + dagre)。节点与列表行共用五态点色与停钮。 */
const TaskDag = lazy(() => import('./TaskDag'));

/**
 * 任务板：一队一卡，卡头为团队名称（teams.name：快照 + team-created / task-created 直播）。
 * 卡内列表 | DAG，只含该 teamId 的任务。
 * 五态只以点色表达：pending 灰、running 转圈、success 蓝、failed 红、cancelled 黄且标题划线。
 * pending 与 running 的行在 hover 时露出停止，点击上抛 onStopTask。
 * 行点击打开执行中的子智能体转录。测试钩子：aria-label `${id} [${status}] ${title}`。
 */

export interface BoardTeamRef {
  readonly teamId: string;
  readonly name: string;
  readonly createdAt?: number;
}

export interface TaskBoardTabProps {
  readonly board: TaskBoardState;
  readonly delegations: readonly Delegation[];
  /** 团队清单（快照 + team-created / task-created 直播）：卡头名称；缺名时回退 teamId */
  readonly teams?: readonly BoardTeamRef[];
  /** 点击任务/节点跳对应子智能体只读页签 */
  readonly onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** pending|running 停止（App 注入 conn.boardStop） */
  readonly onStopTask?: (taskId: string) => void;
  /** create_task 行点开的定位信号：ref=任务 id 或标题；nonce 变更即滚动+高亮对应行 */
  readonly focus?: { ref: string; nonce: number } | null;
  /** 顶部刷新：sessionSnapshot 拉权威 board。返回 Promise 期间钮转圈 */
  readonly onRefresh?: () => Promise<void>;
}

/** 任务 → 委派投影：按 delegationId/label 同文命中，title 同文兜底 */
function agentOfTask(task: BoardTask, delegations: readonly Delegation[]): Delegation | undefined {
  const tag = /^t\d+$/.test(task.id) ? `task-${task.id}` : task.id;
  return (
    delegations.find((d) => d.id === tag || d.label === tag) ??
    delegations.find((d) => d.title !== undefined && d.title === task.title)
  );
}

/** 执行体显示名：优先板态 executedBy/assignee（队友名）；委派 label 与 task id 同文时不当作智能体名 */
function agentDisplayName(task: BoardTask, d: Delegation | undefined): string {
  const by = task.executedBy;
  if (typeof by === 'string' && by !== '' && by !== 'external-cli') return by;
  if (typeof task.assignee === 'string' && task.assignee !== '') return task.assignee;
  if (d === undefined) return '';
  const tag = /^t\d+$/.test(task.id) ? `task-${task.id}` : task.id;
  if (d.label === tag || d.label === task.id) return '';
  return d.label !== '' ? d.label : '';
}

function taskMatchesFocus(task: BoardTask, ref: string): boolean {
  const norm = ref.replace(/^task-/, '');
  return task.id === ref || task.id === norm || task.title === ref;
}

interface TeamGroup {
  teamId: string;
  name: string;
  tasks: BoardTask[];
}

function teamLabel(teamId: string, teams: readonly BoardTeamRef[]): string {
  const hit = teams.find((team) => team.teamId === teamId);
  if (hit !== undefined && hit.name !== '') return hit.name;
  if (teamId !== '') return teamId;
  return t('Team', '团队');
}

/** 一队一卡。已知团队按 createdAt 新者在上；快照未列的 teamId 按 id 排在后面。 */
function groupByTeam(tasks: readonly BoardTask[], teams: readonly BoardTeamRef[]): TeamGroup[] {
  const buckets = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    const bucket = buckets.get(task.teamId);
    if (bucket === undefined) buckets.set(task.teamId, [task]);
    else bucket.push(task);
  }
  const sortTasks = (list: BoardTask[]): BoardTask[] =>
    [...list].sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const seen = new Set<string>();
  const groups: TeamGroup[] = [];
  const known = teams
    .filter((team) => buckets.has(team.teamId))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  for (const team of known) {
    if (seen.has(team.teamId)) continue;
    seen.add(team.teamId);
    groups.push({ teamId: team.teamId, name: teamLabel(team.teamId, teams), tasks: sortTasks(buckets.get(team.teamId) ?? []) });
  }
  for (const teamId of [...buckets.keys()].filter((id) => !seen.has(id)).sort((a, b) => a.localeCompare(b))) {
    groups.push({ teamId, name: teamLabel(teamId, teams), tasks: sortTasks(buckets.get(teamId) ?? []) });
  }
  return groups;
}

type CardView = 'list' | 'dag';

const STOPPABLE = new Set<BoardTask['status']>(['pending', 'running']);

function TaskCard({
  group,
  board,
  delegations,
  onOpenAgent,
  onStopTask,
  focus,
}: {
  group: TeamGroup;
  board: TaskBoardState;
  delegations: readonly Delegation[];
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  onStopTask?: (taskId: string) => void;
  focus?: { ref: string; nonce: number } | null;
}): JSX.Element {
  const [view, setView] = useState<CardView>('list');
  const latestMs = group.tasks.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0);
  const byId = useMemo(() => new Map(group.tasks.map((x) => [x.id, x])), [group.tasks]);
  const focusTaskId = useMemo(() => {
    if (focus === undefined || focus === null || focus.ref === '') return undefined;
    return group.tasks.find((task) => taskMatchesFocus(task, focus.ref))?.id;
  }, [focus?.ref, focus?.nonce, group.tasks]);
  const openTaskAgent = (task: BoardTask): void => {
    const d = agentOfTask(task, delegations);
    const agentName = agentDisplayName(task, d);
    if (agentName === '' && d === undefined) return;
    const label = agentName !== '' ? agentName : (d !== undefined && d.label !== '' ? d.label : task.id);
    const taskText = (task.title !== '' ? `${task.title}\n` : '') + task.spec;
    onOpenAgent?.(label, agentName !== '' ? agentName : task.title, taskText);
  };
  return (
    <section className="tb-card" data-team-id={group.teamId}>
      <div className="tb-card-head">
        <div className="view-toggle" role="group" aria-label="task card view">
          <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            {t('List', '列表')}
          </button>
          <button type="button" aria-pressed={view === 'dag'} className={view === 'dag' ? 'active' : ''} onClick={() => setView('dag')}>
            DAG
          </button>
        </div>
        <span className="tb-team-name">{group.name}</span>
        <span className="todo-card-time">{shortStampMs(latestMs)}</span>
      </div>
      {view === 'list' ? (
        <ul className="tb-task-list" aria-label="task list">
          {group.tasks.map((task) => {
            const d = agentOfTask(task, delegations);
            const agentName = agentDisplayName(task, d);
            const title = task.title !== '' ? task.title : task.id;
            return (
              <li key={task.id} className={`tb-task-row task-status-${task.status}`}>
                <button
                  type="button"
                  className="tb-task-main" data-task-id={task.id} data-task-title={task.title}
                  aria-label={`${task.id} [${task.status}] ${task.title}`}
                  data-tip={agentName !== '' ? t('View subagent', '查看子智能体') : undefined}
                  onClick={() => openTaskAgent(task)}
                >
                  <span className={`tb-status-dot task-status-${task.status}`} aria-hidden="true" />
                  <span className={`tb-task-title${task.status === 'cancelled' ? ' tb-struck' : ''}`}>{title}</span>
                  {agentName !== '' && (
                    <span className="tb-task-agent">
                      <Bot size={11} strokeWidth={1.75} aria-hidden="true" />
                      {agentName}
                    </span>
                  )}
                </button>
                {STOPPABLE.has(task.status) && (
                  <button
                    type="button"
                    className="tb-stop"
                    aria-label={`${t('Stop', '停止')} ${task.id}`}
                    data-tip={t('Stop', '停止')}
                    onClick={() => onStopTask?.(task.id)}
                  >
                    <Square size={11} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="tb-dag-wrap">
          <div className="board-dag-scroll tb-dag-scroll">
            <Suspense fallback={<div className="tb-dag-loading">{t('Loading graph…', '流程图加载中…')}</div>}>
              <TaskDag
                tasks={group.tasks}
                agentOf={(taskId) => {
                  const task = byId.get(taskId) ?? board.tasks[taskId];
                  if (task === undefined) return '';
                  return agentDisplayName(task, agentOfTask(task, delegations));
                }}
                focusId={focusTaskId}
                focusNonce={focus?.nonce}
                onTaskOpen={(taskId) => {
                  const task = byId.get(taskId) ?? board.tasks[taskId];
                  if (task === undefined) return;
                  openTaskAgent(task);
                }}
                onStopTask={onStopTask}
              />
            </Suspense>
          </div>
        </div>
      )}
    </section>
  );
}

export function TaskBoardTab({ board, delegations, teams = [], onOpenAgent, onStopTask, focus, onRefresh }: TaskBoardTabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = (): void => {
    if (refreshing || onRefresh === undefined) return;
    setRefreshing(true);
    void onRefresh().catch(() => {}).finally(() => setRefreshing(false));
  };
  const bar = onRefresh !== undefined && (
    <div className="insight-bar tb-board-bar">
      <button type="button" className="sx-changes-act" aria-label="refresh" data-tip={refreshing ? t('Refreshing…', '刷新中…') : t('Refresh', '刷新')} disabled={refreshing} onClick={refresh}>
        <RefreshCw size={13} strokeWidth={1.75} className={refreshing ? 'sx-fetching' : undefined} />
      </button>
    </div>
  );
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
    const timer = setTimeout(() => hit.classList.remove('flash'), 1800);
    return () => clearTimeout(timer);
  }, [focus?.nonce, focus?.ref]);
  const tasks = useMemo(() => Object.values(board.tasks), [board]);
  const groups = useMemo(() => groupByTeam(tasks, teams), [tasks, teams]);
  if (tasks.length === 0) {
    return (
      <div className="insight-tab">
        {bar}
        <div className="taskboard-cards" aria-label="task board" ref={rootRef}>
          <div className="board-empty-state" role="status">
            <p className="board-empty-title">{t('Task board is empty', '任务板为空')}</p>
            <p className="board-empty-hint">{t('Tasks appear here once agents create them.', '智能体创建任务后会显示在这里。')}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="insight-tab">
      {bar}
      <div className="taskboard-cards" aria-label="task board" ref={rootRef}>
        {groups.map((group) => (
          <TaskCard
            key={group.teamId}
            group={group}
            board={board}
            delegations={delegations}
            onOpenAgent={onOpenAgent}
            onStopTask={onStopTask}
            focus={focus}
          />
        ))}
      </div>
    </div>
  );
}
