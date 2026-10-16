import type { SessionEvent } from '../../src/types';

/**
 * G3 chat 投影 reducer（纯函数）：gui 对话流的事件面单点——token 流式拼接、done 终稿收段、
 * 工具 call/result 配对（乱序回填）、notice 系映射、status·tokens·steps 聚合。
 * 工具配对与 daemon 侧 TranscriptCollector 同构（gui 独立实现，不 import 主仓 serve/*——
 * 两轨并行：归档面（snapshot.messages）与实时面（事件流推导）形态一致，重连/直连所见等价）。
 *
 * 裁定记录：
 * - done 收段语义（事件面）：done.text 是终稿——与 streaming 条已累积文本重叠（互为前缀）时以
 *   终稿为准，不重叠则补入（md += text）；无 streaming 条时独立成条（对齐归档面「done 恒有终答条」）。
 * - usage 会话累计口径：事件载荷实际只有 turnTotal（reactor 单 run 累计，核 src/harness/reactor.ts
 *   emit('usage')——无 sessionTotalTokens 字段），故 gui 以「run 内增量」自行累计会话总量；
 *   水位重置仅在 run 边界（idle 态的 model-start）——model-start 是每模型轮一次（reactor.ts:450
 *   chatRound 内发射），而 turnTotal 是 run 级单调不回零，轮间重置会把各轮水位之和虚增进 tokens。
 *   子代理 usage（payload.subagent）不进主链计数（G8d Agents 标签另聚——入口过滤单点）。
 * - seed 时 tokens 置 0（会话累计经事件续推；G4 若需精确可在 snapshot 加基线，记档）。
 * - streaming 条在 done/error/model-start/tool-call 收段——不留永久流式标（GUI 光标面）。
 */

/** 对话流条目（md 原文；kind 样式钩子在渲染面，streaming=true 流式光标态；ts 日期分隔投影源）。
 *  kind 'thinking' 为 gui 投影扩展（reasoning 事件聚合;快照/归档面不产出,重播种即失——Codex 同形） */
export interface ChatEntry {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error' | 'thinking' | 'run';
  md: string;
  streaming?: boolean;
  /** thinking 专用：段耗时秒（封段时由首尾 ts 差计算;无 ts/不足 1s 省略） */
  seconds?: number;
  /** 条目时间（epoch ms;事件条透传 e.ts,种子条透传快照,本地回显/开条时刻就地取;无源可省） */
  ts?: number;
  /** G14.63 run 专用:轮起点基线(会话累计 steps/tokens)——运行状态行「本轮」口径的减数 */
  stepsBase?: number;
  tokensBase?: number;
  /** run 专用（G11 状态行）：封段统计——done 载荷 {steps, tokensUsed} 透传 */
  steps?: number;
  tokens?: number;
  /** run 专用：收段时刻（完成时间渲染源） */
  endedTs?: number;
  /** G14.209 run 专用:停止态(中断/失败收口——运行条显「已停止」不显时长) */
  stopped?: boolean;
  /** G14.100 run 专用:本轮 git 变动增量(轮尾汇总条;撤销面按 path 寻址) */
  changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null }>;
}

/** chat 投影状态：entries 对话流 + 状态栏三指标 */
export interface ChatState {
  entries: ChatEntry[];
  status: 'idle' | 'running';
  /** 会话累计 tokens（usage 事件续推；seed 归零，见文件头裁定） */
  tokens: number;
  steps: number;
  /** 会话累计 prompt 缓存命中 tokens（usage.cacheHitTotal 续推，与 tokens 同基线法；G14.18 圆环回溯面） */
  cacheTokens: number;
  /** 内部记账（勿消费）：当前 run 的 usage.turnTotal 水位——model-start 重置；tokens 增量基线 */
  turnTokensBase?: number;
  /** 内部记账（勿消费）：当前 run 的 cacheHitTotal 水位——run 边界重置；cache 增量基线 */
  turnCacheBase?: number;
}

export function initialChatState(): ChatState {
  return { entries: [], status: 'idle', tokens: 0, steps: 0, cacheTokens: 0, turnTokensBase: 0, turnCacheBase: 0 };
}

