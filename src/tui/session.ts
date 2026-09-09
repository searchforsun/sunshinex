import { ApprovalDecision, ApprovalRequest, SessionEvent } from '../types';
import { TuiRuntime, TuiRuntimeOpts, createRuntime } from './runtime';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatItem {
  role: ChatRole;
  text: string;
  ts: number;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error';

export interface TuiState {
  messages: ChatItem[];
  approval?: ApprovalRequest;
  todos: TodoItem[];
  status: SessionStatus;
}

export interface SessionOpts extends TuiRuntimeOpts {
  /** manual 模式审批回调（终端化审批装配点；渲染层注入交互实现） */
  asker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

const SLASH_HELP = '命令：/new 新会话（软重置） · /compact 压缩上下文 · /status 会话与账本摘要 · /help 本清单';

/** 会话控制器：事件进 → 状态变更（渲染层订阅）；斜杠命令解析、FIFO 排队、审批挂起/回填；纯逻辑可独立单测 */
export class SessionController {
  readonly runtime: TuiRuntime;
  private state: TuiState = { messages: [], todos: [], status: 'idle' };
  private listeners = new Set<(s: TuiState) => void>();
  private queue: { goal: string; resolve: () => void }[] = [];
  private pendingApproval?: { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };
  /** 裁决权注入（SessionOpts.asker）：挂起语义不变，回填后咨询并以其为最终裁决 */
  private autoAsker?: (req: ApprovalRequest) => Promise<ApprovalDecision>;

  constructor(opts: SessionOpts) {
    this.runtime = createRuntime({
      root: opts.root,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      onEvent: (e) => this.onEvent(e),
    });
    const suspendAsker = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      // 终端化审批：guard ask → 挂起（awaiting-approval + 审批卡）→ 裁决回填 → 继续；
      // 有外部 asker（headless/脚本）时委托之，状态转换保持一致便于观测与渲染
      this.state = { ...this.state, status: 'awaiting-approval', approval: req };
      this.notify();
      // 挂起等回填（App 模态/测试直调）；opts.asker 为裁决权注入，回填后咨询并以其为最终裁决
      let d = await new Promise<ApprovalDecision>((resolve) => {
        this.pendingApproval = { req, resolve };
      });
      if (this.autoAsker) d = await this.autoAsker(req);
      this.state = { ...this.state, approval: undefined, status: 'running' };
      this.notify();
      return d;
    };
    this.autoAsker = opts.asker;
    if (opts.mode === 'manual') this.runtime.harness.security.setAsker(suspendAsker);
  }

  getState(): TuiState {
    return this.state;
  }

  /** 订阅状态变更（渲染层入口）；返回退订函数 */
  onState(cb: (s: TuiState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 提交输入：斜杠命令即时处理；自然语言任务运行中提交进 FIFO 队列 */
  async submit(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    this.pushMsg('user', text);
    if (this.state.status === 'running' || this.state.status === 'awaiting-approval') {
      this.pushMsg('system', `已排队：${text}`);
      return new Promise<void>((resolve) => this.queue.push({ goal: text, resolve }));
    }
    await this.runTaskFlow(text);
    await this.drainQueue();
  }

  /** 回填当前挂起审批；无挂起时静默忽略 */
  async resolveApproval(d: ApprovalDecision): Promise<void> {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.pendingApproval = undefined;
    this.state = { ...this.state, approval: undefined };
    this.notify();
    pending.resolve(d);
  }

  /** 等待会话回到 idle（队列清空且无挂起审批） */
  async waitIdle(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state.status !== 'idle' || this.pendingApproval) {
      if (Date.now() > deadline) throw new Error('waitIdle 超时');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private async runTaskFlow(goal: string): Promise<void> {
    this.state = { ...this.state, status: 'running' };
    this.notify();
    try {
      await this.runtime.runTask(goal);
    } catch (e) {
      this.pushMsg('system', `发生错误：${e instanceof Error ? e.message : String(e)}`);
      this.state = { ...this.state, status: 'error' };
      this.notify();
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      await this.runTaskFlow(next.goal);
      next.resolve();
    }
    this.state = { ...this.state, status: 'idle' };
    this.notify();
  }

  private async handleSlash(text: string): Promise<void> {
    const cmd = text.split(/\s+/)[0] ?? text;
    if (cmd === '/help') {
      this.pushMsg('system', SLASH_HELP);
      return;
    }
    if (cmd === '/status') {
      const s = this.runtime.harness.ledger.summary();
      this.pushMsg('system', `账本：${s.runs} runs / ${s.tokens} tokens；消息 ${this.state.messages.length} 条；待办 ${this.state.todos.length} 项`);
      return;
    }
    if (cmd === '/new') {
      this.runtime.harness.security.clearSessionAllows();
      this.state = { messages: [], todos: [], status: 'idle' };
      this.pushMsg('system', '软重置：消息与待办已清空，会话级审批登记已清除（记忆与账本保留）');
      return;
    }
    if (cmd === '/compact') {
      // 复用 Reactor 同款窗口压缩链：组装当前上下文 → 压缩 → 重注入（与自动压缩同一机制，手动即时触发）
      const items = this.runtime.harness.context.assemble('', []);
      const chunks = await this.runtime.harness.context.window.compact(items, { summaryTokenBudget: 2000 });
      await this.runtime.harness.context.applyCompaction(chunks, { rereadTokenBudget: 2000 });
      this.pushMsg('system', `已压缩：${chunks.length} 个摘要块重注入`);
      return;
    }
    this.pushMsg('system', `未知命令：${cmd}（/help 查看清单）`);
  }

  private onEvent(e: SessionEvent): void {
    if (e.type === 'tool-result') {
      this.pushMsg('tool', `[${e.payload?.ok ? 'OK' : '失败'}] ${e.text ?? ''}`);
      return;
    }
    if (e.type === 'error') {
      this.pushMsg('system', `错误：${e.text ?? '（无说明）'}`);
      return;
    }
    if (e.type === 'done' && e.text) {
      // token 流式增量首版不上屏（增量渲染为后续增强）；收尾以完整 reply 落消息
      this.pushMsg('assistant', e.text);
    }
  }

  private pushMsg(role: ChatRole, text: string): void {
    this.state = { ...this.state, messages: [...this.state.messages, { role, text, ts: Date.now() }] };
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) cb(this.state);
  }
}
