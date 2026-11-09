import { useLayoutEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { t } from './i18n';

/** 详情限高统一高度(用户气泡/记忆/学习技能/后台任务输出/团队章程同一值,2026-11-09 用户裁定「这几个地方的固定高度都一致」) */
export const DETAIL_MAX_HEIGHT = 240;

/** 展开/收起钮(纯 V/^ 18px 无框,hover 底走项目统一弧度):详情块与用户气泡共用 */
export function ClampToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="sx-clamp-toggle"
      aria-expanded={open}
      aria-label={open ? t('Collapse', '收起') : t('Expand', '展开')}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {open ? <ChevronUp size={18} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />}
    </button>
  );
}

/** 详情限高块(2026-11-09 用户裁定):内容超 DETAIL_MAX_HEIGHT 时限高+纵向滚动条,块下方 V;点开=完整高度、
 *  滚动条消失,块下方 ^ 收回。展开态块内私有——外层行折叠即卸载,再展开回限高态(外部折叠自动带走内部 ^)。
 *  as 透传宿主标签(pre 裸文本/div md 面),className 承载宿主原有底色/边框样式 */
export function ClampBlock({
  as: Tag = 'div',
  className,
  style,
  children,
}: {
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => setOver(el.scrollHeight > DETAIL_MAX_HEIGHT + 8);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const clamped = over && !open;
  return (
    <div className="sx-clamp-wrap">
      <Tag
        ref={ref}
        className={`${className ?? ''} sx-clamp${clamped ? ' clamped' : ''}`}
        style={clamped ? { ...style, maxHeight: DETAIL_MAX_HEIGHT } : style}
      >
        {children}
      </Tag>
      {over && (
        <div className="sx-clamp-toggle-row">
          <ClampToggle open={open} onToggle={() => setOpen((v) => !v)} />
        </div>
      )}
    </div>
  );
}