/** snapshot.messages 载荷形态（gui 侧契约声明，五 kind；对齐 daemon TranscriptEntry，不引其类型） */
export interface SnapshotTranscriptEntry {
  seq: number;
  ts?: number;
  kind: ChatEntry['kind'];
  md: string;
  /** G14.16:run 条统计(runmeta 对位)——Worked 行时长与 footer 步数/tokens 回放;
   *  G14.56:runSteps=本轮自身步数(缺场=旧档,footer 回退累计口径) */
  meta?: {
    seconds?: number;
    steps?: number;
    runSteps?: number;
    tokens?: number;
    cacheTokens?: number;
    changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null }>;
    /** G14.210 停止态(中断/失败收口)——回放运行条显「已停止」 */
    stopped?: boolean;
  };
  /** G14.24:thinking 条思考秒数(回放面) */
  seconds?: number;
}

/** 用户提交的本地回显条（`> text` 引用块形态，与归档面 transcript.submit 同款——resync 后由快照条取代） */
export function appendUserMessage(s: ChatState, text: string, ts?: number): ChatState {
  return { ...s, entries: [...s.entries, { key: `u${s.entries.length}`, kind: 'user', md: `> ${text}`, ts: ts ?? Date.now() }] };
}

/** onResync 基线：snapshot.messages 直映射（md 原文、无 streaming；tokens/steps 0 起步——事件面续推） */
export function seedChatFromSnapshot(messages: readonly SnapshotTranscriptEntry[], status: 'idle' | 'running'): ChatState {
  // G14.18:回放会话的累计基线自 run 条 meta 求和(runmeta journal 对位)——tokens/steps 不从零起,
  // 圆环弹层重开即真值;cache 无回放面恒 0(事件面续推仅对本浏览器在场的 run 生效)
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
  const entries: ChatEntry[] = messages.map((m) => ({
    key: `s${m.seq}`,
    kind: m.kind,
    md: m.md,
    ...(m.ts !== undefined ? { ts: m.ts } : {}),
    ...(m.kind === 'thinking' && m.seconds !== undefined ? { seconds: m.seconds } : {}),
    ...(m.kind === 'run' && m.meta !== undefined
      ? {
          seconds: m.meta.seconds,
          steps: m.meta.runSteps ?? m.meta.steps, // G14.56:footer 本轮口径优先(旧档回退累计)
          tokens: m.meta.tokens,
          ...(m.meta.stopped === true ? { stopped: true } : {}), // G14.210 停止态回放
          ...(m.ts !== undefined && m.ts > 0 ? { endedTs: m.ts } : {}), // 回放 ts=runmeta endedTs,footer 时刻面
          ...(m.meta.changes !== undefined && m.meta.changes.length > 0 ? { changes: m.meta.changes } : {}),
        }
      : {}),
  }));
  // G14.51 快照竞态收口:status=running 且末个 run 条无 meta(在途未收段)时,其后的部分回复/
  // 思考是半成品,须按流式态摄入——否则 done 到达时找不到流式条,终稿误追加成新条(回复裂两截);
  // 在途 run 条同标,Working 计时随帧续推。轮间静默期(末 run 已封)不标——上一轮回答不得并入下轮
  if (status === 'running' && lastRunOpen) {
    let runIdx = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]!.kind === 'run') {
        runIdx = i;
        break;
      }
    }
    if (runIdx >= 0) {
      entries[runIdx] = { ...entries[runIdx]!, streaming: true };
      for (let i = entries.length - 1; i > runIdx; i -= 1) {
        const e = entries[i]!;
        if (e.kind === 'assistant' || e.kind === 'thinking') {
          entries[i] = { ...e, streaming: true };
          break;
        }
        if (e.kind === 'tool' || e.kind === 'user') break; // 段界:工具在途/轮首——其后无部分文本段
      }
    }
  }
  return {
    entries,
    status,
    tokens,
    steps,
    cacheTokens,
    turnTokensBase: 0,
    turnCacheBase: 0,
  };
}

