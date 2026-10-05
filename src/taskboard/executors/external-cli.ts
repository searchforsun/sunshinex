/** ExternalCliExecutor(spec §5 P2 external-cli 执行体):外部 CLI 子进程适配——经
 *  sandbox.execBackground 分层拉起 `<command> -p <spec> --output-format stream-json`,
 *  stream-json 行缓冲翻译为 SessionEvent(assistant 文本段→token、tool_use→tool-call、
 *  tool_result→tool-result,统一打 subagent 标)、result 行收结论与 usage、deadline 到点
 *  killBackground 强杀、CLI 拉起失败降级 unavailable。黑盒韧性:解析失败行/未知行忽略,
 *  tool_result 与 tool_use 的 callId 配对按发序 FIFO 尽力而为(外部 CLI 输出非契约面)。
 *  分层口径:board 只依赖 ExternalExecutorLike 最小接口(本文件产),真装配在 harness/index.ts;
 *  本文件只依赖 sandbox/tasks/types/executor 接口,零 board 反向引用(无环)。 */
import type { SessionEvent } from '../../types';
import type { ProcessSandbox } from '../../harness/security/sandbox';
import type { TaskRegistry } from '../../harness/tasks';
import type { Executor } from '../executor';
import type { Inbox } from '../inbox';

/** board 侧最小接口(TaskBoardDeps.externalExecutor 契约):run 单方法,测试可注入 stub */
export interface ExternalExecutorLike {
  run(task: { id: string; title: string; spec: string }, budget: { deadlineAt: number }): Promise<{ ok: boolean; reply: string; tokens: number }>;
}

export interface ExternalCliExecutorDeps {
  sandbox: ProcessSandbox;
  registry: TaskRegistry;
  onEvent?: (e: SessionEvent) => void;
  /** 外部 CLI 命令名,缺省 'claude'(claude code stream-json 方言) */
  command?: string;
}

