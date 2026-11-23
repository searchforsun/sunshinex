/** 出站投影管线(spec 2026-11-21-channels §5):订阅 daemon 帧流,把会话回复按通道投递能力
 *  降级投影回 IM——流式(同气泡全量替换)/分段(缓冲满 maxTextLength 切发)/终稿(done 冲刷)+
 *  终态注记(onRunEnd)与挂起文本回退([审批]/[提问] 投影 + y/n 与自由文本消费)。
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
 *  - 挂起投影三型裁定(spec §5.2 三型 approval/ask/plan-approval;2026-11-22 终审修复波 F1):
 *    **ask 先行**——AskFrame(daemon-wire.ts,pid 帧顶层,req=AskUserRequest 原件,session.ts
 *    suspendAsk 广播/pendingFrames 重发同形)同 approval 路径投影「[提问] <question>(1. x / 2. y),
 *    回复序号或内容」,pending 同表复用(按 sessionId+kind 判别);回执走 daemon ask 单点
 *    resolveAsk(pid, AskUserAnswer)(POST /ask/:pid/reply 内部方法)。**plan-approval 随 P3 打磨**
 *    (P3=流式投影打磨期,spec §11——卡片面与计划书全文投影形态一并裁定,文本回退届时补)。
 *  - 审批/提问挂起投影按 pid 去重卫语句(审查 I-1;daemon-wire 挂起帧明文「客户端以 pid 去重幂等」
 *    ——WS 重连 pendingFrames 重发/Task 7 双通道齐火同 pid 只投影一次);异 pid 照多挂起
 *    「最新一条覆盖」裁定(pending.set,P0 从简);approval-resolved 事件清挂起
 *    (ApprovalFrame 无 resolved 帧形——回执走 HTTP 端点,消费面靠 pendingReply 与下一条覆盖)。
 *  - 陈座提示(终审修复波 F3):pendingReply 回执返回假=pid 已在他路回执(GUI 已处理,daemon 只
 *    pump notice 无 resolved 帧)→ safeDeliver「已在他处处理」提示给原目标,只补反馈不广播;
 *    回执抛错沿用吞错旧语义(异常≠他路回执,状态未知不误导)。
 *  - 终态武装补漏(终审修复波 F2):排队 steer 收尾的内部续跑(session.ts 轮收尾 steerTakePending
 *    → 内部 submit)不经 router.onSubmitted,该轮无终态武装——投影器在 token/done 帧补调可选
 *    deps.ensureArmed(engine 透传 armRunEnd,armed-once 位天然幂等);armedSeen Set 去重(每会话
 *    每轮首帧一次,done 轮界清位——续跑轮链式排队也能逐轮重补,stop 全清)。
 *  - ReplyTarget 在本文件定义,router 不 import reply——engine(Task 7)上层接线 pendingReply。
 */
import type { DaemonFrame } from '../daemon-wire';
import type { AskUserAnswer, AskUserRequest } from '../../types';
import { CHANNEL_MAX_TEXT_LENGTH } from './model';
import type { DeliveryCaps, OutboundMessage } from './model';
import type { StreamDelta } from './adapters/types';

/** 出站投递目标:通道 id + 平台会话标识(与 adapters ChatRef 同构,类型层独立防环) */
export interface ReplyTarget {
  channelId: string;
  chatId: string;
}

/** 投影器依赖注入:engine(Task 7)接线——boundSessions/capsOf 来自 router 绑定表与适配器 caps,
 *  deliver/streamDeliver 落适配器 send/stream,subscribe 挂 daemon 帧流,resolveApproval 接
 *  io.resolveApproval、resolveAsk 接 io.resolveAsk(pid 由投影自帧中提取,engine 只透传决策/回答) */