/* ===== 工具条两行形态（● verb / ⎿ result，占位 …）与配对记账 =====
 * 配对状态经 key 约定编码在 entries 里（ChatState 形态固定不另设池）：
 * - `tool:<callId>`：有 callId 的配对面（迟到者按 callId 回找；`~n` 后缀为重复 callId 的唯一化）
 * - `tool:#<n>`：无 callId 面（FIFO 兜底池）
 * 未配对 = 两行中有 … 占位；双占位/单占位均可被回填。 */

const PLACEHOLDER = '…';

function toolMd(verb: string, resultLine: string): string {
  return `● ${verb}\n⎿ ${resultLine}`;
}

/** 多行观察只取首行；空文本回落 … 占位 */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.length > 0 ? line : PLACEHOLDER;
}

function verbOf(md: string): string {
  const nl = md.indexOf('\n');
  return nl > 2 ? md.slice(2, nl) : PLACEHOLDER;
}

function resultOf(md: string): string {
  const m = md.indexOf('⎿ ');
  return m >= 0 ? md.slice(m + 2) : PLACEHOLDER;
}

/** 未配对条（含占位行）判定 */
function toolUnpaired(md: string): boolean {
  return verbOf(md) === PLACEHOLDER || resultOf(md) === PLACEHOLDER;
}

/** key 唯一化：重复 callId 复现（已配对条同 callId 再来一对手）时递增 `~n` 后缀防 React 撞 key */
function uniqueKey(base: string, entries: readonly ChatEntry[]): string {
  if (!entries.some((e) => e.key === base)) return base;
  let n = 2;
  while (entries.some((e) => e.key === `${base}~${n}`)) n += 1;
  return `${base}~${n}`;
}

/** 条目是否 callId=<callId> 的未配对工具面（key 前缀匹配，`tool:#` 无 callId 面除外） */
function isPendingCallTool(e: ChatEntry, callId: string): boolean {
  if (e.kind !== 'tool' || !e.key.startsWith(`tool:${callId}`)) return false;
  const rest = e.key.slice(`tool:${callId}`.length);
  return (rest === '' || rest.startsWith('~')) && toolUnpaired(e.md);
}

/** entries[idx] 原位替换（浅拷贝数组；其余条目引用复用） */
function replaceAt(entries: readonly ChatEntry[], idx: number, next: ChatEntry): ChatEntry[] {
  const copy = entries.slice();
  copy[idx] = next;
  return copy;
}

/** 收段：最后一个 streaming 条去 streaming 标（md 原样保留）——done/error/model-start/tool-call 共用 */
function sealStreaming(entries: readonly ChatEntry[]): { entries: ChatEntry[]; sealedIdx: number } {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.kind === 'assistant' && e.streaming === true) {
      const { streaming: _drop, ...rest } = e;
      return { entries: replaceAt(entries, i, rest), sealedIdx: i };
    }
  }
  return { entries: entries as ChatEntry[], sealedIdx: -1 };
}

/** 收思考段（G10-C3 尾追语义）：末位 thinking 条去 streaming 标并计耗时（首条 ts → 封段事件 ts）。 */
function sealThinking(entries: readonly ChatEntry[], now?: number): ChatEntry[] {
  const last = entries[entries.length - 1];
  if (last === undefined || last.kind !== 'thinking' || last.streaming !== true) return entries as ChatEntry[];
  const seconds = now !== undefined && typeof last.ts === 'number' && now > last.ts ? Math.round((now - last.ts) / 1000) : undefined;
  return replaceAt(entries, entries.length - 1, { ...last, streaming: undefined, ...(seconds !== undefined ? { seconds } : {}) });
}

/** 封 run 段（G11 状态行）：最后一条 streaming run 条去标并回填耗时/统计。
 *  seconds 首尾 ts 差取整;steps/tokens 透传 done 载荷;endedTs=收段事件 ts。无 run 条透传原数组 */
function sealRun(entries: readonly ChatEntry[], now: number | undefined, stat?: { steps?: number; tokens?: number; stopped?: boolean }): ChatEntry[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.kind === 'run' && e.streaming === true) {
      const seconds = now !== undefined && typeof e.ts === 'number' && now > e.ts ? Math.round((now - e.ts) / 1000) : undefined;
      return replaceAt(entries, i, {
        ...e,
        streaming: undefined,
        ...(seconds !== undefined ? { seconds } : {}),
        ...(stat?.steps !== undefined ? { steps: stat.steps } : {}),
        ...(stat?.tokens !== undefined ? { tokens: stat.tokens } : {}),
        ...(stat?.stopped === true ? { stopped: true } : {}),
        ...(now !== undefined ? { endedTs: now } : {}),
      });
    }
  }
  return entries as ChatEntry[];
}

