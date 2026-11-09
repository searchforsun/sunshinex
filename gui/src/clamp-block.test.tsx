import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ClampBlock, DETAIL_MAX_HEIGHT } from './clamp-block';

/** 详情限高块钉(2026-11-09 用户裁定):超统一高度=限高+纵向滚动(clamped 类=overflow-y auto)+V;展开去
 *  maxHeight(完整高度、滚动条消失)、^ 收起回限高;外层行折叠(卸载)再展开回折叠态=外部折叠自动带走内部 ^。
 *  ResizeObserver 在 jsdom 缺席:组件有 typeof 守卫,本测注入短路径桩走 measure 一次口径 */
class RoStub {
  static instances: RoStub[] = [];
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    RoStub.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {}
  trigger(): void {
    this.cb();
  }
}

afterEach(() => {
  // @ts-expect-error test stub
  delete globalThis.ResizeObserver;
  RoStub.instances = [];
});

function Row({ text }: { text: string }): JSX.Element {
  return <ClampBlock as="pre" className="mem-body-text">{text}</ClampBlock>;
}

function Outer({ text, open }: { text: string; open: boolean }): JSX.Element | null {
  return open ? <Row text={text} /> : null;
}

describe('ClampBlock 详情限高块', () => {
  const short = 'short\n';
  const tall = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');

  it('未超限不出 V;超限出 V 且限高 overflow hidden;点 V 展开去掉 maxHeight(完整高度无内滚),^ 收回', () => {
    // @ts-expect-error test stub
    globalThis.ResizeObserver = RoStub;
    const { rerender } = render(<Row text={short} />);
    expect(screen.queryByRole('button')).toBeNull(); // 未超限:无钮
    expect((document.querySelector('.sx-clamp') as HTMLElement).style.height).toBe(`${DETAIL_MAX_HEIGHT}px`); // 短内容也固定高
    rerender(<Row text={tall} />);
    expect(RoStub.instances.length).toBeGreaterThan(0);
    // 内容高由 jsdom 布局决定=0,直接经 scrollHeight 桩驱动「超限」判定:手动设 prototype 不便,
    // 改为触发 RO 回调前先把 scrollHeight 桩上——jsdom scrollHeight 恒 0,故此处用超阈值文本+
    // Object.defineProperty 一次性抬 scrollHeight
    const first = document.querySelector('.sx-clamp') as HTMLElement;
    Object.defineProperty(first, 'scrollHeight', { value: 400, configurable: true });
    act(() => RoStub.instances.forEach((r) => r.trigger()));
    const v = screen.getByRole('button', { name: 'Expand' });
    expect(first.className).toContain('clamped');
    expect(first.style.height).toBe(`${DETAIL_MAX_HEIGHT}px`); // 固定高(CSS clamped=overflow-y auto 出滚动条)
    fireEvent.click(v);
    const openEl = document.querySelector('.sx-clamp') as HTMLElement;
    expect(openEl.className).not.toContain('clamped');
    expect(openEl.style.height).toBe(''); // 展开态:完整高度=滚动条消失
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect((document.querySelector('.sx-clamp') as HTMLElement).className).toContain('clamped');
  });

  it('外层行折叠(卸载)再展开:回折叠态,内部 ^ 被自动带走', () => {
    // @ts-expect-error test stub
    globalThis.ResizeObserver = RoStub;
    const { rerender } = render(<Outer text={tall} open />);
    const el = document.querySelector('.sx-clamp') as HTMLElement;
    Object.defineProperty(el, 'scrollHeight', { value: 400, configurable: true });
    act(() => RoStub.instances.forEach((r) => r.trigger()));
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect((document.querySelector('.sx-clamp') as HTMLElement).className).not.toContain('clamped');
    // 外层折叠=ClampBlock 卸载;再展开=新实例,回到折叠态
    rerender(<Outer text={tall} open={false} />);
    expect(document.querySelector('.sx-clamp')).toBeNull();
    rerender(<Outer text={tall} open />);
    const fresh = document.querySelector('.sx-clamp') as HTMLElement;
    Object.defineProperty(fresh, 'scrollHeight', { value: 400, configurable: true });
    act(() => RoStub.instances.forEach((r) => r.trigger()));
    expect(fresh.className).toContain('clamped');
    expect(screen.getByRole('button', { name: 'Expand' })).toBeDefined();
  });
});
