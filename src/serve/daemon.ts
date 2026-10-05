import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { createRuntime, TuiRuntime } from '../tui/runtime';
import { ModelAdapter } from '../model/adapter';
import { SessionEvent } from '../types';

/** GUI daemon 构造面：root 为项目目录；model 与 CLI buildModel/TUI 同源注入（三面同一 ModelAdapter 契约） */
export interface GuiDaemonOpts {
  root: string;
  model: ModelAdapter;
}

/** start 入参：port 缺省 0（临时端口，返回实际监听值）；token 缺省随机 24 字节 hex（规格 §4.3） */
export interface GuiDaemonStartOpts {
  port?: number;
  token?: string;
}

/** start 回执：port 为实际监听端口；close 与 GuiDaemon.close 同一幂等收口 */
export interface GuiDaemonHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

/** 单 run 锁的在场票据：abort 句柄持有即「运行中」，run 收束（含中断/失败）即清位 */
interface CurrentRun {
  abort: AbortController;
}

/** JSON body 上限（1MB）：防无界 body 撑爆 daemon 内存；超限即断连收口 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * GUI daemon 核心（spec §3）：HTTP 控制面 + 会话生命周期。装配零旁路——与 TUI 同一 `createRuntime`
 * 单点（mode 恒 dontAsk：GUI v1 无终端交互面，审批/问询走回执端点，T3 接线），`harness` 公开面
 * （tasks/pipeline/mcpClose）只在 teardown 消费。HTTP 面（本任务）：healthz 免鉴权 + submit/interrupt
 * 经 Bearer token 鉴权（§4.3：仅回环 + token，远程暴露为 v1 非目标）。WS 事件泵随 T2 落地，本任务
 * 仅就位 onEvent 注入点（pump 占位缓冲）。
 */
export class GuiDaemon {
  private readonly runtime: TuiRuntime;
  private current?: CurrentRun;
  private server?: http.Server;
  /** 幂等收口：首调落链，后续调用复用同一 Promise（close 链只走一遍） */
  private closePromise?: Promise<void>;
  /** 事件泵占位缓冲（T2 完整化为 WS 广播 + 有界环形缓冲）：onEvent 注入点本任务就位，事件不丢 */
  private readonly eventBuffer: SessionEvent[] = [];
  /** 单 run 锁外窥（测试/后续 /snapshot 消费）：current 在场即 running */
  readonly status: () => 'idle' | 'running' = () => (this.current ? 'running' : 'idle');

  constructor(opts: GuiDaemonOpts) {
    this.runtime = createRuntime({
      root: opts.root,
      model: opts.model,
      mode: 'dontAsk',
      onEvent: (e) => this.pump(e),
    });
  }

  /** 事件泵（T2 前占位）：本任务只入缓冲；T2 换广播 + 环形缓冲（重连补发窗口），注入点不变 */
  private pump(e: SessionEvent): void {
    this.eventBuffer.push(e);
  }