/** token 增量并入当前 streaming 条（无则开条;开条前封思考段——思考先行语义;封段时刻取事件 ts） */
function onToken(s: ChatState, text: string, now?: number): ChatState {
  if (text === '') return s;
  const entries = sealThinking(s.entries, now);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.kind === 'assistant' && e.streaming === true) {
      return { ...s, entries: replaceAt(entries, i, { ...e, md: e.md + text }) };
    }
  }
  return { ...s, entries: [...entries, { key: `a${entries.length}`, kind: 'assistant', md: text, streaming: true, ts: Date.now() }] };
}

/** done 终稿与已累积的合并：互为前缀（重叠）→ 终稿为准；不重叠 → 补入 */
function mergeFinal(acc: string, fin: string): string {
  if (acc === '') return fin;
  if (fin === '') return acc;
  if (fin.startsWith(acc) || acc.startsWith(fin)) return fin.length >= acc.length ? fin : acc;
  return acc + fin;
}

function onDone(s: ChatState, e: SessionEvent): ChatState {
  const base = sealStreaming(sealThinking(s.entries, e.ts));
  // G14.56:footer steps=本轮自身步数(done 载荷 runSteps;旧载荷缺场回退会话累计)
  const footerSteps = typeof e.payload?.runSteps === 'number' ? e.payload.runSteps : e.payload?.steps;
  // G14.209 停止态入条:done 载荷 stopReason 非 done(中断/失败)→运行条显「已停止」不显时长
  const stopped = typeof e.payload?.stopReason === 'string' && e.payload.stopReason !== 'done';
  const entries = sealRun(base.entries, e.ts, {
    steps: typeof footerSteps === 'number' ? footerSteps : undefined,
    tokens: typeof e.payload?.tokensUsed === 'number' ? e.payload.tokensUsed : undefined,
    stopped,
  });
  const text = e.text ?? '';
  // 步数口径(G14.20 统一):done 载荷 steps=reactor 会话累计步数(steps.length,含种子链)——
  // 直接采用(footer/圆环/旁车 meta 同一口径);载荷缺面回落事件计数原值
  const runSteps = typeof e.payload?.steps === 'number' ? e.payload.steps : s.steps;
  if (base.sealedIdx < 0) {
    return { ...s, status: 'idle', steps: runSteps, entries: [...entries, { key: `a${entries.length}`, kind: 'assistant', md: text, ts: e.ts }] };
  }
  const sealed = entries[base.sealedIdx]!;
  return { ...s, status: 'idle', steps: runSteps, entries: replaceAt(entries, base.sealedIdx, { ...sealed, md: mergeFinal(sealed.md, text) }) };
}

/** error 条只入列不封段(G14.51):daemon 契约 done 必发(正常/异常同出口,reactor.ts 收尾)——
 *  运行中旁路错误(上下文溢出重试/提交 409 撞 busy)若在此封 streaming 条,done 到达时找不到
 *  流式条,终稿误追加成新条(回复裂两截);收口统一让位 done */
function onError(s: ChatState, e: SessionEvent): ChatState {
  return { ...s, entries: [...s.entries, { key: `e${s.entries.length}`, kind: 'error', md: e.text ?? 'error', ts: e.ts }] };
}

/** tool-call：callId 命中未配对面（result 先到）→ verb 回填；否则 verb 行即时、result 行占位入列 */
function onToolCall(s: ChatState, e: SessionEvent): ChatState {
  const { entries } = sealStreaming(sealThinking(s.entries, e.ts));
  const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
  if (callId !== undefined) {
    const idx = entries.findIndex((t) => isPendingCallTool(t, callId));
    if (idx >= 0) {
      return { ...s, entries: replaceAt(entries, idx, { ...entries[idx]!, md: toolMd(e.text ?? PLACEHOLDER, resultOf(entries[idx]!.md)) }) };
    }
  }
  const key = uniqueKey(callId !== undefined ? `tool:${callId}` : `tool:#${entries.length}`, entries);
  return { ...s, entries: [...entries, { key, kind: 'tool', md: toolMd(e.text ?? PLACEHOLDER, PLACEHOLDER), ts: e.ts }] };
}

