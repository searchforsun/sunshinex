import type { ChangeFile, SessionEvent } from '../types';

/**
 * SessionKernel 条目模型与纯 reducer(spec 2026-10-17-session-kernel §3.3)。三份投影的并集语义
 * (tui/session · serve/transcript · gui/chat-reducer),差异处显式裁定:
 * - 段边界 = 非流内事件(token/reasoning/usage/step/ctx 之外的一切)——关闭开启中的 assistant/
 *   thinking 段(collector G14.213 语义);error 例外不封段(G14.51:done 必发,收口让位防裂段)。
 * - streaming 不入模型:开启中即流式中(state.openSeg/openRun 派生,§3.1b 词汇收缩内核侧)。
 * - reasoning 与 assistant 段顺序开闭(不交错)——真实事件流(思考先行)渲染等价,段行更规整。
 * - done 终答 mergeFinal(前缀重叠取长/否则补入,GUI 语义);与开启段同文不重复(collector ①b)。
 * - delegation-*、task-*、gate-* 不产条目(G14.213 状态提示不显示;board/delegation 另路投影)。
 * - notice 不做显示面过滤(G14.90/G14.106 是显示裁定,journal 审计面保留——过滤归消费方)。
 * - token 增量只进段聚合,不独立成条(§2 非目标:无 token 级日志)。
 */

/** run 收段统计(runmeta 行/帧对位;本体自 serve/session 上收内核,serve 侧 type re-export) */
export interface RunMeta {
  seconds?: number;
  /** 会话累计步数(done 载荷 steps,含种子链——圆环/侧栏口径) */
  steps?: number;
  /** 本轮自身步数(done 载荷 runSteps;旧档缺场 → 相邻累计差回退) */
  runSteps?: number;
  tokens?: number;
  cacheTokens?: number;
  endedTs?: number;
  /** 停止态(中断/失败收口)——回放运行条显「已停止」 */
  stopped?: boolean;
  /** 本轮 git 变动增量(轮尾汇总条) */
  changes?: ChangeFile[];
}

/** 内核转录条目(§3.3):段级、payload 完整随档——渲染端零推导 */
export interface KernelEntry {
  /** 全局单调序号(kernel 分配;truncate 截断后不复用) */
  seq: number;
  /** 源事件 ts(确定性:事件 sourced,不取 Date.now) */
  ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'thinking' | 'run' | 'notice' | 'error';
  md: string;
  /** tool:调用关联面(input 全量随档——折叠/图标/diff 寻址零推导) */
  callId?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** tool:结果回执(call/result 配对回填;text=观察行截断文本 + ok + full=全量观测——detail 展开与恢复面同源) */
  result?: { text: string; ok: boolean; full?: string };
  /** thinking:段耗时秒(封段时首尾 ts 差取整) */
  seconds?: number;
  /** run:收段统计(done 填基础面,runmeta 帧补全/覆盖) */
  meta?: RunMeta;
}

/** 会话统计面(P9 内核化,spec「数据同源,上层只渲染」):计数器口径唯一权威——
 *  usage.turnTotal 为 run 内单调累计(reactor per-request 全量值叠基线,跨帧覆盖幂等),
 *  水位差值法为正确语义(原 GUI 实现);子代理 usage 为 per-child run 累计,per-child 水位增量并入;
 *  step 计数排除 done 尾帧;ctx 水位 exact 采信/估算只上。TUI/GUI 只读渲染,不再各自累计 */
export interface SessionStats {
  /** 当前轮(最近 model-start)起点 ts;0=无在途轮 */
  turnStartedAt: number;
  turnTokens: number;
  turnCacheTokens: number;
  turnPromptTokens: number;
  turnChildTokens: number;
  sessionTotalTokens: number;
  sessionCacheTokens: number;
  sessionPromptTokens: number;
  sessionChildTokens: number;
  sessionSteps: number;
  sessionTurns: number;
  ctxUsed: number;
  ctxExact: boolean;
  /** 子代理 usage 水位(childId → 该 child 最近 turnTotal)——内部记账,渲染面勿消费 */
  childWatermarks: Record<string, number>;
}

