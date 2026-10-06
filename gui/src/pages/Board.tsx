import { useEffect, useMemo, useState } from 'react';
import { layoutBoard } from '../board-layout';
import type { TaskBoardState, Delegation, BoardTask } from '../projection';

/**
 * G5 看板页(编排 spec §10.3 的 GUI 版 / §13 P3):Board 从 props 纯消费——board/delegations
 * 投影来自 App(事件维稳:task-·gate-·delegation- 前缀帧经 applyBoardEvent/applyDelegation),
 * team 来自 App 态(sessionSnapshot.team,Chat 播种回调回填——事件流无 teammate 面)。
 * 双视图:List(行形态 `${id} [${status}]${gated?' ⚠':''} ${title} (needs d1 → d2) @w`——
 * TUI BoardList 同款信息序,gated 行内 Approve/Deny 小按钮 = gate 审批的 GUI 入口)与
 * DAG(layoutBoard 分层 svg:盒 140×50 + dependsOn 连线,gated 描边高亮/done 降透明度——
 * 类钩子交样式面)。右侧 teammate 侧栏(name+busy 点)+delegations 简列(label+status)。
 * gate 审批动作经 onReview 上抛(App 装配 conn.boardReview)——本页零连接依赖。
 */

export interface BoardProps {
  board: TaskBoardState;
  delegations: Delegation[];
  team: Array<{ name: string; busy: boolean }>;
  /** gate 审批上抛(taskId + approved)——App 接 conn.boardReview(sessionId, taskId, approved) */
  onReview: (taskId: string, approved: boolean) => void;
  /** 返回 Chat(会话内 tab 切换,App 装配) */
  onBack: () => void;
}

type View = 'list' | 'dag';

/** DAG 盒尺寸(与 layoutBoard 坐标步进配套:160/90 步进 = 140 盒宽 + 20 间隙) */
const BOX_W = 140;
const BOX_H = 50;
/** svg 画布边距:右/下留白(盒宽 140 + 文本余量) */
const CANVAS_PAD_X = 180;
const CANVAS_PAD_Y = 100;
/** 盒内 title 截断宽(≈140px 内 15 全角位) */
const TITLE_MAX = 15;

/** 依赖文字箭头:单依赖 `(needs t2)`、多依赖 ` → ` 串联(§10.3 文字依赖的 GUI 形) */
function needsText(dependsOn: string[]): string {
  return dependsOn.length === 0 ? '' : ` (needs ${dependsOn.join(' → ')})`;
}

/** 盒内/行内 title 截断:超宽省略号(全文在 List 行/详情面) */
function truncTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title;
}