/** tool-result：callId 命中未配对面（call 先到）→ result 回填；callId 缺场先入列占位；无 callId FIFO 配最老 / 孤儿独立成条 */
function onToolResult(s: ChatState, e: SessionEvent): ChatState {
  const { entries } = sealStreaming(sealThinking(s.entries, e.ts));
  const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
  const resultLine = firstLine(e.text);
  if (callId !== undefined) {
    const idx = entries.findIndex((t) => isPendingCallTool(t, callId));
    if (idx >= 0) {
      return { ...s, entries: replaceAt(entries, idx, { ...entries[idx]!, md: toolMd(verbOf(entries[idx]!.md), resultLine) }) };
    }
    return { ...s, entries: [...entries, { key: uniqueKey(`tool:${callId}`, entries), kind: 'tool', md: toolMd(PLACEHOLDER, resultLine), ts: e.ts }] };
  }
  // FIFO：最老的无 callId（`tool:#`）未配对面——result 回填（result 先到的孤儿面：result 行被覆盖，verb 占位保留）
  const idx = entries.findIndex((t) => t.kind === 'tool' && t.key.startsWith('tool:#') && toolUnpaired(t.md));
  if (idx >= 0) {
    return { ...s, entries: replaceAt(entries, idx, { ...entries[idx]!, md: toolMd(verbOf(entries[idx]!.md), resultLine) }) };
  }
  const tool = e.payload?.tool;
  const verb = typeof tool === 'string' && tool.length > 0 ? tool : PLACEHOLDER;
  return { ...s, entries: [...entries, { key: `tool:#${entries.length}`, kind: 'tool', md: toolMd(verb, resultLine), ts: e.ts }] };
}

/** 委派起止单行（`✻ label started|status`）：label 取 payload.label 回落 delegationId，status 回落 ended */
function delegationMd(e: SessionEvent): string {
  const p = e.payload as { label?: unknown; delegationId?: unknown; status?: unknown } | undefined;
  const label =
    typeof p?.label === 'string' && p.label.length > 0 ? p.label : typeof p?.delegationId === 'string' && p.delegationId.length > 0 ? p.delegationId : PLACEHOLDER;
  const status = e.type === 'delegation-started' ? 'started' : typeof p?.status === 'string' && p.status.length > 0 ? p.status : 'ended';
  return `✻ ${label} ${status}`;
}

/** usage 会话累计：turnTotal 轮内增量并入（基线 model-start 重置）；无数值载荷不动。
 *  子代理用量（payload.subagent）不经此——入口全类型过滤已单点拦下（G8d Agents 标签另聚） */
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

/** 事件面单点：chat 投影纯归约（忽略 task-、gate-、route/ctx/model-end/reasoning/approval 系——板面/另轨；
 *  入口全类型过滤 payload.subagent 子代理事件——G8d Agents 标签另聚，主流零条目） */
