import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import type { ChatState } from '../../chat-reducer';

/** 模型 pill 与上下文圆环数据面(D32 第六批批F-6 自 Chat.tsx 平移,行为零变化):sessionModel
 *  挂载拉取/sessionContext 四路触发(挂载/idle 收尾/运行中 4s 轮询/悬停展开)/run 轮数计数。 */
export function useChatSessionInfo(deps: {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly chat: ChatState;
}): {
  modelInfo: { current?: string; choices: Array<{ id: string; model: string; effort?: string }> } | null;
  setModelInfo: Dispatch<SetStateAction<{ current?: string; choices: Array<{ id: string; model: string; effort?: string }> } | null>>;
  ctxInfo: { total: number; window: number; parts: Array<{ id: string; tokens: number; count: number }> } | null;
  refreshCtx: () => void;
  runCount: number;
} {
  const { conn, sessionId, chat } = deps;
  const [modelInfo, setModelInfo] = useState<{ current?: string; choices: Array<{ id: string; model: string; effort?: string }> } | null>(null);
/** 模型 pill 数据源(G10-C4):挂载即拉(choices 空=不可切,钮隐藏) */
useEffect(() => {
  conn.sessionModel(sessionId).then(
    (info) => setModelInfo({ current: info.current, choices: info.choices }),
    () => setModelInfo({ choices: [] }),
  );
}, [conn, sessionId]);

/** G14.18 上下文圆环数据:sessionContext 拉取单点——挂载/run 收尾(status 回 idle)/运行中
 *  4s 轮询/悬停展开(圆环 onOpen)四路触发;失败静默保旧值(圆环退化为 0 占用不扰流区)。
 *  G14.21 parts 透传:上下文构成逐段明细(弹层组成面) */
const [ctxInfo, setCtxInfo] = useState<{ total: number; window: number; parts: Array<{ id: string; tokens: number; count: number }> } | null>(null);
const refreshCtx = useCallback((): void => {
  if (typeof conn.sessionContext !== 'function') return;
  conn.sessionContext(sessionId).then(
    (b) => setCtxInfo({ total: b.total, window: b.window, parts: b.parts ?? [] }),
    () => undefined,
  );
}, [conn, sessionId]);
useEffect(() => {
  setCtxInfo(null);
  refreshCtx();
}, [refreshCtx]);
useEffect(() => {
  if (chat.status !== 'idle') return; // run 收尾刷新(运行中由下方轮询与悬停面覆盖)
  refreshCtx();
}, [chat.status, refreshCtx]); // eslint-disable-line react-hooks/exhaustive-deps -- status 回 idle 即轮尾信号
useEffect(() => {
  if (chat.status !== 'running') return;
  const iv = setInterval(refreshCtx, 4000);
  return () => clearInterval(iv);
}, [chat.status, refreshCtx]);
/** 会话任务轮数(run 条计数——圆环弹层「轮次」;回放种子条同口径) */
const runCount = chat.entries.reduce((n, e) => (e.kind === 'run' ? n + 1 : n), 0);
  return { modelInfo, setModelInfo, ctxInfo, refreshCtx, runCount };
}
