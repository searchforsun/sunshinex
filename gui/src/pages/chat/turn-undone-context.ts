/**
 * 撤销状态上下文(2026-11-12 用户裁定「撤销后聚合行不应再出现」):Chat 持 journalId 与
 * localStorage 持久化面,轮尾条据此在重挂/切会话回来时过滤已撤销轮与已撤销行。
 */
import { createContext, useContext } from 'react';
import { loadTurnUndone, markPathUndone, markRunUndone, runUndone, undonePaths } from './turn-undone-store';
export { loadTurnUndone, undonePaths };

export interface TurnUndoApi {
  /** 当前打开会话的 journal id(缺场=新座,不持久化) */
  readonly journalId: string;
  isRunUndone(journalId: string, run: number): boolean;
  isPathUndone(journalId: string, run: number): ReadonlySet<string>;
  markRun(journalId: string, run: number): void;
  markPath(journalId: string, run: number, path: string): void;
}

export const TurnUndoContext = createContext<TurnUndoApi>({
  journalId: '',
  isRunUndone: () => false,
  isPathUndone: () => new Set(),
  markRun: () => undefined,
  markPath: () => undefined,
});

export const useTurnUndo = (): TurnUndoApi => useContext(TurnUndoContext);

export function makeTurnUndoApi(journalId: string): TurnUndoApi {
  return {
    journalId,
    isRunUndone: (jid, run) => runUndone(loadTurnUndone(), jid, run),
    isPathUndone: (jid, run) => undonePaths(loadTurnUndone(), jid, run),
    markRun: (jid, run) => void markRunUndone(jid, run),
    markPath: (jid, run, path) => void markPathUndone(jid, run, path),
  };
}
