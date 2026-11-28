import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { t } from '../../i18n';
import type { Dispatch, SetStateAction } from 'react';
import { AskCard, pickAnswered } from './PendingCards';
import type { AskPick } from './PendingCards';
import type { GuiAskReq } from '../../connection';

/** 问询挂起 dock(D32 第六批批F-2 自 Chat.tsx 平移;2026-11-28 十一轮改单卡分页)。
 *  2026-11-28 十一轮用户实测「第二个或者多个的 ask_question 没有关掉」:旧实现多卡纵排且
 *  「全部答完才能提交」——答了 A 未答 B 时提交按钮恒禁用,已答的 A 也关不掉,旧卡越攒越死。
 *  现改为与群聊 ask 弹窗同构:单卡显示,顶行 ‹ 1/N › 切换,跳过/提交只作用于当前题,提交成功
 *  即移卡(卡集合由快照权威裁剪),后续题自动顶上来。 */
interface AskDockProps {
  readonly askCards: Array<{ pid: string; req: GuiAskReq }>;
  readonly askPicks: Record<string, AskPick>;
  readonly setAskPicks: Dispatch<SetStateAction<Record<string, AskPick>>>;
  readonly sendAsk: (pid: string, reply: { type: 'dismissed' } | { type: 'custom'; text: string } | { type: 'selected'; labels: string[] }) => void;
  /** 子智能体转录跳转(2026-11-14 ask 路由):归因卡超链接回调,App 注入 openAgentTab */
  readonly onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
}

export function AskDock(props: AskDockProps): JSX.Element {
  const { askCards, askPicks, setAskPicks, sendAsk, onOpenAgent } = props;
  const [idx, setIdx] = useState(0);
  // 集合缩小(答完一题)时游标钳回末项
  const cur = Math.min(idx, Math.max(0, askCards.length - 1));
  useEffect(() => {
    if (idx > cur) setIdx(cur);
  }, [idx, cur]);
  const card = askCards[cur];
  const pick = card === undefined ? { labels: [], custom: '' } : (askPicks[card.pid] ?? { labels: [], custom: '' });
  const submittable = card !== undefined && pickAnswered(pick);
  const clearPick = (pid: string): void => setAskPicks((m) => {
    const next = { ...m };
    delete next[pid];
    return next;
  });
  /** 提交当前题(逐题):自由输入优先,其次所选标签;成功/失败由 settle 移卡 */
  const submit = (): void => {
    if (card === undefined || !submittable) return;
    const custom = pick.custom.trim();
    if (custom !== '') sendAsk(card.pid, { type: 'custom', text: custom });
    else if (pick.labels.length > 0) sendAsk(card.pid, { type: 'selected', labels: pick.labels });
    clearPick(card.pid);
  };
  if (card === undefined) return <></>;
  return (
    <div
      className="ask-dock sx-group-ask-dock"
      onKeyDown={(e) => {
        // Enter=提交当前题(dock 级;选项/自定义输入聚焦均冒泡到此)
        if (e.key !== 'Enter' || e.shiftKey || !submittable) return;
        e.preventDefault();
        submit();
      }}
    >
      {askCards.length > 1 && (
        <div className="sx-group-ask-head">
          <span className="sx-group-ask-source">
            <span>{t('Questions', '待答复')}</span>
          </span>
          <span className="sx-group-ask-pager">
            <button type="button" className="sx-iconbtn" aria-label="previous ask" onClick={() => setIdx((i) => (i - 1 + askCards.length) % askCards.length)}><ChevronLeft size={14} strokeWidth={2} aria-hidden="true" /></button>
            <span className="sx-group-ask-count" aria-label="ask position">{cur + 1}/{askCards.length}</span>
            <button type="button" className="sx-iconbtn" aria-label="next ask" onClick={() => setIdx((i) => (i + 1) % askCards.length)}><ChevronRight size={14} strokeWidth={2} aria-hidden="true" /></button>
          </span>
        </div>
      )}
      <div className="ask-scroll sx-group-ask-body">
        <AskCard
          key={card.pid}
          req={card.req}
          pick={pick}
          onPick={(patch) => setAskPicks((m) => {
            const base = m[card.pid] ?? { labels: [], custom: '' };
            return { ...m, [card.pid]: { ...base, ...patch } };
          })}
          onOpenAgent={onOpenAgent}
        />
      </div>
      <div className="ask-actions">
        <button type="button" onClick={() => { sendAsk(card.pid, { type: 'dismissed' }); clearPick(card.pid); }}>
          {t('Skip', '跳过')}
        </button>
        <button type="button" className="primary" disabled={!submittable} onClick={submit}>
          {t('Submit', '提交')}
        </button>
      </div>
    </div>
  );
}
