import { useEffect, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { visibleWorkspaces } from './project-menu-util';

/** 聚合搜索连接面(结构满足即收;App 实传整只 Connection 运行时满足) */
export interface MenuSearchConn {
  sessionsOf(root: string): Promise<SessionRow[]>;
}

export type MenuSearchRow = SessionRow & { root: string; slug: string };

/**
 * 侧栏聚合搜索簇(ProjectMenu 外提,D62 批J):查找面板开合态+查询词+全部工作区会话扁平集
 * (G14.75——打开搜索时逐工作区 sessionsOf 聚合一次,rows 变化即重拉;单工作区失败按空清单
 * 降级,侧栏计数面非权威数据,下次展开重拉)。
 */
export function useMenuSearch(conn: MenuSearchConn, rows: WorkspaceRow[] | null): {
  searchOpen: boolean;
  setSearchOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  allSessions: MenuSearchRow[] | null;
  query: string;
  setQuery: (q: string) => void;
} {
  /** 查找面板(G10-C13):项目 + 会话历史搜索 */
  const [searchOpen, setSearchOpen] = useState(false);
  /** G14.75 聚合搜索:全部工作区的会话扁平集(打开搜索时聚合一次,rows 变化重拉) */
  const [allSessions, setAllSessions] = useState<MenuSearchRow[] | null>(null);
  const [query, setQuery] = useState('');

  // G14.75 聚合搜索:打开时拉全部工作区会话(sessionsOf 每工作区一次,失败静默为空)
  useEffect(() => {
    if (!searchOpen) return;
    const targets = visibleWorkspaces(rows ?? []).filter((r) => r.root !== undefined);
    void Promise.all(
      targets.map((r) =>
        conn
          .sessionsOf(r.root as string)
          .then((list) => list.map((x) => ({ ...x, root: r.root as string, slug: r.slug })))
          .catch(() => []), // 刷新失败按空清单降级(侧栏计数面,非权威数据;下次展开重拉)
      ),
    ).then((groups) => setAllSessions(groups.flat()));
  }, [searchOpen, rows, conn]);

  return { searchOpen, setSearchOpen, allSessions, query, setQuery };
}
