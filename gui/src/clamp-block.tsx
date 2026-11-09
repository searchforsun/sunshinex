import { useLayoutEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { t } from './i18n';

/** 详情正文限高块(2026-11-09 用户裁定「展开详情不再内部纵向滚动」):内容超 maxHeight 时折叠显示+底部
 *  渐隐+纯 V 钮(与用户气泡同款 18px 无框),点开即完整高度(无内滚),底部 ^ 收起。展开态是块内私有态——
 *  外层行折叠时本块随之卸载,再展开回到折叠态(外部折叠自动带走内部 ^)。as 透传宿主标签(pre 裸文本/
 *  div md 面),className 承载宿主原有底色/边框样式 */
export function ClampBlock({
  as: Tag = 'div',
  className,
  style,
  maxHeight = 240,
  children,
}: {
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  maxHeight?: number;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => setOver(el.scrollHeight > maxHeight + 8);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxHeight]);
  const clamped = over && !open;
  return (
    <Tag
      ref={ref}
      className={`${className ?? ''} sx-clamp${clamped ? ' clamped' : ''}`}
      style={clamped ? { ...style, maxHeight } : style}
    >
      {children}
      {over && (
        <span className={`sx-clamp-toggle-row${open ? '' : ' floating'}`}>
          <button
            type="button"
            className="sx-clamp-toggle"
            aria-expanded={open}
            aria-label={open ? t('Collapse', '收起') : t('Expand', '展开')}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            {open ? <ChevronUp size={18} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />}
          </button>
        </span>
      )}
    </Tag>
  );
}
