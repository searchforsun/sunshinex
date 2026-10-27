import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { emptyNavHistory, pushNav } from './nav-history';
import type { NavControls, NavHistory, NavLoc } from './nav-history';

/**
 * 应用级导航历史 hook(2026-10-27 技术债轮 D53 批D 自 App.tsx 外提,行为零变化):
 * 记录(recordNav)+ 回放(navBack/navForward)+ 控制面 + Alt+←/→ 键面。回放期 navLock
 * 抑制记录(回放复用 openSession 本体,不锁即回放被当新导航记二次);回调动词挂 ref
 * (每渲染刷新,零过期闭包)。落点动词由宿主注入——welcome 位=壳层清场(leaveToWelcome)、
 * chat 位=openSession(会话常驻 daemon,GUI 端点全按 :id 寻址,零 newSession/attach)。
 */

export interface NavHistoryDeps {
  /** welcome 位回放动词(壳层清场;宿主 leaveToWelcome) */
  readonly goWelcome: () => void;
  /** chat 位回放动词(宿主 openSession;sessionId/root/journalId 三参原样) */
  readonly openSession: (sessionId: string, root: string, journalId?: string) => void;
  /** 设置页整壳替换无钮,键面同封 */
  readonly settingsOpen: boolean;
}

export interface AppNavHistory {
  readonly navControls: NavControls;
  /** 壳层位置记录动词(openSession/backHome/New chat 各记录;navLock 回放期自抑制) */
  readonly recordNav: (loc: NavLoc) => void;
  /** 史变化即新对象(钮可用性随史)——供宿主 ref 挂最新(快捷键面外如有消费) */
  readonly setNav: Dispatch<SetStateAction<NavHistory>>;
}

export function useNavHistory(deps: NavHistoryDeps): AppNavHistory {
  const { goWelcome, openSession, settingsOpen } = deps;
  const [nav, setNav] = useState<NavHistory>(emptyNavHistory);
  const navLockRef = useRef(false);
  const navRef = useRef(nav);
  navRef.current = nav;
  const recordNav = (loc: NavLoc): void => {
    if (navLockRef.current) return;
    setNav((h) => pushNav(h, loc));
  };

  /** 导航回放(前进/后退落点应用):welcome 位=壳层清场;chat 位=直接 openSession。
   *  navLock 全程落位:回放引发的 openSession/leaveToWelcome 不再记史(位次由回调动词改) */
  const applyNavRef = useRef<(loc: NavLoc) => void>(() => undefined);
  applyNavRef.current = (loc: NavLoc): void => {
    navLockRef.current = true;
    try {
      if (loc.k === 'welcome') goWelcome();
      else openSession(loc.sessionId, loc.root, loc.journalId);
    } finally {
      navLockRef.current = false;
    }
  };
  /** 回调动词(零依赖恒稳):位次先改、落点随 apply——目标位必与当前位异键(相邻去重保证) */
  const navBack = useCallback((): void => {
    const h = navRef.current;
    const loc = h.stack[h.idx - 1];
    if (h.idx <= 0 || loc === undefined) return;
    applyNavRef.current(loc);
    setNav({ ...h, idx: h.idx - 1 });
  }, []);
  const navForward = useCallback((): void => {
    const h = navRef.current;
    const loc = h.stack[h.idx + 1];
    if (h.idx >= h.stack.length - 1 || loc === undefined) return;
    applyNavRef.current(loc);
    setNav({ ...h, idx: h.idx + 1 });
  }, []);
  /** 控制面(顶栏/欢迎页钮对 + Alt+←/→ 快捷键):nav 史变化即新对象(钮可用性随史) */
  const navControls = useMemo<NavControls>(
    () => ({ canBack: nav.idx > 0, canForward: nav.idx < nav.stack.length - 1, back: navBack, forward: navForward }),
    [nav, navBack, navForward],
  );
  /** Alt+←/→(浏览器惯例):preventDefault 免浏览器态吞作自身历史导航;设置页整壳替换无钮,键面同封 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (settingsOpen) return;
      if (e.key === 'ArrowLeft' ? !navControls.canBack : !navControls.canForward) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft') navControls.back();
      else navControls.forward();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, navControls]);

  return { navControls, recordNav, setNav };
}
