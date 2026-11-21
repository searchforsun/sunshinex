import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Connection, RewindResult } from './connection';
import type { RewindRequest } from './pages/chat/chat-types';
import { emptyTabSession, rewindSeat } from './tabs/tab-state';
import type { TabStates } from './tabs/tab-state';
import type { WelcomeGoal } from './welcome/WelcomeComposer';

/** fork/回退换座簇(D62 批H 二段一段 自 App.tsx 逐字平迁,行为零变化):实体逻辑挂 ref(每渲染
 *  刷新,无过期闭包),回调整体零依赖恒稳(G14.211 跳板同形) */
export function useAppRewind(opts: {
  connInstance: Connection | null;
  openSessionId: string;
  openRoot: string;
  setTabStates: Dispatch<SetStateAction<TabStates>>;
  openSession: (sessionId: string, root: string, journalId?: string, inheritWelcomeDraft?: boolean, kindHint?: string) => void;
  showOpError: (err: unknown) => void;
  setWelcomeGoal: Dispatch<SetStateAction<WelcomeGoal | null>>;
  setRecentVersion: Dispatch<SetStateAction<number>>;
}): { onForkStable: (turn: number) => void; onRewindStable: (req: RewindRequest) => Promise<void> } {
  const { connInstance, openSessionId, openRoot, setTabStates, openSession, showOpError, setWelcomeGoal, setRecentVersion } = opts;
  /** G14.211 onFork 跳板:实体逻辑挂 ref(每渲染刷新,无过期闭包),回调整体零依赖恒稳 */
  const forkLatestRef = useRef((_turn?: number) => {});
  forkLatestRef.current = (turn?: number): void => {
    if (connInstance === null) return;
    void connInstance
      .sessionAnchors(openSessionId)
      .then(async (a) => {
        // 逐轮 fork(2026-11-04 用户裁定「fork 显示点击点之上所有记录」):turn 在场=点击 run 的
        // 轮序位(点哪轮,分档切在该轮锚点前=新会话时间线即其上全部记录);缺省=最近轮(原行为)
        const last = turn ?? (a.length > 0 ? a[a.length - 1]!.turn : 1);
        const r = await connInstance.forkSession(openSessionId, last);
        // 侧栏内容随 fork 复制(2026-11-04 用户裁定):父座位页签克隆到子座位——旁路对话页签除外
        // (sidechat 语义绑定父档),终端剥 ptyId(pty 归父会话进程,子会话点开即新开);active 不
        // 还原(「侧栏不必还原成父会话的打开状态」)——子座位空 active,页签条全在
        setTabStates((s) => {
          const p = s[openSessionId];
          if (p === undefined || p.tabs.length === 0) return s;
          const tabs = p.tabs
            .filter((t) => t.type !== 'sidechat')
            .map((t) => (t.params.ptyId !== undefined ? { ...t, params: { ...t.params, ptyId: undefined } } : t));
          return { ...s, [r.sessionId]: { ...emptyTabSession(), tabs, activeUid: null } };
        });
        openSession(r.sessionId, openRoot);
      })
      .catch(showOpError);
  };
  const onForkStable = useCallback((turn: number): void => { forkLatestRef.current(turn); }, []);
  /** 回退(2026-11-05 编辑重发/回到此轮):daemon 挂新会话对象+截短档,此处换座——正文与动态侧栏
   *  (板/待办/子智能体/后台任务)由 openSession+快照播种按新档重建,静态页签按回退点迁座;
   *  编辑文本走 pendingGoal 接力(播种落定才提交,回显不被整替冲掉),纯回退则原文回填新座草稿 */
  const rewindLatestRef = useRef((_req: RewindRequest): Promise<void> => Promise.resolve());
  rewindLatestRef.current = async ({ target, restoreFiles, resend }): Promise<void> => {
    if (connInstance === null) return;
    const from = openSessionId;
    let r: RewindResult;
    try {
      r = await connInstance.rewindSession(from, target, restoreFiles);
    } catch (err) {
      showOpError(err);
      throw err;
    }
    setTabStates((s) => rewindSeat(s, from, r.sessionId, r.atTs)); // 座档随 spread 带走 sideDismissed(关闭记忆随座迁移)
    setWelcomeGoal({ root: openRoot, goal: resend.text, ...(resend.images !== undefined ? { images: resend.images } : {}) });
    setRecentVersion((v) => v + 1);
    openSession(r.sessionId, openRoot, r.journalId);
  };
  const onRewindStable = useCallback((req: RewindRequest): Promise<void> => rewindLatestRef.current(req), []);
  return { onForkStable, onRewindStable };
}