export interface ReplyProjectorDeps {
  boundSessions: () => ReadonlyMap<string, ReplyTarget>;
  capsOf: (channelId: string) => DeliveryCaps | undefined;
  deliver: (t: ReplyTarget, msg: OutboundMessage) => Promise<void>;
  streamDeliver: (t: ReplyTarget, delta: StreamDelta) => Promise<void>;
  subscribe: (cb: (frame: DaemonFrame) => void) => () => void;
  resolveApproval: (pid: string, decision: { approved: boolean; feedback?: string }) => boolean;
  /** ask 挂起回执单点(F1,三型裁定 ask 先行):daemon POST /ask/:pid/reply 内部方法
   *  resolveAsk(pid, AskUserAnswer) 同参透传——三态铸形在投影器(askAnswerOf) */
  resolveAsk: (pid: string, answer: AskUserAnswer) => boolean;
  /** 终态武装补漏(F2,可选):排队续跑轮不经 router.onSubmitted——投影器 token/done 帧补调,
   *  engine 透传 armRunEnd(armed-once 位幂等);缺席=不补(窄桩) */
  ensureArmed?: (sessionId: string, target: ReplyTarget) => void;
  log?: (s: string) => void;
}

/** 挂起投影条(spec §5.2 双型:approval/ask——plan-approval 随 P3 打磨):pid 为 daemon 级回执
 *  寻址键(ApprovalFrame/AskFrame/契约路 payload.pid 同源);req 仅 ask 型留存(回答铸形原料) */
interface PendingEntry {
  kind: 'approval' | 'ask';
  pid: string;
  target: ReplyTarget;
  req?: AskUserRequest;
}

/** 本轮正文缓冲状态:buf 为未流出余量(流式档每 token 全量流出后即空语义由 flushed 承载,
 *  分段档满额切发后清空续积);flushed=本轮正文是否已全量流出(流式档置真——done 不重发) */
interface RunBuf {
  target: ReplyTarget;
  buf: string;
  flushed: boolean;
}

/** capsOf 缺档兜底:保守降级(不流式/纯文本/长度帽单点) */
const FALLBACK_CAPS: DeliveryCaps = { streaming: false, markdown: false, card: false, maxTextLength: CHANNEL_MAX_TEXT_LENGTH };

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

export class ReplyProjector {
  private readonly deps: ReplyProjectorDeps;
  private unsubscribe: (() => void) | null = null;
  private readonly runs = new Map<string, RunBuf>();
  /** sessionId → 挂起投影条(approval/ask 双型,spec §5.2;多挂起并存取最新一条,P0 从简) */
  private readonly pending = new Map<string, PendingEntry>();
  /** 已补调 ensureArmed 的会话期去重位(F2):每会话每轮首帧一次——done 帧轮界清位(续跑轮链式
   *  排队逐轮重补),stop 全清 */
  private readonly armedSeen = new Set<string>();

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
    this.armedSeen.clear(); // F2 武装去重位全清:重启后绑定会话首帧重补武装
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

  /** 挂起文本消费面(router 截胡路)。approval 型:trim 后 y/yes/n/no(大小写不敏感)→ y/n 回执,
   *  其余文本不消费(返回 false,照常走提交分派);ask 型(F1,spec §5.2 三型裁定 ask 先行):
   *  **自由文本恒受理**——铸形规则见 askAnswerOf(y→首选项/n→放弃/序号→选项/原文→选项/其余→custom)。
   *  回执单点:approval→deps.resolveApproval(ApprovalDecision 翻译在 daemon io 注入层),ask→
   *  deps.resolveAsk(AskUserAnswer 三态,daemon POST /ask/:pid/reply 内部方法同参)。
   *  返回假=pid 已在他路回执(GUI 先处理,daemon 只 pump notice 无 resolved 帧——F3 审批陈座)→
   *  safeDeliver「已在他处处理」提示给原目标(只补反馈不广播);抛错沿用吞错旧语义(异常≠他路
   *  回执,回执状态未知不提示误导)。先清座再回执,回执落空/抛错均不回滚清座——pid 失效时保留
   *  挂起只会卡死该会话后续回复;真重复回执由 daemon 回执端点幂等兜底。恒返回 true(文本已被
   *  挂起语义消费,不回模型)。 */
  pendingReply(sessionId: string, text: string): boolean {
    const p = this.pending.get(sessionId);
    if (p === undefined) return false;
    const norm = text.trim().toLowerCase();
    if (p.kind === 'ask') {
      const answer = this.askAnswerOf(p.req ?? { question: '', options: [] }, text, norm);
      return this.consumePending(sessionId, p.pid, p.target, '该提问已在他处处理', () => this.deps.resolveAsk(p.pid, answer));
    }
    const approved = YES.has(norm) ? true : NO.has(norm) ? false : undefined;
    if (approved === undefined) return false;
    return this.consumePending(sessionId, p.pid, p.target, '该审批已在他处处理', () => this.deps.resolveApproval(p.pid, { approved }));
  }

