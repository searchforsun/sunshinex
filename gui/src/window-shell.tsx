import { useEffect, useState } from 'react';
import { Copy, Minus, PanelRight, Square, X } from 'lucide-react';
import { t } from './i18n';

/** 桌面壳窗控面（D62 批B，2026-11-08 自 App.tsx 外提——逐字平移零行为变化）：壳判定/窗控桥/窗控簇/程序化拖拽 */

/** 桌面壳判定(2026-10-23 用户实测修正):UA 含 Electron 不充分——ZCode 等 Electron 系
 *  浏览器的内嵌页同样命中,致 web 误吃桌面让位(页签条 92px 幽灵簇位,[|] 不贴右缘);
 *  须自家 preload 桥在场才算桌面壳(桥由 contextBridge 注入,先于页面脚本,模块期可判) */
export const IS_SHELL =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Electron') &&
  typeof window.sunshinexWindow !== 'undefined';

/** 桌面窗控桥(preload 注入;浏览器态无此全局——形态单点声明见 env-global.d.ts Window.sunshinexWindow) */
export const winBridge = (): Window['sunshinexWindow'] => (IS_SHELL ? window.sunshinexWindow : undefined);

/** 桌面窗控簇:[|] 侧栏开关(唯一渲染——web 贴窗口最右/桌面 −□× 左,同件同尺寸不随收展
 *  变形,页签条自有钮已退役)+ − □ × 自绘按钮(桌面态)——sx-iconbtn 同款圆角 hover,
 *  撤原生 WCO 方块。−□× 走 preload IPC,关闭=驻留 hide 语义 */
export function WindowControls({ showSideToggle, onToggleRightSidebar }: { showSideToggle: boolean; onToggleRightSidebar: () => void }): JSX.Element {
  const bridge = winBridge();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => bridge?.onMaximizedChange(setMaximized), [bridge]);
  // [|] 仅对话页显示(欢迎/设置页无右栏);簇其余为窗口三钮(桌面态)
  return (
    <div className="sx-wincontrols">
      {showSideToggle && (
        <button type="button" className="sx-winbtn" aria-label="toggle side panel" data-tip={t('Open side panel', '打开侧边栏')} onClick={onToggleRightSidebar}>
          <PanelRight size={14} strokeWidth={1.75} />
        </button>
      )}
      {bridge !== undefined && (
        <>
          <button type="button" className="sx-winbtn" aria-label="minimize window" onClick={() => bridge.minimize()}>
            <Minus size={14} strokeWidth={1.75} />
          </button>
          <button type="button" className="sx-winbtn" aria-label={maximized ? 'restore window' : 'maximize window'} onClick={() => bridge.toggleMaximize()}>
            {maximized ? <Copy size={14} strokeWidth={1.75} /> : <Square size={14} strokeWidth={1.75} />}
          </button>
          <button type="button" className="sx-winbtn" aria-label="close window" onClick={() => bridge.close()}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </>
      )}
    </div>
  );
}

/** 窗口程序化拖拽:拖拽面是 [data-drag-band]。按下后光标移动满 4px 才发 drag-start,
 *  纯点击不通知壳(壳侧 setPosition 在无边框窗上会改宽高)。mouseup 发 drag-end。
 *  双击拖拽面切换最大化。按钮、输入和弹层不进入拖拽。 */
export function useWindowDrag(): void {
  useEffect(() => {
    if (!IS_SHELL) return;
    let armed = false;
    let sx = 0;
    let sy = 0;
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t === null || t.closest('button, input, textarea, select, [role="button"], [role="dialog"], [role="menu"]') !== null) return;
      if (t.closest('[data-drag-band]') === null) return;
      armed = true;
      sx = e.screenX;
      sy = e.screenY;
    };
    const onMove = (e: MouseEvent): void => {
      if (!armed || e.buttons !== 1) return;
      if (Math.hypot(e.screenX - sx, e.screenY - sy) < 4) return;
      armed = false;
      winBridge()?.dragStart?.();
    };
    const onUp = (): void => {
      armed = false;
      winBridge()?.dragEnd?.();
    };
    const onDbl = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t === null || t.closest('button, input, textarea, select, [role="button"], [role="dialog"], [role="menu"]') !== null) return;
      if (t.closest('[data-drag-band]') === null) return;
      winBridge()?.toggleMaximize?.();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('dblclick', onDbl, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('dblclick', onDbl, true);
      winBridge()?.dragEnd?.();
    };
  }, []);
}
