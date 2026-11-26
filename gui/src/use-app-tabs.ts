import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from './connection';
import type { ChatSink } from './pages/Chat';
import { SESSION_DELETED_EVENT, SESSION_ARCHIVED_EVENT } from './session-events';
import { lightFirstPanelRow } from './ui-util';
import { seatOfWebContents, seatsOfBrowserKey } from './tabs/WebTabPool';
import type { WebPoolItem } from './tabs/WebTabPool';
import { registryProbe, tabEntry } from './tabs/registry';
import { REFRESHABLE_TAB_TYPES } from './tabs/sidebar-refresh';
import { ensureSession, openTab, closeTab, setActive, cycleTab, reorderTab, setCollapsed, patchTurndiffAddressing, reopenClosed, addSideDismissed, WELCOME_TAB_SEAT } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { usePtyRegistry } from './use-pty-registry';
import { useSideChats } from './use-side-chats';
import { useStableCallback } from './use-stable-callback';

/** tabs 大钩(D62 专项 二段四段 自 App.tsx 逐字平迁,行为零变化):右栏页签条回调簇/openTab*族/
 *  closeTab 关闭链/sidechat 簇/pty 记账/web 池派生一条域一个文件。回调身份纪律随码:
 *  TabStrip 簇与 startSideChat 走 useStableCallback(共享模块),openTabInSession 保持
 *  isWelcome 依赖判例(5232DCE/fe55c46 注),closeTabInSession 保持逐渲染换身份原语义
 *  (消费面全经恒稳跳板/panes 直传)。 */
