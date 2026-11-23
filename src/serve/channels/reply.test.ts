/** 出站投影管线测试(spec 2026-11-21-channels §5,Task 6 简报 ①~⑦ 逐条):subscribe 桩存回调,
 *  测试直接投合成 DaemonFrame 驱动降级链;deliver/streamDeliver/resolveApproval 全桩收集断言。
 *  ⑥b 补一条实际挂起帧形(ApprovalFrame,pid 在帧顶层——session.ts pendingFrames() 同形)用例;
 *  ⑥c 补同 pid 重发去重用例(审查 I-1);① 按 I-2 裁定钉 done 终稿增量。
 *  终审修复波(2026-11-22):⑥d ask 挂起帧投影(F1,spec §5.2 三型裁定 ask 先行);⑥e 审批/提问
 *  陈座提示(F3);⑨ ensureArmed 续跑轮终态武装补漏(F2,projector 面——engine 面 engine.test ⑤)。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyProjector } from './reply';
import type { ReplyProjectorDeps, ReplyTarget } from './reply';
import type { DaemonFrame } from '../daemon-wire';
import type { DeliveryCaps, OutboundMessage } from './model';
import type { StreamDelta } from './adapters/types';
import type { AskUserAnswer } from '../../types';

const TARGET: ReplyTarget = { channelId: 'm1', chatId: 'c1' };

/** 等微任务排空:fire-and-forget 投递桩体同步落账,drain 兜底异步实现 */
async function drain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

interface Harness {
  p: ReplyProjector;
  push: (f: DaemonFrame) => void;
  delivered: Array<{ t: ReplyTarget; msg: OutboundMessage }>;
  streamed: Array<{ t: ReplyTarget; delta: StreamDelta }>;
  resolved: Array<{ pid: string; decision: { approved: boolean; feedback?: string } }>;
  askResolved: Array<{ pid: string; answer: AskUserAnswer }>;
  armed: Array<{ sessionId: string; target: ReplyTarget }>;
  logs: string[];
  /** 回执桩返回值/抛错开关(F3 陈座用例:false=pid 已在他路回执;throw=回执异常吞错路) */
  state: { resolveOk: boolean; askOk: boolean; throwAsk: boolean };
}

/** 桩依赖面:与 ReplyProjectorDeps 交叉(实现前新面先行入桩——交叉型允许超集字段,实现后自然并轨) */
type TestDeps = ReplyProjectorDeps & {
  resolveAsk: (pid: string, answer: AskUserAnswer) => boolean;
  ensureArmed?: (sessionId: string, target: ReplyTarget) => void;
};

function makeHarness(over: Partial<DeliveryCaps> = {}): Harness {
  const caps: DeliveryCaps = { streaming: false, markdown: true, card: false, maxTextLength: 20, ...over };
  const bound = new Map<string, ReplyTarget>([['s1', TARGET]]);
  const delivered: Array<{ t: ReplyTarget; msg: OutboundMessage }> = [];
  const streamed: Array<{ t: ReplyTarget; delta: StreamDelta }> = [];
  const resolved: Array<{ pid: string; decision: { approved: boolean; feedback?: string } }> = [];
  const askResolved: Array<{ pid: string; answer: AskUserAnswer }> = [];
  const armed: Array<{ sessionId: string; target: ReplyTarget }> = [];
  const logs: string[] = [];
  const state = { resolveOk: true, askOk: true, throwAsk: false };
  let sink: ((f: DaemonFrame) => void) | null = null;
  const deps: TestDeps = {
    boundSessions: () => bound,
    capsOf: () => caps,
    deliver: async (t, msg) => {
      delivered.push({ t, msg });
    },
    streamDeliver: async (t, delta) => {
      streamed.push({ t, delta });
    },
    subscribe: (cb) => {
      sink = cb;
      return () => {
        sink = null;
      };
    },
    resolveApproval: (pid, decision) => {
      resolved.push({ pid, decision });
      return state.resolveOk;
    },
    resolveAsk: (pid, answer) => {
      askResolved.push({ pid, answer });
      if (state.throwAsk) throw new Error('ask resolve boom');
      return state.askOk;
    },
    ensureArmed: (sessionId, target) => {
      armed.push({ sessionId, target });
    },
    log: (s) => {
      logs.push(s);
    },
  };
  const p = new ReplyProjector(deps);
  p.start();
  return { p, push: (f) => sink?.(f), delivered, streamed, resolved, askResolved, armed, logs, state };
}

