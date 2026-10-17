import type { SessionEvent } from '../../src/types';
import { applyEvent, applySeed, initialKernelState, type KernelEntry, type KernelState } from '../../src/session/entry';

/**
 * G3 chat 投影 → P4 内核视图层(session-kernel spec §6 P4):事件→转录的投影逻辑全数退役,
 * 本模块改为「同一内核 reducer(applyEvent 全仓唯一实现)+ 纯视图映射」——GUI 本地内嵌内核态,
 * 喂 WS 原始帧(零 wire 改动);快照装载=内核 seed(snapshot.messages 已是内核条目,P2)。
 *
 * 内核承载:token 流式段聚合、reasoning 思考段计秒、tool call/result 双向配对(乱序 FIFO)、
 * done 终稿合并、run 条与 runmeta 对位、子代理零条目——formerly chat-reducer 自建三件套。
 * 视图层保留:status-bar 计数器(tokens/steps/cache 轮水位,会话统计非转录)、run 起点基线
 * (G14.63「本轮」口径减数)、notice 显示过滤(G14.90/G14.106——内核忠实归档,渲染面裁定)、
 * partial-seed 流式派生(G14.51 快照竞态收口)。
 *
 * 裁定记录:
 * - delegation-started/ended 不再产条目(G14.213 状态提示不显示,内核语义;委派可见性归委派徽标/Agents 页)。
 * - entry key 统一 `k<seq>`;callId 直挂条目(`tool:${callId}` key 编码解码退役)。
 * - 物化映射以 WeakMap 保持未变条目的引用身份(token 逐 delta 重映射不触发全列重渲)。
 */

/** 对话流条目（md 原文；kind 样式钩子在渲染面，streaming=true 流式光标态；ts 日期分隔投影源）。
 *  P4 起=内核条目的视图形（映射自 KernelEntry,字段语义不变） */
export interface ChatEntry {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error' | 'thinking' | 'run';
  md: string;
  streaming?: boolean;
  /** thinking 专用：段耗时秒（内核封段计首尾 ts 差） */
  seconds?: number;
  /** 条目时间（epoch ms;内核条目 ts 直映） */
  ts?: number;
  /** P4:tool 条 callId 直挂（fetchDiff 寻址;旧 key 编码退役） */
  callId?: string;
  /** G14.63 run 专用:轮起点基线(会话累计 steps/tokens)——运行状态行「本轮」口径的减数 */
  stepsBase?: number;
  tokensBase?: number;
  /** run 专用（G11 状态行）：封段统计——meta 映射(steps=runSteps 优先,「本轮」口径) */
  steps?: number;
  tokens?: number;
  /** run 专用：收段时刻 */
  endedTs?: number;
  /** G14.209 run 专用:停止态(中断/失败收口——运行条显「已停止」不显时长) */
  stopped?: boolean;
  /** G14.100 run 专用:本轮 git 变动增量(轮尾汇总条;撤销面按 path 寻址) */
  changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>;
}

/** chat 投影状态：内核态 + 物化视图条目 + 状态栏三指标 */
export interface ChatState {
  /** 内核态(P4):事件→转录投影唯一实现(src/session/entry) */
  k: KernelState;
  entries: ChatEntry[];
  status: 'idle' | 'running';
  /** 会话累计 tokens（usage 事件续推；seed 自 run meta 求和） */
  tokens: number;
  steps: number;
  /** 会话累计 prompt 缓存命中 tokens（usage.cacheHitTotal 续推） */
  cacheTokens: number;
  /** 内部记账（勿消费）：当前 run 的 usage.turnTotal 水位——run 边界重置；tokens 增量基线 */
  turnTokensBase?: number;
  /** 内部记账（勿消费）：当前 run 的 cacheHitTotal 水位——run 边界重置 */
  turnCacheBase?: number;
  /** 内部记账（勿消费）：run-open 基线（seq → 当时累计 steps/tokens）——open run 条「本轮」减数 */
  runBases: Record<number, { steps: number; tokens: number }>;
}

export function initialChatState(): ChatState {
  return { k: initialKernelState(), entries: [], status: 'idle', tokens: 0, steps: 0, cacheTokens: 0, turnTokensBase: 0, turnCacheBase: 0, runBases: {} };
}

/** snapshot.messages 载荷形态（gui 侧契约声明;P2 起即内核条目形,meta 对位 RunMeta） */
export interface SnapshotTranscriptEntry {
  seq: number;
  ts?: number;
  kind: ChatEntry['kind'];
  md: string;
  callId?: string;
  name?: string;
  input?: Record<string, unknown>;
  seconds?: number;
  meta?: {
    seconds?: number;
    steps?: number;
    runSteps?: number;
    tokens?: number;
    cacheTokens?: number;
    endedTs?: number;
    stopped?: boolean;
    changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null; newLines?: number }>;
  };
}

