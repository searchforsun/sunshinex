import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import type { GuiApprovalReq, GuiAskAnswer, GuiAskReq, GuiPlanApprovalReq, GuiPlanDecision, SnapshotResponse } from '../../connection';
import type { ChatState } from '../../chat-reducer';
import { applyChatEvent, initialChatState, prependSeed, seedChatFromSnapshot } from '../../chat-reducer';
import type { SessionEvent, TodoItem } from '../../../../src/types';
import type { ChatSink } from '../Chat';

/** 挂起卡(approval/ask/plan-approval 判别联合;pid 为 daemon 级寻址键)。plan-approval=阶段三
 *  plan-arm 裁决卡(spec §5.1,req {doc,items} 计划书+步骤) */
export type PendingCard =
  | { kind: 'approval'; pid: string; req: GuiApprovalReq }
  | { kind: 'ask'; pid: string; req: GuiAskReq }
  | { kind: 'plan-approval'; pid: string; req: GuiPlanApprovalReq };

/** 会话事件面 hook（D32 批C 拆分自 Chat.tsx）：播种门/种子窗帧缓冲/挂起卡列表/事件分流 sink
 *  装配（G14.137 todo 上抛、G14.89 done 刷队列）+ G5 idle 清卡。投影态
 *  （chat/setChat）仍归 Chat 声明，与队列/pill/滚动存档设定器一并注入；G6 工具 input 旁路
 *  暂存已随 P11 T7 字段单源退役（工具条渲染全走内核条目字段）；行为零变化
 *  （Chat.test 播种/挂起卡/事件组为锚）。 */