  /** 回执消费单点:先清座再回执(清座不回滚,见 pendingReply 注);返回假 → 陈座提示(F3);
   *  抛错吞错落痕返回 true */
  private consumePending(sessionId: string, pid: string, target: ReplyTarget, staleText: string, resolve: () => boolean): boolean {
    this.pending.delete(sessionId);
    try {
      if (resolve()) return true;
    } catch (e) {
      this.log(`resolvePending(${pid}) 异常吞错: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
    void this.safeDeliver(target, { text: staleText });
    return true;
  }

  /** ask 回答铸形(AskUserAnswer 三态,G4):y/yes → 首选项(第 1 项 selected;无选项回落 custom
   *  原文);n/no → dismissed;整数序号(1 起,越界不命中)→ 该项 selected;**逗号分隔序号 →
   *  多选**(2026-11-23 用户裁定「多选的识别方式是逗号,如 1,2」——在范围内的序号逐项入选,
   *  labels 数组原生承载;全部越界 → 落自由文本);选项原文(trim+大小写不敏感)→ selected;
   *  其余自由文本 → custom 原文(trim) */
  private askAnswerOf(req: AskUserRequest, raw: string, norm: string): AskUserAnswer {
    const trimmed = raw.trim();
    if (YES.has(norm)) {
      const first = req.options[0];
      return first !== undefined ? { type: 'selected', labels: [first.label] } : { type: 'custom', text: trimmed };
    }
    if (NO.has(norm)) return { type: 'dismissed' };
    const idx = /^\d+$/.test(norm) ? Number.parseInt(norm, 10) : NaN;
    const byIndex = Number.isInteger(idx) && idx >= 1 && idx <= req.options.length ? req.options[idx - 1] : undefined;
    if (byIndex !== undefined) return { type: 'selected', labels: [byIndex.label] };
    // 逗号分隔序号 → 多选（全半角逗号+空白容忍;范围内逐项入选,保出现序去重;全越界回落自由文本）
    if (/^\d{1,4}(?:\s*[，,]\s*\d{1,4})*$/.test(norm)) {
      const picked: string[] = [];
      for (const part of norm.split(/[，,]/)) {
        const n = Number.parseInt(part.trim(), 10);
        const opt = Number.isInteger(n) && n >= 1 && n <= req.options.length ? req.options[n - 1] : undefined;
        if (opt !== undefined && !picked.includes(opt.label)) picked.push(opt.label);
      }
      if (picked.length > 0) return { type: 'selected', labels: picked };
    }
    const byLabel = req.options.find((o) => o.label.trim().toLowerCase() === norm);
    if (byLabel !== undefined) return { type: 'selected', labels: [byLabel.label] };
    return { type: 'custom', text: trimmed };
  }

  /** 帧分派(同步回调面,投递 fire-and-forget + 吞错):仅四类会话事件 + 实际挂起帧形消费 */
  private onFrame(f: DaemonFrame): void {
    if (f.kind === 'approval') {
      // 实际挂起帧形:pid 在帧顶层(session.ts pendingFrames() 同形),摘要取 req.subject
      this.onApprovalRequest(f.sessionId, f.pid, f.req.subject);
      return;
    }
    if (f.kind === 'ask') {
      // ask 挂起帧形(F1,daemon-wire.ts AskFrame——pid 帧顶层,req=AskUserRequest 原件;
      // session.ts suspendAsk 广播/pendingFrames 重连重发同形)
      this.onAskRequest(f.sessionId, f.pid, f.req);
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

  /** 降级链 §5.1 第 1 条:token 缓冲累积;streaming → 每帧全量替换流出;否则满额分段切发。
   *  终态武装补漏(F2):绑定会话首帧补调 ensureArmed(排队续跑轮不经 onSubmitted 的终态缺口) */
  private onToken(sessionId: string, text: string | undefined): void {
    if (typeof text !== 'string' || text === '') return;
    const target = this.deps.boundSessions().get(sessionId);
    if (target === undefined) return;
    this.maybeArm(sessionId, target);
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
   *  typing 态/定稿气泡,审查 I-2 裁定);分段档冲刷未流出余量(非空才发)。均不重发新消息正文。
   *  终态武装补漏(F2,done 档):零输出轮(无 token 帧)的失败终态注记仍须送达——done 帧先于
   *  run 收尾 finally 泵入,此刻补武装的观察者仍能收到本轮终态;随后 armedSeen 轮界清位,
   *  续跑轮(链式排队,内部 submit 不经 onSubmitted)首帧重补武装 */
  private onDone(sessionId: string): void {
    const st = this.runs.get(sessionId);
    if (st !== undefined) {
      this.runs.delete(sessionId);
      if (st.flushed) {
        // 流式档:正文已全量在流,done 只发终稿增量收尾信号(buf 恒非空,空守卫防未来路径)
        if (st.buf !== '') void this.safeStream(st.target, { fullText: st.buf, done: true });
      } else if (st.buf !== '') {
        // 分段档:非空才冲刷
        const caps = this.deps.capsOf(st.target.channelId) ?? FALLBACK_CAPS;
        void this.safeDeliver(st.target, this.bodyMsg(st.buf, caps));
      }
    }
    const target = this.deps.boundSessions().get(sessionId);
    if (target !== undefined) this.maybeArm(sessionId, target);
    this.armedSeen.delete(sessionId);
  }

  /** F2 武装补漏单点:armedSeen 去重(每会话每轮首帧一次,不逐帧重调)+ ensureArmed 缺席跳过;
   *  engine 透传 armRunEnd——armed-once 位天然幂等,武装位在场时引擎侧自跳过 */
  private maybeArm(sessionId: string, target: ReplyTarget): void {
    if (this.deps.ensureArmed === undefined || this.armedSeen.has(sessionId)) return;
    this.armedSeen.add(sessionId);
    this.deps.ensureArmed(sessionId, target);
  }

  /** 降级链 §5.2:审批挂起投影 → 「[审批] <摘要>,回复 y / n」+ 记挂起。
   *  pid 去重卫语句(审查 I-1):pending 已有同 pid → 跳过 deliver(WS 重连 pendingFrames 重发/
   *  双通道齐火防重复面);异 pid 照「最新一条覆盖」裁定。 */
  private onApprovalRequest(sessionId: string, pid: string, summary: string): void {
    const target = this.deps.boundSessions().get(sessionId);
    if (target === undefined) return;
    const existed = this.pending.get(sessionId);
    if (existed !== undefined && existed.pid === pid) return;
    this.pending.set(sessionId, { kind: 'approval', pid, target });
    void this.safeDeliver(target, { text: `[审批] ${summary},回复 y / n` });
  }

  /** 降级链 §5.2 三型之一(F1,ask 先行——plan-approval 随 P3 流式打磨,spec §5.2/§11):
   *  **多行无标识格式**(2026-11-23 用户裁定「去掉[提问]标识」+「问题一行,每个选项一行」+
   *  「多选识别方式是逗号,提示 回复序号(多选如1,2)或内容」):`<question>\n1. x\n2. y\n
   *  回复序号(多选如 1,2)或内容`(req.multiple 才带多选样例;无选项 → 尾行「回复内容」)
   *  + 记挂起(同审批:pid 去重卫语句,异 pid 最新覆盖)。回执消费见 pendingReply ask 分支
   *  (自由文本恒受理,序号/逗号多选/原文/custom 铸形)。 */
  private onAskRequest(sessionId: string, pid: string, req: AskUserRequest): void {
    const target = this.deps.boundSessions().get(sessionId);
    if (target === undefined) return;
    const existed = this.pending.get(sessionId);
    if (existed !== undefined && existed.pid === pid) return;
    this.pending.set(sessionId, { kind: 'ask', pid, target, req });
    const lines: string[] = [req.question];
    for (let i = 0; i < req.options.length; i++) lines.push(`${i + 1}. ${req.options[i]!.label}`);
    lines.push(
      req.options.length === 0
        ? '回复内容'
        : req.multiple === true
          ? '回复序号（多选如 1,2）或内容'
          : '回复序号或内容',
    );
    void this.safeDeliver(target, { text: lines.join('\n') });
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
