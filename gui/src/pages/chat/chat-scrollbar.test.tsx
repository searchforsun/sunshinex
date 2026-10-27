import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatScrollbar } from './ChatScrollbar';

/** 固定长滚动条(2026-10-27 用户裁定):thumb 长度恒定,仅位置映射 scrollTop——jsdom 无布局,
 *  尺寸面全部 defineProperty 桩定(clientHeight/scrollHeight/scrollTop),断言 transform 映射
 *  与无溢出隐藏两态;同步全在 scroll 监听内直接 DOM 写(零 setState/零 rAF) */

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

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ChatScrollbar 固定长滚动条', () => {
  it('scroll 同步把 scrollTop 比例映射为 translateY,位置动而长度恒', () => {
    const { box } = stubBox();
    const { thumb } = mount(box);
    // max=1500,track 300,thumb 常量 56:半程 scrollTop=750 → y=0.5×(300-56)=122
    box.scrollTop = 750;
    box.dispatchEvent(new Event('scroll'));
    expect(thumb.style.opacity).toBe('1');
    expect(thumb.style.transform).toBe('translateY(122px)');
    // 滚到底:y 钳到 trackH-th=244——长度不变(56 由 CSS 常量承担,组件只写位置)
    box.scrollTop = 1500;
    box.dispatchEvent(new Event('scroll'));
    expect(thumb.style.transform).toBe('translateY(244px)');
  });

  it('无溢出(scrollHeight≤clientHeight):thumb 隐藏', () => {
    const { box } = stubBox();
    Object.defineProperty(box, 'scrollHeight', { value: 400, configurable: true });
    const { thumb } = mount(box);
    box.dispatchEvent(new Event('scroll'));
    expect(thumb.style.opacity).toBe('0');
  });
});