/** 视图映射缓存:内核条目不可变,派生标(流式/基线)不变即复用视图对象——token 逐 delta 重映射
 *  只换变动的末段条目,未变行引用身份保持(渲染面 memo 不破) */
const viewCache = new WeakMap<KernelEntry, { sig: string; view: ChatEntry }>();

/** G14.90/G14.106 显示过滤(内核忠实归档,渲染面裁定):ask 回执行/memory 索引漂移行不渲染 */
function noticeHidden(md: string): boolean {
  return /^ask p\S+ answered$/.test(md) || md.startsWith('[memory] index changed');
}

/** 内核态 → 视图条目(纯映射):key=`k<seq>`;streaming=openSeg/openRun 派生(§3.1b 派生态);
 *  run meta→view 字段(steps=runSteps 优先「本轮」口径)+open run 注入基线;delegation 已被内核滤除 */
function mapEntries(k: KernelState, runBases: Record<number, { steps: number; tokens: number }>): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const e of k.entries) {
    if (e.kind === 'notice' && noticeHidden(e.md)) continue;
    const open = e.kind === 'run' ? k.openRun === e.seq : k.openSeg === e.seq;
    const base = runBases[e.seq];
    const sig = `${open ? 'o' : '-'}|${e.kind === 'run' && base !== undefined ? 'b' : '-'}`;
    const hit = viewCache.get(e);
    if (hit !== undefined && hit.sig === sig) {
      out.push(hit.view);
      continue;
    }
    const view: ChatEntry = {
      key: `k${e.seq}`,
      kind: e.kind,
      md: e.md,
      ...(e.ts !== undefined && e.ts > 0 ? { ts: e.ts } : {}),
      streaming: open ? true : undefined, // 键恒在场(消费面 toMatchObject/条件渲染两相宜)
      ...(e.seconds !== undefined ? { seconds: e.seconds } : {}),
      ...(e.callId !== undefined ? { callId: e.callId } : {}),
    };
    if (e.kind === 'run') {
      const m = e.meta;
      if (m !== undefined) {
        view.steps = m.runSteps ?? m.steps; // G14.56:「本轮」口径优先,旧档回退累计
        if (m.tokens !== undefined) view.tokens = m.tokens;
        if (m.seconds !== undefined) view.seconds = m.seconds;
        if (m.stopped === true) view.stopped = true;
        if (m.endedTs !== undefined && m.endedTs > 0) view.endedTs = m.endedTs;
        if (m.changes !== undefined && m.changes.length > 0) view.changes = m.changes;
      }
      if (base !== undefined) {
        view.stepsBase = base.steps;
        view.tokensBase = base.tokens;
      }
    }
    viewCache.set(e, { sig, view });
    out.push(view);
  }
  return out;
}

/** 用户提交的本地回显条（合成 user 事件入核——HTTP 提交路径 daemon 不产 user 帧,G14.89 同口径;
 *  resync 后由快照条取代） */
export function appendUserMessage(s: ChatState, text: string, ts?: number): ChatState {
  return applyChatEvent(s, { type: 'user', text, ts: ts ?? Date.now() });
}

/** onResync 基线：snapshot.messages（内核条目）直 seed——转录投影零推导;计数器自 run meta 求和
 *  （G14.18:回放会话累计不从零起）;G14.51 partial-run 流式派生保留（running 且末 run 无 meta=在途,
 *  末 run+尾随部分段标流式,done 到达不裂段） */
export function seedChatFromSnapshot(messages: readonly SnapshotTranscriptEntry[], status: 'idle' | 'running'): ChatState {
  let tokens = 0;
  let steps = 0;
  let cacheTokens = 0;
  let lastRunOpen = false; // 末个 run 条是否在途(无 meta=未收段);无 run 条=false
  for (const m of messages) {
    if (m.kind !== 'run') continue;
    lastRunOpen = m.meta === undefined;
    if (m.meta === undefined) continue;
    tokens += m.meta.tokens ?? 0;
    steps = Math.max(steps, m.meta.steps ?? 0); // steps=会话累计口径,取末次覆盖值
    cacheTokens += m.meta.cacheTokens ?? 0;
  }
  const s: ChatState = { k: applySeed(initialKernelState(), messages as unknown as ReadonlyArray<KernelEntry & { seq?: number }>), entries: [], status, tokens, steps, cacheTokens, turnTokensBase: 0, turnCacheBase: 0, runBases: {} };
  // G14.51 快照竞态收口:running 且末 run 在途(无 meta)→ 恢复内核游标(openRun/openSeg)——
  // 流式态由内核派生(非事后贴标),后续 token 并入部分段、done 合入同条不裂
  if (status === 'running' && lastRunOpen) {
    let runSeq = -1;
    for (let i = s.k.entries.length - 1; i >= 0; i -= 1) {
      const e = s.k.entries[i]!;
      if (e.kind === 'run') {
        runSeq = e.seq;
        break;
      }
    }
    if (runSeq >= 0) {
      const runIdx = s.k.entries.findIndex((e) => e.seq === runSeq);
      let partialSeq = -1;
      for (let i = s.k.entries.length - 1; i > runIdx; i -= 1) {
        const e = s.k.entries[i]!;
        if (e.kind === 'assistant' || e.kind === 'thinking') {
          partialSeq = e.seq;
          break;
        }
        if (e.kind === 'tool' || e.kind === 'user') break; // 段界:工具在途/轮首——其后无部分文本段
      }
      s.k = { ...s.k, openRun: runSeq, openSeg: partialSeq };
    }
  }
  return { ...s, entries: mapEntries(s.k, s.runBases) };
}

