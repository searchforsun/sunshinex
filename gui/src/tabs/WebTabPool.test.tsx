import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { WebTabPool, type WebPoolItem } from './WebTabPool';
import type { Connection } from '../connection';

/**
 * WebTabPool 对位 zoom 归一锚(ui-zoom 跨空间契约):占位框 gBCR=视觉 px,池项 position:fixed
 * 在 html zoom 子树内样式 px=本地值(视觉/zoom)——不归一即错位+超宽(用户实测 zoom1.25:
 * 浏览器页签整体右移 25% 左侧空白、宽度放大 25% 右侧越视口)。
 */

const VISUAL = { left: 322, top: 95, width: 978, height: 860 };

function stubConn(): Connection {
  return { fetchWebMeta: () => Promise.resolve({ title: '', icon: '' }) } as unknown as Connection;
}

function rectMock(): DOMRect {
  return { ...VISUAL, x: VISUAL.left, y: VISUAL.top, right: VISUAL.left + VISUAL.width, bottom: VISUAL.top + VISUAL.height, toJSON: () => ({}) } as DOMRect;
}

const ITEMS: readonly WebPoolItem[] = [{ seat: 's1', uid: 'u1', params: { url: 'https://x' } }];

describe('WebTabPool 对位 zoom 归一', () => {
  let anchor: HTMLDivElement;
  beforeEach(() => {
    document.documentElement.style.zoom = '';
    anchor = document.createElement('div');
    document.body.appendChild(anchor);
  });
  afterEach(() => {
    anchor.remove();
    document.documentElement.style.zoom = '';
  });

  const frame = async (): Promise<void> => {
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
  };

  it('zoom≠1:gBCR 视觉值 / zoomScale 落本地样式(zoom1.25:left322→257.6,width978→782.4)', async () => {
    document.documentElement.style.zoom = '1.25';
    anchor.getBoundingClientRect = () => rectMock();
    const { container } = render(
      <WebTabPool
        conn={stubConn()}
        items={ITEMS}
        visibleUid="u1"
        anchorRef={{ current: anchor }}
        root="/r"
        draftSeat="s1"
        onMeta={() => {}}
        onClose={() => {}}
        onActivate={() => {}}
      />,
    );
    await frame();
    const item = container.querySelector('.sx-webpool-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.style.left).toBe('257.6px');
    expect(item.style.top).toBe('76px');
    expect(item.style.width).toBe('782.4px');
    expect(item.style.height).toBe('688px');
  });

  it('zoom=1:gBCR 原样透传落样式', async () => {
    anchor.getBoundingClientRect = () => rectMock();
    const { container } = render(
      <WebTabPool
        conn={stubConn()}
        items={ITEMS}
        visibleUid="u1"
        anchorRef={{ current: anchor }}
        root="/r"
        draftSeat="s1"
        onMeta={() => {}}
        onClose={() => {}}
        onActivate={() => {}}
      />,
    );
    await frame();
    const item = container.querySelector('.sx-webpool-item') as HTMLElement;
    expect(item.style.left).toBe('322px');
    expect(item.style.width).toBe('978px');
  });
});
