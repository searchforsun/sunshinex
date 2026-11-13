import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, Bot, Clock, RefreshCw, Square } from 'lucide-react';
import type { TaskBoardState, Delegation, BoardTask } from '../projection';
import { t } from '../i18n';
import { dateStampMs, fmtDurMs, withMinSpin } from '../ui-util';
/** DAG 视图懒载面(React Flow + dagre)。节点与列表行共用五态点色与停钮。 */
const TaskDag = lazy(() => import('./TaskDag'));

/**
 * 智能体团队页签：一队一卡，卡头为团队名称（teams.name：快照 + team-created / task-created 直播）。
 * 卡内三分栏：成员 | 任务 | 编排（默认任务）。
 * 五态只以点色表达：pending 灰、running 转圈、success 蓝、failed 红、cancelled 黄且标题划线。
 * pending 与 running 的行在 hover 时露出停止，点击上抛 onStopTask。
 * 行点击打开执行中的子智能体转录。测试钩子：aria-label `${id} [${status}] ${title}`。
 */

export interface BoardTeamRef {
  readonly teamId: string;
  readonly name: string;
  readonly createdAt?: number;
}

/** 存活成员（快照 team 段；teamId 用于按队过滤；createdAt=名册创建时刻） */
export interface TeamMemberRef {
  readonly name: string;
  readonly busy: boolean;
  readonly teamId?: string;
  readonly createdAt?: number;
}

export interface TaskBoardTabProps {
  readonly board: TaskBoardState;
  readonly delegations: readonly Delegation[];
  /** 团队清单（快照 + team-created / task-created 直播）：卡头名称；缺名时回退 teamId */
  readonly teams?: readonly BoardTeamRef[];
  /** 存活成员清单（快照 team）；按队卡 teamId 过滤 */
  readonly members?: readonly TeamMemberRef[];
  /** 点击任务/节点/成员跳对应子智能体只读页签(第 4 参=板任务 id,转录页定位到该任务气泡) */
  readonly onOpenAgent?: (label: string, agentTitle: string, task?: string, focusTaskId?: string) => void;
  /** pending|running 停止（App 注入 conn.boardStop） */
  readonly onStopTask?: (taskId: string) => void;
  /** 工具行点开的定位信号：kind=task 高亮任务行并切到任务栏；kind=team 高亮队卡（ref=teamId 或队名） */
  readonly focus?: { ref: string; nonce: number; kind?: 'task' | 'team' } | null;
  /** 顶部刷新：sessionSnapshot 拉权威 board/teams/team。返回 Promise 期间钮转圈 */
  readonly onRefresh?: () => Promise<void>;
  /** 正文/顶栏打开侧栏时 App 递增——主动刷一次 */
  readonly refreshNonce?: number;
}

/** 任务 → 委派投影：按 delegationId/label 同文命中，title 同文兜底 */
function agentOfTask(task: BoardTask, delegations: readonly Delegation[]): Delegation | undefined {
  const tag = /^t\d+$/.test(task.id) ? `task-${task.id}` : task.id;
  return (
    delegations.find((d) => d.id === tag || d.label === tag) ??
    delegations.find((d) => d.title !== undefined && d.title === task.title)
  );
}

/** 执行体显示名：优先板态 executedBy/assignee（成员名）；委派 label 与 task id 同文时不当作智能体名 */
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

  /** 一队一卡。已知团队（含尚无任务的空队）按 createdAt 新者在上；快照未列的 teamId 按 id 排在后面。 */
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
  const known = [...teams].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
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

