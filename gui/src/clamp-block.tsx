import { useLayoutEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode, type RefObject } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { t } from './i18n';

/** 详情限高(记忆/学习技能/后台任务输出/团队章程同一值,2026-11-09 用户裁定 320) */
export const DETAIL_MAX_HEIGHT = 320;
/** 用户气泡限高(2026-11-09 用户裁定保持 168) */
export const BUBBLE_MAX_HEIGHT = 168;

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

/** 限高⇄完整高度平滑过渡(2026-11-09 用户裁定「展开关闭要有平滑效果」):命令式驱动 height/max-height——
 *  起点钉当前像素值、强制回流、过渡到终点(scrollHeight 或限高),结束后展开态撤内联值回自然高度(内容后续增减
 *  照常伸缩)。过渡期 overflow hidden 防滚动条闪现;时长取 --dur-relaxed(reduced-motion 下为 0 即刻落定)。
 *  只在 open 切换时过渡;首挂与 active 变化(气泡量测出超限)即刻落定,不在加载时播收缩。active=false 不施加限高 */
export function useClampMotion(ref: RefObject<HTMLElement | null>, open: boolean, limit: number, prop: 'height' | 'maxHeight', active = true): void {
  const prevOpen = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const cssName = prop === 'height' ? 'height' : 'max-height';
    const limited = active && !open;
    const toggled = prevOpen.current !== null && prevOpen.current !== open;
    prevOpen.current = open;
    if (!toggled || !active) {
      el.style.transition = '';
      el.style.overflowY = '';
      el.style[prop] = limited ? `${limit}px` : '';
      return;
    }
    const full = el.scrollHeight;
    el.style.overflowY = 'hidden';
    el.style.transition = 'none';
    el.style[prop] = `${open ? Math.min(limit, full) : full}px`;
    void el.offsetHeight;
    el.style.transition = `${cssName} var(--dur-relaxed) var(--ease-enter)`;
    el.style[prop] = `${open ? full : limit}px`;
    const settle = (): void => {
      el.style.transition = '';
      el.style.overflowY = '';
      if (open) el.style[prop] = '';
    };
    const dur = parseFloat(getComputedStyle(el).transitionDuration);
    if (!(dur > 0)) {
      settle();
      return;
    }
    const onEnd = (e: TransitionEvent): void => {
      if (e.target !== el) return;
      el.removeEventListener('transitionend', onEnd);
      settle();
    };
    el.addEventListener('transitionend', onEnd);
    return () => el.removeEventListener('transitionend', onEnd);
  }, [open, active, limit, prop, ref]);
}

/** 详情固定高块(2026-11-09 用户裁定「固定高度」):收起态恒为 DETAIL_MAX_HEIGHT 固定高(内容短也不缩),
 *  内容超出即纵向滚动条+块下方 V;点开=完整高度、滚动条消失,块下方 ^ 收回。展开态块内私有——外层行折叠即卸载,再展开回限高态(外部折叠自动带走内部 ^)。
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
  const clamped = !open;
  useClampMotion(ref, open, DETAIL_MAX_HEIGHT, 'height');
  return (
    <div className="sx-clamp-wrap">
      <Tag
        ref={ref}
        className={`${className ?? ''} sx-clamp${clamped ? ' clamped' : ''}`}
        style={{ ...style, boxSizing: 'border-box' }}
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