let seq = 0;
/** 合成事件帧:e 增量字段直接摊开(text/payload);type 钉字面量并集(SessionEventType 子集) */
type TestEvType = 'token' | 'done' | 'approval-request' | 'approval-resolved';
function evf(sessionId: string, e: { type: TestEvType; text?: string; payload?: Record<string, unknown> }): DaemonFrame {
  return { kind: 'event', sessionId, seq: ++seq, e: { ...e, ts: 0 } };
}
const token = (sessionId: string, text: string): DaemonFrame => evf(sessionId, { type: 'token', text });
const done = (sessionId: string): DaemonFrame => evf(sessionId, { type: 'done' });
const approvalReq = (sessionId: string, pid: string, subject: string): DaemonFrame =>
  evf(sessionId, { type: 'approval-request', payload: { pid, subject } });

test('① streaming caps:token×3 → streamDeliver 3 次全量替换,末次含全文;done 补终稿增量(done:true 全量)零额外 deliver', async () => {
  const h = makeHarness({ streaming: true });
  h.push(token('s1', '你'));
  h.push(token('s1', '好'));
  h.push(token('s1', '呀'));
  await drain();
  assert.equal(h.streamed.length, 3);
  assert.deepEqual(h.streamed.map((x) => x.delta.fullText), ['你', '你好', '你好呀']); // 同气泡全量替换
  assert.ok(h.streamed.every((x) => x.delta.done === false));
  h.push(done('s1'));
  await drain();
  assert.equal(h.streamed.length, 4); // 末次为终稿增量(审查 I-2:适配器解除 typing 态/定稿气泡)
  assert.deepEqual(h.streamed[3]!.delta, { fullText: '你好呀', done: true });
  assert.equal(h.delivered.length, 0); // done 不重发新消息正文(deliver 面零额外)
});

test('② 非 streaming:缓冲满 maxTextLength 分段;done 冲刷尾段', async () => {
  const h = makeHarness(); // 缺省 maxTextLength=20
  h.push(token('s1', 'a'.repeat(20))); // 满 → 立即分段
  await drain();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]!.msg.text, 'a'.repeat(20));
  h.push(token('s1', 'bb')); // 清缓冲续积
  h.push(token('s1', 'cc'));
  await drain();
  assert.equal(h.delivered.length, 1); // 未满不发
  h.push(done('s1')); // 冲刷尾段
  await drain();
  assert.equal(h.delivered.length, 2);
  assert.equal(h.delivered[1]!.msg.text, 'bbcc');
});

test('③ 未绑定 sessionId 帧忽略', async () => {
  const h = makeHarness({ streaming: true });
  h.push(token('sX', 'x'));
  h.push(done('sX'));
  h.push(approvalReq('sX', 'p9', '删库'));
  await drain();
  assert.equal(h.streamed.length, 0);
  assert.equal(h.delivered.length, 0);
  assert.equal(h.p.pendingReply('sX', 'y'), false);
  assert.equal(h.resolved.length, 0);
});

test('④ onRunEnd:interrupted → 终态注记;done → 零注记零补发;其它原因 → 任务失败注记', async () => {
  const h = makeHarness();
  await h.p.onRunEnd(TARGET, { stopReason: 'interrupted' });
  await drain();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]!.msg.text, '任务已停止');

  const h2 = makeHarness();
  h2.push(token('s1', '残留缓冲')); // done 帧负责正文,onRunEnd 零注记不补发
  await h2.p.onRunEnd(TARGET, { stopReason: 'done' });
  await drain();
  assert.equal(h2.delivered.length, 0);

  const h3 = makeHarness();
  await h3.p.onRunEnd(TARGET, { stopReason: 'error-crash' });
  await drain();
  assert.equal(h3.delivered.length, 1);
  assert.equal(h3.delivered[0]!.msg.text, '任务失败: error-crash');
});

test('⑤ markdown=false → OutboundMessage 不带 markdown 标;true → 带', async () => {
  const h = makeHarness({ markdown: false });
  h.push(token('s1', '正文'));
  h.push(done('s1'));
  await drain();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]!.msg.markdown, undefined);

  const h2 = makeHarness({ markdown: true });
  h2.push(token('s1', '正文'));
  h2.push(done('s1'));
  await drain();
  assert.equal(h2.delivered[0]!.msg.markdown, true);
});

