import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import type { BoardTeamRef, TaskBoardState } from '../../projection';
import { refKindOf, setRefLabels, setRefOpenHandler } from './mention';
import type { RefEntries, RefPal } from './ref-palette';

/** $/# 引用面板簇(D62 批K 自 Chat.tsx 逐字平迁,行为零变化):触发态+两目录缓存+单游标+本会话
 *  实时合并投影+目录懒加载+按名注册表/点击跳转接线。
 *  本会话实时团队/任务/成员(2026-11-20 用户裁定「$/# 出来当前会话正在运行的或存在的团队及任务,
 *  不含临时 spawn 子智能体」):teams=投影队卡;任务=板开放态(pending/running)——spawn 在账本
 *  不在板,天然排除;members=存活成员(名即寻址键);与目录合并后的单点供面板/注册表/发送展开三面共用 */
export function useChatRefEntries(opts: {
  conn: Connection;
  root?: string;
  teams?: readonly BoardTeamRef[];
  board?: TaskBoardState;
  members?: ReadonlyArray<{ name: string; busy: boolean }>;
  onOpenTask?: (taskRef: string) => void;
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
}): {
  refPal: RefPal | null;
  setRefPal: Dispatch<SetStateAction<RefPal | null>>;
  refActive: number;
  setRefActive: Dispatch<SetStateAction<number>>;
  refEntries: RefEntries;
  liveRefEntries: RefEntries;
  loadRefEntries: () => void;
  refEntriesLoadedRef: MutableRefObject<boolean>;
} {
  const { conn, root, teams, board, members, onOpenTask, onOpenAgent } = opts;
  /** agents-teams P1 §3.2 $/# 引用面板:触发态 + 两目录缓存(agents/teams id+name 投影)+单游标。
   *  entries 懒加载(refEntriesLoadedRef 门:首次命中拉一次,失败静默空列=面板照开仅无项;
   *  R5:未知引用提示只认这份缓存,从未拉过=跳过检查,不为提示补拉) */
  const [refPal, setRefPal] = useState<RefPal | null>(null);
  const [refEntries, setRefEntries] = useState<RefEntries>({ agents: [], teams: [] });
  const liveRefEntries = useMemo<RefEntries>(() => {
    const liveTeams = (teams ?? []).map((t) => ({ id: t.teamId, name: t.name }));
    const liveMembers = (members ?? []).map((m) => ({ id: m.name, name: m.name }));
    const liveTasks = board !== undefined
      ? Object.values(board.tasks)
          .filter((t) => t.status === 'pending' || t.status === 'running')
          .map((t) => ({ id: t.id, title: t.title, status: t.status }))
      : [];
    return {
      ...refEntries,
      ...(liveTeams.length > 0 ? { liveTeams } : {}),
      ...(liveTasks.length > 0 ? { liveTasks } : {}),
      ...(liveMembers.length > 0 ? { liveMembers } : {}),
    };
  }, [refEntries, teams, board, members]);
  const [refActive, setRefActive] = useState(0);
  const refEntriesLoadedRef = useRef(false);
  /** $/# 名称注册表 + 点击跳转(2026-11-20 用户裁定「名称不是标识」「点击跳转到指定团队/成员,
   *  与页面蓝色超链接一致」):目录装载后写入模块级注册表——气泡/输入框按名显示、按 id 跳转;
   *  跳转路由=团队卡(`team:<id>`)/成员转录(onOpenAgent) */
  useEffect(() => {
    setRefLabels(liveRefEntries.agents, liveRefEntries.teams, liveRefEntries.liveTeams ?? [], liveRefEntries.liveTasks ?? [], liveRefEntries.liveMembers ?? []);
  }, [liveRefEntries]);
  useEffect(() => {
    setRefOpenHandler((sym, id) => {
      if (sym === '#') onOpenTask?.(refKindOf('#' + id) === 'task' ? id : `team:${id}`);
      else onOpenAgent?.(id, id);
    });
    return () => setRefOpenHandler(null);
  }, [onOpenTask, onOpenAgent]);
  /** agents-teams P1 §3.2 引用目录懒加载:并行 agentsView+teamsView(root 同口径守卫——缺省/
   *  空串/'default' 走全局清单),结果投影 id+name(shadowed 行剔除——同 id 两级行只留生效者),
   *  缓存于 ref(首次命中后零网络);失败静默空列——面板照开仅无项(R5 不为提示补拉) */
  const loadRefEntries = useCallback((): void => {
    if (refEntriesLoadedRef.current) return;
    refEntriesLoadedRef.current = true;
    const refRoot = root !== undefined && root !== '' && root !== 'default' ? root : undefined;
    void Promise.all([conn.agentsView(refRoot), conn.teamsView(refRoot)]).then(
      ([a, tv]) => {
        setRefEntries({
          // 内置四角色并入候选池(2026-11-05 用户实测:零注册目录下 $ 弹了等于没弹)——内置本就
          // 可 $ 引用(spawn/agent 工具均收,agents 索引同源),同 id 注册行不重复列(builtin-first)
          agents: [
            ...a.builtins.map((b) => ({ id: b.role, name: b.name })),
            ...a.view.entries.filter((e) => !e.shadowed).map((e) => ({ id: e.id, name: e.name })),
          ].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i),
          teams: tv.view.entries.filter((e) => !e.shadowed).map((e) => ({ id: e.id, name: e.name })),
        });
      },
      () => {}, // 失败静默:entries 保持空列(面板无项不开;不重试——零网络纪律)
    );
  }, [conn, root]);
  return { refPal, setRefPal, refActive, setRefActive, refEntries, liveRefEntries, loadRefEntries, refEntriesLoadedRef };
}