export function zeroSessionStats(): SessionStats {
  return {
    turnStartedAt: 0, turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0,
    sessionTotalTokens: 0, sessionCacheTokens: 0, sessionPromptTokens: 0, sessionChildTokens: 0,
    sessionSteps: 0, sessionTurns: 0, ctxUsed: 0, ctxExact: false, childWatermarks: {},
  };
}

/** ctx 占用水位(原 TUI chat-model 单点上收):exact=true 端点真实 usage 直接采信(允许回落);
 *  exact=false 装配面估算,只允许向上预告 */
export function applyCtxWatermark(current: number, incoming: number, exact: boolean): number {
  if (!(incoming > 0)) return current;
  return exact ? incoming : Math.max(current, incoming);
}

/** 安静 notice 判定(P10 显示裁定单点):机制回执行(ask 回执/记忆索引漂移)对用户零信息量——
 *  内核忠实归档(journal 审计面保留),但 TUI/GUI 渲染面统一不显示。原 GUI 私有实现上收:
 *  两端同一裁定,防「同会话两端行数不同」分叉 */
export function isQuietNotice(md: string): boolean {
  return /^ask p\S+ answered$/.test(md) || md.startsWith('[memory] index changed');
}

/** 未配对 tool 旁挂记账(条目本体已在列,缺面由迟到者回填;同 collector PendingTool) */
interface PendingTool {
  /** 条目 seq(回填按位寻址) */
  seq: number;
  callId?: string;
  name: string;
  resultLine: string;
}

/** reducer 态:条目列 + 流式侧记账。openRun/openSeg = 开启中条目 seq(-1 无):run 跨 run 全程,
 *  正文/思考段轮内轮替——两游标独立,「开启中即流式中」的派生面。stats=会话统计面(P9,
 *  水位/计数唯一权威,变更经 kernel stats 事件外抛;seed 从 run meta 重建) */
export interface KernelState {
  entries: KernelEntry[];
  nextSeq: number;
  openRun: number;
  openSeg: number;
  pending: PendingTool[];
  stats: SessionStats;
}

export function initialKernelState(): KernelState {
  return { entries: [], nextSeq: 1, openRun: -1, openSeg: -1, pending: [], stats: zeroSessionStats() };
}

const CAP = 2000; // 档面上限(collector T5δ 同纪律:丢最老环形)
const PLACEHOLDER = '…';

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.length > 0 ? line : PLACEHOLDER;
}

/** tool 条 md 单点:`● <name>` + `⎿ <result 首行>` 两行;缺面 … 占位(v2 重放回填同用此形) */
export function toolMd(name: string, resultLine: string): string {
  return `● ${name}\n⎿ ${resultLine}`;
}

/** done 终稿合并(GUI 语义):互为前缀(重叠)取长;不重叠补入 */
function mergeFinal(acc: string, fin: string): string {
  if (acc === '') return fin;
  if (fin === '') return acc;
  if (fin.startsWith(acc) || acc.startsWith(fin)) return fin.length >= acc.length ? fin : acc;
  return acc + fin;
}

function replaceAt(entries: readonly KernelEntry[], idx: number, next: KernelEntry): KernelEntry[] {
  const copy = entries.slice();
  copy[idx] = next;
  return copy;
}

/** 入列单点:分配 seq、超限丢最老(被裁 tool 条同步退出 pending——防迟到回填死条目) */
function appendEntry(s: KernelState, entry: Omit<KernelEntry, 'seq'>): KernelState {
  const seq = s.nextSeq;
  let pending = s.pending;
  const entries = [...s.entries, { ...entry, seq }];
  if (entries.length > CAP) {
    const dropped = entries.shift();
    if (dropped !== undefined && dropped.kind === 'tool') pending = pending.filter((p) => p.seq !== dropped.seq);
  }
  return { ...s, entries, pending, nextSeq: seq + 1 };
}

