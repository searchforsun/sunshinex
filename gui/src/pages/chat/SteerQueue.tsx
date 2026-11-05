import { ArrowUpToLine, ChevronDown, CornerDownRight, GripVertical, Image as ImageIcon, PenLine, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { t } from '../../i18n';
import type { Connection } from '../../connection';
import { renderMentionSpans } from './mention';

/** 排队 chips 条(D32 第六批批F-2 自 Chat.tsx 平移):折叠摘要行+拖拽排序清单,立即/插入/
 *  放回输入框编辑/删除四动作。内联编辑退役(2026-10-26 用户裁定:队列编辑统一走输入框——
 *  「放回输入框」带图回填后重发,内联单行 input 承载不了图片附件)。队列态由 queue 帧实时推
 *  (P5)——动作后快照重拉仅作显式确认(refreshQueued),轮询已退役。开关与队列态 props 注入。
 *  2026-10-31 用户裁定防竞态:立即/插入点击后本条显示转圈(会话标题运行中同款 run-spinner),
 *  直至对应文本落出正文(用户条文本命中)或队列帧摘除;期间全部行的四动作禁点(拖拽同锁)。 */
export interface SteerQueueProps {
  readonly queued: Array<{ seq: number; text: string; images?: string[] }>;
  readonly queueFolded: boolean;
  readonly setQueueFolded: Dispatch<SetStateAction<boolean>>;
  readonly setQueued: Dispatch<SetStateAction<Array<{ seq: number; text: string; images?: string[] }>>>;
  readonly conn: Connection;
  readonly sessionId: string;
  readonly refreshQueued: () => void;
  readonly pauseAndSend: (q: { seq: number; text: string; images?: string[] }) => void;
  readonly setInput: Dispatch<SetStateAction<string>>;
  /** 放回输入框编辑时随行回填图片附件(composer 待发态,Chat 持有) */
  readonly setImages: Dispatch<SetStateAction<string[]>>;
  /** 当前会话用户条文本集(2026-10-31 防竞态):立即/插入后该条转圈直至文本命中正文 */
  readonly entryTexts: ReadonlySet<string>;
}

export function SteerQueue(props: SteerQueueProps): JSX.Element {
  const { queued, queueFolded, setQueueFolded, setQueued, conn, sessionId, refreshQueued, pauseAndSend, setInput, setImages, entryTexts } = props;
  /** 在途条(立即/插入已点、正文未落):seq 集;任一在途=全部行动作锁定(防连点竞态) */
  const [inflight, setInflight] = useState<ReadonlySet<number>>(() => new Set());
  // 收口:队列帧已摘除(daemon 已消费)或文本命中正文(用户条落出)即撤转圈
  useEffect(() => {
    setInflight((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<number>();
      for (const seq of prev) {
        const q = queued.find((x) => x.seq === seq);
        if (q === undefined) continue; // 队列帧已摘除
        if (entryTexts.has(q.text.trim())) continue; // 正文已落出
        next.add(seq);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [queued, entryTexts]);
  const markInflight = (seq: number): void => setInflight((s) => (s.has(seq) ? s : new Set(s).add(seq)));
  const locked = inflight.size > 0;
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
          {queued.map((q, i) => {
            const busy = inflight.has(q.seq);
            return (
            <div
              key={q.seq}
              data-seq={i}
              className="steer-row"
              draggable={!locked}
              onDragStart={(e) => {
                if (locked) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.setData('text/steer-seq', String(i));
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              <span className="steer-grip" data-tip={locked ? undefined : t('Drag to reorder', '拖拽调整排序')}>
                <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className="steer-row-text">
                {q.images !== undefined && q.images.length > 0 && (
                  <span className="steer-img-thumbs" aria-label={t('Attached images', '附件图片')}>
                    {q.images.slice(0, 4).map((src, k) => (
                      <img key={`${k}:${src.slice(-24)}`} src={src} alt="" />
                    ))}
                    {q.images.length > 4 && <span className="steer-img-more">+{q.images.length - 4}</span>}
                  </span>
                )}
                {q.text !== '' ? renderMentionSpans(q.text, undefined, undefined, undefined, true) : <span className="steer-img-only"><ImageIcon size={12} strokeWidth={1.75} aria-hidden="true" />{t('(image)', '(图片)')}</span>}
              </span>
              <span className="steer-row-actions">
                {busy ? (
                  // 在途=会话标题运行中同款转圈,直至对应文本落出正文(四动作整体让位)
                  <span className="run-spinner" aria-label={t('Sending queued message', '正在送出排队消息')} />
                ) : (
                  <>
                <button
                  type="button"
                  className="steer-act"
                  disabled={locked}
                  data-tip={t('Pause the session and send this now', '暂停会话并立即发送消息')}
                  onClick={() => {
                    markInflight(q.seq);
                    void pauseAndSend(q);
                  }}
                >
                  <ArrowUpToLine size={12} strokeWidth={1.75} aria-hidden="true" />
                  {t('Now', '立即')}
                </button>
                <button
                  type="button"
                  className="steer-act"
                  disabled={locked}
                  data-tip={t('Insert this message into the session', '插入消息到会话中')}
                  onClick={() => {
                    markInflight(q.seq);
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
                  disabled={locked}
                  onClick={() => {
                    setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
                    // cancel 失败=daemon 队列保留原条目,下次 refreshQueued 重拉自纠(行重现可再操作)
                    conn.cancelSteer(sessionId, q.seq).catch(() => {});
                    // 队列编辑统一走输入框(2026-10-26 裁定):文本+随行图片一并回填,编辑后重发
                    setInput(q.text);
                    setImages(q.images ?? []);
                  }}
                >
                  <PenLine size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="steer-act steer-act-icon"
                  aria-label={t('Delete', '删除')}
                  data-tip={t('Delete', '删除')}
                  disabled={locked}
                  onClick={() => {
                    setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
                    // 删除同理:本地即消,daemon 侧残留由 refreshQueued 重拉自纠
                    conn.cancelSteer(sessionId, q.seq).catch(() => {});
                  }}
                >
                  <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                  </>
                )}
              </span>
            </div>
            );
          })}
        </div>
          )}
        </div>
  );
}
