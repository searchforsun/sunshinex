import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import type { TaskBoardState, Delegation, BoardTask } from '../projection';
import { t } from '../i18n';
import { shortStampMs } from '../ui-util';

/** DAG 视图懒载面(React Flow@xyflow/react + dagre 布局,开源组件——mermaid 拼源退役):
 *  节点=状态图标+任务名+🤖执行子代理名,平移/缩放/控制钮组件内置;不进主 bundle */
const TaskDag = lazy(() => import('./TaskDag'));

/**
 * G14.174 「任务板」页签体(原 Agents 页签重定位):卡片流——任务按创建批次分卡(≈每轮一卡,
 * createdAt 间隔 >2min 即新批,时间由上到下、渲染最新在顶)。
 * G14.213 按用户设计重构:
 * - 卡头 = [列表|流程图 切换(左)] + 轮次用户输入(单行省略) + 时间(右)
 * - 只显示任务:页内 DELEGATIONS 委派段去除(委派状态走右侧徽标面);行=状态图标+任务名+
 *   执行子代理名(仅执行/完成态显,等待态不显)→ 点击跳对应子 agent 页签(等待态不跳)
 * - 状态图标三态:运行(claimed/in_review)=转圈;完成=蓝点;等待(pending)=灰点;失败=红点
 * - DAG(G14.2xx 用户裁定换开源 DAG 渲染组件):React Flow(@xyflow/react)+dagre 自动布局
 *   (@dagrejs/dagre),替代 mermaid 拼源渲染——预设高度内组件自管平移/滚轮缩放/控制钮;
 *   START/END 虚拟节点补齐并行任务的起止形态;边=内置虚线流动动画;
 *   节点=状态图标+任务名+🤖子代理名,点击跳对应子 agent(等待态无委派不跳)。
 * 测试钩子沿用:行内 Approve/Deny 按钮、aria-label `${id} [${status}] ${title}`。
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

/** 任务 → 执行子代理:委派表按 delegationId/label 同文命中——委派标签=dispatchTag(板 id):
 *  新方言(2026-10-19)板 id 自带 task- 类别段即本形,旧恢复档 tN 补 task- 前缀;title 同文兜底 */
function agentOfTask(task: BoardTask, delegations: readonly Delegation[]): Delegation | undefined {
  const tag = /^t\d+$/.test(task.id) ? `task-${task.id}` : task.id;
  return (
    delegations.find((d) => d.id === tag || d.label === tag) ??
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
  const latestMs = group.reduce((m, x) => Math.max(m, x.updatedAt ?? 0), 0);
  const byId = useMemo(() => new Map(group.map((x) => [x.id, x])), [group]);
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
                  data-tip={agentName !== '' ? t('View subagent', '查看子智能体') : undefined}
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
                  {agentName !== '' && (
                    <span className="tb-task-agent">
                      {/* G14.213 执行子代理=机器人头标识(与 DAG 节点 🤖 同语言) */}
                      <Bot size={11} strokeWidth={1.75} aria-hidden="true" />
                      {agentName}
                    </span>
                  )}
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
          <div className="board-dag-scroll tb-dag-scroll">
            {/* G14.2xx 开源 DAG 组件(React Flow/dagre):节点=状态+任务名+🤖子代理名,
                点击 → 跳对应子 agent(等待态无委派不可点);lazy 载入,chunk 拉起前显占位 */}
            <Suspense fallback={<div className="tb-dag-loading">{t('Loading graph…', '流程图加载中…')}</div>}>
              <TaskDag
                tasks={group}
                agentOf={(taskId) => {
                  const task = byId.get(taskId) ?? board.tasks[taskId];
                  if (task === undefined) return '';
                  const d = agentOfTask(task, delegations);
                  return d !== undefined ? (d.label !== '' ? d.label : (d.title ?? '')) : '';
                }}
                onTaskOpen={(taskId) => {
                  const task = byId.get(taskId) ?? board.tasks[taskId];
                  if (task === undefined) return;
                  const d = agentOfTask(task, delegations);
                  if (d === undefined) return; // 等待态:无执行子代理,不跳转
                  const taskText = (task.title !== '' ? `${task.title}\n` : '') + task.spec;
                  onOpenAgent?.(d.label !== '' ? d.label : task.id, d.title !== undefined && d.title !== '' ? d.title : task.title, taskText.slice(0, 2000));
                }}
              />
            </Suspense>
          </div>
        </div>
      )}
    </section>
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
          <p className="board-empty-title">{t('Task board is empty', '任务板为空')}</p>
          <p className="board-empty-hint">{t('Tasks appear here once agents create them.', '智能体创建任务后会显示在这里。')}</p>
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