const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** POSIX 单引号转义('…'\''…' 形态):shell 决议交 sandbox 既有链,引号形态单点在此 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class ExternalCliExecutor implements ExternalExecutorLike, Executor {
  private readonly deps: ExternalCliExecutorDeps;
  private readonly command: string;
  /** 在飞进程 pid(Executor.stop 单点用;单飞假设——board 串行派发,一次一个 run) */
  private currentPid = 0;

  constructor(deps: ExternalCliExecutorDeps) {
    this.deps = deps;
    this.command = deps.command ?? 'claude';
  }

  capabilities() {
    return { contextSource: 'independent' as const, tools: [] as string[], stopGranularity: 'process' as const, budgetModel: 'deadline-coarse' as const };
  }

  async run(task: { id: string; title: string; spec: string }, budget: { deadlineAt: number }): Promise<{ ok: boolean; reply: string; tokens: number }> {
    return this.runWithSink(task, budget, undefined);
  }

  /** Executor P1 接口适配:事件流 = run 翻译事件经内存队列透出(单消费者假设),conclusion$ = run 终值,
   *  stop = 在飞进程强杀(kill 后迟到 onExit 经 exit promise 自然收口) */
  start(task: { id: string; spec: string; title: string }, _inbox: Inbox): {
    events$: AsyncIterable<SessionEvent>;
    conclusion$: Promise<{ ok: boolean; reply: string; tokens: number }>;
    stop(): Promise<void>;
  } {
    const queued: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const sink = (e: SessionEvent): void => {
      queued.push(e);
      wake?.();
    };
    const events$: AsyncIterable<SessionEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SessionEvent>> => {
          while (queued.length === 0 && !closed) {
            await new Promise<void>((res) => { wake = res; });
          }
          const value = queued.shift();
          return value === undefined ? { value: undefined, done: true } : { value, done: false };
        },
      }),
    };
    const conclusion$ = this.runWithSink(task, { deadlineAt: Date.now() + DEFAULT_DEADLINE_MS }, sink).finally(() => {
      closed = true;
      wake?.();
    });
    return { events$, conclusion$, stop: async () => { this.stopCurrent(); } };
  }

  /** 核心执行:登账 → 拉起 → 行缓冲翻译流 → exit/deadline 竞速 → 收口(台账 finish + 终值) */
  private async runWithSink(
    task: { id: string; title: string; spec: string },
    budget: { deadlineAt: number },
    extraSink?: (e: SessionEvent) => void,
  ): Promise<{ ok: boolean; reply: string; tokens: number }> {
    const subagent = `external-${task.id}`;
    const emit = (e: SessionEvent): void => {
      this.deps.onEvent?.(e);
      extraSink?.(e);
    };
    // 登账本:external 任务在 executor 内部自持(board external 分支 finishExecution 不带 ledgerId)
    const ledgerTask = this.deps.registry.submit({ kind: 'exec', label: subagent });
    let conclusion: string | undefined;
    let tokensSoFar = 0;
    let toolCallSeq = 0;
    const pendingCallIds: string[] = [];
    let buffer = '';
    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return; // 解析失败行忽略(黑盒韧性)
      }
      if (!isObj(obj)) return;
      if (obj.type === 'assistant' && isObj(obj.message)) {
        const content = obj.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!isObj(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            emit({ type: 'token', text: block.text, payload: { subagent }, ts: Date.now() });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            toolCallSeq += 1;
            const callId = `ext-${toolCallSeq}`;
            pendingCallIds.push(callId);
            emit({ type: 'tool-call', text: block.name, payload: { input: block.input, callId, subagent }, ts: Date.now() });
          }
        }
        return;
      }
      if (obj.type === 'user' && isObj(obj.message)) {
        const content = obj.message.content;
        if (!Array.isArray(content)) return;
        if (!content.some((b) => isObj(b) && b.type === 'tool_result')) return;
        const callId = pendingCallIds.shift();
        if (callId === undefined) return; // 无配对 tool_use 的结果行丢弃(FIFO 尽力配对,黑盒降级容忍)
        emit({ type: 'tool-result', text: JSON.stringify(content).slice(0, 200), payload: { ok: true, callId, subagent }, ts: Date.now() });
        return;
      }
      if (obj.type === 'result') {
        if (typeof obj.result === 'string') conclusion = obj.result;
        const usage = isObj(obj.usage) ? obj.usage : {};
        tokensSoFar = (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0)
          + (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0);
      }
      // 其他行类型忽略(system/ping 等)
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
        nl = buffer.indexOf('\n');
      }
      // 尾半行留存,待下一 chunk 拼接(跨 chunk 撕裂行缓冲)
    };
    let exitCode: number | undefined;
    let settleExit: (code: number) => void = () => {};
    const exited = new Promise<number>((res) => { settleExit = res; });
    const onExit = (code: number): void => {
      exitCode = code;
      settleExit(code);
    };
    // 拉起:throw 与 Result fail 均降级 unavailable(CLI 不在 PATH 等)
    let pid = 0;
    try {
      const spawned = await this.deps.sandbox.execBackground(
        `${this.command} -p ${shellQuote(task.spec)} --output-format stream-json`,
        { onData, onExit },
      );
      if (!spawned.ok) {
        return this.settle(ledgerTask.id, { ok: false, reply: `external executor unavailable: ${spawned.error.message}`, tokens: 0 });
      }
      pid = spawned.value.pid;
      this.currentPid = pid;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.settle(ledgerTask.id, { ok: false, reply: `external executor unavailable: ${msg}`, tokens: 0 });
    }
    // deadline 竞速:exit promise vs 定时器(deadline 已过 → 0ms,仍让出事件循环;exit 已决则微任务先行胜出)
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutOutcome = new Promise<'timeout'>((res) => {
      timeoutId = setTimeout((): void => res('timeout'), Math.max(0, budget.deadlineAt - Date.now()));
      timeoutId.unref?.();
    });
    const outcome = await Promise.race([exited.then((): 'exit' => 'exit'), timeoutOutcome]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (this.currentPid === pid) this.currentPid = 0;
    if (outcome === 'timeout') {
      this.deps.sandbox.killBackground(pid); // 进程树收割(sandbox 单点);迟到的 onExit 幂等无害
      return this.settle(ledgerTask.id, { ok: false, reply: 'external executor timed out', tokens: tokensSoFar });
    }
    const finished = exitCode === 0 && conclusion !== undefined;
    return this.settle(ledgerTask.id, { ok: finished, reply: conclusion ?? '(no conclusion)', tokens: tokensSoFar });
  }

  /** 台账收口 + 终值单点:ok → done 带 conclusion marker(与 board P1 路径口径对称);fail → failed */
  private settle(ledgerId: string, r: { ok: boolean; reply: string; tokens: number }): { ok: boolean; reply: string; tokens: number } {
    if (r.ok) {
      this.deps.registry.finish(ledgerId, 'done', { marker: `[conclusion] ${r.reply}\n` });
    } else {
      this.deps.registry.finish(ledgerId, 'failed');
    }
    return r;
  }

  /** stop 单点:杀在飞进程(kill 后 sandbox 经 onExit 收口,run 自然终值) */
  private stopCurrent(): void {
    if (this.currentPid > 0) {
      this.deps.sandbox.killBackground(this.currentPid);
      this.currentPid = 0;
    }
  }
}
