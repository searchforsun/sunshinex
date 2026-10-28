import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { zoomScale } from '../../ui-zoom';

/**
 * 正文纵向滚动条(2026-10-27 二次裁定,反转「长度恒定」):thumb 长度响应式=轨道×视口/内容比
 * (下限 32px),所见即内容量;流式增长时长度随之变化为预期行为(直接 DOM 写,无 setState 抖动
 * 面)。轨道上下边界动态夹紧到滚动容器实际区域——挂载锚是 .sx-main(定位父级),不夹则越顶栏
 * 分割线(用户实测)。实现纪律不变:全直接 DOM 写(零 setState/零 rAF),组件只渲染一次;
 * 同步面=scroll+RO(容器自身尺寸)+MO(条目挂载改 scrollHeight 的盲区)。
 * 交互仅 thumb 拖拽;指针位移按 zoomScale() 归一(视觉 px→本地 px,ui-zoom 契约)。
 * 挂载面:仅主对话(sideChat!==true);原生条由 CSS 在 `.sx-main > .chat` 隐藏。
 */



export function ChatScrollbar(props: { containerRef: MutableRefObject<HTMLElement | null> }): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const box = props.containerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (box === null || track === null || thumb === null) return;

    const sync = (): void => {
      // 轨道上下界动态夹紧到滚动容器实际矩形(不夹则 overlay 从 .sx-main 顶画起,越过顶栏分割线)
      const cr = box.getBoundingClientRect();
      const tr = track.getBoundingClientRect();
      track.style.top = `${Math.max(Math.round(cr.top - tr.top), 0) + 2}px`;
      track.style.bottom = `${Math.max(Math.round(tr.bottom - cr.bottom), 0) + 2}px`;
      const max = box.scrollHeight - box.clientHeight;
      const trackH = track.clientHeight;
      if (max <= 1 || box.scrollHeight <= 0) {
        thumb.style.opacity = '0';
        return;
      }
      // 响应式长度=轨道×视口/内容比,下限 32px(用户裁定反转「恒定 56」)
      const th = Math.max(32, Math.round((box.clientHeight / box.scrollHeight) * trackH));
      thumb.style.height = `${th}px`;
      const y = Math.min(Math.max((box.scrollTop / max) * (trackH - th), 0), trackH - th);
      thumb.style.opacity = '1';
      thumb.style.transform = `translateY(${y}px)`;
    };

    box.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => sync()) : null;
    ro?.observe(box);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => sync()) : null;
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

    sync();
    return () => {
      box.removeEventListener('scroll', sync);
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
