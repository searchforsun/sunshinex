import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from './connection';
import type { ChatSink } from './pages/Chat';
import { buildSideNote } from './pages/chat/side-note';
import { ensureSession, openTab, patchTabMeta, WELCOME_TAB_SEAT, type TabStates } from './tabs/tab-state';
import type { registryProbe } from './tabs/registry';

/** 辅助会话页签簇（D62 批A，2026-11-08 自 App.tsx 外提——逐字平移，行为零变化）：草稿升级 fork、/sides
 *  清单拉取、页签×清单对账（去重/在座改指/不在座收养/关闭记忆不复活）与挂座闸门 sideReleased。
 *  宿主态全经参注入（conn 双形态：connInstance 驱动 effect、connRef 供异步回调取最新）。 */
export function useSideChats(deps: {
  connInstance: Connection | null;
  connRef: MutableRefObject<Connection | null>;
  page: 'welcome' | 'chat';
  openSessionId: string;
  openRoot: string;
  tabStates: TabStates;
  setTabStates: Dispatch<SetStateAction<TabStates>>;
  sideSinksRef: MutableRefObject<Map<string, MutableRefObject<ChatSink | null>>>;
  sideParentRef: MutableRefObject<Map<string, string>>;
  probe: ReturnType<typeof registryProbe>;
}) {
  const { connInstance, connRef, page, openSessionId, openRoot, tabStates, setTabStates, sideSinksRef, sideParentRef } = deps;
  const PROBE = deps.probe;
  /** 草稿升级(2026-11-04 首条发送才 fork):fork 主会话(side 标记;daemon 运行中亦放行——
   *  只读复制与源会话互不干扰)→ 取持久化编号题 → 首条文本登记 App 态位(挂真 Chat 后经
   *  pendingGoal 自动提交;重启态位丢失=不发,安全)→ params 落 sideId(判重键/真 Chat 随之挂) */
  const [sideGoals, setSideGoals] = useState<Map<string, { root: string; goal: string }>>(new Map());
  const upgradeSideChat = async (uid: string, text: string): Promise<void> => {
    const conn = connRef.current;
    if (conn === null || openSessionId === '') return;
    const r = await conn.forkSession(openSessionId, 1, true);
    sideSinksRef.current.set(r.sessionId, { current: null });
    sideParentRef.current.set(r.sessionId, openSessionId);
    releaseSide(r.sessionId);
    // 持久化编号题(daemon fork 落 meta「辅助对话 N」;2026-10-31 用户裁定页签显编号)
    const title = await conn.getSessionTitle(r.sessionId).then((x) => (typeof x.title === 'string' && x.title !== '' ? x.title : undefined)).catch(() => undefined);
    // 2026-11-06 用户裁定「fork 时要给模型加说明」:首条播种注入 fork 说明——以上是主会话上下文、
    // 本会话是辅助会话(用于辅助主会话相关内容,不影响主会话)。模型此前只能从复制内容自行推断
    const mainTitle = await conn.getSessionTitle(openSessionId).then((x) => (typeof x.title === 'string' && x.title !== '' ? x.title : openSessionId)).catch(() => openSessionId);
    if (text.trim() !== '') {
      setSideGoals((m) => new Map(m).set(uid, { root: openRoot, goal: buildSideNote(mainTitle) + text }));
    }
    // 2026-11-07 用户实测「发送后升级会话中,输入框多一枚文本片段」根修:params.insert 是草稿期
    //  圈选注入通道,草稿已消费(appended);不清则升级后的真 Chat 经 initialInsert 再注入一遍=残留。
    //  insert/insertContent 置空串(消费侧 !=='' 判空即跳过)
    const patch = { sideId: r.sessionId, insert: '', insertContent: '', ...(title !== undefined ? { title } : {}) };
    setTabStates((s) => patchTabMeta(patchTabMeta(s, openSessionId, uid, patch), WELCOME_TAB_SEAT, uid, patch));
  };

  /** 辅助对话页签恢复(2026-10-31 用户裁定「辅助对话持久化+编号页签」):重进主会话即按 /sides
   *  清单恢复 辅助对话 N 页签;用户关过的页签经座档 sideDismissed 落盘记忆不复活(2026-11-06
   *  用户实测「已关页签重启后还显示」——ref 内存记忆重启即忘,移入 TabSessionState 随档持久化) */
  /** 辅助会话恢复(2026-11-06 用户实测「持久化和加载还是 404,模型显示默认模型」根修):持久化页签的
   *  sideId 是上个 daemon 生命周期的会话 id,重启后必失效;旧恢复链跳过不在座的 side 档(重启后全部
   *  不在座)=恢复链从未执行,旧 id 页签直挂 snapshot 404,快照缺席模型面落「默认模型」。
   *  改为对账:/sides 清单(journal 级)× 本座 sidechat 页签(sideJournal 优先,旧档按持久化编号题
   *  匹配)——在座即改指 live id,不在座 newSession 壳+attach 收养取 canonical 改指;对账落定前
   *  页签不挂真 Chat(sideReleased 闸门,免先落 404 错误条);挂座失败(journal 已删)放闸如实暴露 */
  const [sideListing, setSideListing] = useState<{ main: string; sides: Array<{ journalId: string; sessionId?: string; title: string }> } | null>(null);
  const [sideReleased, setSideReleased] = useState<ReadonlySet<string>>(() => new Set());
  const releaseSide = useCallback((id: string): void => {
    setSideReleased((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, []);
  /** journal → 在途/已落 canonical(同 daemon 生命周期去重:对账 effect 随页签态重跑不重复挂座) */
  const sideAttachRef = useRef(new Map<string, Promise<string>>());
  useEffect(() => {
    const conn = connInstance;
    if (conn === null || page !== 'chat' || openSessionId === '') return;
    const mainId = openSessionId;
    let dead = false;
    void conn.sessionSides(mainId).then(
      (sides) => { if (!dead) setSideListing({ main: mainId, sides }); },
      () => { if (!dead) setSideListing({ main: mainId, sides: [] }); },
    );
    return () => { dead = true; };
  }, [connInstance, openSessionId, page]);
  const seatTabsForSides = tabStates[openSessionId]?.tabs;
  useEffect(() => {
    const conn = connInstance;
    if (conn === null || sideListing === null || sideListing.main !== openSessionId) return;
    const mainId = openSessionId;
    const tabs = (seatTabsForSides ?? []).filter((x) => x.type === 'sidechat' && x.params.sideId !== undefined);
    const dismissed = tabStates[mainId]?.sideDismissed;
    // 去重收敛(2026-11-06 用户实测「每重启一次多一份重复页签」):历次「side 清单先于盘档水合
    // 到达」的竞态残留了同 journal 多签——按 journal(缺省回退持久化编号题/现 sideId)只留首个,
    // 其余静默移除(同 journal 内容同一份,移除零损失);放闸死 id 签的 404 面随之消失
    const seenKeys = new Set<string>();
    const dupUids = new Set<string>();
    for (const x of tabs) {
      const key = x.params.sideJournal ?? (x.params.title !== undefined ? `t:${x.params.title}` : `s:${x.params.sideId}`);
      if (key === undefined) continue;
      if (seenKeys.has(key)) dupUids.add(x.uid);
      else seenKeys.add(key);
    }
    if (dupUids.size > 0) {
      setTabStates((st) => {
        const cur = st[mainId];
        if (cur === undefined) return st;
        const tabs2 = cur.tabs.filter((t) => !dupUids.has(t.uid));
        return { ...st, [mainId]: { ...cur, tabs: tabs2, activeUid: cur.activeUid !== null && dupUids.has(cur.activeUid) ? (tabs2.find((t) => t.uid === cur.activeUid)?.uid ?? tabs2[tabs2.length - 1]?.uid ?? null) : cur.activeUid } };
      });
    }
    const liveTabs = tabs.filter((x) => !dupUids.has(x.uid));
    const matched = new Set<string>();
    for (const sd of sideListing.sides) {
      const hit = liveTabs.find((x) =>
        x.params.sideJournal === sd.journalId
        || (sd.sessionId !== undefined && x.params.sideId === sd.sessionId)
        || x.params.sideId === sd.journalId
        || (x.params.sideJournal === undefined && x.params.title === sd.title));
      if (hit === undefined) {
        // 在座但无页签(同 daemon 生命周期重进主会话):照旧恢复页签,用户关过的不复活。
        // 不在座(daemon 重启后 sessionId 缺席;盘档加载剥 sidechat 页签=此处恒走收养)同样
        // 重建:newSession 壳+attach 收养取 canonical 再开页(2026-11-06 用户实测「重启后页签
        // 全消失」根修——此前 sessionId 缺席即 continue,页签永不复活)
        // 2026-11-07 双键 OR 匹配:关闭记忆入座档时 sideId+sideJournal 双键同记,此处任一命中即不复活
        // (单键查曾漏 journal 命中面=关闭后对账重开页签的循环风险)
        if (dismissed?.includes(sd.sessionId ?? '') === true || dismissed?.includes(sd.journalId) === true) continue;
        if (sd.sessionId !== undefined) {
          releaseSide(sd.sessionId);
          setTabStates((st) => openTab(ensureSession(st, mainId, PROBE), mainId, 'sidechat', { sideId: sd.sessionId!, sideJournal: sd.journalId, title: sd.title }, PROBE));
          continue;
        }
        let flow = sideAttachRef.current.get(sd.journalId);
        if (flow === undefined) {
          flow = conn.newSession(openRoot).then(({ sessionId: shellId }) => conn.attach(shellId, sd.journalId)).then((r) => r.sessionId);
          sideAttachRef.current.set(sd.journalId, flow);
          flow.catch(() => sideAttachRef.current.delete(sd.journalId));
        }
        void flow.then(
          (id) => {
            releaseSide(id);
            setTabStates((st) => {
              // attach 去重竞态:同 journal 已有页签(盘档水合在收养期间落位等)只改指不重开——
              // 查重必须用 updater 实参 st(渲染闭包 tabStates 是旧快照,水合晚到即漏判=重复开签根因)
              const cur = (st[mainId]?.tabs ?? []).find((x) => x.type === 'sidechat' && (x.params.sideJournal === sd.journalId || x.params.sideId === id));
              if (cur !== undefined) return patchTabMeta(st, mainId, cur.uid, { sideId: id, sideJournal: sd.journalId });
              return openTab(ensureSession(st, mainId, PROBE), mainId, 'sidechat', { sideId: id, sideJournal: sd.journalId, title: sd.title }, PROBE);
            });
          },
          () => { /* journal 已删:跳过恢复 */ },
        );
        continue;
      }
      matched.add(hit.uid);
      if (sd.sessionId !== undefined && hit.params.sideId === sd.sessionId) {
        releaseSide(sd.sessionId);
        if (hit.params.sideJournal === undefined) setTabStates((st) => patchTabMeta(st, mainId, hit.uid, { sideJournal: sd.journalId }));
        continue;
      }
      const stale = hit.params.sideId!;
      let flow = sd.sessionId !== undefined ? Promise.resolve(sd.sessionId) : sideAttachRef.current.get(sd.journalId);
      if (flow === undefined) {
        flow = conn.newSession(openRoot).then(({ sessionId: shellId }) => conn.attach(shellId, sd.journalId)).then((r) => r.sessionId);
        sideAttachRef.current.set(sd.journalId, flow);
        flow.catch(() => sideAttachRef.current.delete(sd.journalId));
      }
      void flow.then(
        (id) => {
          releaseSide(id);
          setTabStates((st) => patchTabMeta(st, mainId, hit.uid, { sideId: id, sideJournal: sd.journalId }));
        },
        () => releaseSide(stale),
      );
    }
    // 清单无对应档的页签(journal 已删等):放闸如实暴露
    for (const x of liveTabs) if (!matched.has(x.uid)) releaseSide(x.params.sideId!);
  }, [connInstance, sideListing, seatTabsForSides, tabStates, openSessionId, openRoot, releaseSide]);
  return { sideGoals, setSideGoals, upgradeSideChat, sideListing, sideReleased, releaseSide };
}
