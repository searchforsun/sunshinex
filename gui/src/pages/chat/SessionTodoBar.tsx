import { Check, ListTodo } from 'lucide-react';
import { t } from '../../i18n';
import type { TodoBatch } from './tool-entry-data';

/**
 * 会话顶部待办条（2026-11-25 用户裁定「会话上部显示待办」「顶部还是最近两轮有触发改待办就显示,
 * 显示时机不变」）：显示最近更新的待办（标题 + done/total + 细进度轨 + 当前进行项）；点击开
 * 「待办」页签看全量清单。显隐闸由 Chat 计算（最近两个 run 内有 todo_write 才渲染）——
 * 老待办不再常驻顶部，与用户气泡解耦（清单归属会话，不随某条消息出现/消失）。
 */
export function SessionTodoBar({ batch, onOpen }: {
  readonly batch: TodoBatch | undefined;
  readonly onOpen?: () => void;
}): JSX.Element | null {
  if (batch === undefined) return null;
  const total = batch.items.length;
  const done = batch.items.filter((x) => x.status === 'completed').length;
  const active = batch.items.find((x) => x.status === 'in_progress');
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <button
      type="button"
      className="session-todo-bar"
      onClick={() => onOpen?.()}
      data-tip={t('Open the todo list', '打开待办清单')}
      aria-label={t('Todos', '待办')}
    >
      <span className="session-todo-icon" aria-hidden="true">
        {total > 0 && done === total ? <Check size={14} strokeWidth={2.5} /> : <ListTodo size={14} strokeWidth={1.75} />}
      </span>
      {batch.title !== undefined && batch.title !== '' && <span className="session-todo-title">{batch.title}</span>}
      <span className="session-todo-count">{`${done}/${total}`}</span>
      <span className="session-todo-track" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="session-todo-current">
        {active !== undefined
          ? active.text
          : done === total
            ? t('All todos completed', '待办已全部完成')
            : ''}
      </span>
    </button>
  );
}