export function useSessionEvents(deps: {
  conn: Connection;
  sessionId: string;
  /** App 持有的转投注册面(见 ChatSink) */
  sinkRef: MutableRefObject<ChatSink | null>;
  /** 投影态读面(G5 idle 清卡的 status 转换侦测);声明与写面归 Chat */
  chat: ChatState;
  setChat: Dispatch<SetStateAction<ChatState>>;
  /** G14.31 辅助对话全新视图:种子历史不落屏 */
  freshView?: boolean;
  /** G10 欢迎页接力:播种完成后提交的 welcome 目标(提交即回调清位) */
  pendingGoal?: { root: string; goal: string; images?: string[] };
  onPendingGoalDone?: () => void;
  /** G5 快照落定回调(App 借此取 snapshot.team) */
  onSeeded?: (snap: SnapshotResponse) => void;
  /** G14.137 todo_write 清单上抛 */
  onTodos?: (todos: TodoItem[]) => void;
  /** G14.154 辅助对话首问:挂载即把携带的选区引用落输入框(仅一次) */
  initialInsert?: string;
  setInput: Dispatch<SetStateAction<string>>;
  /** 队列面(reseed 回显 snapshot.queued;P5 起 queue 帧实时推) */
  setQueued: Dispatch<SetStateAction<Array<{ seq: number; text: string }>>>;
  /** 会话 pill(snapshot 回显面) */
  setSessMode: Dispatch<SetStateAction<'read-only' | 'acceptEdits' | 'full-access' | 'plan'>>;
  setSessEffort: Dispatch<SetStateAction<string | undefined>>;
  /** 归档态播种(2026-10-21:snapshot.archived 回填——顶栏归档钮/徽标三态;旧 daemon 无字段=未归档面) */
  setArchived: Dispatch<SetStateAction<boolean>>;
  /** G14.213 欢迎页接力取用(ref 跳板,声明在 Chat、赋值随 submitText 定义) */
  submitTextRef: MutableRefObject<(text: string, images?: string[]) => Promise<void>>;
  /** G14.212 滚动位存档落盘(unmount 兜底;滚动子系统留 Chat,函数注入) */
  flushScrollMem: () => void;
}): {
  /** G4 挂起卡列表 */
  cards: PendingCard[];
  /** 播种在途门(基线快照落定前输入禁用) */
  seeding: boolean;
  sendApproval: (pid: string, decision: string) => void;
  sendAsk: (pid: string, answer: GuiAskAnswer) => void;
  /** 阶段三 plan-arm 裁决回执(approval/ask 同口径:成功移卡,失败 404 也移) */
  sendPlanApproval: (pid: string, decision: GuiPlanDecision) => void;
} {
  const {
    conn,
    sessionId,
    sinkRef,
    chat,
    freshView,
    pendingGoal,
    onPendingGoalDone,
    onSeeded,
    onTodos,
    initialInsert,
    setInput,
    setChat,
    setQueued,
    setSessMode,
    setSessEffort,
    setArchived,
    submitTextRef,
    flushScrollMem,
  } = deps;
  /** 播种在途门:基线快照落定前输入禁用——本地 user 回显先于种子落定会被种子整替清掉
   *  (挂载/reset → sessionSnapshot 异步应答),提交必须在权威基线之后 */
  const [seeding, setSeeding] = useState(true);
  /** seeding 的同步镜像:sink.on 闭包经 ref 读(状态更新异步,事件路径须即时判) */
  const seedingRef = useRef(true);
  /** 种子在途窗到达的本会话帧缓冲(reseed 清空重来;unmount 随组件销毁) */
  const pendingRef = useRef<Array<{ e: SessionEvent; seq: number }>>([]);
  /** 播种代次:后继 reseed(在途窗内重连)使先行应答失效 */
  const seedGenRef = useRef(0);
  /** G5 idle 清卡:前次 status 记账(ref 免 effect 重复触发)——仅 running→idle 转换清卡 */
  const prevStatusRef = useRef<ChatState['status'] | null>(null);
  /** G4 挂起卡列表(pid 维:回执落定即移;resetSession/idle 清空) */
  const [cards, setCards] = useState<PendingCard[]>([]);
  /** onSeeded 的同步镜像(reseed 闭包经 ref 读,装配期固定免依赖数组抖动) */
  const onSeededRef = useRef<((snap: SnapshotResponse) => void) | undefined>(onSeeded);
  onSeededRef.current = onSeeded;
  const pendingGoalRef = useRef(pendingGoal ?? null);
  pendingGoalRef.current = pendingGoal ?? null;
  const onPendingGoalDoneRef = useRef(onPendingGoalDone);
  onPendingGoalDoneRef.current = onPendingGoalDone;

  /** G4 卡增(同 pid 防重挂——连接层已去重,本地二次防线;G7 reseed 重建复用)与移(回执落定即移) */
  const addCard = useCallback((card: PendingCard): void => {
    setCards((cs) => (cs.some((c) => c.pid === card.pid) ? cs : [...cs, card]));
  }, []);
  const removeCard = useCallback((pid: string): void => {
    setCards((cs) => cs.filter((c) => c.pid !== pid));
  }, []);

  /** 会话基线重建(挂载与 reset 同路径):清投影 + 缓冲 → sessionSnapshot 播种 → 种子落定后
   *  过滤缓冲(seq ≤ snapshot.lastSeq 丢)依序补投 + G7 挂起卡重建(snapshot.pending 逐项——
   *  连接层 pid 去重拦了 daemon 重发帧,快照是重连/刷新后卡内容的唯一来源;addCard pid 防重,实时
   *  挂起帧已挂的卡不重挂);失败倒 error 条不静默 */
  const reseed = useCallback((): void => {
    const gen = ++seedGenRef.current;
    pendingRef.current = [];
    seedingRef.current = true;
    // idle 清卡跳过 reseed 瞬态:initialChatState 的 running→idle 回摆不是真转换——若不豁免,
    // 重连时运行中挂起卡被瞬态清掉,而 daemon 重发被连接层 pid 去重拦下 → 卡永久丢(G4 不变式)
    prevStatusRef.current = null;
    setChat(initialChatState());
    setSeeding(true);
    conn.sessionSnapshot(sessionId).then(
      (snap) => {
        if (seedGenRef.current !== gen) return; // 后继 reseed 已接管(在途窗内重连)
        setQueued(snap.queued ?? []);
        if (typeof snap.mode === 'string') setSessMode(snap.mode as 'read-only' | 'acceptEdits' | 'full-access' | 'plan');
        setSessEffort(snap.effort);
        setArchived(snap.archived === true); // 2026-10-21 归档态播种(sessMode 同链;缺字段=未归档面)
        // P10:status 读内核游标(seed 内派生),快照 status 字段不再入参
        let next = seedChatFromSnapshot(snap.messages, {
          openRun: snap.openRun ?? -1,
          openSeg: snap.openSeg ?? -1,
        });
        if (freshView === true) {
          // G14.31 辅助对话:全新视图——种子历史清零不落屏(上下文只在模型侧,新帧照常续推)
          next = { ...next, entries: [], tokens: 0, steps: 0, cacheTokens: 0, history: undefined };
        } else if (snap.hasMore !== undefined) {
          // 2026-10-26 三期历史链:尾窗播种(服务端缺省 200)元数据入态——后台加载链(下方 effect)消费
          next = { ...next, history: { total: snap.total ?? snap.messages.length, oldestSeq: snap.oldestSeq ?? 0, hasMore: snap.hasMore === true, complete: snap.hasMore !== true } };
        }
        for (const f of pendingRef.current) {
          if (f.seq > snap.lastSeq) next = applyChatEvent(next, f.e); // ≤ 切割序:种子已含,丢(双应用防线)
        }
        pendingRef.current = [];
        seedingRef.current = false;
        setSeeding(false);
        setChat(next);
        // G10 欢迎页接力:播种落定即提交 welcome 目标(一次性——done 回调清 App 态位)。
        // G14.51:先本地回显再提交——daemon 不广播 user 事件,接力目标不回显则运行全程不可见
        const pg = pendingGoalRef.current;
        if (pg !== null && pg.goal.trim() !== '') {
          pendingGoalRef.current = null;
          onPendingGoalDoneRef.current?.();
          // G14.213 走 submitText 单点(命令门控随行):欢迎页 /命令 目标建会话后按 supported
          // 清单走命令通道,skills/普通文本照文本提交——此前裸 sessionSubmit,/命令全成纯文本
          // 外层吞错属良性:submitText 内部已倒 error 条(失败可见),此处仅吸收 rejection 形态
          submitTextRef.current(pg.goal, pg.images).catch(() => undefined);
        }
        onSeededRef.current?.(snap); // G5:App 借快照取 team(每次 reseed 均回填——重播种即更新)
        // G7 挂起卡重建:快照 pending 段逐项(挂起中=status running,reseed 瞬态豁免保卡不误清);
        // plan-approval 分支=阶段三 plan-arm——快照挂起行 req={doc,items},reseed 后 PlanCard 复现
        for (const row of snap.pending ?? []) {
          if (typeof row?.pid !== 'string' || row.pid.length === 0) continue;
          if (row.kind === 'approval') addCard({ kind: 'approval', pid: row.pid, req: (row.req ?? {}) as GuiApprovalReq });
          else if (row.kind === 'ask') addCard({ kind: 'ask', pid: row.pid, req: (row.req ?? {}) as GuiAskReq });
          else if (row.kind === 'plan-approval') addCard({ kind: 'plan-approval', pid: row.pid, req: (row.req ?? { doc: '', items: [] }) as GuiPlanApprovalReq });
        }
      },
      (err: unknown) => {
        if (seedGenRef.current !== gen) return;
        pendingRef.current = []; // 无基线可滤,弃窗内帧(重连 reset/再开页会全量重放补齐)
        seedingRef.current = false;
        setSeeding(false);
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
      },
    );
  }, [conn, sessionId, addCard]);

  /** G4 回执收口单点(2026-10-27 技术债轮 G8:approval/ask/plan 三通道同构块收敛):寻址用帧顶层
   *  pid(T1 契约);成功移卡,失败(404 已决等)也移——不悬挂。失败面不再倒 error 条:挂起生命周期
   *  以 daemon 挂起表为准,本地卡只是其投影 */
  const settle = useCallback(
    (p: Promise<unknown>, pid: string): void => {
      void p.then(
        () => removeCard(pid),
        () => removeCard(pid),
      );
    },
    [removeCard],
  );
  const sendApproval = useCallback(
    (pid: string, decision: string): void => {
      settle(conn.replyApproval(pid, decision), pid);
    },
    [conn, settle],
  );
  const sendAsk = useCallback(
    (pid: string, answer: GuiAskAnswer): void => {
      settle(conn.replyAsk(pid, answer), pid);
    },
    [conn, settle],
  );
  /** 阶段三 plan-arm 裁决回执:沿 approval/ask 回执通道同口径 */
  const sendPlanApproval = useCallback(
    (pid: string, decision: GuiPlanDecision): void => {
      settle(conn.replyPlanApproval(pid, decision), pid);
    },
    [conn, settle],
  );

  useEffect(() => {
    // G14.154 辅助对话首问:挂载即把携带的选区引用落输入框(仅一次)
    if (initialInsert !== undefined && initialInsert !== '') {
      setInput((prev) => (prev.trim() === '' ? `${initialInsert} ` : `${prev.replace(/\s+$/, '')} ${initialInsert} `));
    }
    const sink: ChatSink = {
      on: (e, seq) => {
        // G14.137 todo_write → 任务标签「会话待办」区上抛(清单全量替换语义)——G6 input 暂存
        // 两分支已随 P11 T7 字段单源退役(条目 name/input/result 由内核 reducer 直挂),本臂只余 todo 上抛
        if (e.type === 'tool-call') {
          const cid = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
          if (cid !== '' && (e.text ?? '') === 'todo_write' && onTodos !== undefined) {
            const raw = e.payload?.input;
            const input = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
            const arr = input.todos;
            if (Array.isArray(arr)) {
              const items = arr
                .filter((o) => o !== null && typeof o === 'object')
                .map((o) => o as { text?: unknown; status?: unknown })
                .filter((o) => typeof o.text === 'string' && typeof o.status === 'string')
                .map((o) => ({ text: o.text as string, status: o.status as TodoItem['status'] }));
              onTodos(items);
            }
          }
        }
        if (e.type === 'queue') {
          // P5 等待队列变更帧(spec §12):payload.items=全量列表权威态,实时回显替代轮询
          // (done 帧 double-refresh 退役——轮收束消费/回队走内核 ops,帧随发);播种窗内亦直投
          // (reseed 快照是初始权威,后至帧恒更新)
          const arr = e.payload?.items;
          if (Array.isArray(arr)) {
            setQueued(
              arr
                .filter((o) => o !== null && typeof o === 'object')
                .map((o) => o as { seq?: unknown; text?: unknown; images?: unknown })
                .filter((o) => typeof o.text === 'string' && typeof o.seq === 'number')
                // images 随行透传(2026-10-26 图片附件):队列行小图与「放回输入框」回填数据源
                .map((o) => ({
                  seq: o.seq as number,
                  text: o.text as string,
                  ...(Array.isArray(o.images) && o.images.length > 0 && o.images.every((x) => typeof x === 'string') ? { images: o.images as string[] } : {}),
                })),
            );
          }
          return; // 队列面事件不入转录投影(applyChatEvent 有守卫,此为省一趟)
        }
        if (seedingRef.current) {
          pendingRef.current.push({ e, seq }); // 种子在途:缓冲不投(直投会被种子整替清掉)
          return;
        }
        setChat((c) => applyChatEvent(c, e));
      },
      reset: () => reseed(),
      onApproval: (pid, req) => addCard({ kind: 'approval', pid, req }),
      onAsk: (pid, req) => addCard({ kind: 'ask', pid, req }),
      onPlanApproval: (pid, req) => addCard({ kind: 'plan-approval', pid, req }),
      resetSession: () => {
        setCards([]); // daemon reset 已 deny/dismissed 回填该会话全部挂起——本地卡随之清
        reseed();
      },
    };
    sinkRef.current = sink;
    reseed();
    return () => {
      sinkRef.current = null;
      flushScrollMem(); // G14.212 滚动位存档落盘(节流尾随写外的兜底)
      pendingRef.current = []; // unmount 清缓冲(组件销毁,无跨会话残留)
      seedGenRef.current++; // G6 终审首优先(G7 落地):在途快照应答的 then 回调经 gen 失配早退——
      // 防 backHome→重开窗口内陈旧会话快照经 onSeeded 污染 App 态(team/board——旧板落新壳)
    };
  }, [sinkRef, reseed, addCard]);

  /** 2026-10-26 三期历史链(先上车再补票):尾窗播种落定即自动分段补更老——一页一 effect 轮
   *  (页成 history 换新重触发),失败退避三试置 failed(指示器可点重试重启);freshView 不补
   *  (全新视图历史不落屏);Chat 按 sessionId 重挂=切走即暂停,切回断点续跑 */
  useEffect(() => {
    const h = deps.chat.history;
    if (h === undefined || h.complete || h.failed === true || deps.freshView === true) return;
    let alive = true;
    const step = async (): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const page = await conn.sessionSnapshot(sessionId, { before: h.oldestSeq, limit: 600 }).catch(() => undefined);
        if (!alive) return;
        if (page !== undefined) {
          setChat((c) => prependSeed(c, page.messages, { oldestSeq: page.oldestSeq ?? 0, hasMore: page.hasMore === true }));
          return; // history 换新重触发本 effect(下一页)
        }
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        if (!alive) return;
      }
      setChat((c) => ({ ...c, history: c.history ? { ...c.history, failed: true } : c.history }));
    };
    void step();
    return () => { alive = false; };
  }, [deps.chat.history, conn, sessionId, deps.freshView]);

  /** G5 idle 清卡:status 经 running→idle 转换(run 收束——daemon 已对本 run 挂起 deny 回填)
   *  时置空本地卡列表;reseed 落定的 idle 快照亦经此路径(挂起已回填,不重建——见文件头裁定) */
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = chat.status;
    if (prev !== null && prev !== 'idle' && chat.status === 'idle') setCards([]);
  }, [chat.status]);

  return { cards, seeding, sendApproval, sendAsk, sendPlanApproval };
}
