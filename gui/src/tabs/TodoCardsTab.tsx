import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { t } from '../i18n';
import type { TodoBatch } from '../pages/Chat';

/**
 * G14.174 「待办」页签体（原任务页签的待办面独立成页,用户裁决「任务→待办」）:
 * 每批 todo_write = 一张卡片,时间由上到下(旧→新,渲染最新在顶);卡片头 = 关联轮次用户输入
 * (单行省略) + 进度 chip + 右侧创建时间;体 = 统一圆圈三态待办列表(.todo-dot 三态同源)。
 * 可展开折叠——最新一批缺省展开,其余折叠。
 */

export interface TodoCardsTabProps {
  readonly batches: readonly TodoBatch[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 毫秒时刻 → 本地短时刻(同 ui-util.shortLocalTime 口径,入参为 ms;旧档无时刻回退 --:--) */
function shortTime(ms: number): string {
  if (!(ms > 0)) return '--:--';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TodoCardsTab({ batches }: TodoCardsTabProps): JSX.Element {
  const lastKey = batches.length > 0 ? batches[batches.length - 1]!.key : '';
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
  if (batches.length === 0) {
    return (
      <div className="todo-cards" aria-label="todo cards">
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">暂无待办</p>
          <p className="board-empty-hint">智能体记录待办清单(todo)后会按批次显示在这里。</p>
        </div>
      </div>
    );
  }
  return (
    <div className="todo-cards" aria-label="todo cards">
      {[...batches].reverse().map((b) => {
        const done = b.items.filter((x) => x.status === 'completed').length;
        const open = expanded.has(b.key);
        return (
          <section key={b.key} className="todo-card">
            <button type="button" className="todo-card-head" aria-expanded={open} onClick={() => toggle(b.key)}>
              {open ? <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span className="todo-card-count">{`${done}/${b.items.length}`}</span>
              <span className="todo-card-goal">{b.goal !== '' ? b.goal : t('(no turn input)', '(未关联轮次输入)')}</span>
              <span className="todo-card-time">{shortTime(b.ts)}</span>
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
  );
}
