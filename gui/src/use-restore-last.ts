import { useEffect, useRef } from 'react';
import type { Connection, ConnectionState } from './connection';

/**
 * 恢复现场 hook(2026-10-27 技术债轮 D53 批F 自 App.tsx 外提,行为零变化):
 * G14.2xx 浏览器刷新后重放打开链——应用级指针档(lastRoot+lastJournalId,openSession 落笔),
 * 连接就绪即启动一次 newSession(root) 装配壳 → attach(journal) 播种 → openSession 三连;
 * 指针不可用(档删/目录迁移/首启)静默落欢迎页。restoredRef 单次闸(StrictMode 双跑防重放)。
 */
export function useRestoreLast(deps: {
  readonly connInstance: Connection | null;
  readonly connState: ConnectionState;
  readonly openSession: (sessionId: string, root: string, journalId?: string) => void;
}): void {
  const { connInstance, connState, openSession } = deps;
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || connInstance === null || connState !== 'open') return;
    restoredRef.current = true;
    void Promise.resolve()
      .then(() => connInstance.appGuiState())
      .then(({ state }) => {
        const o = (state ?? {}) as { lastRoot?: unknown; lastJournalId?: unknown };
        if (typeof o.lastRoot !== 'string' || o.lastRoot === '' || typeof o.lastJournalId !== 'string' || o.lastJournalId === '') return;
        const lastRoot: string = o.lastRoot;
        const lastJournalId: string = o.lastJournalId;
        return connInstance
          .newSession(lastRoot)
          .then(({ sessionId }) => connInstance.attach(sessionId, lastJournalId).then((r) => ({ sessionId: r.sessionId, root: lastRoot, journalId: lastJournalId }))) // 收编以返回 id 为准
          .then(({ sessionId, root, journalId }) => openSession(sessionId, root, journalId));
      })
      .catch(() => undefined);
    // eslint 不入依赖(openSession 恒稳:仅 setter/refs;恢复链仅启动一次)
  }, [connInstance, connState]);
}
