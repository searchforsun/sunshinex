import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from './connection';
import { stripTabType } from './tabs/tab-state';
import type { TabStates } from './tabs/tab-state';

/** 设置/定时任务覆盖层状态簇(D62 专项 环解第一刀 自 App.tsx 逐字平迁,行为零变化):
 *  settingsOpen/schedulesMain 早位于 useShellLayout/useNavHistory 之前供其消费——
 *  三角依赖环(settings↔layout↔nav,见 TECH-DEBT-LOG D62)自此解。菜单包装回调
 *  (openSettingsFromMenu 等,需 closeMenuDrawer/recordNav 延迟闭包)留宿主。 */
export function useAppOverlays(opts: {
  connInstance: Connection | null;
  connRef: MutableRefObject<Connection | null>;
  openRoot: string;
  openSession: (sessionId: string, root: string, journalId?: string, inheritWelcomeDraft?: boolean, kindHint?: string) => void;
  showOpError: (err: unknown) => void;
  setTabStates: Dispatch<SetStateAction<TabStates>>;
}): {
  settingsOpen: boolean;
  settingsRoot: string;
  settingsPane: { readonly id: string; readonly row?: string } | undefined;
  setSettingsPane: Dispatch<SetStateAction<{ readonly id: string; readonly row?: string } | undefined>>;
  schedulesMain: boolean;
  setSchedulesMain: Dispatch<SetStateAction<boolean>>;
  scheduleFocus: string | null;
  setScheduleFocus: Dispatch<SetStateAction<string | null>>;
  agentTeamsOn: boolean;
  setAgentTeamsOn: Dispatch<SetStateAction<boolean>>;
  openSettings: () => void;
  closeSettings: () => void;
  openJournalSessionStable: (journalId: string, root: string, kind?: 'sunx') => void;
} {
  const { connInstance, connRef, openRoot, openSession, showOpError, setTabStates } = opts;
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 定时任务主区层(2026-11-20):固定层覆盖主区,左侧菜单保持;Chat 不卸载——点会话/新建/
   *  记录打开会话即关层,回到既有会话链 */
  const [schedulesMain, setSchedulesMain] = useState(false);
  /** 定时任务搜索跳转落点(2026-11-21):非空=任务页开席即定位该卡;手动开页/退出即清 */
  const [scheduleFocus, setScheduleFocus] = useState<string | null>(null);
  /** 设置落点面板请求(托盘「快捷键」直达;关设置即清,侧栏再开仍落「通用」) */
  const [settingsPane, setSettingsPane] = useState<{ readonly id: string; readonly row?: string } | undefined>(undefined);
  const [settingsRoot, setSettingsRoot] = useState('');
  /** agentTeams 开关(settings 语义键;缺省 true)——关则藏「智能体团队」页签菜单项并拒开签;
   *  settingsEpoch 在关设置壳时递增,保存后重读开关(autosave 已落盘) */
  const [agentTeamsOn, setAgentTeamsOn] = useState(true);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  useEffect(() => {
    if (connInstance === null) return;
    let alive = true;
    void connInstance.settings(openRoot !== '' ? openRoot : undefined).then(
      (view) => {
        if (!alive) return;
        const row = view.keys.find((k) => k.key === 'agentTeams');
        const v = row?.value;
        if (v === null || v === undefined || v === '') {
          setAgentTeamsOn(true);
          return;
        }
        const n = v.trim().toLowerCase();
        setAgentTeamsOn(n === 'on' || n === 'true');
      },
      () => {
        if (alive) setAgentTeamsOn(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [connInstance, openRoot, settingsEpoch]);

  /** agentTeams 关闭:剔除已开/盘档残留的 agents 页签(含 recentClosed,防重开旁路) */
  useEffect(() => {
    if (agentTeamsOn) return;
    setTabStates((st) => stripTabType(st, 'agents'));
  }, [agentTeamsOn, setTabStates]);

  /** G8c-T8 开设置态:settingsRoot 快照当前 openRoot(无会话=''=仅全局);connInstance 在场才
   *  可达(设置钮只在 ProjectMenu 底栏,其渲染前提即连接装配完成) */
  const openSettings = useCallback((): void => {
    setSchedulesMain(false); // 设置覆盖层与定时任务层互斥(设置壳整幅覆盖)
    setSettingsRoot(openRoot);
    setSettingsOpen(true);
  }, [openRoot]);

  /** G8c-T8 回会话态(返回钮/Esc 同路径):page 态未动——开设置前是 chat 则回 chat(Chat 重挂
   *  重播种),welcome 则回欢迎空态;关壳即 bump settingsEpoch 重读 agentTeams(表单 autosave 已落) */
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    setSettingsPane(undefined);
    setSettingsEpoch((v) => v + 1);
  }, []);

  /** 记录 → 会话(定时任务 Task 11):关层 + 既有 newSession+attach 打开链(daemon 在座会收编/复用),
   *  root 取 attach 应答真根、缺省回退记录行根;失败经 showOpError 上屏。
   *  2026-11-21:SUNX 目标记录走 attachSunx(容器域 journal 与普通工作区 attach 不同链)。
   *  openSession 每渲染换身份——经 ref 取最新(跳板同形,回调身份恒稳) */
  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;
  const openJournalSessionStable = useCallback((journalId: string, root: string, kind?: 'sunx'): void => {
    setSchedulesMain(false);
    const conn = connRef.current;
    if (conn === null) return;
    if (kind === 'sunx') {
      void conn
        .attachSunx(journalId)
        .then((r) => openSessionRef.current(r.sessionId, r.root || root, journalId))
        .catch(showOpError);
      return;
    }
    void conn
      .newSession(root)
      .then(({ sessionId }) => conn.attach(sessionId, journalId))
      .then((r) => openSessionRef.current(r.sessionId, r.root || root, journalId))
      .catch(showOpError);
  }, [connRef, showOpError]);

  return {
    settingsOpen, settingsRoot, settingsPane, setSettingsPane, schedulesMain, setSchedulesMain,
    scheduleFocus, setScheduleFocus, agentTeamsOn, setAgentTeamsOn,
    openSettings, closeSettings, openJournalSessionStable,
  };
}
