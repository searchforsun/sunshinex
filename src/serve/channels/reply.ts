/** 出站投影管线(spec 2026-11-21-channels §5):订阅 daemon 帧流,把会话回复按通道投递能力
 *  降级投影回 IM——流式(同气泡全量替换)/分段(缓冲满 maxTextLength 切发)/终稿(done 冲刷)+
 *  终态注记(onRunEnd)与审批挂起文本回退([审批] 投影 + y/n 文本消费)。
 *
 *  裁定(spec §5.1/§5.2 + Task 6 预检):
 *  - 降级链全部在投影器不在适配器(适配器只声明 caps + 实现收发,adapters/types.ts 头注同语义)。
 *  - done 帧负责正文冲刷,onRunEnd 只管终态注记——避免双重发送;done 且零输出不补发(防空消息)。
 *  - done 收尾:流式档补终稿增量 {fullText: buf, done:true}(适配器靠它解除 typing 态/定稿气泡
 *    ——StreamDelta.done 语义定义即此,审查 I-2 裁定补生产者);分段档 done 只冲刷未流出余量;
 *    两档均不重发新消息正文(deliver 面零额外)。
 *  - 审批帧双形消费:契约路 kind==='event' && e.type==='approval-request'(pid 在 e.payload.pid);
 *    实际挂起帧形 kind==='approval'(ApprovalFrame——pid 在帧顶层而非 payload,session.ts
 *    pendingFrames() 重连重发同构,摘要取 req.subject)。现状代码无 approval-request 事件发射点
 *    (grep 实证,仅 types.ts:296 词汇),故实际挂起帧形是主路径,契约路留给上层桥接。
 *  - 审批挂起投影按 pid 去重卫语句(审查 I-1;daemon-wire 挂起帧明文「客户端以 pid 去重幂等」
 *    ——WS 重连 pendingFrames 重发/Task 7 双通道齐火同 pid 只投影一次);异 pid 照多挂起
 *    「最新一条覆盖」裁定(pending.set,P0 从简);approval-resolved 事件清挂起
 *    (ApprovalFrame 无 resolved 帧形——回执走 HTTP 端点,消费面靠 pendingReply 与下一条覆盖)。
 *  - ReplyTarget 在本文件定义,router 不 import reply——engine(Task 7)上层接线 pendingReply。
 */
import type { DaemonFrame } from '../daemon-wire';
import type { DeliveryCaps, OutboundMessage } from './model';
import type { StreamDelta } from './adapters/types';

/** 出站投递目标:通道 id + 平台会话标识(与 adapters ChatRef 同构,类型层独立防环) */
export interface ReplyTarget {
  channelId: string;
  chatId: string;
}

/** 投影器依赖注入:engine(Task 7)接线——boundSessions/capsOf 来自 router 绑定表与适配器 caps,
 *  deliver/streamDeliver 落适配器 send/stream,subscribe 挂 daemon 帧流,resolveApproval 接
 *  io.resolveApproval(pid 由投影自帧中提取,engine 只透传决策)。 */
export interface ReplyProjectorDeps {
  boundSessions: () => ReadonlyMap<string, ReplyTarget>;
  capsOf: (channelId: string) => DeliveryCaps | undefined;
  deliver: (t: ReplyTarget, msg: OutboundMessage) => Promise<void>;
  streamDeliver: (t: ReplyTarget, delta: StreamDelta) => Promise<void>;
  subscribe: (cb: (frame: DaemonFrame) => void) => () => void;
  resolveApproval: (pid: string, decision: { approved: boolean; feedback?: string }) => boolean;
  log?: (s: string) => void;
}

/** 审批挂起投影条:pid 为 daemon 级回执寻址键(ApprovalFrame/契约路 payload.pid 同源) */
interface PendingApproval {
  pid: string;
  target: ReplyTarget;
}

/** 本轮正文缓冲状态:buf 为未流出余量(流式档每 token 全量流出后即空语义由 flushed 承载,
 *  分段档满额切发后清空续积);flushed=本轮正文是否已全量流出(流式档置真——done 不重发) */
