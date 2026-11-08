import { useEffect, type MutableRefObject } from 'react';
import { rAFConverge } from '../../ui-util';
import { zoomScale } from '../../ui-zoom';

/** 转录区定位簇（D62 批C，2026-11-08 自 Chat.tsx 外提——两 effect 逐字平移，行为零变化）：待办卡主名字
 *  定位与成员转录 leader 链接定位。命中即撤贴底跟随，锚定+rAF 迭代校正（content-visibility 离屏估高）。 */
export function useChatLocate({
  todoFocus,
  leaderFocus,
  chatScrollRef,
  chatStickRef,
}: {
  todoFocus: { key: string; nonce: number } | null | undefined;
  leaderFocus: { member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null | undefined;
  chatScrollRef: MutableRefObject<HTMLElement | null>;
  chatStickRef: MutableRefObject<boolean>;
}): void {
  /** 待办卡主名字定位(2026-11-03):nonce 变更即滚到关联轮次正文输入气泡——锚定+迭代校正
   *  (ChatRail jump 同款,content-visibility 离屏估算高一次到位必偏),定位即撤贴底跟随 */
  useEffect(() => {
    if (todoFocus === null || todoFocus === undefined) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const node = el.querySelector(`.entry-user[data-entry-key="${CSS.escape(todoFocus.key)}"]`);
    if (node === null) return;
    chatStickRef.current = false;
    // gBCR 视觉差 → scrollTop 本地空间(界面放缩 /zoom 归一,ui-zoom.ts 契约)
    el.scrollTop += (node.getBoundingClientRect().top - el.getBoundingClientRect().top) / zoomScale();
    rAFConverge(el, () => node.getBoundingClientRect().top - el.getBoundingClientRect().top, (delta) => {
      el.scrollTop += delta / zoomScale();
    }, 2);
  }, [todoFocus, chatScrollRef, chatStickRef]);
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
}
