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
  /** tool:结果回执(call/result 配对回填;全文 + ok) */
  result?: { text: string; ok: boolean };
  /** thinking:段耗时秒(封段时首尾 ts 差取整) */
  seconds?: number;
  /** run:收段统计(done 填基础面,runmeta 帧补全/覆盖) */
  meta?: RunMeta;
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
 *  正文/思考段轮内轮替——两游标独立,「开启中即流式中」的派生面 */
export interface KernelState {
  entries: KernelEntry[];
  nextSeq: number;
  openRun: number;
  openSeg: number;
  pending: PendingTool[];
}

export function initialKernelState(): KernelState {
  return { entries: [], nextSeq: 1, openRun: -1, openSeg: -1, pending: [] };
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
  if (typeof e.payload?.subagent === 'string') return state;
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
      const result = { text: e.text ?? '', ok: typeof e.payload?.ok === 'boolean' ? e.payload.ok : true };
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
      if (sealed.openRun >= 0) return sealed; // run 内续轮:不重插 run 条
      const next = appendEntry(sealed, { ts: e.ts, kind: 'run', md: '' });
      return { ...next, openRun: next.nextSeq - 1 };
    }
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
      // 非流内事件(route/model-end/approval 系/task 系/gate 系/delegation 系)一律先封流式段
      // ——collector G14.213 同构:不产条目的事件也承担段边界职责;usage/step/ctx 流内不封
      const inStream = e.type === 'usage' || e.type === 'step' || e.type === 'ctx';
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
  return { ...st, nextSeq: maxSeq + 1 };
}
