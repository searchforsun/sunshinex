import { ExecResult, ToolCallSpec } from '../types';
import { Result } from '../result';
import { ToolRegistry } from './tools';
import { SafetyChain } from './security/chain';
import { PARALLEL_TOOLS_LIMIT } from './prompts/shared';

/** 批次重复上限：同一批次集合签名最多执行 2 次（首次 + 原样重试一次），超限整批程序性拒绝——防模型同批死循环空烧（与稳定段异常收敛行配套） */
const MAX_IDENTICAL_CALLS = 2;
/** 批次计数过期间隔：距末次同批次已拉开 N 步即视为过期清零——早期试错不永久封死后续合法调用 */
const IDENTICAL_CALL_EXPIRY_STEPS = 4;

/** 批次面事件旁路口（窄化为批次仅有的两类事件：tool-call 挂起预告 / tool-result 逐结果回发）——
 *  只收函数不收 Reactor 实例，抽出件可独立钉测；ts 盖点由注入方（Reactor.emit）单点负责 */
export type BatchEventEmit = (type: 'tool-call' | 'tool-result', text: string, payload: Record<string, unknown>) => void;

/** 批次结果记账口（整块注入）：观察行入链 + read/grep 成功后的文件追踪——
 *  链与上下文归 Reactor 所有，BatchRunner 只按约定回发、不持记账面 */
export interface BatchLedger {
  /** 观察行入链（出牌顺序、批后统一回放——与完成序即发的 tool-result 事件两口径） */
  resultRow: (observation: string) => void;
  /** read/grep 真实成功结果的文件追踪（recentFiles LRU） */
  trackFile: (path: string) => void;
}

/** 单批次执行入参：calls=模型出牌原文，argsOf=出牌消费面已解析的入参（坏参 null），step=当前轮步号 */
interface BatchRunInput {
  calls: ToolCallSpec[];
  argsOf: (Record<string, unknown> | null)[];
  step: number;
  ledger: BatchLedger;
}

/** 批次执行器（chatRound 抽件，普查 H5）：批次签名去重 + 串行/超限政策 + 串/并发扇出 + 逐结果回发。
 *  显式依赖注入（registry/safety/事件旁路口），不捕 Reactor 实例——批次语义独立可测；消息装配与出牌消费留在 chatRound */
export class BatchRunner {
  constructor(private deps: { registry: ToolRegistry; safety: SafetyChain; emit: BatchEventEmit }) {}

  /** 批次重复计数（批次集合签名 → 已执行次数 + 末次步号）：实例级、每 run 起点由调用方 reset——程序侧异常收敛兜底 */
  private batchCounts = new Map<string, { count: number; lastStep: number }>();

  /** run 边界重置：批次计数按 run 隔离（跨任务不累计） */
  reset(): void {
    this.batchCounts.clear();
  }

