import type { ArchivedRow } from './archive-group';

/** GUI 专属会话置顶(2026-10-21):纯 GUI 视图偏好——TUI 无此概念,不进共享会话档;
 *  持久化落 userConfigDir/gui/pins.json(GET/PUT /app/pins;2026-10-21 用户裁定「也要持久化」
 *  ——桌面壳与浏览器同 daemon 同享,非浏览器 localStorage)。键全局单份(置顶组跨工作区聚合,
 *  行携 root 快照,点击经 attachJournal 打开)。存钉时刻的标题/时间快照供离列表渲染;归档不删钉
 *  (撤销归档还回置顶组),归档层真删时随删防悬挂。 */

export interface PinEntry {
  /** journalId(会话稳定身份) */
  id: string;
  /** 所属工作区 root(打开用) */
  root: string;
  /** 钉时刻标题快照(无题回落 journalId) */
  title: string;
  /** 钉时刻末次活动(行时间列) */
  updatedAt: number;
}

/** 归一/消毒(服务端 PUT 同规):id/root 非空串,title 可缺,updatedAt 数目;坏条目弃置 */
export function normalizePins(raw: unknown): PinEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is PinEntry =>
      typeof p === 'object' && p !== null &&
      typeof (p as PinEntry).id === 'string' && (p as PinEntry).id !== '' &&
      typeof (p as PinEntry).root === 'string',
  );
}

/** 钉条目构造(自归档区行形/会话行快照取字段) */
export function pinFromRow(row: { id: string; root: string; title?: string; updatedAt: number }): PinEntry {
  return { id: row.id, root: row.root, title: row.title ?? row.id, updatedAt: row.updatedAt };
}

/** 归档行形兼容(归档层行也带钉口时复用) */
export type PinSourceRow = Pick<ArchivedRow, 'id' | 'root' | 'title' | 'updatedAt'>;
