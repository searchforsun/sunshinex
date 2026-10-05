/** T4(P2 agent-message e2e):双向消息零产品码——真 Harness(dontAsk/learnSkills false/tmp root)+
 * 计数捕获 fake 模型(T3 teammate.test.ts 同款:req.messages 逐轮捕获)。数据目录经 SUNSHINEX_DATA_DIR
 * 钉位 tmp(inbox 即 <tmp>/teams/main/inbox,与装配面同路径),team 帽摘除防宿主耦合(team.e2e 同款)。
 * ① lead→teammate 回合边界:spawn w1(mode team)→ 主链真工具面 send_message(回执 delivered + 落档)
 *   → create 任务 → w1 消化至 in-review → 首轮 chat 消息面含 msg 行且先于 Task t1 行(drain 先于 execute)。
 * ② teammate→lead(裁定:teammate 面工具执行不经 fake model 驱动,直测工具):deriveTeammateRegistry 同
 *   harness/index.ts registryFactory 装配点同构 → execute send_message{to:'lead'} → lead.jsonl 落档
 *   (from 'w1')+ harness onEvent 收集器收到 agent-message 事件(lead 投递轨 = 事件 + 落档,Ruling 3)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { deriveTeammateRegistry } from '../taskboard/teammate-tools';
import { makeSendMessageTool } from '../taskboard/message-tools';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult, SessionEvent } from '../types';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 计数捕获 fake ModelAdapter(T3 teammate.test.ts 同款):每 chat() 一轮 stop 收束,chats 捕获每轮
 *  消息面全文——回合边界注入断言的可达面(msg 行经 own chain → Reactor seed → 模型) */
class CountingAdapter implements ModelAdapter {
  readonly provider = 'counting';
  n = 0;
  readonly chats: string[] = [];
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.n += 1;
    this.chats.push(req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
    return { finish: 'stop', content: `done ${this.n}`, toolCalls: [] };
  }
}

