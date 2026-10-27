import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { patchTabMeta, type TabStates } from './tabs/tab-state';

/**
 * pty 记账 hook(2026-10-27 技术债轮 D53 批F 自 App.tsx 外提,行为零变化):
 * terminal 标签 uid → ptyId(G8b)。分配落定记账+标签参数落盘(刷新后凭档直连旧 pty,
 * replay 重建屏幕不丢历史);重挂重连判据读取面;关标签出账(取走即删)。切标签/会话
 * 不清——pty 生命周期属标签不属渲染,backHome 亦不 kill。
 */
export function usePtyRegistry(
  openSessionId: string,
  setTabStates: Dispatch<SetStateAction<TabStates>>,
): {
  handlePtyAllocated: (uid: string, ptyId: string) => void;
  ptyIdFor: (uid: string) => string | undefined;
  /** 关标签出账:取走即删(命中回 ptyId 供调用方 killPty;未记账回 undefined) */
  takePtyId: (uid: string) => string | undefined;
} {
  const ptyIdsRef = useRef(new Map<string, string>());
  /** G8b pty 分配落定记账(TerminalTab 回传;registry render props 面)——useCallback 零依赖
   *  (仅 ref)保稳定:TerminalTab 装配 effect 以此为依赖,inline 箭头会令其随 App 重渲染重跑 */
  const handlePtyAllocated = useCallback((uid: string, ptyId: string): void => {
    ptyIdsRef.current.set(uid, ptyId);
    // G14.2xx ptyId 落标签参数(gui-state 落盘):刷新后凭档直连旧 pty(replay 重建屏幕),
    // 不再换新壳丢历史
    setTabStates((s) => patchTabMeta(s, openSessionId, uid, { ptyId }));
  }, [openSessionId, setTabStates]);

  /** G8b pty 记账读取面(TerminalTab 重挂重连判据):命中 = 该标签 pty 存活未 kill——重挂
   *  跳过 openPty 直连同 ptyId(replay 恢复屏幕);同上 useCallback 稳定注入 */
  const ptyIdFor = useCallback((uid: string): string | undefined => ptyIdsRef.current.get(uid), []);

  const takePtyId = useCallback((uid: string): string | undefined => {
    const ptyId = ptyIdsRef.current.get(uid);
    if (ptyId !== undefined) ptyIdsRef.current.delete(uid);
    return ptyId;
  }, []);

  return { handlePtyAllocated, ptyIdFor, takePtyId };
}
