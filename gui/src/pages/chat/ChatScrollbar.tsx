import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { zoomScale } from '../../ui-zoom';

/**
 * 正文固定长纵向滚动条(2026-10-27 用户裁定):原生 thumb 长度=视口/内容比,流式增长与图片
 * 解码逐段改写 scrollHeight,thumb 随之抖缩(「长度抖动,好像分段一样」)——自绘 overlay:
 * 长度恒定(CSS 56px 本地 px,与内容量无关,冷加载即最终态无二次变化),仅位置映射 scrollTop
 * 比例。实现纪律:全直接 DOM 写(零 setState/零 rAF——RO/MO 回调本就按帧合并,scroll 事件
 * 按帧派发),组件只渲染一次;同步面=scroll+RO(容器自身尺寸)+MO(条目挂载改 scrollHeight,
 * 用户上翻阅读时流式在下方长高无 scroll 事件的盲区)。
 * 交互仅 thumb 拖拽(track 点跳退役:track 若接事件须盖住右缘内容条,窄窗压正文选区);
 * 指针位移按 zoomScale() 归一(视觉 px→本地 px,ui-zoom 契约),映射比无量纲不受 zoom 影响。
 * 挂载面:仅主对话(Chat 内 sideChat!==true 才挂,容器=.sx-main 定位父级);原生条由 CSS 在
 * `.sx-main > .chat` 隐藏,侧栏 dock 与 Files 等其余滚动面不动。
 */

const THUMB_FALLBACK = 56;

export function ChatScrollbar(props: { containerRef: MutableRefObject<HTMLElement | null> }): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const box = props.containerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (box === null || track === null || thumb === null) return;

    const sync = (): void => {
      const max = box.scrollHeight - box.clientHeight;
      const trackH = track.clientHeight;
      const th = thumb.offsetHeight > 0 ? thumb.offsetHeight : THUMB_FALLBACK;
      if (max <= 1 || trackH <= th + 8) {
        thumb.style.opacity = '0';
        return;
      }
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
      const th = thumb.offsetHeight > 0 ? thumb.offsetHeight : THUMB_FALLBACK;
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
      const th = thumb.offsetHeight > 0 ? thumb.offsetHeight : THUMB_FALLBACK;
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
