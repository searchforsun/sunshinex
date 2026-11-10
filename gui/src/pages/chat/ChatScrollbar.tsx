import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { zoomScale } from '../../ui-zoom';

/**
 * 正文纵向滚动条:thumb 长度响应式=轨道×视口/内容比(下限 32px)。
 * 贴底闩:MO 撑高先于归底时同帧粘 y=trackH−th。
 * 滚动期稳态(2026-10-31 根修):历史债=content-visibility 水合 + 阅读态 overflow-anchor
 * 回拉 + 滚动中 MO/RO 仍 layoutTrack——三源叠加=thumb/视口上下回退。本组件滚动窗内:
 * ①只接受 scroll 改位置 ②冻结长度 ③吞掉 MO/RO(贴底除外仍粘底) ④临时 overflow-anchor:none
 * 切断原生回拉。静默后一帧全量校正。
 */

const THUMB_MIN = 32;
const SCROLL_SETTLE_MS = 140;

function thumbHeight(trackH: number, clientH: number, scrollH: number): number {
  return Math.max(THUMB_MIN, Math.round((clientH / scrollH) * trackH));
}

export function ChatScrollbar(props: { containerRef: MutableRefObject<HTMLElement | null>; /** bottom 让位(px,终端下栏开时=栏高):overlay 定位锚=.sx-main 全高,不避让即条带盖进下栏区 */ bottomOffset?: number }): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const box = props.containerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (box === null || track === null || thumb === null) return;

    let lastPinned = false;
    let scrolling = false;
    let frozenTh: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    /** 进入滚动窗前的锚定值,静默后还原——避免长期污染 stick 路径的 syncOverflowAnchor */
    let savedAnchor: string | null = null;

    const layoutTrack = (): void => {
      const cr = box.getBoundingClientRect();
      const ar = track.offsetParent instanceof HTMLElement ? track.offsetParent.getBoundingClientRect() : null;
      const z = zoomScale();
      if (ar !== null) {
        const top = `${Math.max(Math.round((cr.top - ar.top) / z), 0) + 2}px`;
        const bottom = `${Math.max(Math.round((ar.bottom - cr.bottom) / z), 0) + 2}px`;
        if (track.style.top !== top) track.style.top = top;
        if (track.style.bottom !== bottom) track.style.bottom = bottom;
      }
    };

    const writeThumb = (withPosition: boolean, relayout: boolean): void => {
      if (relayout) layoutTrack();
      const max = box.scrollHeight - box.clientHeight;
      const trackH = track.clientHeight;
      if (max <= 1 || box.scrollHeight <= 0) {
        thumb.style.opacity = '0';
        return;
      }
      if (trackH <= THUMB_MIN) return;
      if (withPosition) lastPinned = max - box.scrollTop <= 4;
      let th: number;
      if (scrolling && frozenTh !== null && !lastPinned) {
        th = frozenTh;
      } else {
        th = thumbHeight(trackH, box.clientHeight, box.scrollHeight);
        frozenTh = th;
      }
      if (thumb.style.height !== `${th}px`) thumb.style.height = `${th}px`;
      if (!withPosition && !lastPinned) return;
      const y = lastPinned
        ? trackH - th
        : Math.min(Math.max((box.scrollTop / max) * (trackH - th), 0), trackH - th);
      thumb.style.opacity = '1';
      const next = `translateY(${Math.round(y)}px)`;
      if (thumb.style.transform !== next) thumb.style.transform = next;
    };

    let rafId: number | null = null;
    let wantPosition = false;
    let wantLayout = false;
    const requestSync = (position: boolean, relayout: boolean): void => {
      if (position) wantPosition = true;
      if (relayout) wantLayout = true;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const p = wantPosition;
        const l = wantLayout;
        wantPosition = false;
        wantLayout = false;
        writeThumb(p, l);
      });
    };

    const markScrolling = (): void => {
      if (!scrolling) {
        scrolling = true;
        // 切断阅读态 overflow-anchor 回拉(历史 G14.211 auto × cv 水合 = 滚动中视口回退)
        savedAnchor = box.style.overflowAnchor;
        box.style.overflowAnchor = 'none';
      }
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        scrolling = false;
        settleTimer = null;
        if (savedAnchor !== null) {
          box.style.overflowAnchor = savedAnchor;
          savedAnchor = null;
        }
        requestSync(true, true);
      }, SCROLL_SETTLE_MS);
    };

    const onScroll = (): void => {
      markScrolling();
      requestSync(true, false);
    };
    box.addEventListener('scroll', onScroll, { passive: true });

    // 滚动窗内吞掉 MO/RO(非贴底):历史路径滚动中仍 layoutTrack/改长 = thumb 回退主因之一;
    // 贴底仍放行(冷加载粘底),但不重测轨道、不重判闩(scrollTop 滞后会误脱闩)
    const onResize = (): void => {
      if (scrolling && !lastPinned) return;
      requestSync(false, !scrolling);
    };
    const onMutate = (): void => {
      if (scrolling && !lastPinned) return;
      requestSync(false, !scrolling);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(box);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(onMutate) : null;
    mo?.observe(box, { childList: true, subtree: true });

    let dragging = false;
    let grab = 0;
    const yLocalOf = (e: { clientY: number }): number => {
      const rect = track.getBoundingClientRect();
      return (e.clientY - rect.top) / zoomScale();
    };
    const onDown = (e: PointerEvent): void => {
      const max = box.scrollHeight - box.clientHeight;
      const trackH = track.clientHeight;
      const th = thumb.offsetHeight;
      if (max <= 1 || trackH <= th + 8) return;
      const m = /translateY\((-?[\d.]+)px\)/.exec(thumb.style.transform);
      grab = yLocalOf(e) - (m !== null ? parseFloat(m[1]) : 0);
      dragging = true;
      markScrolling();
      thumb.classList.add('sx-vbar-drag');
      thumb.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      markScrolling();
      const max = box.scrollHeight - box.clientHeight;
      const trackH = track.clientHeight;
      const th = thumb.offsetHeight;
      if (max <= 1 || trackH <= th + 8) return;
      const y = Math.min(Math.max(yLocalOf(e) - grab, 0), trackH - th);
      box.scrollTop = (y / (trackH - th)) * max;
    };
    const onUp = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      thumb.classList.remove('sx-vbar-drag');
      thumb.releasePointerCapture?.(e.pointerId);
    };
    thumb.addEventListener('pointerdown', onDown);
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
    thumb.addEventListener('pointercancel', onUp);

    writeThumb(true, true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (savedAnchor !== null) box.style.overflowAnchor = savedAnchor;
      box.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      mo?.disconnect();
      thumb.removeEventListener('pointerdown', onDown);
      thumb.removeEventListener('pointermove', onMove);
      thumb.removeEventListener('pointerup', onUp);
      thumb.removeEventListener('pointercancel', onUp);
    };
  }, [props.containerRef]);

  return (
    <div className="sx-vbar" ref={trackRef} aria-hidden="true" style={props.bottomOffset !== undefined ? { bottom: props.bottomOffset } : undefined}>
      <div className="sx-vbar-thumb" ref={thumbRef} />
    </div>
  );
}
