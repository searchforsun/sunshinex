import { useMemo } from 'react';
import type { Connection } from '../../connection';
import type { ChatEntry } from '../../chat-reducer';
import { useLiveGitChanges } from './use-live-changes';

/** 轮尾改动条+顶栏总改动簇(D62 批K 自 Chat.tsx 逐字平迁,行为零变化):hasRunChanges 门的双
 *  useLiveGitChanges + add/del 汇总。轮尾改动条(2026-11-07):本会话当前 git 变动(审查页同源),
 *  各轮条取交集显示;有轮改动记录才拉,run 收尾/回焦/广播/10s 可见轮询刷新。 */
export function useChatChanges(opts: {
  conn: Connection;
  sessionId: string;
  entries: readonly ChatEntry[];
  running: boolean;
  active: boolean;
  sideChat?: boolean;
}): {
  liveChanges: ReturnType<typeof useLiveGitChanges>;
  changesTotal: { add: number; del: number } | null;
} {
  const { conn, sessionId, entries, running, active, sideChat } = opts;
  const hasRunChanges = entries.some((en) => en.changes !== undefined && en.changes.length > 0);
  const liveChanges = useLiveGitChanges(
    typeof conn.sessionChanges === 'function'
      ? // 非 git 目录(branch='' )→ null:live 缺场回落轮记录原样——轮次 checkpoint 面 git 无关,
        // 改动卡在非 git 目录同样可用(数据=轮末快照封存条目)
        () => conn.sessionChanges(sessionId).then((r) => (r.branch === '' ? null : { files: r.files }))
      : undefined,
    sessionId,
    running,
    active && hasRunChanges,
  );
  // 顶栏总改动(2026-11-10 用户裁定「主会话顶部实时展示 +A −D,点击开审查页」):独立于改动卡的
  // enabled 门(有 run 改动记录才拉)——主会话恒拉(辅助会话不拉,零 git 开销);live 缺场=null 不渲染。
  // 2026-11-18 多会话卡顿轮:/changes 实测 689–745ms(单线程 daemon),隐藏驻留座恒停轮询——
  // 切回合再随 enabled 翻转重拉一次(useLiveGitChanges effect 依赖 enabled)
  const topbarLive = useLiveGitChanges(
    sideChat !== true && typeof conn.sessionChanges === 'function'
      ? () => conn.sessionChanges(sessionId).then((r) => (r.branch === '' ? null : { files: r.files }))
      : undefined,
    sessionId,
    running,
    active && sideChat !== true,
  );
  const changesTotal = useMemo(() => {
    const files = topbarLive;
    if (files === undefined || files === null || files.length === 0) return null;
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.added ?? f.newLines ?? 0;
      del += f.deleted ?? 0;
    }
    return add + del > 0 ? { add, del } : null;
  }, [topbarLive]);
  return { liveChanges, changesTotal };
}
