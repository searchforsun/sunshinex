import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatScrollbar } from './ChatScrollbar';

/** 响应式滚动条(2026-10-27 二次裁定):thumb 长度=轨道x视口/内容比(下限 32),位置映射 scrollTop——jsdom 无布局,
 *  尺寸面全部 defineProperty 桩定(clientHeight/scrollHeight/scrollTop),断言 transform 映射
 *  与无溢出隐藏两态。2026-10-31 rAF 合流:同步事件只排队,落值在下一动画帧——用例 await 帧
 *  冲洗后再断言;y 写整数(亚像素闪烁根修,112.5→113)。 */

function stubBox(): { box: HTMLElement } {
  const box = document.createElement('div');
  let top = 0;
  Object.defineProperty(box, 'clientHeight', { value: 500, configurable: true });
  Object.defineProperty(box, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(box, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
  document.body.appendChild(box);
  return { box };
}

function mount(barHost: HTMLElement): { thumb: HTMLElement } {
  render(<ChatScrollbar containerRef={{ current: barHost }} />);
  const track = document.querySelector('.sx-vbar') as HTMLElement;
  const thumb = document.querySelector('.sx-vbar-thumb') as HTMLElement;
  expect(track).not.toBeNull();
  expect(thumb).not.toBeNull();
  Object.defineProperty(track, 'clientHeight', { value: 300, configurable: true });
  return { thumb };
}

/** 帧冲洗:rAF 合流后落值在下一动画帧(jsdom rAF=定时器实现,16ms 窗足够) */
const flushFrame = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ChatScrollbar 响应式滚动条', () => {
  it('scroll 同步(rAF 合流):长度响应式映射内容比,位置映射 scrollTop 比例(y 整数落写)', async () => {
    const { box } = stubBox();
    const { thumb } = mount(box);
    // max=1500,track 300,thumb 响应式=300×500/2000=75:半程 scrollTop=750 → y=0.5×(300-75)=112.5→取整 113
    box.scrollTop = 750;
    box.dispatchEvent(new Event('scroll'));
    await flushFrame();
    expect(thumb.style.opacity).toBe('1');
    expect(thumb.style.height).toBe('75px');
    expect(thumb.style.transform).toBe('translateY(113px)');
    // 滚到底:y 钳到 trackH-th=225
    box.scrollTop = 1500;
    box.dispatchEvent(new Event('scroll'));
    await flushFrame();
    expect(thumb.style.transform).toBe('translateY(225px)');
  });

  it('无溢出(scrollHeight≤clientHeight):thumb 隐藏', async () => {
    const { box } = stubBox();
    Object.defineProperty(box, 'scrollHeight', { value: 400, configurable: true });
    const { thumb } = mount(box);
    box.dispatchEvent(new Event('scroll'));
    await flushFrame();
    expect(thumb.style.opacity).toBe('0');
  });
});
