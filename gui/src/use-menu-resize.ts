import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { MAIN_MIN_WIDTH } from './thread-width';

/** G12 左栏宽度偏好键（theme/ui-zoom 同族面私有持久化）。
 *  MIN 与 .sx-menu CSS min-width 240 同值:状态与 CSS 下限分叉会让视口护栏少算渲染宽
 *  (曾漏 20px 越视口)。G14.2xx 用户裁定:最大宽退役——三栏均只留最小宽钳制 */
const MENU_WIDTH_KEY = 'sunshinex.menuWidth';
const MENU_WIDTH_MIN = 240;
const MENU_WIDTH_DEFAULT = 260;

/**
 * G12 左栏宽度可调（D42 自 App.tsx 钩子化，行为零变化）：拖右缘边条改 --menu-w（只钳最小
 * 240），localStorage 持久；SettingsShell 的左栏同为 .sx-menu，随同一变量联动。拖宽上界=
 * 视口−右栏−主区最小宽（无固定最大宽但不越视口，G14.2xx 用户裁定）；起拖基线取当前渲染宽
 * （状态可能滞留护栏外，不取渲染宽则向窄拖先空走死区）+ 起拖定格右栏占宽（拖拽中三栏不重
 * 排，与原渲染闭包同口径）。mouseup 解绑+持久化；卸载兜底解绑。
 *
 * getSidebarOccupied 由宿主按渲染态提供（未渲染=0：欢迎页/折叠/settings 态）。
 */
export function useMenuResize(
  shellRef: RefObject<HTMLDivElement | null>,
  getSidebarOccupied: () => number,
): { menuWidth: number; startMenuResize: (e: ReactMouseEvent<HTMLDivElement>) => void } {
  const [menuWidth, setMenuWidth] = useState<number>(() => {
    // 隐私模式/存储禁用下 localStorage 抛 SecurityError——theme/ui-zoom 同款守卫口径,缺省宽兜底
    try {
      const raw = Number(localStorage.getItem(MENU_WIDTH_KEY));
      return Number.isFinite(raw) && raw >= MENU_WIDTH_MIN ? raw : MENU_WIDTH_DEFAULT;
    } catch {
      return MENU_WIDTH_DEFAULT;
    }
  });
  /** 左栏拖宽在途清理句柄(mouseup 解绑;卸载兜底) */
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const startMenuResize = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      e.preventDefault();
      const el = e.currentTarget;
      el.classList.add('active');
      const startX = e.clientX;
      const occupied = getSidebarOccupied();
      const startWidth = Math.min(menuWidth, window.innerWidth - occupied - MAIN_MIN_WIDTH);
      shellRef.current?.classList.add('sx-dragging'); // 拖拽期 iframe 指针事件让位(见 CSS .sx-dragging)
      let next = startWidth;
      const onMove = (ev: MouseEvent): void => {
        // 同右栏:菜单拖宽至中栏触底即停(右栏实际占宽计入,未渲染=0),右栏不越视口
        next = Math.max(
          MENU_WIDTH_MIN,
          Math.min(window.innerWidth - occupied - MAIN_MIN_WIDTH, startWidth + ev.clientX - startX),
        );
        setMenuWidth(next);
      };
      const stop = (): void => {
        el.classList.remove('active');
        shellRef.current?.classList.remove('sx-dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', stop);
        cleanupRef.current = null;
        // 持久化失败(隐私模式)仅内存态生效,拖宽不受阻
        try {
          localStorage.setItem(MENU_WIDTH_KEY, String(next));
        } catch { /* 降级静默 */ }
      };
      cleanupRef.current = stop;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', stop);
    },
    [menuWidth, shellRef, getSidebarOccupied],
  );

  return { menuWidth, startMenuResize };
}