test('⑥ approval-request 帧 → deliver 含「[审批]」;pendingReply y/yes/n/no 消费并调 resolve', async () => {
  const h = makeHarness();
  h.push(approvalReq('s1', 'p1', '运行 rm -rf /tmp/x'));
  await drain();
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0]!.msg.text.includes('[审批]'));
  assert.ok(h.delivered[0]!.msg.text.includes('运行 rm -rf /tmp/x'));
  assert.ok(h.delivered[0]!.msg.text.includes('y / n'));
  assert.equal(h.p.pendingReply('s1', ' Y '), true); // trim + 大小写不敏感
  assert.deepEqual(h.resolved, [{ pid: 'p1', decision: { approved: true } }]);
  assert.equal(h.p.pendingReply('s1', 'y'), false); // 已消费,二次不命中
  assert.equal(h.resolved.length, 1);

  // n / no / 无关词三分支:no → approved false;yes → true;无关词不消费
  const h2 = makeHarness();
  h2.push(approvalReq('s1', 'p2', '格式化磁盘'));
  assert.equal(h2.p.pendingReply('s1', '随便说说'), false);
  assert.equal(h2.resolved.length, 0);
  assert.equal(h2.p.pendingReply('s1', 'n'), true);
  assert.deepEqual(h2.resolved, [{ pid: 'p2', decision: { approved: false } }]);
  h2.push(approvalReq('s1', 'p3', '再批一个')); // 多挂起并存取最新一条(P0 从简裁定)
  assert.equal(h2.p.pendingReply('s1', 'yes'), true);
  assert.deepEqual(h2.resolved[1], { pid: 'p3', decision: { approved: true } });
});

test('⑥b 实际挂起帧形 ApprovalFrame(pid 在帧顶层,session.ts pendingFrames 同形)同投影', async () => {
  const h = makeHarness();
  h.push({ kind: 'approval', sessionId: 's1', pid: 'pW', req: { id: 'r1', kind: 'command', subject: 'ls -la' } });
  await drain();
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0]!.msg.text.includes('[审批]'));
  assert.ok(h.delivered[0]!.msg.text.includes('ls -la'));
  assert.equal(h.p.pendingReply('s1', 'no'), true);
  assert.deepEqual(h.resolved, [{ pid: 'pW', decision: { approved: false } }]);
});

test('⑥c 同 pid approval-request 重发去重:deliver 只一次,pending 仍在;异 pid 照最新覆盖', async () => {
  const h = makeHarness();
  h.push(approvalReq('s1', 'pD', '删除文件'));
  h.push(approvalReq('s1', 'pD', '删除文件')); // WS 重连 pendingFrames 重发/双通道齐火同 pid(审查 I-1)
  await drain();
  assert.equal(h.delivered.length, 1); // 同 pid 去重,只投影一次
  assert.equal(h.p.pendingReply('s1', 'y'), true); // 挂起仍在,可正常消费
  assert.deepEqual(h.resolved, [{ pid: 'pD', decision: { approved: true } }]);
  h.push(approvalReq('s1', 'pE', '再批一个')); // 异 pid → 「最新一条覆盖」照常投影
  await drain();
  assert.equal(h.delivered.length, 2);
  assert.equal(h.p.pendingReply('s1', 'n'), true);
  assert.deepEqual(h.resolved[1], { pid: 'pE', decision: { approved: false } });
});

test('⑦ approval-resolved 帧 → pending 清空,此后 pendingReply 恒 false', async () => {
  const h = makeHarness();
  h.push(approvalReq('s1', 'p1', '待批'));
  h.push(evf('s1', { type: 'approval-resolved' }));
  assert.equal(h.p.pendingReply('s1', 'y'), false);
  assert.equal(h.resolved.length, 0);
});

test('⑧ deliver/streamDeliver 抛错吞错 + log,不击穿帧处理', async () => {
  const bound = new Map<string, ReplyTarget>([['s1', TARGET]]);
  const logs: string[] = [];
  let sink: ((f: DaemonFrame) => void) | null = null;
  const p = new ReplyProjector({
    boundSessions: () => bound,
    capsOf: () => ({ streaming: false, markdown: true, card: false, maxTextLength: 5 }),
    deliver: async () => {
      throw new Error('send boom');
    },
    streamDeliver: async () => {
      throw new Error('stream boom');
    },
    subscribe: (cb) => {
      sink = cb;
      return () => {
        sink = null;
      };
    },
    resolveApproval: () => {
      throw new Error('resolve boom');
    },
    resolveAsk: () => true, // ⑧ 不涉 ask 路,桩仅满足 deps 形(回执抛错吞错语义已由 ⑥e h4 覆盖)
    log: (s) => {
      logs.push(s);
    },
  });
  const push = (f: DaemonFrame): void => sink?.(f); // 闭包面投帧(规避 TS 对回调赋值的 null 收窄)
  p.start();
  push(token('s1', 'a'.repeat(6))); // 满 → 分段 deliver 抛错(吞错 log 1)
  push(token('s1', 'b')); // 续积
  push(done('s1')); // 尾段冲刷 deliver 抛错(吞错 log 2)
  push(approvalReq('s1', 'pE', '批准')); // 审批投影 deliver 抛错(吞错 log 3),挂起照记
  await drain();
  assert.equal(logs.length, 3);
  assert.equal(p.pendingReply('s1', 'y'), true); // resolve 抛错吞错(log 4),消费面不击穿
  assert.equal(logs.length, 4);
});

