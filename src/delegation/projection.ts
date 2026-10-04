import type { SessionEvent } from '../types';

/** 委派投影(spec 2026-10-04 §4.5):spawn/graph 节点/后台任务的统一生命周期投影。
 *  纯函数从 SessionEvent 流推导,零 TUI 依赖——GUI 同源消费点(任何订阅者 + 本 reducer 即可
 *  推导委派列表);会话侧瞬态不落 journal(与 LiveTaskState 同口径,归档面走消息区 SPAWN 行) */
export type DelegationKind = 'subagent' | 'background-task' | 'graph-node';
export type DelegationStatus = 'running' | 'done' | 'failed' | 'skipped' | 'paused';

export interface Delegation {
  id: string;
  kind: DelegationKind;
  label: string;
  status: DelegationStatus;
  startedAt: number;
  endedAt?: number;
  tokens?: number;
  reply?: string;
}

/** 发射侧载荷口径单点(spec §11:结构化,禁 ANSI/预渲染) */
export interface DelegationEventPayload {
  delegationId: string;
  kind: DelegationKind;
  label?: string;
  status?: 'done' | 'failed' | 'skipped' | 'paused';
  taskId?: string;
  nodeKind?: string;
  tokens?: number;
  reply?: string;
}

function payloadOf(e: SessionEvent): DelegationEventPayload | undefined {
  const p = e.payload as Partial<DelegationEventPayload> | undefined;
  if (typeof p?.delegationId !== 'string' || p.delegationId.length === 0) return undefined;
  if (p.kind !== 'subagent' && p.kind !== 'background-task' && p.kind !== 'graph-node') return undefined;
  return p as DelegationEventPayload;
}

/** 状态推导(纯):started 建条/幂等重发保留首起点;ended 收态、无宿主时合成终态条目
 *  (graph skipped 节点无 started 的真实形态);非委派事件原引用返回(零分配) */
export function applyDelegation(list: Delegation[], e: SessionEvent): Delegation[] {
  if (e.type !== 'delegation-started' && e.type !== 'delegation-ended') return list;
  const p = payloadOf(e);
  if (p === undefined) return list;
  const idx = list.findIndex((d) => d.id === p.delegationId);
  if (e.type === 'delegation-started') {
    const entry: Delegation = { id: p.delegationId, kind: p.kind, label: p.label ?? p.delegationId, status: 'running', startedAt: e.ts };
    if (idx < 0) return [...list, entry];
    const next = [...list];
    next[idx] = { ...entry, startedAt: list[idx]!.startedAt };
    return next;
  }
  const base: Delegation =
    idx >= 0
      ? list[idx]!
      : { id: p.delegationId, kind: p.kind, label: p.label ?? p.delegationId, status: 'running', startedAt: e.ts };
  const ended: Delegation = {
    ...base,
    status: p.status ?? 'done',
    endedAt: e.ts,
    ...(typeof p.tokens === 'number' ? { tokens: p.tokens } : {}),
    ...(typeof p.reply === 'string' ? { reply: p.reply } : {}),
  };
  const next = [...list];
  if (idx >= 0) next[idx] = ended;
  else next.push(ended);
  return next;
}
