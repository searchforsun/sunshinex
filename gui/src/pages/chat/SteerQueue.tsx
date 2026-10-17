import { ArrowUpToLine, ChevronDown, CornerDownRight, GripVertical, PenLine, Trash2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { t } from '../../i18n';
import type { Connection } from '../../connection';

/** 排队 chips 条(D32 第六批批F-2 自 Chat.tsx 平移,行为零变化):折叠摘要行+拖拽排序清单,
 *  立即/插入/放回输入框/删除四动作。开关与队列态 props 注入(dispatch 原形)。 */
export interface SteerQueueProps {
  readonly queued: Array<{ seq: number; text: string }>;
  readonly queueFolded: boolean;
  readonly setQueueFolded: Dispatch<SetStateAction<boolean>>;
  readonly setQueued: Dispatch<SetStateAction<Array<{ seq: number; text: string }>>>;
  readonly conn: Connection;
  readonly sessionId: string;
  readonly refreshQueued: () => void;
  readonly pauseAndSend: (q: { seq: number; text: string }) => void;
  readonly setInput: Dispatch<SetStateAction<string>>;
}

export function SteerQueue(props: SteerQueueProps): JSX.Element {
  const { queued, queueFolded, setQueueFolded, setQueued, conn, sessionId, refreshQueued, pauseAndSend, setInput } = props;
  return (
        <div className="steer-queue" aria-label="queued messages">
          {/* G14.87 折叠摘要行:嵌条头部(欢迎页 options-bar 同形),折叠只留此行不推高 dock */}
          <button
            type="button"
            className="steer-fold"
            aria-expanded={!queueFolded}
            onClick={() => setQueueFolded((v) => !v)}
          >
            <span>
              {t('Queued', '排队')} · {queued.length}
            </span>
            <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" className={queueFolded ? 'steer-fold-chev up' : 'steer-fold-chev'} />
          </button>
          {!queueFolded && (
        <div
          className="steer-list"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const from = Number(e.dataTransfer.getData('text/steer-seq'));
            const to = Number((e.target instanceof Element ? e.target.closest('[data-seq]') : null)?.getAttribute('data-seq') ?? NaN);
            if (Number.isNaN(from) || Number.isNaN(to) || from === to) return;
            setQueued((qs) => {
              const arr = [...qs];
              const [m] = arr.splice(from, 1);
              arr.splice(to, 0, m);
              return arr.map((x, i2) => ({ ...x, seq: i2 }));
            });
            conn.moveSteer(sessionId, from, to).then(refreshQueued, () => {});
          }}
        >
          {queued.map((q, i) => (
            <div
              key={q.seq}
              data-seq={i}
              className="steer-row"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/steer-seq', String(i));
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              <span className="steer-grip" data-tip={t('Drag to reorder', '拖拽调整排序')}>
                <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className="steer-row-text">{q.text}</span>
              <span className="steer-row-actions">
                <button
                  type="button"
                  className="steer-act"
                  data-tip={t('Pause current round and start next with this', '暂停当前轮次,直接开启下一轮发送本条')}
                  onClick={() => void pauseAndSend(q)}
                >
                  <ArrowUpToLine size={12} strokeWidth={1.75} aria-hidden="true" />
                  {t('Now', '立即')}
                </button>
                <button
                  type="button"
                  className="steer-act"
                  data-tip={t('Move to front, inject at next step', '提到队首,下一轮立即插入发送')}
                  onClick={() => {
                    conn.frontSteer(sessionId, q.seq).then(refreshQueued, () => {});
                  }}
                >
                  <CornerDownRight size={12} strokeWidth={1.75} aria-hidden="true" />
                  {t('Insert', '插入')}
                </button>
                <button
                  type="button"
                  className="steer-act steer-act-icon"
                  aria-label={t('Edit in input box', '放回输入框编辑')}
                  data-tip={t('Edit in input box', '放回输入框编辑')}
                  onClick={() => {
                    setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
                    // cancel 失败=daemon 队列保留原条目,下次 refreshQueued 重拉自纠(行重现可再操作)
                    // 删除同理:本地即消,daemon 侧残留由 refreshQueued 重拉自纠
                    conn.cancelSteer(sessionId, q.seq).catch(() => {});
                    setInput(q.text);
                  }}
                >
                  <PenLine size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="steer-act steer-act-icon"
                  aria-label={t('Delete', '删除')}
                  data-tip={t('Delete', '删除')}
                  onClick={() => {
                    setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
                    conn.cancelSteer(sessionId, q.seq).catch(() => {});
                  }}
                >
                  <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </div>
          ))}
        </div>
          )}
        </div>
  );
}