interface RunBuf {
  target: ReplyTarget;
  buf: string;
  flushed: boolean;
}

/** capsOf 缺档兜底:保守降级(不流式/纯文本/4000,数值与 mock 缺省档同源) */
const FALLBACK_CAPS: DeliveryCaps = { streaming: false, markdown: false, card: false, maxTextLength: 4000 };

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

export class ReplyProjector {
  private readonly deps: ReplyProjectorDeps;
  private unsubscribe: (() => void) | null = null;
  private readonly runs = new Map<string, RunBuf>();
  /** sessionId → 审批挂起投影(多挂起并存取最新一条,P0 从简) */
  private readonly pending = new Map<string, PendingApproval>();

  constructor(deps: ReplyProjectorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.deps.subscribe((f) => this.onFrame(f));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.runs.clear(); // 挂起 pending 表保留:stop 只摘帧订阅,IM 回复消费面(pendingReply)仍在座
  }

  /** 一轮收尾注记(router 每轮提交后注册,executor.ts schedules/executor.ts:104 同款一次性观察者):
   *  done/缺省 → 零注记(done 帧已负责正文冲刷,零输出不补发防空消息);interrupted → 「任务已停止」;
   *  其它 → 「任务失败: <stopReason>」。顺带清同目标残留正文缓冲,下一轮干净起步。 */
  async onRunEnd(t: ReplyTarget, info: { stopReason?: string }): Promise<void> {
    for (const [sid, st] of this.runs) {
      if (st.target.channelId === t.channelId && st.target.chatId === t.chatId) this.runs.delete(sid);
    }
    const reason = info.stopReason;
    if (reason === 'done') return;
    const text = reason === 'interrupted' ? '任务已停止' : reason !== undefined ? `任务失败: ${reason}` : '任务失败';
    await this.safeDeliver(t, { text });
  }

