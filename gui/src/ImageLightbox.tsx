import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Check, Copy, Download, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { t } from './i18n';
import { COPY_RESET_MS } from './use-copy-feedback';

/**
 * 图片查看浮层(2026-10-26 图片功能):全屏遮罩单图查看——缩放(按钮/滚轮/键盘,±25% 步进,
 * 25%–800%)+拖拽平移+倍数显形+复制到剪贴板+下载原文件。点遮罩/Esc 关闭。复制统一转 PNG
 * (ClipboardItem 仅原生 PNG 广泛支持;GIF/JPEG 经 canvas 转码),失败 1.5s 示「未复制」不弹错。
 */

const SCALE_MIN = 0.25;
const SCALE_MAX = 8;
const SCALE_STEP = 1.25;

/** dataURL/blob URL → PNG blob(剪贴板写入面统一形态);canvas 不可用/解码失败回 undefined */
async function toPngBlob(src: string): Promise<Blob | undefined> {
  try {
    const bmp = await createImageBitmap(await (await fetch(src)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), 'image/png'));
  } catch {
    return undefined;
  }
}

export function ImageLightbox({ src, name, onClose }: { src: string; name?: string; onClose: () => void }): JSX.Element {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);
  const zoomBy = useCallback((f: number): void => {
    setScale((v) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * f * 100) / 100)));
  }, []);
  const copyImage = useCallback((): void => {
    void (async () => {
      const done = (ok: boolean): void => {
        setCopyState(ok ? 'ok' : 'fail');
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopyState('idle'), COPY_RESET_MS);
      };
      try {
        const png = await toPngBlob(src);
        if (png === undefined || typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) {
          done(false);
          return;
        }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        done(true);
      } catch {
        done(false);
      }
    })();
  }, [src]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomBy(SCALE_STEP);
      else if (e.key === '-') zoomBy(1 / SCALE_STEP);
      else if (e.key === '0') {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomBy]);
  const pct = Math.round(scale * 100);
  return (
    <div
      className="sx-lightbox"
      role="dialog"
      aria-label={t('Image viewer', '图片查看')}
      onClick={() => dragRef.current === null && onClose()}
      onWheel={(e) => {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP);
      }}
    >
      <img
        src={src}
        alt={name ?? ''}
        className="sx-lightbox-img"
        draggable={false}
        decoding="async"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e: ReactPointerEvent<HTMLImageElement>) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e: ReactPointerEvent<HTMLImageElement>) => {
          const d = dragRef.current;
          if (d === null) return;
          setOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) });
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      />
      <div className="sx-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="sx-lightbox-act" aria-label={t('Zoom in', '放大')} data-tip={t('Zoom in', '放大')} onClick={() => zoomBy(SCALE_STEP)}>
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
        </button>
        <span className="sx-lightbox-pct" aria-live="polite">{pct}%</span>
        <button type="button" className="sx-lightbox-act" aria-label={t('Zoom out', '缩小')} data-tip={t('Zoom out', '缩小')} onClick={() => zoomBy(1 / SCALE_STEP)}>
          <Minus size={14} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sx-lightbox-act"
          aria-label={t('Reset zoom', '重置缩放')}
          data-tip={t('Reset zoom', '重置缩放')}
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        <span className="sx-lightbox-sep" aria-hidden="true" />
        <button
          type="button"
          className="sx-lightbox-act"
          aria-label={copyState === 'ok' ? t('Copied', '已复制') : copyState === 'fail' ? t('Not copied', '未复制') : t('Copy image', '复制图片')}
          data-tip={copyState === 'ok' ? t('Copied', '已复制') : copyState === 'fail' ? t('Not copied', '未复制') : t('Copy image', '复制图片')}
          onClick={copyImage}
        >
          {copyState === 'ok' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={2} aria-hidden="true" />}
        </button>
        <a className="sx-lightbox-act" href={src} download={name ?? 'image.png'} aria-label={t('Download', '下载')} data-tip={t('Download', '下载')} role="button" onClick={(e) => e.stopPropagation()}>
          <Download size={13} strokeWidth={2} aria-hidden="true" />
        </a>
        <span className="sx-lightbox-sep" aria-hidden="true" />
        <button type="button" className="sx-lightbox-act" aria-label={t('Close', '关闭')} data-tip={t('Close', '关闭')} onClick={onClose}>
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
