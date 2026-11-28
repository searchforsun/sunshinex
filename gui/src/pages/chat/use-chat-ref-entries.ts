import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import type { BoardTeamRef, TaskBoardState } from '../../projection';
import { setRefLabels } from './mention';
import type { RefEntries, RefPal } from './ref-palette';

/** 目录装载 conn 结构面（D85 参数化）：agentsView/teamsView 可缺（欢迎页 conn 桩未挂=装载器
 *  缺席,面板照开仅无项）；Connection 整体结构满足。 */
export interface RefCatalogConn {
  agentsView?(root?: string): Promise<{ builtins: Array<{ role: string; name: string }>; view: { entries: Array<{ id: string; name: string; shadowed?: boolean }>; warnings: string[] } }>;
  teamsView?(root?: string): Promise<{ view: { entries: Array<{ id: string; name: string; shadowed?: boolean }>; warnings: string[] } }>;
}

/** $/# 引用目录装载核（D85 参数化单点,自 useChatRefEntries 拆出）：agentsView+teamsView 并行
 *  拉取 → id/name 投影（内置四角色并入+shadowed 行剔除+同 id 去重），首触懒加载一次
 *  （loadedRef 门,重复命中零网络）,失败静默空列（面板照开仅无项;不重试——零网络纪律）。
 *  消费面=useChatRefEntries（主对话）与编辑卡/侧聊草稿/欢迎页（catalog-only 装配,无实时段）。
 *  按名注册表与点击跳转接线不在本核——全局单主属 Chat 装配（setRefOpenHandler 卸载即清,
 *  多装配并存会互相清注册,见 useChatRefEntries）。 */
export function useRefCatalog(opts: { conn: RefCatalogConn; root?: string }): {
  refEntries: RefEntries;
  loadRefEntries: () => void;
  refEntriesLoadedRef: MutableRefObject<boolean>;
} {
  const { conn, root } = opts;
  /** entries 懒加载(refEntriesLoadedRef 门:首次命中拉一次,失败静默空列=面板照开仅无项;
   *  R5:未知引用提示只认这份缓存,从未拉过=跳过检查,不为提示补拉) */
  const [refEntries, setRefEntries] = useState<RefEntries>({ agents: [], teams: [] });
  const refEntriesLoadedRef = useRef(false);
  const loadRefEntries = useCallback((): void => {
    if (refEntriesLoadedRef.current) return;
    if (conn.agentsView === undefined || conn.teamsView === undefined) return;
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
  return { refEntries, loadRefEntries, refEntriesLoadedRef };
}

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
  // onOpenTask/onOpenAgent 仅供旧注册面留位（现注册在 App 壳层）——解构保留会触发未用告警
  const { conn, root, teams, board, members } = opts;
  /** agents-teams P1 §3.2 $/# 引用面板:触发态 + 单游标 + 目录装载（useRefCatalog 核,D85） */
  const { refEntries, loadRefEntries, refEntriesLoadedRef } = useRefCatalog({ conn, root });
  const [refPal, setRefPal] = useState<RefPal | null>(null);
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
  /** $/# 名称注册表 + 点击跳转(2026-11-20 用户裁定「名称不是标识」「点击跳转到指定团队/成员,
   *  与页面蓝色超链接一致」):目录装载后写入模块级注册表——气泡/输入框按名显示、按 id 跳转;
   *  跳转路由=团队卡(`team:<id>`)/成员转录(onOpenAgent) */
  useEffect(() => {
    setRefLabels(liveRefEntries.agents, liveRefEntries.teams, liveRefEntries.liveTeams ?? [], liveRefEntries.liveTasks ?? [], liveRefEntries.liveMembers ?? []);
  }, [liveRefEntries]);
  // 点击跳转注册已上移 App 壳层（2026-11-28 九轮「普通会话 $/# 仍点不开侧栏」）：座位级注册随
  // 热切换/缓存座生命周期漂移（无回调实例覆盖共享句柄=点击静默），App 单点注册与座位解耦。
  return { refPal, setRefPal, refActive, setRefActive, refEntries, liveRefEntries, loadRefEntries, refEntriesLoadedRef };
}
