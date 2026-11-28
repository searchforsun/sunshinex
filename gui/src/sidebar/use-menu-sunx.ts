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
 * 2026-11-28 五轮裁定「群聊发送的消息,sunx 的运行态/完成态左侧菜单没有实时显示」：行驱 refresh
 * 靠 rows 换引用(30s tick/事件),群派发进行中行集恒旧——加 4s 轻轮询(浅等守卫,运行态点/完成
 * 时间随拉随显);失败静默保旧列(初次失败落空清单)。
 */
export function useMenuSunx(conn: MenuSunxConn, rows: WorkspaceRow[] | null, reloadNonce = 0): Array<SessionRow & { root: string; slug: string }> | null {
  const [sunxRows, setSunxRows] = useState<Array<SessionRow & { root: string; slug: string }> | null>(null);
  useEffect(() => {
    let alive = true;
    let firstRun = true;
    const load = (): void => {
      void conn
        .sunxSessions()
        .then((list) => {
          if (!alive) return;
          // 归档行**保留**在行集里(2026-11-24 用户实测「归档后归档 Sunx 层找不到」根修):本 hook 是
          // 「SUNX 分组」与「归档 Sunx 层」共源(ProjectMenu archiveRows sunx 分支 filter archived===true
          // 取自同集)——此前在此滤 archived 行=归档层断源恒空。分组侧滤行移到 SunxSection 渲染面
          const mapped = list.map((x) => ({ ...x, root: x.root ?? '', slug: x.root ?? '' }));
          setSunxRows((prev) => (listShallowEqual(prev, mapped) ? prev : mapped));
        })
        .catch(() => {
          // 轮询失败静默保旧列;初次失败落空清单降级(侧栏计数面,非权威数据)
          if (alive && firstRun) setSunxRows([]);
        });
      firstRun = false;
    };
    load();
    const id = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [conn, rows, reloadNonce]);
  return sunxRows;
}