/** usage 会话累计：turnTotal 轮内增量并入（基线 model-start 重置）；无数值载荷不动。
 *  子代理用量（payload.subagent）不经此——内核入口已滤,计数器双保险再拦 */
function onUsage(s: ChatState, e: SessionEvent): ChatState {
  const turnTotal = e.payload?.turnTotal;
  if (typeof turnTotal !== 'number') return s;
  const base = s.turnTokensBase ?? 0;
  const delta = Math.max(0, turnTotal - base);
  // cacheHitTotal 与 turnTotal 同为 run 级单调累计——同基线法增量续推（端点无缓存回告恒 0）
  const cacheTotal = e.payload?.cacheHitTotal;
  const cacheBase = s.turnCacheBase ?? 0;
  const cacheDelta = typeof cacheTotal === 'number' ? Math.max(0, cacheTotal - cacheBase) : 0;
  if (delta === 0 && turnTotal === base && cacheDelta === 0 && cacheTotal === cacheBase) return s;
  return {
    ...s,
    tokens: s.tokens + delta,
    ...(cacheDelta > 0 ? { cacheTokens: s.cacheTokens + cacheDelta } : {}),
    turnTokensBase: turnTotal,
    ...(typeof cacheTotal === 'number' ? { turnCacheBase: cacheTotal } : {}),
  };
}

/** 事件面单点：内核归约(转录投影)+ 计数器归约会话统计 → 物化视图重映射。
 *  status: model-start 置 running(水位重置仅在 run 边界——model-start 每模型轮一次,run 内续轮
 *  不重置,否则多轮 run tokens 虚增)、done 回 idle;error 不动(G14.51:done 必发,收口让位) */
export function applyChatEvent(s: ChatState, e: SessionEvent): ChatState {
  if (typeof e.payload?.subagent === 'string') return s; // 子代理事件另轨(Agents 标签,G8d):主流零条目零计数
  if (e.type === 'queue') return s; // P5 队列面事件(UseSessionEvents 截收 setQueued):不入转录投影(防御——default 分支会把当边界误闭合开启段)
  const k = applyEvent(s.k, e);
  let next: ChatState = { ...s, k };
  switch (e.type) {
    case 'model-start': {
      if (s.status === 'idle') {
        // run-open 基线记账(G14.63「本轮」减数;openRun 即本轮新开 run 条)
        const bases = k.openRun >= 0 ? { ...s.runBases, [k.openRun]: { steps: s.steps, tokens: s.tokens } } : s.runBases;
        next = { ...next, status: 'running', turnTokensBase: 0, turnCacheBase: 0, runBases: bases };
      } else {
        next = { ...next, status: 'running' }; // run 内续轮:不重插 run 条、不重置水位(内核同语义)
      }
      break;
    }
    case 'done': {
      // 步数口径(G14.20 统一):done 载荷 steps=reactor 会话累计步数,直接采用;载荷缺面回落原值
      next = { ...next, status: 'idle', steps: typeof e.payload?.steps === 'number' ? e.payload.steps : s.steps };
      break;
    }
    case 'step':
      next = { ...next, steps: s.steps + 1 };
      break;
    case 'usage':
      next = onUsage(next, e);
      break;
    default:
      break;
  }
  // 零变化透传(内核态与计数器均未动——route/ctx 等空边界事件免重渲染)
  if (
    next.k === s.k &&
    next.status === s.status &&
    next.steps === s.steps &&
    next.tokens === s.tokens &&
    next.cacheTokens === s.cacheTokens &&
    next.turnTokensBase === s.turnTokensBase &&
    next.turnCacheBase === s.turnCacheBase &&
    next.runBases === s.runBases
  ) {
    return s;
  }
  return { ...next, entries: mapEntries(next.k, next.runBases) };
}
