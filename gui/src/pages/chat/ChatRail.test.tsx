import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { ChatRail } from './ChatRail';
import type { ChatEntry } from '../../chat-reducer';

/**
 * 2026-11-18 大会话滚动 CPU 轮(用户实测「打开多个会话后滑动 CPU 高」;产品口径上千上万条):
 * 刻度条的滚动路径从 O(用户消息数)/帧 收敛为 O(log N):
 * ①滚动判定改二分(文档序=纵向序),不再逐只 gBCR 全表;②加亮直改 DOM class 不走 state
 * (旧实现每变一次整条刻度重渲染);③预览串随 entries 封存(旧实现每渲染重算 N 份 previewText)。
 * jsdom 无布局:gBCR/getComputedStyle 打桩(chat 口 800×600,pad 40;用户气泡按表给 top)。
 */

const mk = (key: string, kind: 'user' | 'assistant', md: string): ChatEntry => ({ key, kind, md, seq: 1, ts: 0 }) as unknown as ChatEntry;

describe('ChatRail 滚动定位(大会话 CPU 轮)', () => {
  const origGBCR = Element.prototype.getBoundingClientRect;
  const origGCS = window.getComputedStyle;
  afterEach(() => {
    Element.prototype.getBoundingClientRect = origGBCR;
    window.getComputedStyle = origGCS;
    document.body.innerHTML = '';
  });

  it('二分取越线气泡 → 对应刻度加亮;预览串=封存行数据', async () => {
    const chat = document.createElement('div');
    chat.className = 'chat';
    const tops = new Map<string, number>([
      ['u1', 0],
      ['u2', 100],
      ['u3', 300],
      ['u4', 700],
    ]);
    for (const key of ['u1', 'u2', 'u3', 'u4']) {
      const node = document.createElement('div');
      node.className = 'entry-user';
      node.setAttribute('data-entry-key', key);
      chat.appendChild(node);
    }
    document.body.appendChild(chat);
    const rectOf = (top: number, height: number): DOMRect =>
      ({ top, bottom: top + height, height, width: 800, left: 40, right: 840, x: 40, y: top, toJSON: () => ({}) }) as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this === chat) return rectOf(0, 600);
      const k = this.getAttribute?.('data-entry-key');
      if (k !== null && k !== undefined) return rectOf(tops.get(k) ?? 0, 10);
      return origGBCR.call(this);
    };
    window.getComputedStyle = ((el: Element, pe?: string | null): CSSStyleDeclaration => {
      const st = pe === undefined ? origGCS(el) : origGCS(el, pe);
      return el === chat ? ({ ...st, paddingLeft: '40px' } as CSSStyleDeclaration) : st;
    }) as typeof getComputedStyle;

    const entries = [mk('u1', 'user', 'm1'), mk('u2', 'user', 'm2'), mk('u3', 'user', 'm3'), mk('u4', 'user', 'm4'), mk('a4', 'assistant', 'reply-4')];
    const ref = { current: chat as HTMLElement | null };
    const view = render(<ChatRail entries={entries} chatScrollRef={ref} />);
    // 首亮沉降门 350ms:等过再断言(实机即此门)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const ticks = Array.from(document.querySelectorAll<HTMLButtonElement>('.sx-rail-tick'));
    expect(ticks.length).toBe(4);
    // 判定线 = 滚动口下缘 600 − 40 = 560:越线最后一只 = u3(300 ≤ 560 < 700)
    expect(ticks[2]!.classList.contains('active')).toBe(true);
    expect(ticks[3]!.classList.contains('active')).toBe(false);
    // 预览串按需:未 hover 时零预览卡(2026-11-19 切换/流式卡顿轮——旧实现 N×2 预览 span 常驻,
    // 且每渲染重算 N 份 previewText)
    expect(document.querySelectorAll('.sx-rail-preview').length).toBe(0);
    // 预览串来自封存行(回复预览取末条 assistant),只在 hover 那一枚算/挂
    fireEvent.mouseEnter(ticks[0]!);
    // 2026-11-20 预览移出刻度按钮(列表内滚不裁预览):全局单卡查询
    expect(document.querySelector('.sx-rail-preview .sx-rail-pv-user')!.textContent).toBe('m1');
    expect(document.querySelectorAll('.sx-rail-preview').length).toBe(1);
    fireEvent.mouseLeave(ticks[0]!);
    fireEvent.mouseEnter(ticks[3]!);
    expect(document.querySelector('.sx-rail-preview .sx-rail-pv-reply')!.textContent).toBe('reply-4');
    view.unmount();
  });
});
