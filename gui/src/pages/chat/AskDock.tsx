import { t } from '../../i18n';
import type { Dispatch, SetStateAction } from 'react';
import { AskCard, pickAnswered } from './PendingCards';
import type { AskPick } from './PendingCards';
import type { GuiAskReq } from '../../connection';

/** 问询挂起 dock(D32 第六批批F-2 自 Chat.tsx 平移,行为零变化):分支注释随迁。 */
export interface AskDockProps {
  readonly askCards: Array<{ pid: string; req: GuiAskReq }>;
  readonly askPicks: Record<string, AskPick>;
  readonly setAskPicks: Dispatch<SetStateAction<Record<string, AskPick>>>;
  readonly sendAsk: (pid: string, reply: { type: 'dismissed' } | { type: 'custom'; text: string } | { type: 'selected'; labels: string[] }) => void;
}

export function AskDock(props: AskDockProps): JSX.Element {
  const { askCards, askPicks, setAskPicks, sendAsk } = props;
  return (
          /* G14.80/G14.91:ask_question 挂起时输入框变为选择题表单——卡列表纵排(单卡内选项自滚)+
             固定提交区(右下):多题任一未答不可提交;跳过=全部 dismissed;全部处理完恢复输入框 */
          <div className="ask-dock">
            <div className="ask-scroll">
              {askCards.map((c) => (
                <AskCard
                  key={c.pid}
                  req={c.req}
                  pick={askPicks[c.pid] ?? { labels: [], custom: '' }}
                  onPick={(patch) =>
                    setAskPicks((m) => {
                      const base = m[c.pid] ?? { labels: [], custom: '' };
                      return { ...m, [c.pid]: { ...base, ...patch } };
                    })
                  }
                />
              ))}
            </div>
            <div className="ask-actions">
              <button
                type="button"
                onClick={() => {
                  askCards.forEach((c) => sendAsk(c.pid, { type: 'dismissed' }));
                  setAskPicks({});
                }}
              >
                {t('Skip', '跳过')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!askCards.every((c) => pickAnswered(askPicks[c.pid]))}
                onClick={() => {
                  askCards.forEach((c) => {
                    const p = askPicks[c.pid];
                    const custom = p?.custom.trim() ?? '';
                    if (custom !== '') sendAsk(c.pid, { type: 'custom', text: custom });
                    else if ((p?.labels.length ?? 0) > 0) sendAsk(c.pid, { type: 'selected', labels: p!.labels });
                  });
                  setAskPicks({});
                }}
              >
                {t('Submit', '提交')}
              </button>
            </div>
          </div>
  );
}
