import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Connection, ConnectionState } from './connection';
import { parseTabSession, type TabStates } from './tabs/tab-state';

/**
 * 标签态持久化 hook(2026-10-27 技术债轮 D53 批C-3 自 App.tsx 外提,行为零变化):
 * 附接水合拉档(盘为真相源,<slug>/gui/sessions/<会话id>.json,CLAUDE.md §13 持久化分层)
 * + 变更写透(500ms 防抖每会话一把)。内存总表(tabStates)仍由宿主持有——标签域操作
 * (开/关/激活/拖宽)全在宿主,本 hook 只承载「盘↔内存」两个方向的同步效应。
 */

export interface TabPersistenceDeps {
  readonly connInstance: Connection | null;
  readonly connState: ConnectionState;
  readonly openSessionId: string;
  readonly tabStates: TabStates;
  readonly setTabStates: Dispatch<SetStateAction<TabStates>>;
}

export function useTabPersistence(deps: TabPersistenceDeps): void {
  const { connInstance, connState, openSessionId, tabStates, setTabStates } = deps;
  /** 已水合会话集:拉档完成前禁写透(空态初值不得抢在回档前覆盘);同时防重复拉档 */
  const hydratedRef = useRef<Set<string>>(new Set());
  /** 写透防抖句柄(每会话一把):变更串内只落最后一笔 */
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // G14.2xx 附接水合:切会话即拉盘档回填(仅在本地无此会话态或空态时落——不覆写在途编辑);
  // 拉到(含空档)即记水合,写透闸门随之放开
  useEffect(() => {
    if (connInstance === null || connState !== 'open' || openSessionId === '') return;
    if (hydratedRef.current.has(openSessionId)) return;
    let dead = false;
    const done = (): void => {
      // 水合标记在 GET 落定后才放行写透——在途期间空态初值不得抢先覆盘
      hydratedRef.current.add(openSessionId);
    };
    // 异步面调用(daemon 未附会话等 404 → 拒绝走容错,不炸渲染)
    void Promise.resolve().then(() => connInstance.guiState(openSessionId)).then(
      ({ state }) => {
        if (dead) return;
        done();
        const parsed = parseTabSession(state);
        if (parsed === null) return;
        setTabStates((s) => {
          const cur = s[openSessionId];
          // 本地已有在途标签(非空)以内存为准;空态/缺席才落盘档
          if (cur !== undefined && (cur.tabs.length > 0 || cur.recentClosed.length > 0)) return s;
          return { ...s, [openSessionId]: parsed };
        });
      },
      () => {
        if (dead) return;
        done(); // 拉档失败:内存态继续用,写透闸门放开(下次变更仍会写透)
      },
    );
    return () => {
      dead = true;
    };
  }, [connInstance, connState, openSessionId, setTabStates]);

  // G14.2xx 变更写透(500ms 防抖,每会话一把):标签任何变化最终落 <slug>/gui/sessions/<id>.json;
  // 水合前不写(防空态初值覆盘)
  useEffect(() => {
    if (openSessionId === '' || connState !== 'open' || connInstance === null) return;
    if (!hydratedRef.current.has(openSessionId)) return;
    const timers = saveTimersRef.current;
    const prev = timers.get(openSessionId);
    if (prev !== undefined) clearTimeout(prev);
    timers.set(
      openSessionId,
      setTimeout(() => {
        timers.delete(openSessionId);
        void connInstance.saveGuiState(openSessionId, { v: 1, ...tabStates[openSessionId] });
      }, 500),
    );
  }, [tabStates, openSessionId, connState, connInstance]);
}
