import { SessionEvent } from '../types';

/** 活任务阶段（瞬态不落 journal，规格 §4）：idle=无任务、thinking=等待首 token/动作、responding=正文流式中、tool-pending=有未决调用、tool-awaiting=审批挂起 */
export type LiveTaskPhase = 'idle' | 'thinking' | 'responding' | 'tool-pending' | 'tool-awaiting';

export interface ActiveCall {
  callId: string;
  verb: string;
  startedAt: number;
}

export interface LiveTaskState {
  phase: LiveTaskPhase;
  activeCalls: ActiveCall[];
}

export function initialTaskState(): LiveTaskState {
  return { phase: 'idle', activeCalls: [] };
}

/** 事件流→活任务状态（单点纯函数，规格 §4.2）：只消费三态相关事件，其余零扰动返回原引用 */
export function applyTaskState(s: LiveTaskState, e: SessionEvent): LiveTaskState {
  switch (e.type) {
    case 'model-start':
      return { phase: 'thinking', activeCalls: [] };
    case 'token':
      return s.phase === 'responding' ? s : { ...s, phase: 'responding' };
    case 'tool-call': {
      const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
      if (callId.length === 0) return s;
      if (s.activeCalls.some((c) => c.callId === callId)) return { ...s, phase: 'tool-pending' };
      const call: ActiveCall = { callId, verb: e.text ?? '', startedAt: Date.now() };
      return { phase: 'tool-pending', activeCalls: [...s.activeCalls, call] };
    }
    case 'tool-result': {
      const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
      if (callId.length === 0) return s;
      const activeCalls = s.activeCalls.filter((c) => c.callId !== callId);
      if (activeCalls.length === s.activeCalls.length) return s;
      if (activeCalls.length > 0) return { ...s, activeCalls };
      return { phase: 'thinking', activeCalls };
    }
    case 'done':
    case 'error':
      return initialTaskState();
    default:
      return s;
  }
}
