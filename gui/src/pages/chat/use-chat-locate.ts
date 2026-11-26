import { useEffect, useRef, type MutableRefObject } from 'react';
import { rAFConverge } from '../../ui-util';
import { zoomScale } from '../../ui-zoom';

/** 转录区定位簇（D62 批C，2026-11-08 自 Chat.tsx 外提——两 effect 逐字平移，行为零变化）：
 *  成员转录 leader 链接定位。命中即撤贴底跟随，锚定+rAF 迭代校正（content-visibility 离屏估高）。
 *  待办卡主名字→用户气泡定位随 2026-11-25「去掉和用户消息的绑定」裁定退役（待办是会话级清单，
 *  不再归属某个用户气泡）。
 *  2026-11-26 增跨 Sunx 归因定位（用户裁定「点击气泡上蓝色 sunx 名字定位到对应发送气泡的轮次中」）：
 *  信号命中本会话即滚到发送方 run 条目（data-entry-key=k<runSeq>）并闪光。信号一次性消费——
 *  目标未挂载（播种中/窗口外）时随 entriesTick 变化重试，短超时后放弃并清信号（切回不重复跳）。 */
export function useChatLocate({
  leaderFocus,
  sunxPeerFocus,
  journalId,
  entriesTick,
  onSunxPeerFocusDone,
  chatScrollRef,
  chatStickRef,
}: {
  leaderFocus: { member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null | undefined;
  sunxPeerFocus?: { journalId: string; runSeq: number; nonce: number } | null;
  journalId?: string;
  entriesTick?: number;
  onSunxPeerFocusDone?: () => void;
  chatScrollRef: MutableRefObject<HTMLElement | null>;
  chatStickRef: MutableRefObject<boolean>;
}): void {
  /** 成员转录 leader 链接定位(2026-11-08 用户裁定「定位到主对话对应发送位置,不打开页签」):
   *  toLeader=成员发给 leader 的消息 → 主对话里该成员的消息气泡(data-from=成员,正文含定位文本);
   *  fromLeader=leader 发来的消息 → 主对话里发送团队消息工具行(收件人=成员)。命中滚到并闪光 */
  useEffect(() => {
    if (leaderFocus === null || leaderFocus === undefined) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const norm = (x: string): string => x.replace(/\s+/g, ' ').trim();
    const needle = norm(leaderFocus.text).slice(0, 60);
    let hit: HTMLElement | undefined;
    if (leaderFocus.dir === 'toLeader') {
      const bubbles = [...el.querySelectorAll<HTMLElement>('.agent-msg')].filter((n) => n.dataset.from === leaderFocus.member);
      hit = (needle !== '' ? bubbles.find((n) => norm(n.querySelector('.agent-msg-text')?.textContent ?? '').includes(needle)) : undefined) ?? bubbles.at(-1);
    } else {
      const rows = [...el.querySelectorAll<HTMLElement>('.entry-tool[data-tool="send_agent_team_message"]')];
      hit = rows.filter((n) => norm(n.querySelector('.tool-summary')?.textContent ?? '').includes(leaderFocus.member)).at(-1) ?? rows.at(-1);
    }
    if (hit === undefined) return;
    const target = hit;
    chatStickRef.current = false;
    el.scrollTop += (target.getBoundingClientRect().top - el.getBoundingClientRect().top) / zoomScale();
    rAFConverge(el, () => target.getBoundingClientRect().top - el.getBoundingClientRect().top, (d) => {
      el.scrollTop += d / zoomScale();
    }, 2);
  }, [leaderFocus, chatScrollRef, chatStickRef]);

  /** 跨 Sunx 归因定位（2026-11-26 用户裁定「点击气泡上蓝色 sunx 名字定位到对应发送气泡的轮次中」）：
   *  目标=发送方该轮 run 条目（EntryViews run 行 data-entry-key=k<runSeq>）。未挂载（播种中/窗口外）
   *  时本 effect 随 entriesTick 重跑重试；2.5s 仍未命中即放弃（会话已打开，用户自行滚动），
   *  两条路径都清信号——一次性消费，切回不重复跳 */
  const peerHandledNonceRef = useRef(0);
  useEffect(() => {
    const f = sunxPeerFocus;
    if (f === null || f === undefined || f.nonce === peerHandledNonceRef.current) return;
    if (journalId === undefined || journalId === '' || journalId !== f.journalId) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const target = el.querySelector<HTMLElement>(`.entry[data-entry-key="k${f.runSeq}"]`);
    if (target !== null) {
      peerHandledNonceRef.current = f.nonce;
      chatStickRef.current = false;
      el.scrollTop += (target.getBoundingClientRect().top - el.getBoundingClientRect().top) / zoomScale();
      rAFConverge(el, () => target.getBoundingClientRect().top - el.getBoundingClientRect().top, (d) => {
        el.scrollTop += d / zoomScale();
      }, 2);
      target.classList.add('chat-locate-flash');
      window.setTimeout(() => target.classList.remove('chat-locate-flash'), 1600);
      onSunxPeerFocusDone?.();
      return;
    }
    const timer = window.setTimeout(() => {
      peerHandledNonceRef.current = f.nonce;
      onSunxPeerFocusDone?.();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [sunxPeerFocus, journalId, entriesTick, onSunxPeerFocusDone, chatScrollRef, chatStickRef]);
}
