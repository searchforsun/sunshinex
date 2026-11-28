import { useEffect, useRef, type MutableRefObject } from 'react';
import { rAFConverge } from '../../ui-util';
import { zoomScale } from '../../ui-zoom';

/** 转录区定位簇（D62 批C，2026-11-08 自 Chat.tsx 外提——两 effect 逐字平移，行为零变化）：
 *  成员转录 leader 链接定位。命中即撤贴底跟随，锚定+rAF 迭代校正（content-visibility 离屏估高）。
 *  待办卡主名字→用户气泡定位随 2026-11-25「去掉和用户消息的绑定」裁定退役（待办是会话级清单，
 *  不再归属某个用户气泡）。
 *  跨 Sunx 两个方向（2026-11-26）：①接收方点来源行→发送轮落点走 MessageList（revealRequest，与左侧
 *  刻度同路径、无闪光）；②发送方点投递行目标名→目标会话里刚投递的用户气泡（按正文匹配，本簇
 *  sunxBubbleFocus，leader 同款 rAF 收敛）。
 */
export function useChatLocate({
  leaderFocus,
  sunxBubbleFocus,
  onSunxBubbleFocusDone,
  chatScrollRef,
  chatStickRef,
}: {
  leaderFocus: { member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null | undefined;
  /** 跨 Sunx 投递目标气泡定位（2026-11-26 用户裁定「点击可以跳转到指定气泡」）：正文 needle + nonce */
  sunxBubbleFocus?: { text: string; nonce: number } | null;
  onSunxBubbleFocusDone?: () => void;
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

  /** 跨 Sunx 投递目标气泡定位（2026-11-26）：目标会话里刚投递的那条用户气泡（正文前缀匹配，
   *  末条优先——同文多投取最新）；未挂载（播种中）时 ≤90 帧有界轮询，命中即滚到位（无闪光，
   *  与刻度同款 scrollTop+rAFConverge）、消费清信号 */
  const bubbleHandledRef = useRef(0);
  useEffect(() => {
    const f = sunxBubbleFocus;
    if (f === null || f === undefined || bubbleHandledRef.current === f.nonce) return;
    const el = chatScrollRef.current;
    if (el === null) return;
    const norm = (x: string): string => x.replace(/\s+/g, ' ').trim();
    // 2026-11-28 十轮「群主气泡 @sunx chip 点击定位不到」：目标会话里的 @提及 渲染成 chip（textContent
    // 只有名字、无 @ 前缀），群页 needle 带 @ ——剥掉 @令牌 再比;原文与剥后双针,任一命中即可
    const stripAt = (x: string): string => x.replace(/(^|\s)@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim();
    const needles = [norm(f.text).slice(0, 60), stripAt(f.text).slice(0, 60)].filter((x) => x !== '');
    const find = (): HTMLElement | undefined =>
      needles.length === 0
        ? undefined
        : [...el.querySelectorAll<HTMLElement>('.entry-user[data-entry-key]')]
            .filter((n) => {
              const body = norm(n.querySelector('.user-md-plain')?.textContent ?? '');
              return needles.some((nd) => body.includes(nd));
            })
            .at(-1);
    const land = (node: HTMLElement): void => {
      chatStickRef.current = false;
      el.scrollTop += (node.getBoundingClientRect().top - el.getBoundingClientRect().top) / zoomScale();
      rAFConverge(el, () => node.getBoundingClientRect().top - el.getBoundingClientRect().top, (d) => {
        el.scrollTop += d / zoomScale();
      }, 2);
    };
    bubbleHandledRef.current = f.nonce;
    const hit = find();
    if (hit !== undefined) {
      land(hit);
      onSunxBubbleFocusDone?.();
      return;
    }
    let tries = 0;
    const seek = (): void => {
      const n2 = find();
      if (n2 === undefined) {
        tries += 1;
        if (tries < 90) requestAnimationFrame(seek);
        else onSunxBubbleFocusDone?.();
        return;
      }
      land(n2);
      onSunxBubbleFocusDone?.();
    };
    requestAnimationFrame(seek);
  }, [sunxBubbleFocus, onSunxBubbleFocusDone, chatScrollRef, chatStickRef]);
}
