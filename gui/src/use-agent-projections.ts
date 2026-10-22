import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { applyAgentEvent } from './tabs/agent-activity';
import type { AgentActivities } from './tabs/agent-activity';
import type { SessionEvent } from '../../src/types';
import type { Connection } from './connection';
import type { ChatState } from './chat-reducer';

const ACTS_LRU_MAX = 8;
const CHAT_MEM_LRU_MAX = 4;

/**
 * 子智能体投影域三件（D42 自 App.tsx 钩子化，行搬运零逻辑变化）：
 * ①按会话分桶的活动聚合（LRU 有界）；②转录内存缓存（Chat 卸载写回/重挂直渲）；
 * ③影子水合（journal 全量清零重放 + 在途帧 seq 缓冲截流）。onEvent 路由面与触发点
 * 消费四 ref 原样（App.tsx 持有解构），水合单点每渲染重赋闭包（恒取最新连接实例）。
 */

/** G8d 子智能体活动聚合(App 态):payload.subagent 标签流经 applyAgentEvent 归约——Agents 标签
 *  只读消费(services.agentActivities);delegation 起止 label 命中既有卡时改状态(权威终语)。
 *  G14.2xx b 按会话分桶(外层键=sessionId):切会话不清零——内存缓存直接命中(切回零拉取零
 *  重建,标签撞名也不串态);刷新/重连后由影子水合从 journal 重建 */
export function useAgentBuckets(): {
  agentActivitiesBySession: Record<string, AgentActivities>;
  bumpActs: (sessionId: string, fold: (a: AgentActivities) => AgentActivities) => void;
} {
  const [agentActivitiesBySession, setAgentActivitiesBySession] = useState<Record<string, AgentActivities>>({});
  /** 子智能体桶 LRU 触碰序(上限 ACTS_LRU_MAX=8):最近使用的会话桶保留,久不用的淘汰——内存有界 */
  const actsLRURef = useRef<string[]>([]);
  /** 子智能体桶统一写入口:LRU 触碰 + 淘汰超限桶(非当前会话);fold=对桶的纯归约 */
  const bumpActs = useCallback((sessionId: string, fold: (a: AgentActivities) => AgentActivities): void => {
    const lru = actsLRURef.current.filter((k) => k !== sessionId);
    lru.push(sessionId);
    actsLRURef.current = lru;
    setAgentActivitiesBySession((m) => {
      const next: Record<string, AgentActivities> = {};
      for (const k of lru) {
        if (lru.length > ACTS_LRU_MAX && k === lru[0]) continue; // 最旧且超限:淘汰
        next[k] = m[k] ?? {};
      }
      next[sessionId] = fold(m[sessionId] ?? {});
      return next;
    });
  }, []);
  return { agentActivitiesBySession, bumpActs };
}

/** G14.2xx b 转录内存缓存(LRU 4 会话):Chat 卸载时写回最新投影,重挂载即以缓存态直渲
 *  (stale-while-revalidate——先见缓存转录,快照播种落定无缝整替校准),切会话回来不再白屏等
 *  快照往返。键=journalId(跨重启稳定)。内核条目引用跨快照共享,单会话转录条目 ≤2000 条,
 *  4 会话上限内存有界;同会话反复进出只触碰 LRU 不复制 */
export function useChatMemory(): {
  chatMemGet: (key: string) => ChatState | undefined;
  chatMemPut: (key: string, state: ChatState) => void;
} {
  const chatMemRef = useRef<Map<string, ChatState>>(new Map());
  const chatMemLRURef = useRef<string[]>([]);
  const chatMemGet = useCallback((key: string): ChatState | undefined => {
    const hit = chatMemRef.current.get(key);
    if (hit !== undefined) chatMemLRURef.current = [...chatMemLRURef.current.filter((k) => k !== key), key];
    return hit;
  }, []);
  const chatMemPut = useCallback((key: string, state: ChatState): void => {
    chatMemRef.current.set(key, state);
    const lru = chatMemLRURef.current.filter((k) => k !== key);
    lru.push(key);
    while (lru.length > CHAT_MEM_LRU_MAX) {
      const evict = lru.shift();
      if (evict !== undefined) chatMemRef.current.delete(evict);
    }
    chatMemLRURef.current = lru;
  }, []);
  return { chatMemGet, chatMemPut };
}

