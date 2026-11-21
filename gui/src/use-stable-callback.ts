import { useCallback, useRef } from 'react';

/** 2026-11-16 流畅轮:零依赖恒稳回调单点(最新闭包经 ref 直取——forkLatestRef/propsRef 既有
 *  手法收敛)。Chat/ProjectMenu/TabStrip memo 化的前提:JSX 内联箭头每渲染换身份=每帧击穿
 *  memo(全 App 重渲染即三子树全量重渲);包装恒稳,行为=每次调用取当帧闭包,无过期闭包面。
 *  (D62 二段四段 自 App.tsx 逐字平迁为共享模块:tabs/menu 外提钩子与宿主同源导入,免钩子
 *  反向 import App.tsx 成环) */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []) as (...args: A) => R;
}