/** 开启新段(已开启段先封;新段 seq 记入游标) */
function openSegEntry(s: KernelState, now: number, entry: Omit<KernelEntry, 'seq'>): KernelState {
  const sealed = sealSeg(s, now);
  const next = appendEntry(sealed, entry);
  return { ...next, openSeg: next.nextSeq - 1 };
}

/** 关闭开启中的 assistant/thinking 段(thinking 计秒;run 不在此封——done 专属) */
function sealSeg(s: KernelState, now: number): KernelState {
  if (s.openSeg < 0) return s;
  const idx = s.entries.findIndex((e) => e.seq === s.openSeg);
  if (idx < 0) return { ...s, openSeg: -1 };
  const cur = s.entries[idx]!;
  if (cur.kind !== 'assistant' && cur.kind !== 'thinking') return { ...s, openSeg: -1 };
  const seconds = cur.kind === 'thinking' && now > cur.ts ? Math.round((now - cur.ts) / 1000) : undefined;
  return { ...s, entries: replaceAt(s.entries, idx, { ...cur, ...(seconds !== undefined ? { seconds } : {}) }), openSeg: -1 };
}

/** runmeta changes 载荷净化(外部 payload 不予信任:面缺省回落、空 path 丢弃;v2 runmeta 行重放同用) */
export function sanitizeChanges(raw: unknown): ChangeFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChangeFile[] = [];
  for (const c of raw) {
    const o = (c ?? {}) as Partial<Record<keyof ChangeFile, unknown>>;
    if (typeof o.path !== 'string' || o.path === '') continue;
    out.push({
      path: o.path,
      status: (typeof o.status === 'string' ? o.status : 'modified') as ChangeFile['status'],
      added: typeof o.added === 'number' ? o.added : null,
      deleted: typeof o.deleted === 'number' ? o.deleted : null,
      ...(typeof o.newLines === 'number' ? { newLines: o.newLines } : {}),
    });
  }
  return out;
}

/**
 * 事件 → 转录条目纯归约(state 进出零副作用)。子代理事件(payload.subagent)另轨——主流零条目
 * (G8d 同口径);usage/step/ctx/route/model-end/approval 系/task 系/gate 系/delegation 系零条目。
 */
