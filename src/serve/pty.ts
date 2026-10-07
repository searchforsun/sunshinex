import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

/**
 * 通用 pty 会话管理（G8b 终端目录 T2）：daemon 终端路由的进程面单点——spawn 建条目、
 * 64KB 环形缓冲供 WS 重放（T3 专用重放帧消费）、resize/write 直通、kill 幂等、
 * `killAllFor(owner)` 供 daemon dispose/teardown 按会话锚批量清杀（防孤儿 conpty）。
 * 本层零 daemon 依赖：纯进程管理，id/owner 均由调用方（daemon）铸造与解释。
 */

/** spawn 入参（daemon 传入；`owner` 为 daemon 会话 id——killAllFor 的清杀锚） */
export interface PtySpawnOptions {
  readonly file: string; readonly args: readonly string[];
  readonly cwd: string; readonly cols: number; readonly rows: number;
  readonly owner: string;                      // 会话 id(daemon 传入)——killAllFor 锚
  readonly env?: Readonly<Record<string, string>>;
}

/** 会话句柄（T3 消费面；onExit 触发后条目自动注销——has→false，句柄自身仍可安全调用） */
export interface PtySession {
  readonly id: string;
  write(data: string): void;                   // UTF-8 直写(输入链)
  resize(cols: number, rows: number): void;
  kill(): void;
  replay(): string;                            // 环形缓冲尾部(UTF-8 文本,≤ RING_LIMIT chars)
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;    // 触发后自动注销条目(has→false)
}

/** 重放环形缓冲上限（chars）：终端回滚即够用，超限即丢头保尾 */
export const RING_LIMIT = 65536;

/**
 * win32 收口所需的 node-pty 1.1.0 内部形（仅 ConPTY 收口用，全部可选——内部结构变更时
 * 自动退化为 no-op 而非崩溃；非 win32 平台不触达）
 */
interface WinPtyAgentInternals {
  readonly _inSocket?: { destroy?: () => void };
  readonly _conoutSocketWorker?: { dispose?: () => void };
}

/** PtySession 实现：环形缓冲 + 多订阅回调数组 + exit 注销回-manager */
class PtySessionImpl implements PtySession {
  readonly id: string;
  private readonly proc: IPty;
  private readonly unregister: () => void;
  private ring = '';
  private readonly dataCbs: Array<(data: string) => void> = [];
  private readonly exitCbs: Array<(code: number) => void> = [];
  private exited = false;
  private killedByUs = false;

  constructor(id: string, proc: IPty, unregister: () => void) {
    this.id = id;
    this.proc = proc;
    this.unregister = unregister;
    proc.onData((data) => {
      this.ring += data;
      if (this.ring.length > RING_LIMIT) this.ring = this.ring.slice(-RING_LIMIT);
      for (const cb of this.dataCbs) cb(data);
    });
    proc.onExit(({ exitCode }) => this.handleExit(exitCode));
  }

  write(data: string): void {
    if (this.exited) return;                   // 死会话静默：写已毁 socket 会炸出流错误
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;                   // conpty 已 exit 后 resize 会 throw(agent 守卫)
    this.proc.resize(cols, rows);
  }

  kill(): void {
    if (this.exited || this.killedByUs) return; // 幂等（重复 kill/kill 后 exit 双触达均静默）
    this.killedByUs = true;
    this.unregister();                         // 同步摘条目：killAllFor 后 size 即归零（不等 exit 事件）
    this.proc.kill();                          // exit 事件仍会异步送达 onExit 订阅者
  }

  replay(): string {
    return this.ring;
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    this.exitCbs.push(cb);
  }

  private handleExit(exitCode: number): void {
    if (this.exited) return;                   // conpty 双发兜底(exit 事件仅一次,防御性)
    this.exited = true;
    this.unregister();                         // 注销先行：onExit 回调内 has 已→false
    for (const cb of this.exitCbs) cb(exitCode);
    this.closeConptyIfNeeded();
  }

  /**
   * win32 ConPTY 收口（防事件循环滞留）：node-pty 1.1.0 自然退出路径只毁 outSocket
   * （约 1s flush 延迟后），conout worker 线程（常驻 named-pipe server）与 inSocket 从不
   * 释放——进程会永挂（G8b-T1 冒烟 exit 124 即此因）。kill 路径 node-pty 自会 dispose，
   * 故仅在自然退出（!killedByUs）时补刀：destroy inSocket + dispose conout worker
   * （后者 1s drain 后 worker.terminate()）。全部走可选内部形：探测不到即跳过。
   */
  private closeConptyIfNeeded(): void {
    if (process.platform !== 'win32' || this.killedByUs) return;
    try {
      const agent = (this.proc as unknown as { _agent?: WinPtyAgentInternals })._agent;
      agent?._inSocket?.destroy?.();
      agent?._conoutSocketWorker?.dispose?.();
    } catch {
      // 收口尽力而为：失败不反噬 exit 通知链
    }
  }
}

/** pty 会话注册表：id → 会话；条目内联 owner 供 killAllFor 反查 */
interface PtyEntry {
  readonly owner: string;
  readonly session: PtySessionImpl;
}

/** PtyManager：daemon 持有的 pty 总注册表（spawn/get/ownerOf/has/kill/killAllFor/size） */
export class PtyManager {
  private readonly sessions = new Map<string, PtyEntry>();

  /** spawn 真进程建条目；id 撞名 throw（不先建进程，防泄漏） */
  spawn(id: string, opts: PtySpawnOptions): PtySession {
    if (this.sessions.has(id)) throw new Error(`pty id exists: ${id}`);
    const proc = pty.spawn(opts.file, [...opts.args], {
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      name: 'xterm-256color',                  // xterm.js 前端对齐(T7);win32 仅装饰,unix 注入 TERM
      env: opts.env ? { ...opts.env } : undefined,
    });
    const session = new PtySessionImpl(id, proc, () => { this.sessions.delete(id); });
    this.sessions.set(id, { owner: opts.owner, session });
    return session;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id)?.session;
  }

  /** owner 反查（G8e-T4 daemon ptyId↔会话归属校验面）：条目在 → owner（daemon 会话 id）；
   *  不在/已注销 → undefined。只读不杀——跨会话误删/误连的判归在 daemon 路由层收口 */
  ownerOf(id: string): string | undefined {
    return this.sessions.get(id)?.owner;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  kill(id: string): void {
    this.sessions.get(id)?.session.kill();     // 无此 id 静默(幂等)
  }

  /** 该 owner（daemon 会话）全部 kill——dispose/teardown 消费；条目随 kill 同步摘除，exit 事件异步送达订阅者 */
  killAllFor(owner: string): void {
    for (const entry of this.sessions.values()) {
      if (entry.owner === owner) entry.session.kill();
    }
  }

  /** 活跃条目数（测试断言清杀净） */
  get size(): number {
    return this.sessions.size;
  }
}