  /** 审批文本回退消费面(router 截胡路):trim 后 y/yes/n/no(大小写不敏感)且挂起在场 →
   *  先清座再调 resolveApproval 回执 → true(文本已按 y/n 语义消费,不回模型)。
   *  resolveApproval 抛错/返回假均不回滚清座——pid 失效(已在他路回执)时保留挂起只会卡死
   *  该会话后续回复;真重复回执由 daemon 回执端点幂等兜底。 */
  pendingReply(sessionId: string, text: string): boolean {
    const norm = text.trim().toLowerCase();
    const approved = YES.has(norm) ? true : NO.has(norm) ? false : undefined;
    if (approved === undefined) return false;
    const p = this.pending.get(sessionId);
    if (p === undefined) return false;
    this.pending.delete(sessionId);
    try {
      this.deps.resolveApproval(p.pid, { approved });
    } catch (e) {
      this.log(`resolveApproval(${p.pid}) 异常吞错: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }

  /** 帧分派(同步回调面,投递 fire-and-forget + 吞错):仅四类会话事件 + 实际挂起帧形消费 */
  private onFrame(f: DaemonFrame): void {
    if (f.kind === 'approval') {
      // 实际挂起帧形:pid 在帧顶层(session.ts pendingFrames() 同形),摘要取 req.subject
      this.onApprovalRequest(f.sessionId, f.pid, f.req.subject);
      return;
    }
    if (f.kind !== 'event') return;
    const { sessionId, e } = f;
    switch (e.type) {
      case 'token':
        this.onToken(sessionId, e.text);
        return;
      case 'done':
        this.onDone(sessionId);
        return;
      case 'approval-request': {
        // 契约路:pid 取 e.payload.pid(现状无发射点,grep 实证——字段名按词汇约定预留,上层桥接按此构造)
        const pid = e.payload?.['pid'];
        if (typeof pid !== 'string' || pid === '') {
          this.log(`approval-request(${sessionId}) 缺 payload.pid,无法寻址回执,跳过投影`);
          return;
        }
        const payloadSubject = e.payload?.['subject'];
        const summary = typeof payloadSubject === 'string' && payloadSubject !== '' ? payloadSubject : (e.text ?? '');
        this.onApprovalRequest(sessionId, pid, summary);
        return;
      }
      case 'approval-resolved':
        this.pending.delete(sessionId);
        return;
      default:
        return;
    }
  }

  /** 降级链 §5.1 第 1 条:token 缓冲累积;streaming → 每帧全量替换流出;否则满额分段切发 */
  private onToken(sessionId: string, text: string | undefined): void {
    if (typeof text !== 'string' || text === '') return;
    const target = this.deps.boundSessions().get(sessionId);
    if (target === undefined) return;
    const caps = this.deps.capsOf(target.channelId) ?? FALLBACK_CAPS;
    let st = this.runs.get(sessionId);
    if (st === undefined) {
      st = { target, buf: '', flushed: false };
      this.runs.set(sessionId, st);
    }
    st.buf += text;
    if (caps.streaming) {
      st.flushed = true; // 正文随本帧全量替换流出,done 不重发
      void this.safeStream(target, { fullText: st.buf, done: false });
    } else if (st.buf.length >= caps.maxTextLength) {
      void this.safeDeliver(target, this.bodyMsg(st.buf, caps));
      st.buf = ''; // 清缓冲续积(flushed 保持假——余量语义由 buf 空否承载)
    }
  }

  /** 降级链 §5.1 第 2 条:done 收尾——流式档补终稿增量(fullText 全量 + done:true,适配器解除
   *  typing 态/定稿气泡,审查 I-2 裁定);分段档冲刷未流出余量(非空才发)。均不重发新消息正文。 */
  private onDone(sessionId: string): void {
    const st = this.runs.get(sessionId);
    if (st === undefined) return;
    this.runs.delete(sessionId);
    if (st.flushed) {
      // 流式档:正文已全量在流,done 只发终稿增量收尾信号(buf 恒非空,空守卫防未来路径)
      if (st.buf !== '') void this.safeStream(st.target, { fullText: st.buf, done: true });
      return;
    }
    if (st.buf === '') return; // 分段档:非空才冲刷
    const caps = this.deps.capsOf(st.target.channelId) ?? FALLBACK_CAPS;
    void this.safeDeliver(st.target, this.bodyMsg(st.buf, caps));
  }

  /** 降级链 §5.2 第 4 条:审批挂起投影 → 「[审批] <摘要>,回复 y / n」+ 记挂起。
   *  pid 去重卫语句(审查 I-1):pending 已有同 pid → 跳过 deliver(WS 重连 pendingFrames 重发/
   *  双通道齐火防重复面);异 pid 照「最新一条覆盖」裁定。 */
  private onApprovalRequest(sessionId: string, pid: string, summary: string): void {
    const target = this.deps.boundSessions().get(sessionId);
    if (target === undefined) return;
    const existed = this.pending.get(sessionId);
    if (existed !== undefined && existed.pid === pid) return;
    this.pending.set(sessionId, { pid, target });
    void this.safeDeliver(target, { text: `[审批] ${summary},回复 y / n` });
  }

  /** markdown 降级:caps.markdown 才带标,否则纯文本(注记/审批投影恒纯文本) */
  private bodyMsg(text: string, caps: DeliveryCaps): OutboundMessage {
    return caps.markdown ? { text, markdown: true } : { text };
  }

  /** 投递吞错面:deliver/streamDeliver 任一异常(同步/异步)不击穿帧处理,log 落痕 */
  private async safeDeliver(t: ReplyTarget, msg: OutboundMessage): Promise<void> {
    try {
      await this.deps.deliver(t, msg);
    } catch (e) {
      this.log(`deliver(${t.channelId}/${t.chatId}) 失败吞错: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async safeStream(t: ReplyTarget, delta: StreamDelta): Promise<void> {
    try {
      await this.deps.streamDeliver(t, delta);
    } catch (e) {
      this.log(`streamDeliver(${t.channelId}/${t.chatId}) 失败吞错: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private log(s: string): void {
    this.deps.log?.(s);
  }
}