export function applyEvent(state: KernelState, e: SessionEvent): KernelState {
  const sub = e.payload?.subagent;
  if (typeof sub === 'string' && sub.length > 0) {
    // 子代理事件另轨:转录零条目(主链不可见,G8d);usage 例外入统计面(P9 child token per-child 水位)
    if (e.type !== 'usage') return state;
    const total = e.payload?.turnTotal;
    if (typeof total !== 'number') return state;
    const prev = state.stats.childWatermarks[sub] ?? 0;
    const delta = Math.max(0, total - prev);
    if (delta === 0 && total === prev) return state;
    return {
      ...state,
      stats: {
        ...state.stats,
        turnChildTokens: state.stats.turnChildTokens + delta,
        sessionChildTokens: state.stats.sessionChildTokens + delta,
        childWatermarks: { ...state.stats.childWatermarks, [sub]: total },
      },
    };
  }
  switch (e.type) {
    case 'token': {
      const text = e.text ?? '';
      if (text === '') return state;
      if (state.openSeg >= 0) {
        const idx = state.entries.findIndex((x) => x.seq === state.openSeg);
        const cur = idx >= 0 ? state.entries[idx]! : undefined;
        if (cur !== undefined && cur.kind === 'assistant') {
          return { ...state, entries: replaceAt(state.entries, idx, { ...cur, md: cur.md + text }) };
        }
      }
      return openSegEntry(state, e.ts, { ts: e.ts, kind: 'assistant', md: text }); // 思考先行:开启段是 thinking 则先封
    }
    case 'reasoning': {
      const text = e.text ?? '';
      if (text === '') return state;
      if (state.openSeg >= 0) {
        const idx = state.entries.findIndex((x) => x.seq === state.openSeg);
        const cur = idx >= 0 ? state.entries[idx]! : undefined;
        if (cur !== undefined && cur.kind === 'thinking') {
          return { ...state, entries: replaceAt(state.entries, idx, { ...cur, md: cur.md + text }) };
        }
      }
      return openSegEntry(state, e.ts, { ts: e.ts, kind: 'thinking', md: text });
    }
    case 'tool-call': {
      const sealed = sealSeg(state, e.ts);
      const callId = typeof e.payload?.callId === 'string' && e.payload.callId !== '' ? e.payload.callId : undefined;
      const name = e.text ?? PLACEHOLDER;
      if (callId !== undefined) {
        const pi = sealed.pending.findIndex((p) => p.callId === callId);
        if (pi >= 0) {
          // result 先行的乱序路径:name/input 回填同条(seq/ts 保持 result 到达时刻的入列位)
          const p = sealed.pending[pi]!;
          const idx = sealed.entries.findIndex((x) => x.seq === p.seq);
          if (idx >= 0) {
            const cur = sealed.entries[idx]!;
            const input = e.payload?.input;
            const pending = sealed.pending.slice();
            pending[pi] = { ...p, name };
            return {
              ...sealed,
              entries: replaceAt(sealed.entries, idx, {
                ...cur,
                name,
                md: toolMd(name, p.resultLine),
                ...(input !== undefined && typeof input === 'object' ? { input: input as Record<string, unknown> } : {}),
              }),
              pending,
            };
          }
        }
      }
      const input = e.payload?.input;
      const next = appendEntry(sealed, {
        ts: e.ts,
        kind: 'tool',
        md: toolMd(name, PLACEHOLDER),
        ...(callId !== undefined ? { callId } : {}),
        name,
        ...(input !== undefined && typeof input === 'object' ? { input: input as Record<string, unknown> } : {}),
      });
      return { ...next, pending: [...next.pending, { seq: next.nextSeq - 1, ...(callId !== undefined ? { callId } : {}), name, resultLine: PLACEHOLDER }] };
    }
    case 'tool-result': {
      const sealed = sealSeg(state, e.ts);
      const callId = typeof e.payload?.callId === 'string' && e.payload.callId !== '' ? e.payload.callId : undefined;
      const resultLine = firstLine(e.text);
      const result = {
        text: e.text ?? '',
        ok: typeof e.payload?.ok === 'boolean' ? e.payload.ok : true,
        // 全量观测随档(batch-runner payload.full):detail 展开与恢复面同一来源,live/restore 零推导
        ...(typeof e.payload?.full === 'string' ? { full: e.payload.full } : {}),
      };
      const fill = (cur: KernelEntry, name: string): KernelEntry => ({ ...cur, md: toolMd(name, resultLine), result });
      if (callId !== undefined) {
        const pi = sealed.pending.findIndex((p) => p.callId === callId);
        if (pi >= 0) {
          const p = sealed.pending[pi]!;
          const idx = sealed.entries.findIndex((x) => x.seq === p.seq);
          if (idx >= 0) {
            return {
              ...sealed,
              entries: replaceAt(sealed.entries, idx, fill(sealed.entries[idx]!, p.name)),
              pending: sealed.pending.filter((_, i) => i !== pi),
            };
          }
        }
        // result 先到:占位条即刻入列(callId 留账,等 call 回填 name)
        const next = appendEntry(sealed, { ts: e.ts, kind: 'tool', md: toolMd(PLACEHOLDER, resultLine), callId, result });
        return { ...next, pending: [...next.pending, { seq: next.nextSeq - 1, callId, name: PLACEHOLDER, resultLine }] };
      }
      // 无 callId:FIFO 兜底配最老的无 callId 未配对条(pendingCalls 同口径)
      const pi = sealed.pending.findIndex((p) => p.callId === undefined);
      if (pi >= 0) {
        const p = sealed.pending[pi]!;
        const idx = sealed.entries.findIndex((x) => x.seq === p.seq);
        if (idx >= 0) {
          return {
            ...sealed,
            entries: replaceAt(sealed.entries, idx, fill(sealed.entries[idx]!, p.name)),
            pending: sealed.pending.filter((_, i) => i !== pi),
          };
        }
      }
      // 孤儿 result:以 payload.tool 为动词独立成条(完备条,不进 pending)
      const tool = e.payload?.tool;
      const verb = typeof tool === 'string' && tool.length > 0 ? tool : PLACEHOLDER;
      return appendEntry(sealed, { ts: e.ts, kind: 'tool', md: toolMd(verb, resultLine), name: verb, result });
    }
    case 'user': {
      const sealed = sealSeg(state, e.ts);
      return appendEntry(sealed, { ts: e.ts, kind: 'user', md: `> ${e.text ?? ''}` });
    }
    case 'notice': {
      const sealed = sealSeg(state, e.ts);
      return appendEntry(sealed, { ts: e.ts, kind: 'notice', md: e.text ?? '' });
    }
    case 'error':
      // 不封段(G14.51):done 必发,收口让位——运行中旁路错误只入条,开启段留给 done 合并
      return appendEntry(state, { ts: e.ts, kind: 'error', md: e.text ?? 'error' });
    case 'agent-message': {
      const p = e.payload as { from?: unknown; to?: unknown; text?: unknown } | undefined;
      const from = typeof p?.from === 'string' && p.from.length > 0 ? p.from : '?';
      const to = typeof p?.to === 'string' && p.to.length > 0 ? p.to : '?';
      const sealed = sealSeg(state, e.ts);
      return appendEntry(sealed, { ts: e.ts, kind: 'notice', md: `[${from} → ${to}] ${typeof p?.text === 'string' ? p.text : ''}` });
    }
    case 'model-start': {
      const sealed = sealSeg(state, e.ts);
      if (sealed.openRun >= 0) return sealed; // run 内续轮:不重插 run 条,轮窗计数器不清
      const next = appendEntry(sealed, { ts: e.ts, kind: 'run', md: '' });
      // 轮窗重置与开轮计数(P9):run 即「本轮」窗口——turn 面计数器清零,sessionTurns+1
      return {
        ...next,
        openRun: next.nextSeq - 1,
        stats: { ...next.stats, turnStartedAt: e.ts, turnTokens: 0, turnCacheTokens: 0, turnPromptTokens: 0, turnChildTokens: 0, sessionTurns: next.stats.sessionTurns + 1 },
      };
    }
    case 'usage': {
      // P9 统计面:水位差值法(reactor turnTotal=run 内单调累计,per-request 全量叠基线跨帧幂等)。
      // 子代理 usage 已在前置守卫分流(per-child 水位),此处恒为主链
      const p = e.payload ?? {};
      if (typeof p.turnTotal !== 'number') return state;
      const turnDelta = Math.max(0, p.turnTotal - state.stats.turnTokens);
      const cacheTotal = typeof p.cacheHitTotal === 'number' ? p.cacheHitTotal : null;
      const promptTotal = typeof p.promptTotal === 'number' ? p.promptTotal : null;
      const cacheDelta = cacheTotal !== null ? Math.max(0, cacheTotal - state.stats.turnCacheTokens) : 0;
      const promptDelta = promptTotal !== null ? Math.max(0, promptTotal - state.stats.turnPromptTokens) : 0;
      if (turnDelta === 0 && cacheDelta === 0 && promptDelta === 0 && p.turnTotal === state.stats.turnTokens) return state;
      return {
        ...state,
        stats: {
          ...state.stats,
          turnTokens: p.turnTotal,
          sessionTotalTokens: state.stats.sessionTotalTokens + turnDelta,
          ...(cacheTotal !== null ? { turnCacheTokens: cacheTotal, sessionCacheTokens: state.stats.sessionCacheTokens + cacheDelta } : {}),
          ...(promptTotal !== null ? { turnPromptTokens: promptTotal, sessionPromptTokens: state.stats.sessionPromptTokens + promptDelta } : {}),
        },
      };
    }
    case 'ctx': {
      // P9 统计面:ctx 水位(exact 采信/估算只上,applyCtxWatermark 单点)
      const used = applyCtxWatermark(state.stats.ctxUsed, typeof e.payload?.used === 'number' ? e.payload.used : 0, e.payload?.exact === true);
      const exact = e.payload?.exact === true;
      if (used === state.stats.ctxUsed && exact === state.stats.ctxExact) return state;
      return { ...state, stats: { ...state.stats, ctxUsed: used, ctxExact: exact } };
    }
    case 'step':
      // P9 统计面:步数计账(model 动作步;done 收尾帧不计——与 TUI 旧口径一致)
      if (e.text === 'done') return state;
      return { ...state, stats: { ...state.stats, sessionSteps: state.stats.sessionSteps + 1 } };
    case 'done': {
      // ① 思考段先封(thinking 先行);开启 assistant 段合并终稿(同文不重复),无开启段且终稿非空才独立成条
      let st = state;
      const segIdx = st.openSeg >= 0 ? st.entries.findIndex((x) => x.seq === st.openSeg) : -1;
      const seg = segIdx >= 0 ? st.entries[segIdx] : undefined;
      if (seg !== undefined && seg.kind === 'thinking') st = sealSeg(st, e.ts);
      const finalText = e.text ?? '';
      if (seg !== undefined && seg.kind === 'assistant') {
        st = { ...st, entries: replaceAt(st.entries, segIdx, { ...seg, md: mergeFinal(seg.md, finalText) }), openSeg: -1 };
      } else if (finalText.trim() !== '') {
        st = appendEntry({ ...st, openSeg: -1 }, { ts: e.ts, kind: 'assistant', md: finalText });
      } else {
        st = { ...st, openSeg: -1 };
      }
      // ② 封 run:meta 基础面(steps/runSteps/tokensUsed/stopped 出自 done 载荷;seconds 首尾 ts 差;
      //    cacheTokens/changes 等 runmeta 帧补全——权威统计晚于 done 到达,帧覆盖语义)
      if (st.openRun >= 0) {
        const ridx = st.entries.findIndex((x) => x.seq === st.openRun);
        const run = ridx >= 0 ? st.entries[ridx] : undefined;
        if (run !== undefined && run.kind === 'run') {
          const seconds = e.ts > run.ts ? Math.round((e.ts - run.ts) / 1000) : undefined;
          const p = e.payload ?? {};
          const stopped = typeof p.stopReason === 'string' && p.stopReason !== 'done';
          const meta: RunMeta = {
            ...(run.meta ?? {}),
            ...(seconds !== undefined ? { seconds } : {}),
            ...(typeof p.steps === 'number' ? { steps: p.steps } : {}),
            ...(typeof p.runSteps === 'number' ? { runSteps: p.runSteps } : {}),
            ...(typeof p.tokensUsed === 'number' ? { tokens: p.tokensUsed } : {}),
            ...(stopped ? { stopped: true } : {}),
            endedTs: e.ts,
          };
          st = { ...st, entries: replaceAt(st.entries, ridx, { ...run, meta }) };
        }
      }
      return { ...st, openRun: -1, openSeg: -1 };
    }
    case 'runmeta': {
      // 收尾元数据帧:末个 run 条补全/覆盖统计(晚于 done 帧——run 条已封;无 run 条不动)
      const p = e.payload ?? {};
      let idx = -1;
      for (let i = state.entries.length - 1; i >= 0; i -= 1) {
        if (state.entries[i]!.kind === 'run') {
          idx = i;
          break;
        }
      }
      if (idx < 0) return state;
      const cur = state.entries[idx]!;
      const changes = sanitizeChanges(p.changes);
      const meta: RunMeta = {
        ...(cur.meta ?? {}),
        ...(typeof p.seconds === 'number' ? { seconds: p.seconds } : {}),
        ...(typeof p.steps === 'number' ? { steps: p.steps } : {}),
        ...(typeof p.runSteps === 'number' ? { runSteps: p.runSteps } : {}),
        ...(typeof p.tokens === 'number' ? { tokens: p.tokens } : {}),
        ...(typeof p.cacheTokens === 'number' ? { cacheTokens: p.cacheTokens } : {}),
        ...(typeof p.endedTs === 'number' ? { endedTs: p.endedTs } : {}),
        ...(p.stopped === true ? { stopped: true } : {}),
        ...(changes !== undefined && changes.length > 0 ? { changes } : {}),
      };
      return { ...state, entries: replaceAt(state.entries, idx, { ...cur, meta }) };
    }
    default: {
      // 非流内事件(route/approval 系/task 系/gate 系/delegation 系)一律先封流式段
      // ——collector G14.213 同构:不产条目的事件也承担段边界职责;model-end 流内
      // 不封(每模型轮收尾即发——封段会把轮内正文与 done 终稿裂成重复两条,实测 TUI 往返抓出);
      // usage/step/ctx 已升级显式统计面分支(P9),不再走流内免封清单
      const inStream = e.type === 'model-end';
      return inStream ? state : sealSeg(state, e.ts);
    }
  }
}