/** 轮询等待谓词成立(缺省 30s 上限 100ms 步——task-8 裁定的快照驱动节拍) */
async function until(pred: () => boolean, ms = 30_000, step = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** 环境钉位:SUNSHINEX_DATA_DIR 直指 tmp(resolveDataDir 最高优先覆盖,inbox/taskboard/账本全落 tmp)
 * + SUNSHINEX_TEAM_TOKEN_CAP 摘除(宿主若设帽,回写即被拦 pending 悬置假失败);返回恢复函数 */
function pinEnv(tmp: string): () => void {
  const savedData = process.env.SUNSHINEX_DATA_DIR;
  const savedCap = process.env.SUNSHINEX_TEAM_TOKEN_CAP;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  delete process.env.SUNSHINEX_TEAM_TOKEN_CAP;
  return () => {
    if (savedData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = savedData;
    if (savedCap === undefined) delete process.env.SUNSHINEX_TEAM_TOKEN_CAP;
    else process.env.SUNSHINEX_TEAM_TOKEN_CAP = savedCap;
  };
}

const cleanup = (h: Harness | undefined, tmp: string, restore: () => void): void => {
  h?.team.stopAll();
  h?.tasks.stopAll();
  restore();
  fs.rmSync(tmp, { recursive: true, force: true });
};

test('e2e lead→teammate:主链真工具面 send_message → 回执 delivered + inbox 落档;w1 首轮消息面含消息行且先于 Task t1 行', async () => {
  const tmp = tmpdir('sunshinex-msg-e2e-1-');
  const restore = pinEnv(tmp);
  let h: Harness | undefined;
  try {
    const model = new CountingAdapter();
    h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
    // spawn w1(mode 'team')——经真 spawn 工具执行面(与模型出牌同一条链;team.e2e 同款)
    const sp = await h.tools.execute('spawn', { prompt: 'worker w1: claim board tasks and finish each', label: 'w1', mode: 'team' }, h.safety);
    assert.ok(sp.ok && sp.value.exitCode === 0, `spawn w1 应成功:${JSON.stringify(sp)}`);
    assert.ok(sp.value.stdout.includes('teammate w1 started'), `spawn 回执应含 teammate w1 started:${sp.value.stdout}`);
    assert.deepEqual(h.team.aliveNames(), ['w1'], 'w1 活名在场(主链面 send_message 白名单数据源)');
    // lead→w1:经主链真工具面投递(签名现场核对 ToolRegistry.execute(name, input, safety))
    const sm = await h.tools.execute('send_message', { to: 'w1', text: 'prioritize tests' }, h.safety);
    assert.ok(sm.ok && sm.value.exitCode === 0, `send_message 应成功:${JSON.stringify(sm)}`);
    assert.match(sm.value.stdout, /^message m1 delivered to w1$/, '回执 message <id> delivered to <to>');
    assert.ok(fs.existsSync(path.join(tmp, 'teams', 'main', 'inbox', 'w1.jsonl')), 'w1 收件档应在 <tmp>/teams/main/inbox 落盘');
    // 建任务(消息先于任务投递)→ w1 消化:轮询快照至 in-review(派发路由自动踢点,worker 首轮 execute 前 drain)
    const created = h.taskboard.create({ title: 'M1', spec: 'do M1' });
    assert.ok(created.ok, `create 应成功:${JSON.stringify(created)}`);
    const digested = await until(() => h!.taskboard.snapshot().tasks['t1']?.status === 'in-review');
    assert.ok(digested, 't1 应由 w1 消化至 in-review');
    // 回合边界注入可见(T3 语义 e2e 复证):w1 首轮 chat 消息面含 m1 消息行,且先于本任务 Task t1 行
    assert.ok(model.chats.length >= 1, 'w1 至少一轮 chat');
    const first = model.chats[0]!;
    assert.ok(first.includes('msg:m1 [message from lead] prioritize tests'), `首轮消息面应含 m1 消息行,实际:${first.slice(0, 300)}`);
    assert.ok(first.includes('Task t1:'), '首轮消息面应含 Task t1 行(seed 经缺省 chainView 取 own chain)');
    assert.ok(
      first.indexOf('msg:m1 [message from lead] prioritize tests') < first.indexOf('Task t1:'),
      '消息行应先于 Task t1 行(drain 先于 execute)',
    );
  } finally {
    cleanup(h, tmp, restore);
  }
});

test('e2e teammate→lead:派生面直测 send_message → lead.jsonl 落档(from w1)+ agent-message 事件入 harness 收集器', async () => {
  const tmp = tmpdir('sunshinex-msg-e2e-2-');
  const restore = pinEnv(tmp);
  let h: Harness | undefined;
  try {
    const events: SessionEvent[] = [];
    h = new Harness({ root: tmp, mode: 'dontAsk', model: new CountingAdapter(), learnSkills: false, onEvent: (e) => events.push(e) });
    const sp = await h.tools.execute('spawn', { prompt: 'worker w1', label: 'w1', mode: 'team' }, h.safety);
    assert.ok(sp.ok && sp.value.exitCode === 0, `spawn w1 应成功:${JSON.stringify(sp)}`);
    // 裁定(T4 计划):teammate 面工具执行不经 fake model 驱动,直测工具——deriveTeammateRegistry 同
    // harness/index.ts registryFactory 装配点同构(仅 w1 活名时排己白名单恰 ['lead']);onEvent 透传
    // 同一收集器(装配点同款)
    const face = deriveTeammateRegistry(
      h.tools,
      h.taskboard,
      h.team,
      makeSendMessageTool({ inbox: h.inbox, onEvent: (e) => events.push(e), knownRecipients: () => ['lead'], from: () => 'w1' }),
    );
    assert.ok(face.get('send_message') !== undefined, '派生面应含 send_message');
    const sm = await face.execute('send_message', { to: 'lead', text: 'done with prep' }, h.safety);
    assert.ok(sm.ok && sm.value.exitCode === 0, `send_message(to lead) 应成功:${JSON.stringify(sm)}`);
    assert.match(sm.value.stdout, /^message m1 delivered to lead$/, '回执 delivered to lead');
    // 落档:lead.jsonl 在 <tmp>/teams/main/inbox,from 'w1'(发件人身份来自注入器闭包)
    const leadFile = path.join(tmp, 'teams', 'main', 'inbox', 'lead.jsonl');
    assert.ok(fs.existsSync(leadFile), 'lead 收件档应落盘');
    const rec = JSON.parse(fs.readFileSync(leadFile, 'utf8').trim()) as { id: string; from: string; to: string; text: string; ts: number };
    assert.deepEqual([rec.from, rec.to, rec.text], ['w1', 'lead', 'done with prep'], '落档 from/to/text(from = 注入器 teammate 名)');
    // 事件:harness onEvent 收集器收到 agent-message {from w1, to lead, text}(与落档同源,Ruling 3 双轨)
    const ev = events.find((e) => e.type === 'agent-message');
    assert.ok(ev, 'agent-message 事件应入收集器');
    assert.deepEqual(ev!.payload, { messageId: rec.id, from: 'w1', to: 'lead', text: 'done with prep' });
    assert.equal(ev!.ts, rec.ts, '事件 ts 与落档消息 ts 同源');
    // fork 子面无 send_message(L2 身份专属):已由 teammate-spawn.test.ts 钉住(L2 T3 评审附带 1),引注不重复
  } finally {
    cleanup(h, tmp, restore);
  }
});
