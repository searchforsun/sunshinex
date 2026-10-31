import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatScrollbar } from './ChatScrollbar';

/** 滚动条:长度始终响应式;贴底闩在 scrollTop 未跟上的撑高帧仍粘底。jsdom 无布局,尺寸面
 *  defineProperty 桩定。rAF 合流后落值在下一帧——用例 await 帧冲洗。 */

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

describe('ChatScrollbar', () => {
  it('非贴底:长度响应式,位置映射 scrollTop 比例(y 整数落写)', async () => {
    const { box } = stubBox();
    const { thumb } = mount(box);
    // max=1500,track 300,thumb=300×500/2000=75:半程 scrollTop=750 → y=0.5×(300-75)=112.5→取整 113
    box.scrollTop = 750;
    box.dispatchEvent(new Event('scroll'));
    await flushFrame();
    expect(thumb.style.opacity).toBe('1');
    expect(thumb.style.height).toBe('75px');
    expect(thumb.style.transform).toBe('translateY(113px)');
  });

  it('贴底:长度仍响应式,位置钉轨道底', async () => {
    const { box } = stubBox();
    const { thumb } = mount(box);
    box.scrollTop = 1500; // max
    box.dispatchEvent(new Event('scroll'));
    await flushFrame();
    expect(thumb.style.height).toBe('75px');
    expect(thumb.style.transform).toBe('translateY(225px)'); // trackH-th=300-75
  });

  it('贴底闩:撑高后 scrollTop 未跟上仍粘底(冷加载抖动根)', async () => {
    const { box } = stubBox();
    const { thumb } = mount(box);
    box.scrollTop = 1500;
    box.dispatchEvent(new Event('scroll'));
    await flushFrame();
    expect(thumb.style.transform).toBe('translateY(225px)');

    // 内容撑高,scrollTop 仍停在旧 max——距底已远;MO 路径不得按比例式脱底
    Object.defineProperty(box, 'scrollHeight', { value: 3000, configurable: true });
    box.appendChild(document.createElement('div'));
    await flushFrame();
    // th=500/3000×300=50;粘底 y=300-50=250(比例式会落到 1500/2500×250=150)
    expect(thumb.style.height).toBe('50px');
    expect(thumb.style.transform).toBe('translateY(250px)');
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