/** List 视图:任务行(状态色钩 task-status-<status>;gated ⚠ + 行内审批) */
function BoardList({ board, onReview }: { board: TaskBoardState; onReview: (taskId: string, approved: boolean) => void }): JSX.Element {
  const tasks = Object.values(board.tasks).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  if (tasks.length === 0) return <p className="board-empty">任务板为空——尚无任务。</p>;
  return (
    <ul className="board-list" aria-label="task list">
      {tasks.map((t) => (
        <li key={t.id} className="board-row">
          <div className={`task-row task-status-${t.status}${t.gated === true ? ' gated' : ''}`}>
            {`${t.id} [${t.status}] ${t.title}${t.gated === true ? ' ⚠' : ''}${needsText(t.dependsOn)}${t.assignee !== undefined ? ` @${t.assignee}` : ''}`}
          </div>
          {t.gated === true && (
            <span className="gate-actions">
              <button type="button" className="approve" onClick={() => onReview(t.id, true)}>
                {`Approve ${t.id}`}
              </button>
              <button type="button" className="deny" onClick={() => onReview(t.id, false)}>
                {`Deny ${t.id}`}
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** DAG 视图:layoutBoard 分层 svg——盒(id+title 截断)+dependsOn 连线(线尾即箭头语义,
 *  自上而下依赖方向);gated 描边高亮/done 降透明度均为类钩子(样式面消费);节点点击选中
 *  (selectedId,再点同节点取消)→ 详情面板(brief 明文项:板投影内数据纯展示) */
function BoardDag({
  board,
  selectedId,
  onSelect,
}: {
  board: TaskBoardState;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}): JSX.Element {
  const nodes = useMemo(() => layoutBoard(Object.values(board.tasks)), [board]);
  if (nodes.length === 0) return <p className="board-empty">任务板为空——尚无任务。</p>;
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const maxY = Math.max(...nodes.map((n) => n.y));
  return (
    <svg className="board-dag" width={maxX + CANVAS_PAD_X} height={maxY + CANVAS_PAD_Y} role="img" aria-label="task dag">
      {nodes.flatMap((n) => {
        const task = board.tasks[n.id];
        if (task === undefined) return [];
        return task.dependsOn
          .filter((d) => pos.has(d))
          .map((d) => {
            const from = pos.get(d)!;
            return (
              <line
                key={`e-${d}-${n.id}`}
                className="dag-edge"
                x1={from.x + BOX_W}
                y1={from.y + BOX_H / 2}
                x2={n.x}
                y2={n.y + BOX_H / 2}
              />
            );
          });
      })}
      {nodes.flatMap((n) => {
        const task = board.tasks[n.id];
        if (task === undefined) return [];
        const cls = `task-box task-status-${task.status}${task.gated === true ? ' gated' : ''}${task.status === 'done' ? ' done' : ''}${
          n.id === selectedId ? ' selected' : ''
        }`;
        return (
          <g
            key={n.id}
            data-task={n.id}
            className={cls}
            role="button"
            aria-label={`task ${n.id}`}
            onClick={() => onSelect(n.id)}
          >
            <rect x={n.x} y={n.y} width={BOX_W} height={BOX_H} rx={4} />
            <text x={n.x + 8} y={n.y + 18} className="box-id">
              {n.id}
            </text>
            <text x={n.x + 8} y={n.y + 36} className="box-title">
              {truncTitle(task.title)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 选中任务详情面板(DAG 点击选中消费):id/status/title/spec/deps/artifact 摘要——板投影内
 *  数据纯展示,无动作面 */
function TaskDetail({ task }: { task: BoardTask }): JSX.Element {
  const artifact =
    task.artifact === undefined
      ? ''
      : ` · ${task.artifact.conclusion ?? ''}${task.artifact.tokens !== undefined ? ` ${task.artifact.tokens} tokens` : ''}${
          task.artifact.durationMs !== undefined ? ` ${task.artifact.durationMs}ms` : ''
        }`;
  return (
    <section className="board-detail" aria-label="task detail">
      <header className="detail-head">{`${task.id} [${task.status}]${task.gated === true ? ' ⚠' : ''} ${task.title}`}</header>
      <p className="detail-spec">{task.spec !== '' ? task.spec : '(无 spec)'}</p>
      <p className="detail-meta">{`${task.dependsOn.length > 0 ? `needs ${task.dependsOn.join(' → ')}` : '无依赖'}${
        task.assignee !== undefined ? ` · @${task.assignee}` : ''
      }${artifact}`}</p>
    </section>
  );
}

export function Board({ board, delegations, team, onReview, onBack }: BoardProps): JSX.Element {
  const [view, setView] = useState<View>('list');
  /** DAG 选中任务(再点同节点/Esc 取消;任务消失时详情面板自防御退场) */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Esc 取消选中(仅选中在场时挂听)
  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const selected = selectedId !== null ? (board.tasks[selectedId] ?? null) : null;
  const selectNode = (taskId: string): void => {
    setSelectedId((cur) => (cur === taskId ? null : taskId));
  };

  return (
    <>
      <header className="board-topbar">
        <button type="button" className="back" onClick={onBack}>
          ← 返回 Chat
        </button>
        <div className="view-toggle" role="group" aria-label="board view">
          <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            List
          </button>
          <button type="button" aria-pressed={view === 'dag'} className={view === 'dag' ? 'active' : ''} onClick={() => setView('dag')}>
            DAG
          </button>
        </div>
      </header>
      <div className="board-body">
        <main className="board-main" aria-label="board">
          {view === 'list' ? (
            <BoardList board={board} onReview={onReview} />
          ) : (
            <>
              <BoardDag board={board} selectedId={selectedId} onSelect={selectNode} />
              {selected !== null && <TaskDetail task={selected} />}
            </>
          )}
        </main>
        <aside className="team-sidebar" aria-label="team">
          <h3>team</h3>
          {team.length === 0 && <p className="team-empty">无在册 teammate。</p>}
          <ul className="team-list">
            {team.map((m) => (
              <li key={m.name} className="teammate">
                <span className={`team-dot${m.busy ? ' busy' : ''}`} aria-label={m.busy ? 'busy' : 'free'} />
                {m.name}
              </li>
            ))}
          </ul>
          <section className="delegations" aria-label="delegations">
            <h3>delegations</h3>
            {delegations.length === 0 && <p className="delegations-empty">暂无委派。</p>}
            <ul className="delegation-list">
              {delegations.map((d) => (
                <li key={d.id} className={`delegation delegation-${d.status}`}>
                  {`${d.label} [${d.status}]`}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