  async runBatch(input: BatchRunInput): Promise<void> {
    const { calls, argsOf, step, ledger } = input;
    // 执行面校验（参数 schema 表达不了的跨调用约束）：批内含状态类调用（前后有序依赖）→ 整轮按出牌顺序串行执行，
    // 保证先到的调用完成后后者才开跑、副作用顺序与模型意图一致；仅超上限仍拒绝。单调用不限
    // （todo_write 不在独占集：毫秒级全量替换写、与调研/委派类调用无序依赖，独占会连带整批委派串行）
    const overLimit = calls.length > PARALLEL_TOOLS_LIMIT;
    const exclusive = (c: ToolCallSpec) => {
      const cat = this.deps.registry.get(c.name)?.category;
      return cat === 'bash' || cat === 'ask' || cat === 'worktree' || cat === 'task' || cat === undefined;
    };
    const sequential = calls.length > 1 && calls.some(exclusive);
    const rejection = overLimit
      ? `Parallel batch rejected: exceeds the limit of ${PARALLEL_TOOLS_LIMIT} tools; use fewer calls per round`
      : '';

    // 轮内事件计账 id：步号+批内序位合成（事件旁路口径，链行不携带）
    const callIds = calls.map((_, i) => `step:${step}-idx:${i}`);

    // 批次重复护栏：签名 = 整批调用的集合标识（成员「工具名+参数」规范化后排序拼接，与出牌顺序无关）；
    // 同一集合标识的批次全链路最多执行 3 次，超限整批程序性拒绝——病理形态是「整批原样重发」，
    // 集合口径下单调用正常复用不受影响（集合不同即计数独立），实例级计数、每 run 起点由调用方 reset
    const signatureOf = (name: string, args: Record<string, unknown> | null): string => {
      const canon = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(canon);
        if (v !== null && typeof v === 'object') {
          return Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]);
        }
        return v;
      };
      return `${name}:${JSON.stringify(args === null ? null : canon(args))}`;
    };
    const batchSig = calls.map((c, i) => signatureOf(c.name, argsOf[i])).sort().join('|');
    const prev = this.batchCounts.get(batchSig);
    // 过期策略：距末次同批次调用已拉开 N 步 → 视为新意图重新计数（跨任务段的正常重复不永久封死）
    const n = prev !== undefined && step - prev.lastStep <= IDENTICAL_CALL_EXPIRY_STEPS ? prev.count : 0;
    const batchRejected = n >= MAX_IDENTICAL_CALLS;
    this.batchCounts.set(batchSig, { count: n + 1, lastStep: step });
    const overDuplicated: boolean[] = calls.map(() => batchRejected);
    // 整批超限跳过实际执行，拒绝观察行统一在下方结果循环产出

    // 调用行先行上屏（执行前发射：长工具执行中调用行即可见，TUI 实时性契约）
    for (let i = 0; i < calls.length; i++) {
      this.deps.emit('tool-call', calls[i].name, { input: argsOf[i] ?? {}, callId: callIds[i], status: 'pending' });
    }

    if (overLimit) {
      for (let i = 0; i < calls.length; i++) {
        this.deps.emit('tool-result', rejection.slice(0, 200), { ok: false, full: rejection, tool: calls[i].name, callId: callIds[i], status: 'failed' });
        ledger.resultRow(rejection);
      }
      return;
    }

    const runOne = (c: ToolCallSpec, args: Record<string, unknown> | null) =>
      args === null ? null : this.deps.registry.execute(c.name, args, this.deps.safety);

    // 纯并行批（无状态类调用）整批并发；含状态类调用的批按出牌顺序串行——前一个完成后后者才开跑；同参超限调用跳过执行。
    // 结果事件回程即发（活动行实时清行——批内最长调用不再拖住其余调用的结果呈现）；
    // 链行仍按出牌顺序入链（role:tool 与调用行按位配对），事件流为瞬态呈现、链行为事实源
    const results: (Result<ExecResult> | null)[] = new Array(calls.length).fill(null);
    const obsOf: string[] = new Array(calls.length);
    const emitResult = (i: number, c: ToolCallSpec, args: Record<string, unknown> | null, r: Result<ExecResult> | null): void => {
      const obs = overDuplicated[i]
        ? 'Repeated identical batch rejected: this exact set of calls already ran ' +
          MAX_IDENTICAL_CALLS +
          ' times and was skipped this round (not executed)'
        : args === null || r === null
          ? 'Tool call "' + c.name + '" arguments are not valid JSON: ' + c.argsJson.slice(0, 200) + ' — fix the arguments and retry'
          : describe(r);
      this.deps.emit('tool-result', obs.slice(0, 200), { ok: r !== null && r.ok, full: obs, tool: c.name, callId: callIds[i], status: r !== null && r.ok ? 'completed' : 'failed' });
      obsOf[i] = obs;
    };
    if (sequential) {
      for (let i = 0; i < calls.length; i++) {
        if (overDuplicated[i]) { emitResult(i, calls[i], argsOf[i], null); continue; }
        const r = await runOne(calls[i], argsOf[i]);
        results[i] = r;
        emitResult(i, calls[i], argsOf[i], r);
      }
    } else {
      await Promise.all(calls.map(async (c, i) => {
        if (overDuplicated[i]) { emitResult(i, c, argsOf[i], null); return; }
        const r = await runOne(c, argsOf[i]);
        results[i] = r;
        emitResult(i, c, argsOf[i], r);
      }));
    }
    // 批后记账（出牌顺序）：观察行入链 + read/grep 成功结果文件追踪——经 ledger 回调整块承载
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const args = argsOf[i];
      const r = results[i];
      ledger.resultRow(obsOf[i]);
      if (r !== null && r.ok && (c.name === 'read' || c.name === 'grep')) {
        const p = (args as { path?: unknown } | null)?.path;
        if (typeof p === 'string' && p.length > 0) ledger.trackFile(p);
      }
    }
    // 整批全拒只回写现象观察行（工具结果行已完整呈现拒绝事实），不发旁路事件——
    // 系统层再报一次即同事实双报（TUI 渲染成 ✗ 错误红行）；被拒步骤可跳过，
    // 续跑/换路/收束的判断权在模型
  }
}

/** 执行结果→观察行：stdout/stderr 兜底 ok、超 2000 截断；失败行 code 前缀去重（仅批次面消费，随抽件搬移） */
function describe(r: Result<ExecResult>): string {
  if (r.ok) {
    const out = r.value.stdout || r.value.stderr || 'ok';
    return out.length > 2000 ? `${out.slice(0, 2000)}\n...(truncated)` : out;
  }
  return r.error.message.startsWith(r.error.code) ? r.error.message : `${r.error.code}: ${r.error.message}`;
}
