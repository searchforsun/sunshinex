import { useEffect, useRef } from 'react';
import type { TabInstance } from './tabs/tab-state';

/**
 * keep-alive LRU hook(2026-10-27 技术债轮 D53 批F 自 App.tsx 外提,行为零变化):
 * 2026-10-26 二期 keep-alive——重标签(terminal/file/diff/taskboard/directory)保留上限 4,
 * 超限自动关最久未触的非活动标签;触达序=活动重标签尾追,新出现的重标签补录。
 */
const HEAVY_TAB_TYPES = new Set<string>(['terminal', 'file', 'diff', 'taskboard', 'directory']);
const KEEP_ALIVE_CAP = 4;

export function useHeavyTabLru(deps: {
  readonly tabs: readonly TabInstance[];
  readonly activeUid: string | null;
  readonly activeType: TabInstance['type'] | undefined;
  /** 超限自动关的关标签动词(宿主 closeTabInSession——含 pty 出账/kill 链) */
  readonly closeTabInSession: (uid: string) => void;
}): void {
  const { tabs, activeUid, activeType, closeTabInSession } = deps;
  const heavyTouchRef = useRef<string[]>([]);
  useEffect(() => {
    if (activeUid === null || activeType === undefined || !HEAVY_TAB_TYPES.has(activeType)) return;
    heavyTouchRef.current = [...heavyTouchRef.current.filter((u) => u !== activeUid), activeUid];
  }, [activeUid, activeType]);
  useEffect(() => {
    const heavy = tabs.filter((t) => HEAVY_TAB_TYPES.has(t.type)).map((t) => t.uid);
    for (const u of heavy) if (!heavyTouchRef.current.includes(u)) heavyTouchRef.current.push(u);
    const order = heavyTouchRef.current.filter((u) => heavy.includes(u));
    const excess = order.slice(0, Math.max(0, order.length - KEEP_ALIVE_CAP)).filter((u) => u !== activeUid);
    for (const u of excess) {
      if (tabs.some((t) => t.uid === u)) closeTabInSession(u);
    }
  }, [tabs, activeUid, closeTabInSession]);
}