export function useAppTabs(opts: {
  connInstance: Connection | null;
  connRef: MutableRefObject<Connection | null>;
  sessionRef: MutableRefObject<string>;
  openJournalIdRef: MutableRefObject<string>;
  backHomeRef: MutableRefObject<() => void>;
  page: 'welcome' | 'chat';
  isWelcome: boolean;
  openSessionId: string;
  openRoot: string;
  tabStates: TabStates;
  tabState: TabStates[string];
  setTabStates: Dispatch<SetStateAction<TabStates>>;
  agentTeamsOn: boolean;
  sideSinksRef: MutableRefObject<Map<string, MutableRefObject<ChatSink | null>>>;
  sideParentRef: MutableRefObject<Map<string, string>>;
  probe: ReturnType<typeof registryProbe>;
}): {
  startSideChat: (insert?: string, insertContent?: string) => void;
  sideGoals: ReturnType<typeof useSideChats>['sideGoals'];
  setSideGoals: ReturnType<typeof useSideChats>['setSideGoals'];
  upgradeSideChat: ReturnType<typeof useSideChats>['upgradeSideChat'];
  sideListing: ReturnType<typeof useSideChats>['sideListing'];
  sideReleased: ReturnType<typeof useSideChats>['sideReleased'];
  tabSelectStable: (uid: string) => void;
  tabReorderStable: (fromUid: string, toUid: string) => void;
  tabCloseStable: (uid: string) => void;
  tabOpenTypeStable: (t: TabTypeId) => void;
  tabCycleStable: (d: 1 | -1) => void;
  tabReopenClosedStable: (i: number) => void;
  tabCloseActiveStable: () => void;
  panelRefreshNonce: number | undefined;
  openTabInSession: (type: TabTypeId, params?: TabParams) => void;
  openDiffTab: (callId: string, path: string) => void;
  openTurndiffTab: (run: number, path: string) => void;
  openAgentTab: (label: string, agentTitle?: string, task?: string, focusTaskId?: string) => void;
  leaderFocus: { member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null;
  openLeaderBubble: (m: { member: string; text: string; dir: 'toLeader' | 'fromLeader' }) => void;
  /** 跨 Sunx 归因行定位信号(2026-11-26 用户裁定「点击气泡上蓝色 sunx 名字定位到对应发送气泡的
   *  轮次中」):journalId=发送方档,runSeq=发送轮 run 条目 seq——Chat 播种后滚到该轮并闪光 */
  sunxPeerFocus: { journalId: string; runSeq: number; nonce: number } | null;
  focusSunxPeer: (f: { journalId: string; runSeq: number }) => void;
  clearSunxPeerFocus: () => void;
  openWebTab: (url: string) => void;
  openBoardTab: () => void;
  openTabType: (type: TabTypeId) => void;
  openTabLit: (type: TabTypeId) => void;
  openArtifactsTab: () => void;
  hiddenMenuIds: ReadonlySet<string> | undefined;
  closeTabInSession: (uid: string) => void;
  closeDockTab: (uid: string) => void;
  handlePtyAllocated: ReturnType<typeof usePtyRegistry>['handlePtyAllocated'];
  ptyIdFor: ReturnType<typeof usePtyRegistry>['ptyIdFor'];
  webPoolItems: WebPoolItem[];
  curSeatRef: MutableRefObject<string>;
} {
  const { connInstance, connRef, sessionRef, openJournalIdRef, backHomeRef, page, isWelcome, openSessionId, openRoot, tabStates, tabState, setTabStates, agentTeamsOn, sideSinksRef, sideParentRef, probe } = opts;

  /** tabStates 镜像(2026-11-16 流畅轮):openTurndiffTab 等读面走 ref 免依赖——草稿直写
   *  (patchTabMeta 每击键 setTabStates)换掉回调身份会击穿 ChatMemo/TabStripMemo */
  const tabStatesRef = useRef<TabStates>({});
  tabStatesRef.current = tabStates;

  /** G14.29 辅助对话:右栏 sidechat 标签绑定旁路会话。帧路由经 sideSinksRef(onEvent 同键转投);
   *  卡点与 /btw /side 输入拦截同汇本口。
   *  2026-11-04 用户裁定「发送第一条才 fork」:点开只开草稿页签(不 fork;sidechat 判重键
   *  sideId 缺='' 互判重聚焦既有——类似欢迎页临时会话,每次打开复用同一草稿页),首条发送时
   *  才 fork 主对话整档(见 upgradeSideChat) */
  const startSideChat = useStableCallback((insert?: string, insertContent?: string): void => {
    if (openSessionId === '') return;
    // 2026-11-07 串扰根修:token 内容随 insert 同路入参(辅助面私有账本收),全局注册表仅兜底
    openTabInSession('sidechat', insert !== undefined && insert !== '' ? { insert, insertContent } : {});
  });
  const { sideGoals, setSideGoals, upgradeSideChat, sideListing, sideReleased } = useSideChats({
    connInstance, connRef, page, openSessionId, openRoot, tabStates, setTabStates, sideSinksRef, sideParentRef, probe,
  });

  /** 右栏页签条回调簇(TabStripMemo 下发面) */
  const tabSelectStable = useStableCallback((uid: string): void => setTabStates((s) => setActive(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid)));
  const tabReorderStable = useStableCallback((fromUid: string, toUid: string): void => setTabStates((s) => reorderTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, fromUid, toUid)));
  const tabCloseStable = useStableCallback((uid: string): void => closeTabInSession(uid));
  const tabOpenTypeStable = useStableCallback((t: TabTypeId): void => {
    // G14.2xx 辅助对话特判:sidechat 需先 fork 出 side 会话(拿 sideId)再开页——
    // 直接 openTab 只会落无 sideId 的空壳档;startSideChat 完成装配+开页一条龙
    if (t === 'sidechat') {
      startSideChat();
      return;
    }
    if (t === 'agents' && !agentTeamsOn) return;
    openTabInSession(t, tabEntry(t).mintParams?.());
  });
  const tabCycleStable = useStableCallback((d: 1 | -1): void => setTabStates((s) => cycleTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, d)));
  const tabReopenClosedStable = useStableCallback((i: number): void => {
    const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
    const entry = tabStatesRef.current[seat]?.recentClosed[i];
    if (entry?.type === 'agents' && !agentTeamsOn) return;
    setTabStates((s) => reopenClosed(s, seat, i, probe));
  });
  const tabCloseActiveStable = useStableCallback((): void => {
    const uid = tabStatesRef.current[isWelcome ? WELCOME_TAB_SEAT : openSessionId]?.activeUid;
    if (uid !== null && uid !== undefined) closeTabInSession(uid);
  });

  /** G8a 开标签(会话内):Chat write 工具 path 按钮 / 标签条「+」菜单共用——判重聚焦经
   *  tab-state(同目标重开=聚焦既有,单例类型单份)。G14.211 useCallback+sessionRef 零依赖
   *  稳定:内联闭包随 App 渲染换新,击穿 ChatEntryView memo——点一次文件=全列表重渲染闪帧
   *  (正文抖动源之一);sessionRef 恒同步 openSessionId,无过期闭包面 */
  /** 可刷新侧栏打开信号:正文/顶栏每次 open 递增,页签据此主动拉一次 */
  const [panelRefreshNonce, setPanelRefreshNonce] = useState<number | undefined>(undefined);
  const openTabInSession = useCallback((type: TabTypeId, params: TabParams = {}): void => {
    // 2026-10-27 欢迎页全局草稿:无会话(欢迎页)写 '@welcome' 草稿座——临时会话思想:发出去
    // (欢迎页建席,openSession 第 4 参)才整座继承到新会话;开既有会话零交集(继承门见 openSession)
    const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
    // G14.38:程序化开标签即展开右栏(默认折叠下 write/diff/目录跳转/卡片开面板均可见)
    setTabStates((st) => setCollapsed(st, seat, false));
    setTabStates((s) => openTab(s, seat, type, params, probe));
    // 带刷新钮的侧栏:打开即刷一次(keep-alive 常挂时仅切激活不会重挂载)
    if (REFRESHABLE_TAB_TYPES.has(type)) setPanelRefreshNonce(Date.now());
    // isWelcome 必入依赖(2026-10-29 用户实测「欢迎页点浏览器/终端不开,开会话才见=绑定错了」
    // 根修):5232DCE 起进欢迎页不清 openSessionId——chat→welcome 若 openSessionId 不变,本回调
    // 不重建,闭包滞留聊天页 isWelcome=false,落座写成会话座;渲染层读 '@welcome' 恒空,开会话
    // 才见标签(草稿座迁移链忠实搬运了写错座的档)。fe55c46 修同族三处判定时此处依赖遗漏
  }, [openSessionId, isWelcome]);
  // 2026-11-10 用户裁定「写入/编辑跳转复用本轮 diff 页签,不再跳审查页」:write/edit 工具行跳转
  // (callId 寻址)与轮尾改动条(run+path 寻址)统一开 turndiff 单文件页签;'diff' 型保留=审查页
  // 空入参守卫(2026-11-10 用户裁定「去掉本轮空页签入口」):无 callId 且无 path 的裸开=「没有可展示的内容」死页签,不开
  const openDiffTab = useCallback((callId: string, path: string): void => { if (callId === '' && path === '') return; openTabInSession('turndiff', { callId, path: path.replaceAll('\\', '/').replace(/^(\.\/)+/, '') }); }, [openTabInSession]);
  // 轮尾行点击(2026-11-11 用户裁定「当作一个区域处理」):同文件已有 turndiff 页签(刀级 callId
  // 寻址)就地处切 run+path 聚合寻址并激活——同文件恒一签,点轮尾=看聚合、点工具行=看那一刀
  const openTurndiffTab = useCallback((run: number, path: string): void => {
    if (path === '') return;
    // 路径归一(2026-11-12):反斜杠统一+剥 ./ 前缀——'./edit-test.md' 与 'edit-test.md' 是同一文件,
    // 不归一则复用匹配打穿(实测三页签并存)
    const norm = path.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
    const seat = tabStatesRef.current[openSessionId];
    const existing = seat?.tabs.find((tb) => tb.type === 'turndiff' && (tb.params.path ?? '').replaceAll('\\', '/').replace(/^(\.\/)+/, '') === norm);
    if (seat !== undefined && existing !== undefined) {
      setTabStates((s) => setActive(patchTurndiffAddressing(s, openSessionId, existing.uid, { run, path: norm }), openSessionId, existing.uid));
      return;
    }
    openTabInSession('turndiff', { run, path: norm });
  }, [openTabInSession, openSessionId]);
  const openAgentTab = useCallback((label: string, agentTitle?: string, task?: string, focusTaskId?: string): void => { openTabInSession('agent', { label, agentTitle, task, focusTaskId }); }, [openTabInSession]);
  /** 成员转录 leader 链接点击(2026-11-08 用户裁定「定位到主对话对应发送位置,不打开页签」):
   *  记 {member,text,dir,nonce} 下发 Chat——主对话滚到对应消息气泡/发送工具行并闪光 */
  const [leaderFocus, setLeaderFocus] = useState<{ member: string; text: string; dir: 'toLeader' | 'fromLeader'; nonce: number } | null>(null);
  const openLeaderBubble = useCallback((m: { member: string; text: string; dir: 'toLeader' | 'fromLeader' }): void => { setLeaderFocus({ ...m, nonce: Date.now() }); }, []);
  /** 跨 Sunx 定位信号（2026-11-26）：App 组合 openSunxInstance 后下发——nonce 驱动 Chat 侧一次性消费 */
  const [sunxPeerFocus, setSunxPeerFocus] = useState<{ journalId: string; runSeq: number; nonce: number } | null>(null);
  const focusSunxPeer = useCallback((f: { journalId: string; runSeq: number }): void => { setSunxPeerFocus({ ...f, nonce: Date.now() }); }, []);
  /** 一次性消费收口（Chat 侧定位完成/放弃后清信号——切回该会话不重复跳转） */
  const clearSunxPeerFocus = useCallback((): void => { setSunxPeerFocus(null); }, []);
  /** 浏览器工具联动(2026-10-31 用户裁定「浏览器默认直接打开侧栏的浏览器」):agent 走
   *  browser_navigate 时 Chat 上抛 url,此处开 web 页签跟随(判重由 openTabInSession 承担) */
  const openWebTab = useCallback((url: string): void => { openTabInSession('web', { url }); }, [openTabInSession]);
  /** M2 融合(2026-11-02 用户裁定「页内超链接开新页签,和浏览器一样」):guest 弹窗 URL 由壳转发
   *  (main setWindowOpenHandler → builtin:open-url),此处开新侧栏 web 页签;判重由 openTab 承担 */
  // 订阅只挂一次,回调经 ref 取最新 openWebTab(闭包滞留首帧会话座=开签落错座,页签不可见)
  const openWebTabRef = useRef(openWebTab);
  openWebTabRef.current = openWebTab;
  // 会话删除:卸载其座位的页签(常驻池里的 webview 随之销毁,不再占资源);删的是正开会话则
  // 主对话回欢迎页(2026-11-04 用户裁定,归档同裁定)
  useEffect(() => {
    const onDeleted = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (id === sessionRef.current || id === openJournalIdRef.current) backHomeRef.current();
      const seats = new Set([id, ...seatsOfBrowserKey(id)]);
      setTabStates((s) => {
        if (![...seats].some((seat) => s[seat] !== undefined)) return s;
        const next = { ...s };
        for (const seat of seats) delete next[seat];
        return next;
      });
    };
    const onArchived = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (id === sessionRef.current || id === openJournalIdRef.current) backHomeRef.current();
    };
    window.addEventListener(SESSION_DELETED_EVENT, onDeleted);
    window.addEventListener(SESSION_ARCHIVED_EVENT, onArchived);
    return () => {
      window.removeEventListener(SESSION_DELETED_EVENT, onDeleted);
      window.removeEventListener(SESSION_ARCHIVED_EVENT, onArchived);
    };
  }, []);
  const curSeatRef = useRef('');
  curSeatRef.current = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
  useEffect(() => {
    const bridge = window.sunshinexWindow;
    if (bridge?.onOpenUrl === undefined) return;
    // 归座(浏览器状态按会话隔离):agent 开页带座位;页内弹窗按开启者 webview 所在座位;
    // 非当前座位只入该座位(后台会话的 agent 不打扰用户视图),当前座位走既有开签(展开侧栏)
    return bridge.onOpenUrl((url, target) => {
      const seat = target?.seat ?? (target?.openerWebContentsId !== undefined ? seatOfWebContents(target.openerWebContentsId) : undefined);
      if (seat === undefined || seat === '' || seat === curSeatRef.current) {
        openWebTabRef.current(url);
        return;
      }
      setTabStates((s) => openTab(ensureSession(s, seat, probe), seat, 'web', { url }, probe));
    });
  }, []);

  /** agents 页签 id=智能体团队页签(卡片流;tab 持久化档兼容保留旧 id);agentTeams 关闭时不挂载 */
  const openBoardTab = useCallback((): void => {
    if (!agentTeamsOn) return;
    openTabInSession('agents', {});
  }, [openTabInSession, agentTeamsOn]);
  const openTabType = useCallback((type: TabTypeId): void => {
    if (type === 'agents' && !agentTeamsOn) return;
    openTabInSession(type, {});
  }, [openTabInSession, agentTeamsOn]);
  /** 顶栏计数钮开签(2026-11-24 用户裁定「点击顶部的后台任务/待办/计划书/团队任务等触发点也要
   *  高亮」):开签后点亮面板**第一行**——顶栏钮=跳转触发点(区别于 + 菜单/命令面板手动开签);
   *  无行面页签(diff)轮询自然过期零副作用 */
  const openTabLit = useCallback((type: TabTypeId): void => {
    openTabType(type);
    lightFirstPanelRow(type);
  }, [openTabType]);
  const openArtifactsTab = useCallback((): void => {
    openTabInSession('artifacts', {});
  }, [openTabInSession]);
  const hiddenMenuIds = useMemo(
    () => (agentTeamsOn ? undefined : new Set<string>(['agents'])),
    [agentTeamsOn],
  );

  /** pty 记账(use-pty-registry 单点,2026-10-27 技术债轮 D53 批F 外提):terminal 标签 uid→ptyId */
  const { handlePtyAllocated, ptyIdFor, takePtyId } = usePtyRegistry(isWelcome ? WELCOME_TAB_SEAT : openSessionId, setTabStates);

  /** G8b 关标签链(TabStrip onClose/onCloseActive 共用):被关标签为 terminal 且 pty 已记账 →
   *  fire-and-forget killPty(拒约吞——关标签不等 HTTP;已关会话侧幂等)再关标签态 */
  const closeTabInSession = (uid: string): void => {
    // 辅助对话页签关闭即记忆(重进主会话不复活;切会话不误记——按当前席上该页签的 sideId 记)
    const seat = isWelcome ? WELCOME_TAB_SEAT : openSessionId;
    const tab = tabStates[seat]?.tabs.find((x) => x.uid === uid);
    if (tab !== undefined && tab.type === 'sidechat' && tab.params.sideId !== undefined) {
      // 关闭记忆入座档落盘(2026-11-06 移入 TabSessionState):sideId+sideJournal 双键——
      // daemon 重启后 live id 失效,恢复对账按 journal 判「关过不复活」
      const sj = tab.params.sideJournal;
      setTabStates((s) => addSideDismissed(s, seat, typeof sj === 'string' ? [tab.params.sideId!, sj] : [tab.params.sideId!]));
    }
    const t = tabState.tabs.find((x) => x.uid === uid);
    if (t?.type === 'terminal') {
      // 记账键=座位+uid:欢迎页转移入会话的终端账仍在 '@welcome' 座(注册表 curSeat 已切)——
      // 出账 miss 回落盘档 params.ptyId(转移链整座搬运,档必在);app 域 pty(draftPty 旗)走
      // killPtyAt 直杀(会话段 kill 归属校验不认 '@app')
      const ptyId = takePtyId(uid) ?? (typeof t.params.ptyId === 'string' ? t.params.ptyId : undefined);
      if (ptyId !== undefined) {
        const conn = connRef.current;
        // killPty 尽力而为:标签已关,失败=daemon 侧 pty 随会话 teardown 兜底回收,无用户可见后果
        if (conn !== null) {
          if (isWelcome || t.params.draftPty === true) void conn.killPtyAt(ptyId).catch(() => {});
          else void conn.killPty(openSessionId, ptyId).catch(() => {});
        }
      }
    }
    setTabStates((s) => closeTab(s, isWelcome ? WELCOME_TAB_SEAT : openSessionId, uid));
  };

  /** 2026-11-10 终端下栏标签关闭:同一 kill 链单点复用(takePtyId 出账→killPty 尽力而为)——
   *  dock 标签 uid(dock-term-<n>)与右栏页签 uid 在同一座位记账表内不相交 */
  const closeDockTab = useCallback(
    (uid: string): void => {
      const ptyId = takePtyId(uid);
      if (ptyId === undefined) return;
      const conn = connRef.current;
      if (conn !== null) void conn.killPty(openSessionId, ptyId).catch(() => {});
    },
    [takePtyId, openSessionId],
  );

  /** 浏览器页签池:全部座位的 web 页签(切会话/收侧栏/进设置不卸载,后台会话 agent 仍可驱动) */
  const webPoolItems = useMemo<WebPoolItem[]>(
    () => Object.entries(tabStates).flatMap(([seat, st]) => st.tabs.filter((t) => t.type === 'web').map((t) => ({ seat, uid: t.uid, params: t.params }))),
    [tabStates],
  );

  return {
    startSideChat, sideGoals, setSideGoals, upgradeSideChat, sideListing, sideReleased,
    tabSelectStable, tabReorderStable, tabCloseStable, tabOpenTypeStable, tabCycleStable, tabReopenClosedStable, tabCloseActiveStable,
    panelRefreshNonce, openTabInSession, openDiffTab, openTurndiffTab, openAgentTab, leaderFocus, openLeaderBubble, openWebTab,
    sunxPeerFocus, focusSunxPeer, clearSunxPeerFocus,
    openBoardTab, openTabType, openTabLit, openArtifactsTab, hiddenMenuIds, closeTabInSession, closeDockTab,
    handlePtyAllocated, ptyIdFor, webPoolItems, curSeatRef,
  };
}
