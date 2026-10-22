import { useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { createConnection, type ConnectionState, type Connection } from './connection';
import type { SessionEvent } from '../../src/types';
import type { AgentActivities } from './tabs/agent-activity';
import { applyAgentEvent } from './tabs/agent-activity';
import { applyBoardEvent, applyDelegation, emptyBoard, boardEventFrom, type SessionProjection } from './projection';
import type { ChatSink } from './pages/Chat';

/** D34 串态收口的投影空态(D42 自 App.tsx 随连接装配迁入导出——openSession/backHome 清零与
 *  连接回调 onReset/onResetSession 整替共此一口径) */
export const EMPTY_PROJECTION = (): SessionProjection => ({ board: emptyBoard(), sessionTodos: [], delegations: [], team: [] });

/** 连接装配依赖面(D42 外提):路由/投影回调闭包取首渲染值(装配一次 []),会话切换经
 *  sessionRef/各 ref 免闭包陈旧——与原 AppShell 内联 effect 同口径 */
export interface ConnectionWiringDeps {
  sessionRef: MutableRefObject<string>;
  chatSinkRef: MutableRefObject<ChatSink | null>;
  sideSinksRef: MutableRefObject<Map<string, MutableRefObject<ChatSink | null>>>;
  boardPendingRef: MutableRefObject<Array<{ e: SessionEvent; seq: number }>>;
  boardSeedingRef: MutableRefObject<boolean>;
  shadowHydrateRef: MutableRefObject<((sessionId: string) => void) | null>;
  shadowHydratedRef: MutableRefObject<Set<string>>;
  shadowHydratingRef: MutableRefObject<Set<string>>;
  shadowBufRef: MutableRefObject<Map<string, Array<{ e: SessionEvent; seq: number }>>>;
  connRef: MutableRefObject<Connection | null>;
  reopenBoardSeedWindow: () => void;
  bumpActs: (sessionId: string, fold: (a: AgentActivities) => AgentActivities) => void;
  setRecentVersion: Dispatch<SetStateAction<number>>;
  setRunningIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setProjection: Dispatch<SetStateAction<SessionProjection>>;
  setTodoBatches: Dispatch<SetStateAction<import('./pages/Chat').TodoBatch[]>>;
  setTurnGoal: Dispatch<SetStateAction<string>>;
  setConnState: Dispatch<SetStateAction<ConnectionState>>;
}

/**
 * 单连接装配（D42 自 App.tsx 钩子化，行搬运零逻辑变化）：createConnection 一次装配（[]），
 * onEvent 单 WS 收全会话帧（sessionRef 判据过滤他会话——本会话帧经 chatSinkRef 转投 Chat；
 * task/gate 走板投影 seq 门、delegation 双投板面+子智能体桶、subagent 另轨影子截流），
 * onReset 清投影+播种窗重开+影子重水合，G4 挂起面经 sessionRef 过滤转投。卸载 close+清
 * connRef/实例。
 */
export function useConnectionWiring(deps: ConnectionWiringDeps): Connection | null {
  const [connInstance, setConnInstance] = useState<Connection | null>(null);
  useEffect(() => {
    const {
      sessionRef, chatSinkRef, sideSinksRef, boardPendingRef, boardSeedingRef,
      shadowHydrateRef, shadowHydratedRef, shadowHydratingRef, shadowBufRef, connRef,
      reopenBoardSeedWindow, bumpActs, setRecentVersion, setRunningIds, setProjection,
      setTodoBatches, setTurnGoal, setConnState,
    } = deps;
    const conn = createConnection({
      baseUrl: import.meta.env.VITE_SERVE_URL ?? location.origin,
      onEvent: (sessionId, e: SessionEvent, seq: number) => {
        if (e.type === 'model-start' || e.type === 'done') setRecentVersion((v) => v + 1); // G14.52:run 起跑/收束都刷侧栏(运行圆点亮起与熄灭跟手)
        // G14.2xx 运行态按会话记:任一会话起跑点亮其行;收束只熄自己(跨会话切换/恢复不误熄不卡转圈)
        if (e.type === 'model-start') setRunningIds((s) => (s.has(sessionId) ? s : new Set([...s, sessionId])));
        else if (e.type === 'done' || e.type === 'error') setRunningIds((s) => (s.has(sessionId) ? new Set([...s].filter((x) => x !== sessionId)) : s));
        if (sessionId !== sessionRef.current) {
          // G14.29 辅助会话帧:只投旁路聊天流(板/委派/子智能体投影不涉旁路,丢弃)
          if (typeof e.payload?.subagent !== 'string') sideSinksRef.current.get(sessionId)?.current?.on(e, seq);
          return;
        }
        if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
          // G6 seq 门:播种窗内缓冲(onSeeded 后过滤重放),窗外直投
          if (boardSeedingRef.current) boardPendingRef.current.push({ e, seq });
          else setProjection((p) => ({ ...p, board: applyBoardEvent(p.board, boardEventFrom(e)) }));
          return;
        }
        if (e.type.startsWith('delegation-')) {
          if (boardSeedingRef.current) boardPendingRef.current.push({ e, seq });
          else {
            setProjection((p) => ({ ...p, delegations: applyDelegation(p.delegations, e) }));
            // G8d:delegation 起止无 subagent 标签——payload.label 命中既有卡才改状态(Runner 权威
            // 终语:ended failed → error·done → done;未建卡原引用返回,React 同引用即免重渲染)
            bumpActs(sessionId, (a) => applyAgentEvent(a, e));
          }
        }
        if (typeof e.payload?.subagent === 'string') {
          // G14.2xx b 影子水合在途:subagent 帧截流缓冲(落定按 seq>cut 重放)——防清零重放丢在途帧
          const buf = shadowBufRef.current.get(sessionId);
          if (shadowHydratingRef.current.has(sessionId) && buf !== undefined) {
            buf.push({ e, seq });
            return;
          }
          // G8d 子智能体事件另轨(Agents 标签聚合):不投 chat——chat reducer 入口另有同判过滤兜底
          // (种子重放等路径仍过 reducer,零害保留);建卡/行化/水位在此单点归约
          bumpActs(sessionId, (a) => applyAgentEvent(a, e));
          return;
        }
        chatSinkRef.current?.on(e, seq);
      },
      onReset: () => {
        // 重连/首连同路径:板/委派投影清零 + 播种窗重开(随补发帧经 onSeeded 过滤重放;Chat 投影
        // 由 sink.reset 清+本会话重播种;welcome 无 sink 时帧被会话过滤,窗恒空悬挂至下次 openSession)
        reopenBoardSeedWindow();
        setProjection(EMPTY_PROJECTION()); // D34 串态收口:board/todos/delegations/team 一处整替
        setTodoBatches([]);
        setTurnGoal('');
        if (sessionRef.current !== '') bumpActs(sessionRef.current, () => ({})); // G8d:仅当前会话桶清零(重连影子水合重建;他会话缓存不动)
        chatSinkRef.current?.reset();
        // G14.2xx b 重连影子重水合:WS 回放已不含 shadow 帧(环窗溢出+回放面跳过,恢复唯一入口=
        // journal 水合),清零后对在座会话即刻拉取重建(在座会话切走再回/重连同路径)
        if (sessionRef.current !== '') {
          shadowHydratedRef.current.delete(sessionRef.current);
          shadowHydrateRef.current?.(sessionRef.current);
        }
      },
      // G4 挂起面装配:连接层回调闭包固定,经 sessionRef 过滤本会话后转投 Chat sink(卡片区);
      //  他会话挂起卡不显(本会话外无渲染面),他会话 reset 不触发重播种
      onApproval: (sessionId, pid, req) => {
        if (sessionId !== sessionRef.current) {
          sideSinksRef.current.get(sessionId)?.current?.onApproval(pid, req);
          return;
        }
        chatSinkRef.current?.onApproval(pid, req);
      },
      onAsk: (sessionId, pid, req) => {
        if (sessionId !== sessionRef.current) {
          sideSinksRef.current.get(sessionId)?.current?.onAsk(pid, req);
          return;
        }
        chatSinkRef.current?.onAsk(pid, req);
      },
      onResetSession: (sessionId) => {
        if (sessionId !== sessionRef.current) {
          sideSinksRef.current.get(sessionId)?.current?.resetSession();
          return;
        }
        // G3.5 交接 d 收口(G5):会话维 reset 清 board/delegations 投影(仅连接级 onReset 清的缺口
        //  ——会话 reset 后旧任务悬挂)+ 播种窗重开清缓冲(窗内帧属旧板,弃);Chat 卡区清+重播种经 sink
        reopenBoardSeedWindow();
        setProjection(EMPTY_PROJECTION()); // D34 串态收口:sessionTodos 漏清三处之一随收口补齐(纪律落实)
        setTodoBatches([]);
        setTurnGoal('');
        if (sessionRef.current !== '') bumpActs(sessionRef.current, () => ({})); // G8d:会话维 reset 清当前桶(swap 新 Harness,旧卡作废)
        chatSinkRef.current?.resetSession();
      },
      onStateChange: setConnState,
    });
    connRef.current = conn;
    setConnInstance(conn);
    return () => {
      connRef.current = null;
      setConnInstance(null);
      conn.close();
    };
    // 装配一次:回调闭包固定取首渲染值,可变面全经 ref 转发(原 AppShell 内联 effect 同口径)
  }, []);
  return connInstance;
}
