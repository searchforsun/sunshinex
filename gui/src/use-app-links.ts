import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanPathInput, isAbsPath, joinWsPath, OPEN_DEFAULT_KEY, workspaceOfAbs } from './ui-util';
import type { TabParams, TabTypeId } from './tabs/tab-state';

/** 连接面(结构满足即收;App 实传整只 Connection) */
interface AppLinksConn {
  sessionsOf(root: string): Promise<Array<{ liveSessionId?: string }>>;
  newSession(root: string): Promise<{ sessionId: string }>;
  workspaces(): Promise<Array<{ root?: string }>>;
  openInEditor(path: string, id: string, root?: string): Promise<void>;
  attachSunx(journalId: string): Promise<{ sessionId: string; root: string }>;
}

/**
 * 记忆/技能/目录/文件/任务定位开签簇(App 外提,D62 批H):记忆页签+定位(2026-10-31 用户裁定
 * 「点击打开侧栏对应记忆行」,focus slug 随 render props 下发,nonce 保重复点击触发);学习技能
 * 同构(2026-11-01 用户裁定);目录树入左菜单层(2026-10-27 用户裁定,menuDir 驱动 ProjectMenu
 * 目录视图,locate 相对路径树内展开定位);目录路径解析(在册项目 → 左树定位,区外按默认打开
 * 方式外开);文件开签(尾斜杠=目录同口径);树内点文件排队旗(无会话先建席再补开,2026-11-14
 * 用户裁定「打开项目不要自动打开之前运行的会话项」:一律开新壳会话承载);SUNX 总览页进实例
 * (sunx P2 Task 8,attachSunx 直寻址重开);后台任务页签+行定位(task_wait 链);工具行定位
 * (`bg:`=账本行/`team:`=队卡/其余=板任务行)。
 */
