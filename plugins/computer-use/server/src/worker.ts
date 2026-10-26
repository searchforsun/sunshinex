/** PowerShell worker 协议面（plan Task 18）：持久 powershell.exe 子进程，stdin/stdout 行分隔 JSON 按 id 配对。
 *
 *  职责单点：spawn（windowsHide，脚本经 -EncodedCommand 注入——不落盘、不触执行策略、stdin 留给协议通道）、
 *  行回执按 id 配对 resolve/reject、请求串行排队（同一时刻一个在途——桌面输入本就串行语义，后续请求排队）、
 *  stderr 环形缓冲（调试面，上限 200 行，进程退出消息附尾部）、close()（SIGTERM 收口+5s 兜底 kill+等退出）、
 *  进程退出/流错误 → 未决请求全部 reject；close 后调用 op 立即 reject。
 *  错误形态：子包无既有错误类，取最小自定义 WorkerError（code+message，形态沿主仓 CodedToolError）。
 *  协议对端脚本见 worker.ps1.ts；注入消费方见 types.ts WorkerClient（index.ts 生产装配，Task 19 首个真实消费）。 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { WorkerClient } from './types';
import { WORKER_PS1 } from './worker.ps1';

/** worker 域错误：code 三态——worker_op_failed（PS 侧 ok:false 回执，消息透传）/ worker_exit（进程退出或启动失败，未决收口）/ worker_closed（close 后调用）。 */
export class WorkerError extends Error {
  constructor(
    readonly code: 'worker_op_failed' | 'worker_exit' | 'worker_closed',
    message: string,
  ) {
    super(message);
  }
}

/** 子进程最小结构面（createWorker 只依赖此形态；测试注入 fake 无需伪造整个 ChildProcess）。 */
export interface WorkerProc {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: string | number): boolean;
}

