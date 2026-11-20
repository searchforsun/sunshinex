import { useEffect, useState } from 'react';
import type { ScheduleJobView, SessionRow, WorkspaceRow } from '../connection';
import { visibleWorkspaces } from './project-menu-util';

/** 聚合搜索连接面(结构满足即收;App 实传整只 Connection 运行时满足) */
export interface MenuSearchConn {
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** 定时任务面(GET /schedules):搜索分类用;旧桩缺名=不出定时任务分类 */
  schedules?(): Promise<{ jobs: ScheduleJobView[] }>;
}

export type MenuSearchRow = SessionRow & { root: string; slug: string };

/**
 * 侧栏聚合搜索簇(ProjectMenu 外提,D62 批J):查找面板开合态+查询词+全部工作区会话扁平集
 * (G14.75——打开搜索时逐工作区 sessionsOf 聚合一次,rows 变化即重拉;单工作区失败按空清单
 * 降级,侧栏计数面非权威数据,下次展开重拉)。
 * 2026-11-21 补充「还有 SUNX 等,定时任务等等」:定时任务清单与聚合搜索同开同拉,失败按空清
 * 单降级(不发错误面;任务页自身仍是权威错误面)。
 */
export function useMenuSearch(conn: MenuSearchConn, rows: WorkspaceRow[] | null): {
  searchOpen: boolean;
  setSearchOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  allSessions: MenuSearchRow[] | null;
  schedules: ScheduleJobView[] | null;
  query: string;
  setQuery: (q: string) => void;
} {
  /** 查找面板(G10-C13):项目 + 会话历史搜索 */
  const [searchOpen, setSearchOpen] = useState(false);
  /** G14.75 聚合搜索:全部工作区的会话扁平集(打开搜索时聚合一次,rows 变化重拉) */
  const [allSessions, setAllSessions] = useState<MenuSearchRow[] | null>(null);
  /** 定时任务清单(搜索分类面;同样打开即拉) */
  const [schedules, setSchedules] = useState<ScheduleJobView[] | null>(null);
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

  // 定时任务:与搜索同开同拉;旧桩无 schedules 面=空清单(分类按空态渲染)
  useEffect(() => {
    if (!searchOpen) return;
    let alive = true;
    if (conn.schedules === undefined) {
      setSchedules([]);
      return;
    }
    conn.schedules().then(
      (r) => {
        if (alive) setSchedules(r.jobs);
      },
      () => {
        if (alive) setSchedules([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [searchOpen, conn]);

  return { searchOpen, setSearchOpen, allSessions, schedules, query, setQuery };
}