/** 历史播种(v2 档装载/attach 派生):入参 seq>0 原样沿用(v2 行 seq 与 live 同源——truncate 行
 *  upToSeq 对位依赖),缺省/0 才续发(链派生等异源播种);nextSeq = max+1。播种条目一律视为已闭合
 *  (不动流式记账/配对池),不触发 kernel 事件(kernel 侧职责) */
export function applySeed(state: KernelState, entries: ReadonlyArray<Omit<KernelEntry, 'seq'> & { seq?: number }>): KernelState {
  let auto = state.nextSeq;
  let maxSeq = state.nextSeq - 1;
  const seeded: KernelEntry[] = entries.map((e) => {
    const seq = typeof e.seq === 'number' && Number.isInteger(e.seq) && e.seq > 0 ? e.seq : auto++;
    if (seq > maxSeq) maxSeq = seq;
    return { ...e, seq } as KernelEntry;
  });
  let st: KernelState = { ...state, entries: [...state.entries, ...seeded] };
  while (st.entries.length > CAP) {
    const dropped = st.entries.shift();
    if (dropped !== undefined && dropped.kind === 'tool') st = { ...st, pending: st.pending.filter((p) => p.seq !== dropped.seq) };
  }
  // 统计面重建(P9):会话累计自历史 run meta 派生(G14.18 口径——回放会话累计不从零起);
  // tokens/cache 逐 run 求和,steps 取末次覆盖值(载荷为累计口径),turns 数 run 条
  let totalTokens = 0;
  let totalCache = 0;
  let steps = 0;
  let turns = 0;
  for (const e of st.entries) {
    if (e.kind === 'run') {
      turns += 1;
      if (e.meta !== undefined) {
        totalTokens += e.meta.tokens ?? 0;
        totalCache += e.meta.cacheTokens ?? 0;
        steps = Math.max(steps, e.meta.steps ?? 0);
      }
    }
  }
  if (totalTokens > 0 || totalCache > 0 || steps > 0 || turns > 0) {
    st = { ...st, stats: { ...st.stats, sessionTotalTokens: totalTokens, sessionCacheTokens: totalCache, sessionSteps: steps, sessionTurns: turns } };
  }
  return { ...st, nextSeq: maxSeq + 1 };
}