/** 队卡成员：优先 teamId 精确匹配；缺 teamId 的旧快照回落——单队全显，多队则按任务 assignee/executedBy 归属 */
function membersOfTeam(
  teamId: string,
  members: readonly TeamMemberRef[],
  tasks: readonly BoardTask[],
  teamCount: number,
): TeamMemberRef[] {
  const withId = members.filter((m) => typeof m.teamId === 'string' && m.teamId !== '');
  if (withId.length > 0) return withId.filter((m) => m.teamId === teamId);
  if (teamCount <= 1) return [...members];
  const names = new Set<string>();
  for (const task of tasks) {
    if (typeof task.assignee === 'string' && task.assignee !== '') names.add(task.assignee);
    if (typeof task.executedBy === 'string' && task.executedBy !== '' && task.executedBy !== 'external-cli') {
      names.add(task.executedBy);
    }
  }
  return members.filter((m) => names.has(m.name));
}

type CardView = 'members' | 'tasks' | 'orchestration';

const STOPPABLE = new Set<BoardTask['status']>(['pending', 'running']);

/** 完成耗时=artifact.durationMs；运行中=自进入 running 的 updatedAt 起算（板态无独立 startedAt） */
function taskDurationMs(task: BoardTask, now: number): number | undefined {
  const finished = task.artifact?.durationMs;
  if (typeof finished === 'number' && finished >= 0
    && (task.status === 'success' || task.status === 'failed' || task.status === 'cancelled')) {
    return finished;
  }
  if (task.status === 'running' && task.updatedAt > 0) return Math.max(0, now - task.updatedAt);
  return undefined;
}

