import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COPY_RESET_MS } from '../use-copy-feedback';
import { zoomScale } from '../ui-zoom';

/** 会话行快捷菜单(⋯ 弹出,2026-10-22 用户裁定:行尾 ⋯ 收敛直连动作钮):fixed 定位随锚点
 *  坐标(锚=行尾 ⋯ 钮右缘/下缘),右对齐下开——fixed 免侧栏滚动容器裁切;外部 mousedown/
 *  Esc/滚动/resize 即关(锚钮自身 mousedown 由调用方 stopPropagation——toggle 语义不被
 *  document 先收击穿)。纯展示件:items 注入,选择即回调+关。
 *  x/y 入参=调用方 gBCR 视觉 px;fixed 偏移吃本地 px——按 ui-zoom 跨空间契约在渲染处归一
 *  (写入单点,三调用方 ChatTopbar ⋯/归档确认、projects 移除确认零迁移),zoom≠1 桌面
 *  弹层不再漂移 zoom 倍(同根病先例:821ea9d 两栏拖拽/db5bf3e④ tooltip)。
 *  2026-11-21 正文卡菜单「飞了」根修:菜单 portal 到 document.body——此前挂在原地,
 *  .chat-unit 的 contain:layout 会使其成为 fixed 后代包含块(坐标按块盒解释),正文产物卡的
 *  「打开 ▾/更多方式」菜单遂错位到远处;portal 后恒以视口为基准(与 ImageLightbox 同手法)。 */
export interface SessionRowMenuItem {
  id: string;
  label: string;
  icon?: JSX.Element;
  /** 行尾右置尾标(如默认应用的勾;flex 推到行最右,与名称侧分离) */
  tail?: JSX.Element;
  /** 选中态(默认应用行:浅底强调,与普通行区分) */
  active?: boolean;
  /** 禁用项(灰显不可点,如运行中的归档) */
  disabled?: boolean;
  /** 分隔线项( label/图标忽略,渲染为分隔线) */
  divider?: boolean;
  /** 2026-11-06 用户裁定:复制回显项——选中后不即关,留菜单 COPY_RESET_MS 显 ✓ 尾标再自动关
   *  (即关则 tail ✓ 从未可见;外部/Esc/滚动仍即关不受影响) */
  keepOpen?: boolean;
  onSelect: () => void;
}

export function SessionRowMenu({ x, y, anchorTop, items, onClose, placement = 'below' }: {
  x: number;
  y: number;
  /** 锚钮顶缘(above 渲染底缝基准:菜单底=anchorTop−2,完全在打开钮上方不遮钮——
   *  2026-11-15 用户裁定「翻到打开上面,不是覆盖打开」;缺席退化 y−2,旧调用方零波及) */
  anchorTop?: number;
  items: SessionRowMenuItem[];
  onClose: () => void;
  /** 纵向开向:below=下开(贴上缘锚点默认);above=恒上开(产物卡等下半区锚点,2026-11-14 用户裁定) */
  placement?: 'below' | 'above';
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  // 纵向翻转(2026-11-14 用户裁定「下面不够显示就显示到上面」):贴窗口下缘的锚点,菜单下开
  // 被视口裁切 → 改上开(锚上缘留 2px 缝)。挂载后 useLayoutEffect 量高翻转(绘制前生效,无闪跳)
  const [above, setAbove] = useState(placement === 'above');
  useLayoutEffect(() => {
    if (placement === 'above') return; // 恒上开,不自动下探
    const el = ref.current;
    if (el === null) return;
    const h = el.offsetHeight;
    if (h === 0) return;
    if (y + 2 + h > window.innerHeight && y > h) setAbove(true);
  }, [y, items.length, placement]);
  // 上开定位=菜单底缘贴锚顶上方 2px(translateY(-100%) 自身高百分比,免读 offsetHeight——
  // 首渲染 ref 未挂载读到 0 会误画锚点下方,2026-11-15 产物卡实测根修);下开=top+2px 缝
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
  return createPortal(
    <div
      ref={ref}
      className="sx-menu-pop sx-session-row-pop"
      role="menu"
      style={{ position: 'fixed', left: x / zoomScale(), top: (above ? (anchorTop ?? y) - 2 : y + 2) / zoomScale(), right: 'auto', transform: above ? 'translate(-100%, -100%)' : 'translateX(-100%)', zIndex: 200 }}
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
            className={`sx-menuitem${it.active === true ? " sx-menuitem-active" : ""}`}
            aria-current={it.active === true ? 'true' : undefined}
            disabled={it.disabled}
            onClick={() => {
              it.onSelect();
              if (it.keepOpen === true) window.setTimeout(onClose, COPY_RESET_MS);
              else onClose();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.tail !== undefined && <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>{it.tail}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
