import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Check, Clock, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import { markJumpHighlight, shortStampMs, withMinSpin } from '../ui-util';
import type { Connection } from '../connection';
import type { TodoBatch } from '../pages/Chat';
import { mergeTodoBatches } from '../pages/chat/tool-entry-data';

/**
 * G14.174 「待办」页签体（原任务页签的待办面独立成页,用户裁决「任务→待办」）:
 * **一个待办一卡**（2026-11-25 用户裁定「一个待办可以跨多个轮次:给待办一个标题参数,
 * 代替用户输入信息」——原每批 todo_write 一卡、卡头挂关联轮次用户输入,模型改写清单措辞即
 * 裂成多卡;现按 title 跨轮归并,同标题=同一待办,进度推进/措辞改写收敛同一卡,不同标题才是
 * 不同待办）。卡头 = 标题 + 进度 chip + 创建时间（用户气泡回链退役）;体 = 统一圆圈三态
 * 待办列表(.todo-dot 三态同源)。
 * 2026-10-31 用户裁定:骨架对齐后台任务页签(insight-tab+bar+todo-cards,消双层边距)+
 * 顶部刷新钮——conn.sessionSnapshot 拉 daemon journal 派生的 todoBatches 权威投影,
 * 覆盖 store 派生面(底层最新数据;拉失败/空集回退 store 实时投影),同一归并口径。
 * 清单变点靠 Chat 转录派生 live 推送;开签/手动刷新走 GET 快照权威面。
 */

interface TodoCardsTabProps {
  readonly batches: readonly TodoBatch[];
  readonly conn: Connection;
  readonly sessionId: string;
  /** 正文/顶栏打开侧栏时 App 递增——主动刷一次 */
  readonly refreshNonce?: number;
  /** 2026-11-04 待办行点击定位信号:按清单签名匹配卡,滚动+闪光+自动展开 */
  readonly locateSig?: { sig: string; nonce: number; title?: string } | null;
}

export function TodoCardsTab({ batches, conn, sessionId, refreshNonce, locateSig }: TodoCardsTabProps): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  /** 刷新面:快照拉到的 todoBatches(权威投影);非空才覆盖 store 派生面,空集=旧 daemon/无记录回退。
   *  快照载荷与转录派生同一归并口径(标题跨轮归并),页签不铺原始批次 */
  const [refreshed, setRefreshed] = useState<readonly TodoBatch[]>([]);
  const refresh = (): void => {
    if (refreshing) return;
    setRefreshing(true);
    withMinSpin(conn.sessionSnapshot(sessionId))
      .then((snap) => setRefreshed(mergeTodoBatches(snap.todoBatches ?? [])))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };
  useEffect(() => {
    if (refreshNonce === undefined) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);
  const view = refreshed.length > 0 ? refreshed : mergeTodoBatches(batches);
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
   *  自动展开+滚动居中(2026-11-08 用户裁定「定位即够,撤全局湛蓝闪光」);无匹配签名静默 */
  useEffect(() => {
    if (locateSig === undefined || locateSig === null) return;
    const hit = view.find((b) => b.items.map((x) => x.text).join('\n') === locateSig.sig);
    if (hit === undefined) return;
    setExpanded((s) => new Set([...s, hit.key]));
    const el = document.querySelector(`[data-batch-key="${CSS.escape(hit.key)}"]`);
    el?.scrollIntoView({ block: 'center' });
    if (el !== null) markJumpHighlight(el);
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
          <RefreshCw size={14} strokeWidth={1.75} className={refreshing ? 'sx-fetching' : undefined} />
        </button>
      </div>
      <div className="todo-cards" aria-label="todo cards">
        {view.length === 0 && (
          <div className="board-empty-state" role="status">
            <p className="board-empty-title">{t('No todos yet', '暂无待办')}</p>
            <p className="board-empty-hint">{t('The current todo list recorded by the agent will appear here.', '智能体记录的当前待办清单(todo)会显示在这里。')}</p>
          </div>
        )}
        {[...view].reverse().map((b) => {
          const done = b.items.filter((x) => x.status === 'completed').length;
          const open = expanded.has(b.key);
          return (
            <section key={b.key} data-batch-key={b.key} className={'todo-card'}>
              <button type="button" className="todo-card-head" aria-expanded={open} onClick={() => toggle(b.key)}>
                {open ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />}
                <span className="todo-card-count">{`${done}/${b.items.length}`}</span>
                <span className="todo-card-goal">{b.title !== undefined && b.title !== '' ? b.title : t('Untitled todos', '未命名待办')}</span>
                <span className="todo-card-time" data-tip={t('Created', '创建时间')}>
                  <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
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
