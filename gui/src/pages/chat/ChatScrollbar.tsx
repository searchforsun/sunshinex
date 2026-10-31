import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { zoomScale } from '../../ui-zoom';

/**
 * 正文纵向滚动条(2026-10-27 二次裁定,反转「长度恒定」):thumb 长度响应式=轨道×视口/内容比
 * (下限 32px),所见即内容量。轨道上下边界动态夹紧到滚动容器实际区域(锚 .sx-main)。
 * 贴底闩(2026-10-31):冷会话/流式渐进撑高时 MO 先于贴底归底改 scrollHeight——若只改长度、
 * 位置等 scroll 才钉底,thumb 底缘会先抬后落=上下抖;一旦贴底,后续几何同步同帧粘
 * y=trackH−th,不以滞后 scrollTop 重判脱闩(scroll 路径才更新闩)。同步源 scroll+RO+MO
 * 经 rAF 帧内合流;y 取整防亚像素闪。交互仅 thumb 拖拽;指针位移按 zoomScale() 归一。
 * 挂载面:仅主对话。
 */

const THUMB_MIN = 32;

function thumbHeight(trackH: number, clientH: number, scrollH: number): number {
  return Math.max(THUMB_MIN, Math.round((clientH / scrollH) * trackH));
}

export function ChatScrollbar(props: { containerRef: MutableRefObject<HTMLElement | null> }): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const box = props.containerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (box === null || track === null || thumb === null) return;

    /** 贴底闩:scroll 路径按距底≤4px 更新;MO 几何路径只读——撑高瞬间 scrollTop 未跟上仍粘底 */
    let lastPinned = false;

    const layoutTrack = (): void => {
      // 轨道边界=锚 offsetParent 绝对坐标直写(防 top(n+1)=T−top(n)+2 周期振荡)。
      // 同值写守卫:恒等字符串不落 DOM。zoom 契约:视觉差 /z 归一成本地 px
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

    /** withPosition=true(scroll/RO):重判闩并写位置;false(MO):只改长度,闩开时同帧粘底 */
    const writeThumb = (withPosition: boolean): void => {
      layoutTrack();
      const max = box.scrollHeight - box.clientHeight;
      const trackH = track.clientHeight;
      if (max <= 1 || box.scrollHeight <= 0) {
        thumb.style.opacity = '0';
        return;
      }
      if (withPosition) lastPinned = max - box.scrollTop <= 4;
      const th = thumbHeight(trackH, box.clientHeight, box.scrollHeight);
      if (thumb.style.height !== `${th}px`) thumb.style.height = `${th}px`;
      if (!withPosition && !lastPinned) return;
      const y = lastPinned
        ? trackH - th
        : Math.min(Math.max((box.scrollTop / max) * (trackH - th), 0), trackH - th);
      thumb.style.opacity = '1';
      // y 取整:zoom 树下分数 scrollTop→分数 translateY 落设备像素反复跳=亚像素闪烁
      thumb.style.transform = `translateY(${Math.round(y)}px)`;
    };

    // rAF 合流:流式期 scroll(贴底归底)+MO 高频交替,帧内合并至多一次同步
    let rafId: number | null = null;
    let withPosition = false;
    const requestSync = (position: boolean): void => {
      if (position) withPosition = true;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const p = withPosition;
        withPosition = false;
        writeThumb(p);
      });
    };

    const onScroll = (): void => requestSync(true);
    box.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => requestSync(true)) : null;
    ro?.observe(box);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => requestSync(false)) : null;
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
      thumb.classList.add('sx-vbar-drag');
      thumb.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
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

    writeThumb(true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
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
    <div className="sx-vbar" ref={trackRef} aria-hidden="true">
      <div className="sx-vbar-thumb" ref={thumbRef} />
    </div>
  );
}