function TaskCard({
  group,
  board,
  delegations,
  members,
  teamCount,
  teamCreatedAt,
  onOpenAgent,
  onStopTask,
  focus,
}: {
  group: TeamGroup;
  board: TaskBoardState;
  delegations: readonly Delegation[];
  members: readonly TeamMemberRef[];
  teamCount: number;
  teamCreatedAt?: number;
  onOpenAgent?: (label: string, agentTitle: string, task?: string, focusTaskId?: string) => void;
  onStopTask?: (taskId: string) => void;
  focus?: { ref: string; nonce: number; kind?: 'task' | 'team' } | null;
}): JSX.Element {
  const [view, setView] = useState<CardView>('tasks');
  /** 停止二段确认武装态(2026-11-02 用户裁定「点击按钮变红边框」):首击红边武装,3s 内再击执行 */
  const [armedStop, setArmedStop] = useState<string | null>(null);
  const hasRunning = group.tasks.some((x) => x.status === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);
  const headStamp = teamCreatedAt !== undefined && teamCreatedAt > 0
    ? teamCreatedAt
    : group.tasks.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0);
  const byId = useMemo(() => new Map(group.tasks.map((x) => [x.id, x])), [group.tasks]);
  const focusTaskId = useMemo(() => {
    if (focus === undefined || focus === null || focus.ref === '' || focus.kind === 'team') return undefined;
    return group.tasks.find((task) => taskMatchesFocus(task, focus.ref))?.id;
  }, [focus?.ref, focus?.nonce, focus?.kind, group.tasks]);
  // 工具行定位到任务：切到任务栏（编排面 DAG 自带 focusId，仍可高亮）
  useEffect(() => {
    if (focusTaskId === undefined) return;
    setView('tasks');
  }, [focus?.nonce, focusTaskId]);
  const teamMembers = useMemo(
    () => membersOfTeam(group.teamId, members, group.tasks, teamCount),
    [group.teamId, group.tasks, members, teamCount],
  );
  const openTaskAgent = (task: BoardTask): void => {
    const d = agentOfTask(task, delegations);
    const agentName = agentDisplayName(task, d);
    if (agentName === '' && d === undefined) return;
    const label = agentName !== '' ? agentName : (d !== undefined && d.label !== '' ? d.label : task.id);
    const taskText = (task.title !== '' ? `${task.title}\n` : '') + task.spec;
    onOpenAgent?.(label, agentName !== '' ? agentName : task.title, taskText, task.id);
  };
  return (
    <section className="tb-card" data-team-id={group.teamId}>
      <div className="tb-card-head">
        <div className="view-toggle" role="group" aria-label="task card view">
          <button type="button" aria-pressed={view === 'members'} className={view === 'members' ? 'active' : ''} onClick={() => setView('members')}>
            {t('Members', '成员')}
          </button>
          <button type="button" aria-pressed={view === 'tasks'} className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>
            {t('Tasks', '任务')}
          </button>
          <button type="button" aria-pressed={view === 'orchestration'} className={view === 'orchestration' ? 'active' : ''} onClick={() => setView('orchestration')}>
            {t('Orchestration', '编排')}
          </button>
        </div>
        <span className="tb-team-name">{group.name}</span>
        {headStamp > 0 && (
          <span className="todo-card-time" data-tip={t('Created', '创建时间')}>
            <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
            {dateStampMs(headStamp)}
          </span>
        )}
      </div>
      {view === 'members' ? (
        teamMembers.length === 0 ? (
          <div className="board-empty-state tb-members-empty" role="status">
            <p className="board-empty-title">{t('No members', '暂无成员')}</p>
          </div>
        ) : (
          <ul className="tb-task-list" aria-label="member list">
            {teamMembers.map((m) => (
              <li key={m.name} className={`tb-task-row${m.busy ? ' task-status-running' : ''}`}>
                <button
                  type="button"
                  className="tb-task-main"
                  data-member-name={m.name}
                  aria-label={`${m.name}${m.busy ? ' [busy]' : ''}`}
                  data-tip={t('Open subagent', '打开子智能体')}
                  onClick={() => onOpenAgent?.(m.name, m.name)}
                >
                  <span className={`tb-status-dot${m.busy ? ' task-status-running' : ' task-status-pending'}`} aria-hidden="true" />
                  <span className="tb-task-title">{m.name}</span>
                  <span className="tb-task-agent">
                    <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
                    {m.busy ? t('busy', '忙碌') : t('idle', '空闲')}
                  </span>
                  {typeof m.createdAt === 'number' && m.createdAt > 0 && (
                    <span className="todo-card-time" data-tip={t('Created', '创建时间')}>
                      <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
                      {dateStampMs(m.createdAt)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : view === 'tasks' ? (
        <ul className="tb-task-list" aria-label="task list">
          {group.tasks.map((task) => {
            const d = agentOfTask(task, delegations);
            const agentName = agentDisplayName(task, d);
            const title = task.title !== '' ? task.title : task.id;
            const dur = taskDurationMs(task, now);
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
                      <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
                      {agentName}
                    </span>
                  )}
                  {dur !== undefined && (
                    <span className="bg-dur" data-tip={t('Elapsed', '运行时长')}>
                      <AlarmClock size={14} strokeWidth={1.75} aria-hidden="true" />
                      {fmtDurMs(dur)}
                    </span>
                  )}
                  {task.createdAt > 0 && (
                    <span className="todo-card-time" data-tip={t('Created', '创建时间')}>
                      <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
                      {dateStampMs(task.createdAt)}
                    </span>
                  )}
                </button>
                {STOPPABLE.has(task.status) && (
                  <button
                    type="button"
                    className={`tb-stop${armedStop === task.id ? ' arm' : ''}`}
                    aria-label={`${t('Stop', '停止')} ${task.id}`}
                    data-tip={armedStop === task.id ? t('Click again to confirm', '再次点击确认') : t('Stop', '停止')}
                    onClick={() => {
                      if (armedStop === task.id) {
                        setArmedStop(null);
                        onStopTask?.(task.id);
                      } else {
                        setArmedStop(task.id);
                        setTimeout(() => setArmedStop((cur) => (cur === task.id ? null : cur)), 3000);
                      }
                    }}
                  >
                    <Square size={14} strokeWidth={2.25} fill="currentColor" aria-hidden="true" />
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
                durationOf={(taskId) => {
                  const task = byId.get(taskId) ?? board.tasks[taskId];
                  if (task === undefined) return undefined;
                  return taskDurationMs(task, now);
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

export function TaskBoardTab({ board, delegations, teams = [], members = [], onOpenAgent, onStopTask, focus, onRefresh, refreshNonce }: TaskBoardTabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 刷新失败可见化(D30 口径:静默吞=点了没反应;InsightTabs 停止失败横幅同款形态)
  const [actError, setActError] = useState('');
  const refresh = (): void => {
    if (refreshing || onRefresh === undefined) return;
    setRefreshing(true);
    void withMinSpin(onRefresh())
      .then(() => setActError(''))
      .catch((err: unknown) => setActError(`${t('Refresh failed', '刷新失败')}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setRefreshing(false));
  };
  // 正文打开 / 工具行定位:主动拉快照(成员名册仅快照有;busy 靠 delegation 直播)
  useEffect(() => {
    if (refreshNonce === undefined || onRefresh === undefined) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);
  useEffect(() => {
    if (focus === undefined || focus === null || onRefresh === undefined) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);
  const bar = onRefresh !== undefined && (
    <div className="insight-bar tb-board-bar">
      <button type="button" className="sx-changes-act" aria-label="refresh" data-tip={refreshing ? t('Refreshing…', '刷新中…') : t('Refresh', '刷新')} disabled={refreshing} onClick={refresh}>
        <RefreshCw size={14} strokeWidth={1.75} className={refreshing ? 'sx-fetching' : undefined} />
      </button>
      {actError !== '' && <p className="home-error" role="alert">{actError}</p>}
    </div>
  );
  useEffect(() => {
    if (focus === undefined || focus === null || focus.ref === '') return;
    // 定位共体（team/task 两分型仅选择器与判别面不同,滚动单点承载;2026-11-08 用户裁定撤闪光）
    const flashAndScroll = (hit: Element): (() => void) => {
      hit.scrollIntoView({ block: 'center' }); // 2026-11-08 用户裁定「去掉滑动」:瞬跳到位
      return () => undefined;
    };
    if (focus.kind === 'team') {
      const cards = [...(rootRef.current?.querySelectorAll('.tb-card') ?? [])];
      const hit = cards.find((card) => {
        const id = card.getAttribute('data-team-id') ?? '';
        const name = card.querySelector('.tb-team-name')?.textContent ?? '';
        return id === focus.ref || name === focus.ref;
      });
      return hit === undefined ? undefined : flashAndScroll(hit);
    }
    const norm = focus.ref.replace(/^task-/, '');
    const rows = [...(rootRef.current?.querySelectorAll('.tb-task-main') ?? [])];
    const hit = rows.find((r) => {
      const id = r.getAttribute('data-task-id') ?? '';
      const title = r.getAttribute('data-task-title') ?? '';
      return id === focus.ref || id === norm || title === focus.ref;
    });
    return hit === undefined ? undefined : flashAndScroll(hit);
  }, [focus?.nonce, focus?.ref, focus?.kind]);
  const tasks = useMemo(() => Object.values(board.tasks), [board]);
  const groups = useMemo(() => groupByTeam(tasks, teams), [tasks, teams]);
  const createdAtOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const team of teams) {
      if (typeof team.createdAt === 'number' && team.createdAt > 0) m.set(team.teamId, team.createdAt);
    }
    return m;
  }, [teams]);
  if (tasks.length === 0 && teams.length === 0) {
    return (
      <div className="insight-tab">
        {bar}
        <div className="taskboard-cards" aria-label="agent teams" ref={rootRef}>
          <div className="board-empty-state" role="status">
            <p className="board-empty-title">{t('Agent teams is empty', '智能体团队为空')}</p>
            <p className="board-empty-hint">{t('Teams appear here once agents create them.', '智能体创建团队后会显示在这里。')}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="insight-tab">
      {bar}
      <div className="taskboard-cards" aria-label="agent teams" ref={rootRef}>
        {groups.map((group) => (
          <TaskCard
            key={group.teamId}
            group={group}
            board={board}
            delegations={delegations}
            members={members}
            teamCount={groups.length}
            teamCreatedAt={createdAtOf.get(group.teamId)}
            onOpenAgent={onOpenAgent}
            onStopTask={onStopTask}
            focus={focus}
          />
        ))}
      </div>
    </div>
  );
}