/** spawn 注入缝（第二可选参）：生产面走 node child_process.spawn，测试面注入 fake（行回放/乱序回执/进程退出）。 */
export type SpawnFn = (exe: string, args: readonly string[], opts: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => WorkerProc;

const defaultSpawn: SpawnFn = (exe, args, opts) => nodeSpawn(exe, args, opts);

/** stderr 环形缓冲上限（行）——调试面：进程退出消息附尾部，stderrTail() 供诊断取用。 */
const STDERR_RING_MAX = 200;

/** close() 兜底强杀时限（ms）：SIGTERM 后仍存活则 kill 兜底（Windows 下两者皆终止等价，防僵尸进程悬挂 close）。 */
const CLOSE_KILL_AFTER_MS = 5000;

/** 起一个持久 PS worker（exe 缺省 powershell.exe；spawnFn 供测试注入 fake）。
 *  返回 WorkerClient（op 串行排队 + close 收口），另附 stderrTail() 调试面（环形缓冲尾部）。 */
export function createWorker(exe = 'powershell.exe', spawnFn: SpawnFn = defaultSpawn): WorkerClient & { stderrTail(max?: number): string[] } {
  // -NoProfile 免 profile 副作用/杂音输出；-NonInteractive 禁交互提示；-EncodedCommand 不受执行策略约束
  const child = spawnFn(
    exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WORKER_PS1, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  type Pending = { resolve: (v: unknown) => void; reject: (e: WorkerError) => void };
  const pending = new Map<number, Pending>();
  const stderrRing: string[] = [];
  let nextId = 1;
  let closed = false; // close() 已调用（此后 op 立即拒绝）
  let exited = false; // 进程已退出/启动失败（此后 op 立即拒绝）
  let exitErr: WorkerError | null = null;
  let settleExit: () => void = () => {};
  let killTimer: NodeJS.Timeout | null = null;
  const exitDone = new Promise<void>((res) => {
    settleExit = res;
  });

  const pushStderr = (line: string): void => {
    const t = line.replace(/\r+$/, '');
    if (!t.trim()) return;
    stderrRing.push(t);
    if (stderrRing.length > STDERR_RING_MAX) stderrRing.splice(0, stderrRing.length - STDERR_RING_MAX);
  };
  const tailText = (): string => (stderrRing.length > 0 ? `; stderr tail: ${stderrRing.slice(-5).join(' | ')}` : '');

  /** 进程退出/启动失败收口（幂等）：未决请求全部 reject，close() 的等待随之落定。 */
  const settle = (err: WorkerError): void => {
    if (exited) return;
    exited = true;
    exitErr = err;
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    rl.close();
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    settleExit();
  };

  // 流面接线：stderr → 环形缓冲；stdin 写侧错误吞掉进缓冲（对端死后写触发 EPIPE，不破事件循环）
  if (child.stdin && child.stdout && child.stderr) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) pushStderr(line);
    });
    child.stdin.on('error', (err: Error) => {
      pushStderr(`stdin: ${err.message}`);
    });
  }

  // 回执读面：readline 按 \n 切（PS WriteLine 的 \r\n 由 readline 归一）→ 按 id 配对；坏行/未配对回执进缓冲不崩溃
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      pushStderr(`worker: unparsable line: ${line.slice(0, 200)}`);
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : Number.NaN; // 非数 id（含坏回执）永不配对（pending 不存 NaN 键）
    const entry = pending.get(id);
    if (!entry) {
      pushStderr(`worker: response without pending id: ${line.slice(0, 200)}`);
      return;
    }
    pending.delete(id);
    if (msg.ok === true) entry.resolve(msg.result);
    else entry.reject(new WorkerError('worker_op_failed', typeof msg.error === 'string' ? msg.error : `ok:false without error message: ${line.slice(0, 200)}`));
  });

  child.once('exit', (code, signal) => {
    settle(new WorkerError('worker_exit', `worker process exited (code=${code}, signal=${signal})${tailText()}`));
  });
  child.on('error', (err) => {
    settle(new WorkerError('worker_exit', `worker process failed: ${err.message}${tailText()}`));
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    settle(new WorkerError('worker_exit', 'worker spawn produced no stdio pipes'));
  }

  /** 单请求发送（串行队列的执行单元）：id 自增配对，写失败即刻收单。 */
  const send = (op: string, params: Record<string, unknown>): Promise<unknown> => {
    if (closed) return Promise.reject(new WorkerError('worker_closed', 'worker already closed'));
    if (exited) return Promise.reject(exitErr ?? new WorkerError('worker_exit', 'worker process has exited'));
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
      } catch (err) {
        pending.delete(id);
        reject(new WorkerError('worker_exit', `stdin write failed: ${(err as Error).message}`));
      }
    });
  };

  /** 串行队列：chain 首尾相接，前请求落定后下一请求才发送（失败不吃链——后续请求照常排队）。 */
  let chain: Promise<void> = Promise.resolve();
  const op = <T>(opName: string, params: Record<string, unknown>): Promise<T> => {
    const run = (): Promise<T> => send(opName, params) as Promise<T>;
    const result = chain.then(run, run);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const close = async (): Promise<void> => {
    if (closed) {
      await exitDone;
      return;
    }
    closed = true;
    try {
      child.stdin.end(); // stdin EOF → PS 主循环 ReadLine 得 null → 脚本收尾退出（体面路径）
    } catch {
      /* 流已销毁（对端早死）——进程侧收口 */
    }
    try {
      child.kill('SIGTERM'); // Windows 下即终止等价；POSIX 下若 5s 后仍存活由下方 SIGKILL 兜底
    } catch {
      /* 已退出 */
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, CLOSE_KILL_AFTER_MS);
    killTimer.unref(); // 兜底定时器不挂事件循环（进程已死时 close 立即经 exitDone 落定）
    await exitDone;
  };

  return { op, close, stderrTail: (max = 20) => stderrRing.slice(-max) };
}