export function applyChatEvent(s: ChatState, e: SessionEvent): ChatState {
  if (typeof e.payload?.subagent === 'string') return s; // 子代理事件另轨(Agents 标签,G8d):主流零条目
  switch (e.type) {
    case 'token':
      return onToken(s, e.text ?? '', e.ts);
    case 'user':
      // G14.89 daemon 队列自动续发的回显帧(HTTP 提交路径不产——GUI 本地回显)
      return appendUserMessage(s, e.text ?? '');
    case 'done':
      return onDone(s, e);
    case 'error':
      return onError(s, e);
    case 'reasoning': {
      const text = e.text ?? '';
      if (text === '') return s;
      const last = s.entries[s.entries.length - 1];
      if (last !== undefined && last.kind === 'thinking' && last.streaming === true) {
        return { ...s, entries: replaceAt(s.entries, s.entries.length - 1, { ...last, md: last.md + text }) };
      }
      return { ...s, entries: [...s.entries, { key: `t${s.entries.length}`, kind: 'thinking', md: text, streaming: true, ts: e.ts }] };
    }
    case 'notice':
      // G14.90 ask 回执归档行冗余(结构化问答体已示✓ Answered)——主流不渲染(journal 审计面保留)
      if (/^ask p\S+ answered$/.test(e.text ?? '')) return s;
      // G14.106 memory 索引漂移 notice(含 Memory Index 全文)是模型链行——GUI 可见面不渲染
      if ((e.text ?? '').startsWith('[memory] index changed')) return s;
      return { ...s, entries: [...s.entries, { key: `n${s.entries.length}`, kind: 'notice', md: e.text ?? '', ts: e.ts }] };
    case 'runmeta': {
      // G14.100 run 收尾元数据帧:末个 run 条补全统计+本轮 changes(demo 汇总条数据源;
      // journal 落档后 pump——晚于 done 帧,run 条已封段)
      const p = e.payload ?? {};
      let idx = -1;
      for (let i = s.entries.length - 1; i >= 0; i -= 1) {
        if (s.entries[i]!.kind === 'run') { idx = i; break; }
      }
      if (idx < 0) return s;
      const cur = s.entries[idx]!;
      const raw = p.changes;
      const changes = Array.isArray(raw)
        ? raw
            .map((c) => {
              const o = (c ?? {}) as { path?: unknown; status?: unknown; added?: unknown; deleted?: unknown; newLines?: unknown };
              return { path: String(o.path ?? ''), status: String(o.status ?? ''), added: typeof o.added === 'number' ? o.added : null, deleted: typeof o.deleted === 'number' ? o.deleted : null, ...(typeof o.newLines === 'number' ? { newLines: o.newLines } : {}) };
            })
            .filter((c) => c.path !== '')
        : undefined;
      return { ...s, entries: replaceAt(s.entries, idx, {
        ...cur,
        ...(typeof p.runSteps === 'number' ? { steps: p.runSteps } : {}),
        ...(typeof p.tokens === 'number' ? { tokens: p.tokens } : {}),
        ...(typeof p.endedTs === 'number' ? { endedTs: p.endedTs } : {}),
        ...(changes !== undefined && changes.length > 0 ? { changes } : {}),
      }) };
    }
    case 'tool-call':
      return onToolCall(s, e);
    case 'tool-result':
      return onToolResult(s, e);
    case 'model-start': {
      const { entries } = sealStreaming(sealThinking(s.entries, e.ts));
      if (s.status !== 'idle') return { ...s, entries, status: 'running' }; // run 内续轮:不重插 run 条、不重置水位
      // 水位重置仅在 run 边界：model-start 每模型轮一次（reactor.ts:450），turnTotal 是 run 级
      // 单调累计（reactor.ts:293）——run 内续轮（status=running）不重置，否则多轮 run tokens 虚增
      // G14.22 轮次顺序=[用户输入]→[Worked 行+分割线]→[工具/回复]:run 条尾插(user 回显先入列
      // 故自然居其后,与回放 seed 同序);Worked 行描述的是其后这段工作
      return {
        ...s,
        entries: [...entries, { key: `run:${entries.length}`, kind: 'run' as const, md: '', streaming: true as const, ts: e.ts, stepsBase: s.steps, tokensBase: s.tokens }],
        status: 'running',
        turnTokensBase: 0,
        turnCacheBase: 0,
      };
    }
    case 'step':
      return { ...s, steps: s.steps + 1 };
    case 'usage':
      return onUsage(s, e);
    case 'delegation-started':
    case 'delegation-ended':
      return { ...s, entries: [...s.entries, { key: `n${s.entries.length}`, kind: 'notice', md: delegationMd(e), ts: e.ts }] };
    case 'agent-message': {
      const p = e.payload as { from?: unknown; to?: unknown; text?: unknown } | undefined;
      const from = typeof p?.from === 'string' && p.from.length > 0 ? p.from : '?';
      const to = typeof p?.to === 'string' && p.to.length > 0 ? p.to : '?';
      return { ...s, entries: [...s.entries, { key: `n${s.entries.length}`, kind: 'notice', md: `[${from} → ${to}] ${typeof p?.text === 'string' ? p.text : ''}`, ts: e.ts }] };
    }
    default:
      return s;
  }
}
