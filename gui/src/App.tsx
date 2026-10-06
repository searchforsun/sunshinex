import type { SnapshotResponse } from './connection';

/**
 * G2 App 骨架：纯 snapshot 渲染，零交互零连接（连接装配与事件实时面 G3；md 渲染 G3）。
 * 顶栏（status 圆点+文字）/ 转录列表（`[kind] md` 纯文本行）/ 板列表（`id [status] title` 行，数值序）。
 */

/** id 方言 t<seq> 的数值序（非 t 前缀排尾，字典序兜底） */
function numericOrder(a: string, b: string): number {
  const na = /^t(\d+)$/.exec(a);
  const nb = /^t(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function App({ snapshot }: { snapshot: SnapshotResponse }): JSX.Element {
  const tasks = Object.values(snapshot.board.tasks).sort((a, b) => numericOrder(a.id, b.id));
  return (
    <div className="app">
      <header className="topbar">
        <span className={`status-dot status-${snapshot.status}`} aria-label={`status: ${snapshot.status}`} />
        <span className="status-text">{snapshot.status}</span>
      </header>
      <section className="transcript" aria-label="transcript">
        {snapshot.messages.map((m) => (
          <div key={m.seq} className={`msg msg-${m.kind}`}>
            [{m.kind}] {m.md}
          </div>
        ))}
      </section>
      <section className="board" aria-label="board">
        {tasks.map((t) => (
          <div key={t.id} className={`task task-${t.status}`}>
            {t.id} [{t.status}] {t.title}
          </div>
        ))}
      </section>
    </div>
  );
}
