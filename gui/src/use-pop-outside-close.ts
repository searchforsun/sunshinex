import { useEffect } from 'react';

/** 弹层外点收单点（D62 批D 收敛——model/mode/proj/plus 四 effect 同形四份）：open 期间监听 document
 *  mousedown，点击落在弹层面板（panelSel）与锚钮（anchorSel）之外即收。close 经参注入（setter 直传）。 */
export function usePopOutsideClose(open: boolean, panelSel: string, anchorSel: string, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest(panelSel) === null && e.target.closest(anchorSel) === null) {
        close();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close=setXxx(false) 形 setter 直传,语义恒定
  }, [open, panelSel, anchorSel]);
}
