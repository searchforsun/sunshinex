import { useEffect, useRef } from 'react';
import { zoomScale } from '../ui-zoom';

/** 会话行快捷菜单(⋯ 弹出,2026-10-22 用户裁定:行尾 ⋯ 收敛直连动作钮):fixed 定位随锚点
 *  坐标(锚=行尾 ⋯ 钮右缘/下缘),右对齐下开——fixed 免侧栏滚动容器裁切;外部 mousedown/
 *  Esc/滚动/resize 即关(锚钮自身 mousedown 由调用方 stopPropagation——toggle 语义不被
 *  document 先收击穿)。纯展示件:items 注入,选择即回调+关。
 *  x/y 入参=调用方 gBCR 视觉 px;fixed 偏移吃本地 px——按 ui-zoom 跨空间契约在渲染处归一
 *  (写入单点,三调用方 ChatTopbar ⋯/归档确认、projects 移除确认零迁移),zoom≠1 桌面
 *  弹层不再漂移 zoom 倍(同根病先例:821ea9d 两栏拖拽/db5bf3e④ tooltip)。 */
export interface SessionRowMenuItem {
  id: string;
  label: string;
  icon?: JSX.Element;
  /** 禁用项(灰显不可点,如运行中的归档) */
  disabled?: boolean;
  /** 分隔线项( label/图标忽略,渲染为分隔线) */
  divider?: boolean;
  onSelect: () => void;
}

export function SessionRowMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: SessionRowMenuItem[];
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && e.target instanceof Element && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = (): void => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="sx-menu-pop sx-session-row-pop"
      role="menu"
      style={{ position: 'fixed', left: x / zoomScale(), top: (y + 2) / zoomScale(), right: 'auto', transform: 'translateX(-100%)', zIndex: 200 }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it) =>
        it.divider ? (
          <div key={it.id} className="sx-menu-divider" role="separator" />
        ) : (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className="sx-menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onSelect();
              onClose();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