export function useAppLinks({ connInstance, connRef, openRoot, openSessionId, openSession, openTabInSession, openBoardTab, setTaskFocus, setMenuClosed, showOpError }: {
  connInstance: AppLinksConn | null;
  connRef: { current: AppLinksConn | null };
  openRoot: string;
  openSessionId: string;
  openSession: (sessionId: string, root: string, journalId?: string) => void;
  openTabInSession: (type: TabTypeId, params?: TabParams) => void;
  openBoardTab: () => void;
  setTaskFocus: (v: { ref: string; nonce: number; kind?: 'task' | 'team' } | null) => void;
  setMenuClosed: (v: boolean) => void;
  showOpError: (err: unknown) => void;
}): {
  memoryFocus: { slug: string; nonce: number } | undefined;
  openMemoryTab: (focus?: string) => void;
  learnedFocus: { slug: string; nonce: number } | undefined;
  openLearnedTab: (focus?: string) => void;
  menuDir: { root: string; sessionId: string; locate?: string } | null;
  openProjectDirectory: (root: string, locate?: string) => void;
  openDirectoryPath: (raw: string) => void;
  openFileTab: (p: string) => void;
  openFileFromTree: (path: string, root: string) => void;
  openSunxInstance: (t: { journalId?: string; sessionId?: string; root: string }) => void;
  bgFocus: { id: string; nonce: number } | undefined;
  openTaskFocus: (ref: string) => void;
  setMenuDir: (v: { root: string; sessionId: string; locate?: string } | null) => void;
} {
  /** 记忆页签+定位(2026-10-31 用户裁定「点击打开侧栏对应记忆行」):focus slug 随 render props
   *  下发 MemoryTab,展开并滚至对应行;nonce 保证同 slug 重复点击仍触发 */
  const [memoryFocus, setMemoryFocus] = useState<{ slug: string; nonce: number } | undefined>(undefined);
  const openMemoryTab = useCallback((focus?: string): void => {
    openTabInSession('memory');
    setMemoryFocus(focus !== undefined && focus !== '' ? { slug: focus, nonce: Date.now() } : undefined);
  }, [openTabInSession]);
  /** 学习技能页签+定位(2026-11-01 用户裁定「点击正文 学习|更新技能 → 侧栏展开指定技能,内容原样展示」):
   *  与记忆同构——focus slug 随 render props 下发 LearnedSkillsTab,展开并滚至对应行 */
  const [learnedFocus, setLearnedFocus] = useState<{ slug: string; nonce: number } | undefined>(undefined);
  const openLearnedTab = useCallback((focus?: string): void => {
    openTabInSession('learned');
    setLearnedFocus(focus !== undefined && focus !== '' ? { slug: focus, nonce: Date.now() } : undefined);
  }, [openTabInSession]);
  /** 2026-10-27 目录树入左菜单层(用户裁定):menuDir={root,sessionId,locate?} 驱动 ProjectMenu 目录视图;
   *  locate=相对目录,树打开后逐层展开定位;sessionId 由 ensureSessionForRoot 落值 */
  const [menuDir, setMenuDir] = useState<{ root: string; sessionId: string; locate?: string } | null>(null);
  /** 组头/正文目录链:ensureSession → 左菜单目录视图;locate 相对路径则树内展开定位 */
  const openProjectDirectory = useCallback((root: string, locate?: string): void => {
    if (connInstance === null || root === '') return;
    setMenuClosed(false);
    // 同项目目录视图已开:只换 locate(避免重拉建席)
    if (menuDir !== null && menuDir.root === root) {
      setMenuDir({ ...menuDir, locate });
      return;
    }
    void Promise.resolve()
      .then(() => connInstance.sessionsOf(root))
      .then((rows) => {
        const first = rows[0];
        return first !== undefined
          ? { sessionId: first.liveSessionId ?? connInstance.newSession(root).then((r) => r.sessionId) }
          : connInstance.newSession(root).then((r) => ({ sessionId: r.sessionId }));
      })
      .then(({ sessionId }) => Promise.resolve(sessionId).then((sid) => setMenuDir({ root, sessionId: sid, locate })))
      .catch(showOpError);
    // eslint 不入依赖(setMenuClosed/setMenuDir 恒稳;connInstance 由连接生命周期持有)
  }, [connInstance, menuDir, setMenuClosed, showOpError]);
  /** 目录路径:在册项目 → 左侧树定位该项目+相对路径;否则按用户默认打开方式(资源管理器/vscode…)外开 */
  const openDirectoryPath = useCallback((raw: string): void => {
    if (connInstance === null) return;
    const cleaned = cleanPathInput(raw);
    const abs = isAbsPath(cleaned)
      ? cleaned.replace(/[\\/]+$/, '') || cleaned
      : joinWsPath(openRoot || '', cleaned).replace(/[\\/]+$/, '');
    if (abs === '') return;
    void connInstance
      .workspaces()
      .then((rows) => {
        const hit = workspaceOfAbs(abs, rows.flatMap((r) => (r.root !== undefined && r.root !== '' ? [r.root] : [])));
        if (hit !== null) {
          openProjectDirectory(hit.root, hit.rel === '' ? undefined : hit.rel);
          return;
        }
        return connInstance.openInEditor(abs, localStorage.getItem(OPEN_DEFAULT_KEY) ?? 'explorer');
      })
      .catch(showOpError);
  }, [connInstance, openRoot, openProjectDirectory, showOpError]);
  /** 文件开签;尾斜杠=目录 → 走 openDirectoryPath(正文目录芯片/畸形 ./D:\\… 同口径) */
  const openFileTab = useCallback((p: string): void => {
    const cleaned = cleanPathInput(p);
    if (/[\\/]$/.test(cleaned) || /[\\/]$/.test(p.trim())) {
      openDirectoryPath(cleaned === '' ? p : cleaned);
      return;
    }
    openTabInSession('file', { path: cleaned === '' ? p : cleaned });
  }, [openTabInSession, openDirectoryPath]);
  /** 树内点文件排队旗:目标会话成为打开会话后补开文件标签(欢迎页/无会话态先建席再进) */
  const pendingFileTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (openSessionId === '' || pendingFileTabRef.current === null) return;
    const p0 = pendingFileTabRef.current;
    pendingFileTabRef.current = null;
    openFileTab(p0);
  }, [openSessionId, openFileTab]);
  /** 树内点文件→右侧文件标签:有打开会话直接开(服务端信任根已放行跨项目);无会话(欢迎页)→
   *  建席+attach+openSession 进会话,标签经 pendingFileTabRef 排队补开 */
  const openFileFromTree = useCallback((path: string, root: string): void => {
    const abs = joinWsPath(root, path);
    if (openSessionId !== '') {
      openFileTab(abs);
      return;
    }
    if (connInstance === null) return;
    pendingFileTabRef.current = abs;
    // 2026-11-14 用户裁定「打开项目不要自动打开之前运行的会话项」:原先无会话时点树内文件会
    // attach 到该项目最近一次会话(rows[0],常是**运行中**的那个)并接管主视图——运行中会话被
    // 乱动。改为一律开该根的新壳会话承载文件页签,旧会话原样不动
    void Promise.resolve()
      .then(() => connInstance.newSession(root))
      .then((r) => ({ sessionId: r.sessionId, journalId: undefined as string | undefined, root }))
      .then(({ sessionId, journalId, root: realRoot }) => openSession(sessionId, realRoot, journalId))
      .catch((err: unknown) => {
        // 建席链败:排队旗回收——残留会在用户下次打开任意会话时补开出陈旧路径的幽灵文件标签
        pendingFileTabRef.current = null;
        showOpError(err);
      });
    // eslint 不入依赖(openSession 恒稳;connInstance 由连接生命周期持有)
  }, [openSessionId, openFileTab, connInstance, openSession, showOpError]);
  /** SUNX 总览页进实例(sunx P2 Task 8,spec §17.3「点卡片进实例」;App 注入 TabRenderProps.onOpenSunxInstance):
   *  journalId=attachSunx 直寻址重开(P3 Task 3 数据源改向:域定位/壳铸造/attach 全链 daemon 单点——
   *  不再 newSession(root)+attach 两步,root 参数仅作应答缺根兜底)→openSession canonical——Chat fork
   *  横幅回父同链,daemon 重启后 runtime 表按新壳 id 重挂,裸 journal id 必 404;sessionId=新建成功裸
   *  openSession(newSession 即 canonical,NewSunxDialog 成功链同侧栏 openCreatedSunx 形态)。 */
  const openSunxInstance = useCallback((t: { journalId?: string; sessionId?: string; root: string }): void => {
    if (t.sessionId !== undefined && t.sessionId !== '') {
      openSession(t.sessionId, t.root);
      return;
    }
    const jid = t.journalId;
    if (jid === undefined || jid === '') return;
    const conn = connRef.current;
    if (conn === null) return;
    void conn
      .attachSunx(jid)
      .then((r) => openSession(r.sessionId, r.root || t.root, jid))
      .catch(showOpError);
  }, [openSession, connRef, showOpError]);
  /** 后台任务页签+行定位(task_wait 链路;与板面 openTaskFocus 分立——账本≠板) */
  const [bgFocus, setBgFocus] = useState<{ id: string; nonce: number } | undefined>(undefined);
  const openBgTaskFocus = useCallback((id: string): void => {
    openTabInSession('bgtasks');
    if (id !== '') setBgFocus({ id, nonce: Date.now() });
  }, [openTabInSession]);
  /** 工具行定位:开任务板页签 + focus。`bg:` 前缀=后台任务账本行(task_wait);
   *  `team:` 前缀=队卡定位；其余=板任务行高亮(create_agent_team_task/agent_team_task_wait 等) */
  const openTaskFocus = useCallback((ref: string): void => {
    if (ref.startsWith('bg:')) {
      openBgTaskFocus(ref.slice(3));
      return;
    }
    openBoardTab();
    if (ref.startsWith('team:')) setTaskFocus({ ref: ref.slice(5), nonce: Date.now(), kind: 'team' });
    else setTaskFocus({ ref, nonce: Date.now(), kind: 'task' });
  }, [openBoardTab, openBgTaskFocus, setTaskFocus]);
  return {
    memoryFocus, openMemoryTab, learnedFocus, openLearnedTab, menuDir,
    openProjectDirectory, openDirectoryPath, openFileTab, openFileFromTree, openSunxInstance,
    bgFocus, openTaskFocus, setMenuDir,
  };
}