/** 合成 ask 挂起帧(AskFrame,daemon-wire.ts:31——pid 帧顶层,req=AskUserRequest 原件) */
const askFrame = (sessionId: string, pid: string, question: string, options: string[], multiple?: boolean): DaemonFrame => ({
  kind: 'ask',
  sessionId,
  pid,
  req: { question, options: options.map((label) => ({ label })), ...(multiple === true ? { multiple: true } : {}) },
});

test('⑥d ask 挂起帧投影(F1,spec §5.2 三型裁定 ask 先行):无标识多行文案(问题/逐行选项/指引);pendingReply 序号/逗号多选/选项原文/自由文本/y/n 全受理落 resolveAsk', async () => {
  const h = makeHarness();
  h.push(askFrame('s1', 'pA', '用哪个方案?', ['A 方案', 'B 方案']));
  await drain();
  assert.equal(h.delivered.length, 1);
  // 无 [提问] 标识(2026-11-23 用户裁定「去掉[提问]标识」)+多行格式(「问题一行,每个选项一行」)
  assert.ok(h.delivered[0]!.msg.text.startsWith('用哪个方案?'));
  assert.ok(h.delivered[0]!.msg.text.includes('1. A 方案'));
  assert.ok(!h.delivered[0]!.msg.text.includes('[提问]'));
  assert.ok(h.delivered[0]!.msg.text.includes('用哪个方案?\n1. A 方案\n2. B 方案\n回复序号或内容'));
  assert.ok(h.delivered[0]!.msg.text.includes('序号')); // 「回复序号或内容」指引
  // ① 选项序号回执(1 起,trim 容忍)
  assert.equal(h.p.pendingReply('s1', ' 2 '), true);
  assert.deepEqual(h.askResolved, [{ pid: 'pA', answer: { type: 'selected', labels: ['B 方案'] } }]);
  assert.equal(h.resolved.length, 0); // ask 挂起不误落审批回执

  // ①b 逗号多选(2026-11-23 用户裁定「多选的识别方式是逗号,如 1,2」+multiple 帧尾样例提示)
  const hM = makeHarness();
  hM.push(askFrame('s1', 'pM', '哪些要做?', ['甲', '乙', '丙'], true));
  await drain();
  assert.ok(hM.delivered[0]!.msg.text.includes('回复序号（多选如 1,2）或内容'), 'multiple 帧=多选样例尾行');
  assert.equal(hM.p.pendingReply('s1', ' 1,3 '), true);
  assert.deepEqual(hM.askResolved, [{ pid: 'pM', answer: { type: 'selected', labels: ['甲', '丙'] } }]);
  // 全半角逗号混排+去重;越界项剔除;仅剩一项也走 selected
  hM.push(askFrame('s1', 'pM2', '再来?', ['X', 'Y'], true));
  assert.equal(hM.p.pendingReply('s1', '1，1，9'), true);
  assert.deepEqual(hM.askResolved[1], { pid: 'pM2', answer: { type: 'selected', labels: ['X'] } });

  // ② 选项原文回执(trim + 大小写不敏感,selected 带原件 label)
  const h2 = makeHarness();
  h2.push(askFrame('s1', 'pB', '继续吗?', ['OK', 'Cancel']));
  assert.equal(h2.p.pendingReply('s1', ' ok '), true);
  assert.deepEqual(h2.askResolved, [{ pid: 'pB', answer: { type: 'selected', labels: ['OK'] } }]);

  // ③ 自由文本 → custom 原样(trim);无选项帧无「序号」指引
  const h3 = makeHarness();
  h3.push(askFrame('s1', 'pC', '用什么名字?', []));
  await drain();
  assert.ok(!h3.delivered[0]!.msg.text.includes('序号'));
  assert.equal(h3.p.pendingReply('s1', ' 就叫太阳 '), true);
  assert.deepEqual(h3.askResolved, [{ pid: 'pC', answer: { type: 'custom', text: '就叫太阳' } }]);

  // ④ y → 首选项(selected 第 1 项);n → dismissed
  const h4 = makeHarness();
  h4.push(askFrame('s1', 'pD', '确认执行?', ['执行', '取消']));
  assert.equal(h4.p.pendingReply('s1', 'y'), true);
  assert.deepEqual(h4.askResolved, [{ pid: 'pD', answer: { type: 'selected', labels: ['执行'] } }]);
  h4.push(askFrame('s1', 'pE', '再问一次?', ['好']));
  assert.equal(h4.p.pendingReply('s1', 'n'), true);
  assert.deepEqual(h4.askResolved[1], { pid: 'pE', answer: { type: 'dismissed' } });

  // ⑤ 无挂起 → 恒 false(自由文本判据只在 ask 挂起在场时截胡)
  const h5 = makeHarness();
  assert.equal(h5.p.pendingReply('s1', '随便聊聊'), false);
  assert.equal(h5.askResolved.length, 0);
});

