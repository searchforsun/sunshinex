import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Check, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import { shortStampMs } from '../ui-util';
import type { Connection } from '../connection';
import type { TodoBatch } from '../pages/Chat';

/**
 * G14.174 「待办」页签体（原任务页签的待办面独立成页,用户裁决「任务→待办」）:
 * 每批 todo_write = 一张卡片,时间由上到下(旧→新,渲染最新在顶);卡片头 = 关联轮次用户输入
 * (单行省略) + 进度 chip + 右侧创建时间;体 = 统一圆圈三态待办列表(.todo-dot 三态同源)。
 * 可展开折叠——最新一批缺省展开,其余折叠。
 * 2026-10-31 用户裁定:骨架对齐后台任务页签(insight-tab+bar+todo-cards,消双层边距)+
 * 顶部刷新钮——conn.sessionSnapshot 拉 daemon journal 派生的 todoBatches 权威投影,
 * 拉到的非空集覆盖 store 派生面(底层最新数据;拉失败/空集回退 store 实时投影)。
 */

export interface TodoCardsTabProps {
  readonly batches: readonly TodoBatch[];
  readonly conn: Connection;
  readonly sessionId: string;
}

export function TodoCardsTab({ batches, conn, sessionId }: TodoCardsTabProps): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  /** 刷新面:快照拉到的 todoBatches(权威投影);非空才覆盖 store 派生面,空集=旧 daemon/无记录回退 */
  const [refreshed, setRefreshed] = useState<readonly TodoBatch[]>([]);
  const refresh = (): void => {
    if (refreshing) return;
    setRefreshing(true);
    conn.sessionSnapshot(sessionId)
      .then((snap) => setRefreshed(snap.todoBatches ?? []))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };
  const view = refreshed.length > 0 ? refreshed : batches;
  const lastKey = view.length > 0 ? view[view.length - 1]!.key : '';
  /** 折叠集合:挂载即末批展开(batches 页签打开时已填);新批到来跟随展开,手动折叠后不再打扰 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(lastKey !== '' ? [lastKey] : []));
  const [autoKey, setAutoKey] = useState(lastKey);
  useEffect(() => {
    if (lastKey !== '' && lastKey !== autoKey) {
      setAutoKey(lastKey);
      setExpanded((s) => new Set([...s, lastKey]));
    }
  }, [lastKey, autoKey]);
  const toggle = (key: string): void => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button
          type="button"
          className="sx-changes-act"
          aria-label="refresh"
          data-tip={refreshing ? t('Refreshing…', '刷新中…') : t('Refresh', '刷新')}
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshCw size={13} strokeWidth={1.75} className={refreshing ? 'sx-fetching' : undefined} />
        </button>
      </div>
      <div className="todo-cards" aria-label="todo cards">
        {view.length === 0 && (
          <div className="board-empty-state" role="status">
            <p className="board-empty-title">{t('No todos yet', '暂无待办')}</p>
            <p className="board-empty-hint">{t('Todo batches recorded by the agent will appear here.', '智能体记录待办清单(todo)后会按批次显示在这里。')}</p>
          </div>
        )}
        {[...view].reverse().map((b) => {
          const done = b.items.filter((x) => x.status === 'completed').length;
          const open = expanded.has(b.key);
          return (
            <section key={b.key} className="todo-card">
              <button type="button" className="todo-card-head" aria-expanded={open} onClick={() => toggle(b.key)}>
                {open ? <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />}
                <span className="todo-card-count">{`${done}/${b.items.length}`}</span>
                <span className="todo-card-goal">{b.goal !== '' ? b.goal : t('(no turn input)', '(未关联轮次输入)')}</span>
                <span className="todo-card-time">{shortStampMs(b.ts)}</span>
              </button>
              {open && (
                <ul className="board-todos-list todo-card-list">
                  {b.items.map((it, i) => (
                    <li key={i} className={`todo-item todo-${it.status}`}>
                      <span className={`todo-dot ${it.status}`} aria-hidden="true">
                        {it.status === 'completed' && <Check size={9} strokeWidth={3} />}
                        {it.status === 'in_progress' && <ArrowRight size={9} strokeWidth={3} />}
                      </span>
                      <span className={'todo-text' + (it.status === 'completed' ? ' done' : '')}>{it.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