/** G14.2xx b 影子水合(子智能体投影恢复):journal subagent 行全量拉取清零重放——WS 环窗(512)
 *  对长会话子智能体流必溢出且连接建立常先于会话 attach,刷新/重连后「无活动记录」的病根。
 *  在途 subagent 帧按 seq 缓冲截流,落定后重放 seq>cut(服务端读档时刻泵水位)——cut 前已含
 *  于行集,cut 后只在缓冲,零丢帧零重复。board/delegation 不走此路(快照携带+attach seedShadow
 *  既有可靠链),避免与播种窗交叉。connInstance 参随渲染进新闭包——水合单点每渲染重赋 ref。 */
export function useShadowHydration(
  bumpActs: (sessionId: string, fold: (a: AgentActivities) => AgentActivities) => void,
  connInstance: Connection | null,
): {
  shadowHydrateRef: MutableRefObject<((sessionId: string) => void) | null>;
  shadowHydratedRef: MutableRefObject<Set<string>>;
  shadowHydratingRef: MutableRefObject<Set<string>>;
  shadowBufRef: MutableRefObject<Map<string, Array<{ e: SessionEvent; seq: number }>>>;
} {
  const shadowHydratingRef = useRef<Set<string>>(new Set());
  const shadowHydratedRef = useRef<Set<string>>(new Set());
  /** 在途缓冲按会话分桶(并发水合互踩防线——A 在途时切 B,B 的清桶不得冲掉 A 的在途帧) */
  const shadowBufRef = useRef<Map<string, Array<{ e: SessionEvent; seq: number }>>>(new Map());
  /** 影子子智能体帧判定(与内核 shadow 透传同口径的子智能体子集) */
  const shadowHydrateRef = useRef<((sessionId: string) => void) | null>(null);
  /** G14.2xx b 影子水合单点:journal subagent 行全量清零重放 + 在途缓冲 seq>cut 重放(每渲染
   *  重赋 ref——闭包恒取最新 connInstance;onReset/会话打开 effect 经 ref 触发) */
  shadowHydrateRef.current = (sessionId: string): void => {
    if (connInstance === null) return;
    if (shadowHydratingRef.current.has(sessionId)) return; // 在途幂等
    shadowHydratingRef.current.add(sessionId);
    shadowBufRef.current.set(sessionId, []);
    const buf = (): Array<{ e: SessionEvent; seq: number }> => shadowBufRef.current.get(sessionId) ?? [];
    const fold = (acts: AgentActivities, e: SessionEvent): AgentActivities =>
      // delegation 行一并入折(journal 有档——delegation-ended 终语对卡状态的影响随重建保留)
      typeof e.payload?.subagent === 'string' || e.type.startsWith('delegation-') ? applyAgentEvent(acts, e) : acts;
    void connInstance.shadowEvents(sessionId).then(
      ({ events, cut }) => {
        let acts: AgentActivities = {};
        for (const e of events) acts = fold(acts, e); // journal 全量(到读档时刻)
        for (const { e, seq } of buf()) {
          if (seq > cut) acts = fold(acts, e); // 读档后到达的帧只在缓冲
        }
        shadowBufRef.current.delete(sessionId);
        shadowHydratingRef.current.delete(sessionId);
        // 按会话桶整替(只覆本会话,他桶内存缓存不动)
        bumpActs(sessionId, () => acts);
      },
      () => {
        // 拉取失败(daemon 未附/旧版无端点):摘标记放行实时帧直投并允许下次触发点重试
        shadowBufRef.current.delete(sessionId);
        shadowHydratingRef.current.delete(sessionId);
        shadowHydratedRef.current.delete(sessionId);
      },
    );
  };
  return { shadowHydrateRef, shadowHydratedRef, shadowHydratingRef, shadowBufRef };
}