test('⑥e 审批/提问陈座提示(F3):resolve 返回假(pid 已在 GUI 回执)→ deliver「已在他处处理」给原目标;返回真零提示', async () => {
  // 审批陈座:IM 回 y 被 pendingReply 消费但 resolveApproval 落空 → 提示补反馈
  const h = makeHarness();
  h.push(approvalReq('s1', 'pS', '删除文件'));
  await drain();
  assert.equal(h.delivered.length, 1); // 仅 [审批] 投影
  h.state.resolveOk = false; // GUI 已先回执——daemon 侧 resolveApproval 返回假
  assert.equal(h.p.pendingReply('s1', 'y'), true);
  await drain();
  assert.equal(h.delivered.length, 2);
  assert.equal(h.delivered[1]!.t, TARGET); // 只给原目标,不广播
  assert.ok(h.delivered[1]!.msg.text.includes('已在他处处理'));

  // 正常路径(resolve 返回真)零提示
  const h2 = makeHarness();
  h2.push(approvalReq('s1', 'pT', '再删一个'));
  assert.equal(h2.p.pendingReply('s1', 'n'), true);
  await drain();
  assert.equal(h2.delivered.length, 1);

  // ask 陈座同构
  const h3 = makeHarness();
  h3.push(askFrame('s1', 'pU', '问点啥?', []));
  await drain();
  assert.equal(h3.delivered.length, 1); // [提问] 投影
  h3.state.askOk = false;
  assert.equal(h3.p.pendingReply('s1', '随便'), true);
  await drain();
  assert.equal(h3.delivered.length, 2);
  assert.ok(h3.delivered[1]!.msg.text.includes('已在他处处理'));

  // resolve 抛错沿用旧语义:吞错不提示(异常≠他路回执,回执状态未知不误导用户)
  const h4 = makeHarness();
  h4.push(askFrame('s1', 'pV', '抛错问?', []));
  await drain();
  assert.equal(h4.delivered.length, 1);
  h4.state.throwAsk = true;
  assert.equal(h4.p.pendingReply('s1', '答'), true);
  await drain();
  assert.equal(h4.delivered.length, 1); // 仅投影,无陈座提示
  assert.ok(h4.logs.some((s) => s.includes('吞错')));
});

test('⑨ 终态武装补漏(F2,projector 面):绑定会话 token 首帧调 ensureArmed 一次;done 轮界清位重调;stop 全清;未绑定不调', async () => {
  const h = makeHarness();
  h.push(token('s1', 'a'));
  h.push(token('s1', 'b'));
  await drain();
  assert.deepEqual(h.armed, [{ sessionId: 's1', target: TARGET }]); // 首帧一次,不逐帧重调
  h.push(done('s1')); // 轮界:清去重位
  h.push(token('s1', 'c')); // 续跑轮首帧 → 重补武装(排队 steer 收尾内部续跑不经 onSubmitted,F2)
  await drain();
  assert.deepEqual(h.armed[1], { sessionId: 's1', target: TARGET });
  assert.equal(h.armed.length, 2);
  h.push(done('s1'));
  h.p.stop(); // stop 全清(reply.ts stop 语义)
  h.p.start(); // 重挂订阅后再验
  h.push(token('s1', 'd'));
  await drain();
  assert.equal(h.armed.length, 3);
  h.push(token('sX', 'x')); // 未绑定会话帧不触发武装
  await drain();
  assert.equal(h.armed.length, 3);
});
