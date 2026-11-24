import { useEffect, useState } from 'react';
import type { SessionRow, WorkspaceRow } from '../connection';
import { listShallowEqual } from './project-menu-util';

/** SUNX 行集连接面(结构满足即收;App 实传整只 Connection 运行时满足) */
interface MenuSunxConn {
  sunxSessions(): Promise<SessionRow[]>;
}

/**
 * SUNX 组行集(ProjectMenu 外提,D62 批J):GET /sunx/sessions 域容器全域枚举单点(sunx P3
 * Task 3 数据源改向)——宿主 /sessions 逐工作区聚合(sessionsOf 每根一拉+kind 过滤)退役。
 * 行携出生 meta root(域旁车);slug 以 root 代(分节键=工作区根,wsName 显示走 root basename)。
 * 拉取失败按空清单降级(侧栏计数面,非权威数据;rows 变化即重拉——30s tick/聚焦/config-changed
 * 全走 loadWorkspaces→rows 换引用,单一驱动点,与既有刷新节奏同拍;2026-11-16 流畅轮:浅等守卫,
 * 内容未变保旧引用——30s 轮询不再换身份重渲染)。reloadNonce=即时重拉触发面(2026-11-16 用户
 * 实测「创建后没有立刻显示到 SUNX 下」:新建成功链调 setSunxReload——workspaces 未变时 rows
 * 保引用,浅等守卫下既有驱动点全不触发,nonce 是唯一即时缝)。
 */
export function useMenuSunx(conn: MenuSunxConn, rows: WorkspaceRow[] | null, reloadNonce = 0): Array<SessionRow & { root: string; slug: string }> | null {
  const [sunxRows, setSunxRows] = useState<Array<SessionRow & { root: string; slug: string }> | null>(null);
  useEffect(() => {
    let alive = true;
    void conn
      .sunxSessions()
      .then((list) => {
        if (!alive) return;
        // 已归档行不进分组(2026-11-21 用户实测「归档后不消失」):归档 Sunx 专域行携 archived 标注,
        // 过滤之——归档后在「归档 Sunx」层可见,分组只留未归档
        const mapped = list
          .filter((x) => x.archived !== true)
          .map((x) => ({ ...x, root: x.root ?? '', slug: x.root ?? '' }));
        setSunxRows((prev) => (listShallowEqual(prev, mapped) ? prev : mapped));
      })
      .catch(() => {
        if (alive) setSunxRows([]);
      });
    return () => {
      alive = false;
    };
  }, [rows, conn, reloadNonce]);
  return sunxRows;
}