  /**
   * 启动 HTTP 控制面：恒绑 127.0.0.1（§4.3 裁定——远程暴露为 v1 非目标，bind 面=鉴权面的第一道）；
   * port 0 = 系统分配临时端口，回执返回实际监听值（测试并行不撞口）。
   */
  async start(opts?: GuiDaemonStartOpts): Promise<GuiDaemonHandle> {
    const token = opts?.token ?? crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => this.dispatch(req, res, token));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts?.port ?? 0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('GuiDaemon: listen address unavailable');
    return { port: addr.port, token, close: () => this.close() };
  }

  /** 幂等 teardown：http server close → tasks.stopAll → pipeline drain → mcpClose（序同 CLI teardownCliRun 现场，
   *  HTTP 面先行关闭——不再接受新请求后再动运行时内脏；细节裁定见各步骤行内注释） */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.teardown();
    return this.closePromise;
  }

  private async teardown(): Promise<void> {
    // 1) HTTP server 先收：close 停接新连接，closeAllConnections 掐掉存活的 keep-alive 空闲连接——
    //    否则 undici 连接池的滞留套接字会让 close 回调悬到超时，teardown 时序不可控
    const srv = this.server;
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
    }
    // 2) 停全部后台任务（同 CLI D24 理由：任务执行体先停、通道后关，stopAll 同步纯本地记账不抛）
    this.runtime.harness.tasks.stopAll();
    // 3) 排空后台沉淀管线（此时无新入队源，drain 即终态）
    await this.runtime.harness.pipeline.drain();
    // 4) MCP 连接收口：关闭 stdio 子进程，防悬挂事件循环
    await this.runtime.harness.mcpClose();
  }

  /** 内部路由表（本任务三端点；/steer、/snapshot、静态资源随 T2/T3 增补，不另起分发机制） */
  private readonly routes: ReadonlyArray<{ method: string; path: string; auth: boolean; run: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> }> = [
    { method: 'GET', path: '/healthz', auth: false, run: async (_req, res) => this.send(res, 200, { ok: true }) },
    { method: 'POST', path: '/submit', auth: true, run: (req, res) => this.handleSubmit(req, res) },
    { method: 'POST', path: '/interrupt', auth: true, run: async (_req, res) => this.handleInterrupt(res) },
  ];

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = this.routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (!route) {
      // T3 收口为带 hint 的静态缺失提示；本任务简单 404
      this.send(res, 404, { error: 'not found' });
      return;
    }
    // 鉴权（§4.3）：除 healthz 外恒验 Bearer token——恒时比较不做（token 非密钥材料，回环面时序侧信道无实义）
    if (route.auth && req.headers.authorization !== `Bearer ${token}`) {
      this.send(res, 401, { error: 'unauthorized' });
      return;
    }
    route.run(req, res).catch((err) => {
      console.error('[serve] handler error:', err);
      if (!res.headersSent) this.send(res, 500, { error: 'internal error' });
      else res.end();
    });
  }

  /** body 读取 + JSON 解析：解析失败/超限统一以 {status, error} 回执，不抛出（dispatch 已兜 500，此处提前收口带准确码） */
  private async readJson(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'payload too large' };
      chunks.push(chunk as Buffer);
    }
    try {
      return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { ok: false, status: 400, error: 'invalid json body' };
    }
  }

  private async handleSubmit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJson(req);
    if (!parsed.ok) {
      this.send(res, parsed.status, { error: parsed.error });
      return;
    }
    const goal = (parsed.body as { goal?: unknown } | null)?.goal;
    if (typeof goal !== 'string' || goal.length === 0) {
      this.send(res, 400, { error: 'goal must be a non-empty string' });
      return;
    }
    // 单 run 锁（v1 一 daemon 一会话）：运行中拒新提交（409），不排队——GUI 侧无队列语义，排队会静默吞掉用户意图
    if (this.current) {
      this.send(res, 409, { error: 'run in progress' });
      return;
    }
    const abort = new AbortController();
    this.current = { abort };
    // 202 即回：run 异步走主链入口 runTask（同 TUI /goal 路径），失败吞错转 stderr 日志行（daemon 不因单 run 失败倒面），
    // finally 清锁——中断（stopReason=interrupted）与正常收束同路径清位
    void this.runtime
      .runTask(goal, { signal: abort.signal })
      .catch((err) => console.error('[serve] run failed:', err))
      .finally(() => {
        this.current = undefined;
      });
    this.send(res, 202, { ok: true });
  }

  private handleInterrupt(res: http.ServerResponse): void {
    if (!this.current) {
      this.send(res, 409, { error: 'no run in progress' });
      return;
    }
    // 步边界/在途模型调用经 signal 即刻中止（reactor 既有语义），runTask 以 stopReason=interrupted 收束后 finally 清锁
    this.current.abort.abort();
    this.send(res, 200, { ok: true });
  }

  private send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
