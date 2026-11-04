import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Check, Clock, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import { shortStampMs, withMinSpin } from '../ui-util';
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
 * 清单变点靠 Chat 转录派生 live 推送;开签/手动刷新走 GET 快照权威面。
 */

export interface TodoCardsTabProps {
  readonly batches: readonly TodoBatch[];
  readonly conn: Connection;
  readonly sessionId: string;
  /** 正文/顶栏打开侧栏时 App 递增——主动刷一次 */
  readonly refreshNonce?: number;
  /** 主名字点击定位(2026-11-03):滚到该批关联轮次的正文输入气泡;无 userKey(旧投影)不可点 */
  readonly onLocate?: (batch: TodoBatch) => void;
  /** 2026-11-04 待办行点击定位信号:按清单签名匹配卡,滚动+闪光+自动展开 */
  readonly locateSig?: { sig: string; nonce: number } | null;
}

export function TodoCardsTab({ batches, conn, sessionId, refreshNonce, onLocate, locateSig }: TodoCardsTabProps): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  /** 刷新面:快照拉到的 todoBatches(权威投影);非空才覆盖 store 派生面,空集=旧 daemon/无记录回退 */
  const [refreshed, setRefreshed] = useState<readonly TodoBatch[]>([]);
  const refresh = (): void => {
    if (refreshing) return;
    setRefreshing(true);
    withMinSpin(conn.sessionSnapshot(sessionId))
      .then((snap) => setRefreshed(snap.todoBatches ?? []))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };
  useEffect(() => {
    if (refreshNonce === undefined) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);
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
  /** 待办行点击定位(2026-11-04 用户裁定「点待办字样打开侧栏对应待办」):按清单签名匹配卡,
   *  自动展开+滚动居中+accent 闪光 1.8s;无匹配签名(旧批次/被合并)静默 */
  const [flashKey, setFlashKey] = useState<string | null>(null);
  useEffect(() => {
    if (locateSig === undefined || locateSig === null) return;
    const hit = view.find((b) => b.items.map((x) => x.text).join('\n') === locateSig.sig);
    if (hit === undefined) return;
    setExpanded((s) => new Set([...s, hit.key]));
    setFlashKey(hit.key);
    const el = document.querySelector(`[data-batch-key="${CSS.escape(hit.key)}"]`);
    el?.scrollIntoView({ block: 'center' });
    window.setTimeout(() => setFlashKey(null), 1800);
  }, [locateSig, view]);
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
            <section key={b.key} data-batch-key={b.key} className={'todo-card' + (flashKey === b.key ? ' focus-flash' : '')}>
              <button type="button" className="todo-card-head" aria-expanded={open} onClick={() => toggle(b.key)}>
                {open ? <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />}
                <span className="todo-card-count">{`${done}/${b.items.length}`}</span>
                <span className="todo-card-goal">
                  <span
                    role="button"
                    tabIndex={-1}
                    className={b.userKey !== undefined && onLocate !== undefined ? 'todo-card-goal-link' : undefined}
                    data-tip={b.userKey !== undefined && onLocate !== undefined ? t('Locate in chat', '定位到正文气泡') : undefined}
                    onClick={(e2) => {
                      if (b.userKey === undefined || onLocate === undefined) return;
                      e2.stopPropagation();
                      onLocate(b);
                    }}
                  >
                    {b.goal !== '' ? b.goal : t('(no turn input)', '(未关联轮次输入)')}
                  </span>
                </span>
                <span className="todo-card-time" data-tip={t('Created', '创建时间')}>
                  <Clock size={11} strokeWidth={1.75} aria-hidden="true" />
                  {shortStampMs(b.ts)}
                </span>
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
