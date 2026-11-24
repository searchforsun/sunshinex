/** 通道引擎测试(spec 2026-11-21-channels §2/§8.3,Task 7 简报四用例逐条):io 桩(桩 SessionRuntime
 *  含 onRunEnd 观察面)+ 临时档 ChannelsBindingsStore + configs 注入;① applyConfigs 调和(起→connected,
 *  空表→全停 disconnected);② secret 缺失 fail-closed(telegram + 条目无 secret 字段;2026-11-22
 *  用户裁定:密钥内联条目可回显,env 槽退役);
 *  ③ test(id) dry-run 独立实例;④ mockAdapter(id).emit 全链路(binding 创建 + ack 进 mock.sent +
 *  定向回复 @前缀,裁定 2 deliver 包装面)。域容器钉 SUNSHINEX_CHANNELS_DIR 临时目录(防污染真实
 *  ~/.sunshinex,router.test.ts 同款)。⑤ 终审修复波 F2:未武装绑定会话直接来 token 帧(模拟排队
 *  steer 收尾内部续跑轮,session.ts 不经 router.onSubmitted)→ ensureArmed 补注册 onRunEnd。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChannelsEngine } from './engine';
import type { ChannelsSessionIo } from './router';
import { ChannelsBindingsStore } from './store';
import { bindingKey } from './model';
import type { ChannelConfig, InboundMessage } from './model';
import type { SessionRuntime } from '../session';
import type { DaemonFrame } from '../daemon-wire';

process.env.SUNSHINEX_CHANNELS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-engine-'));

/** 桩 SessionRuntime:计数面(submits)+ onRunEnd 观察注册面(engine armRunEnd 武装消费) */
interface RtStub {
  _status: 'idle' | 'running';
  status: () => 'idle' | 'running';
  submit: (text: string, images?: string[]) => { ok: true } | { ok: false; status: 409; error: string };
  steer: (text: string, images?: string[]) => void;
  interrupt: () => { ok: boolean; error?: string };
  ensureJournalMinted: () => void;
  attachedJournalId: string;
  dataDir: string;
  onRunEnd: (cb: (info: { stopReason?: string }) => void) => () => void;
  runEndCbs: Array<(info: { stopReason?: string }) => void>;
  submits: Array<{ text: string; images?: string[] }>;
  submitExternal: (text: string, images?: string[]) => { ok: true } | { ok: false; status: 409; error: string };
}

function makeRuntime(): RtStub {
  const rt: RtStub = {
    _status: 'idle',
    status: () => rt._status,
    submits: [],
    runEndCbs: [],
    submit: (text, images) => {
      rt.submits.push({ text, images });
      return { ok: true };
    },
    submitExternal: (text, images) => {
      rt.submits.push({ text, images });
      return { ok: true };
    },
    steer: () => {},
    interrupt: () => ({ ok: true }),
    ensureJournalMinted: () => {},
    attachedJournalId: 'j1',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'chan-rt-')),
    onRunEnd: (cb) => {
      rt.runEndCbs.push(cb);
      return () => {
        const i = rt.runEndCbs.indexOf(cb);
        if (i >= 0) rt.runEndCbs.splice(i, 1);
      };
    },
  };
  return rt;
}

function mkCfg(over: Partial<Omit<ChannelConfig, 'allow'>> & { allow?: ChannelConfig['allow'] } = {}): ChannelConfig {
  const { allow, ...rest } = over;
  return { id: 'm1', platform: 'mock', enabled: true, root: 'auto', mode: 'acceptEdits', allow: allow ?? { kind: 'all' }, ...rest };
}

let msgSeq = 0;
function mkMsg(over: Partial<InboundMessage> = {}): InboundMessage {
  return { channel: 'm1', chatId: 'c1', chatKind: 'direct', userId: 'u1', msgId: `m${++msgSeq}`, text: 'hello', ...over };
}

function makeHarness(configs: ChannelConfig[] = []) {
  const bindings = new ChannelsBindingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chan-bind-')), 'channels-bindings.json'));
  const runtimes = new Map<string, RtStub>();
  let seq = 0;
  let frameSink: ((f: DaemonFrame) => void) | undefined; // 帧泵桩存回调(⑤ 投影器帧驱动)
  const io: ChannelsSessionIo = {
    createSession: () => {
      const id = `s${++seq}`;
      runtimes.set(id, makeRuntime());
      return { ok: true, value: { sessionId: id } };
    },
    getSession: (id) => runtimes.get(id) as unknown as SessionRuntime | undefined,
    attach: (id) => {
      if (!runtimes.has(id)) runtimes.set(id, makeRuntime());
      return { ok: true, value: { sessionId: id, root: '/r' } };
    },
    releaseSession: (id) => {
      runtimes.delete(id);
    },
    activeSessionId: () => undefined,
    onFrame: (cb) => {
      frameSink = cb;
      return () => {
        frameSink = undefined;
      };
    },
    resolveApproval: () => true,
    resolveAsk: () => true,
  };
  const engine = new ChannelsEngine(io, bindings, { configs: () => configs });
  return { engine, bindings, runtimes, io, pushFrame: (f: DaemonFrame) => frameSink?.(f) };
}

/** 等微任务排空:emit → handleInbound(异步)→ ack → deliver 全链路 fire-and-forget 落账 */
async function drain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('① applyConfigs 调和:启用 mock → health connected;再 applyConfigs 空表 → 全停 disconnected', () => {
  const h = makeHarness([mkCfg()]);
  h.engine.start(); // applyConfigs(configs()) 调和
  const up = h.engine.health();
  assert.equal(up.length, 1);
  assert.equal(up[0]!.id, 'm1');
  assert.equal(up[0]!.platform, 'mock');
  assert.equal(up[0]!.enabled, true);
  assert.equal(up[0]!.connected, true);

  h.engine.applyConfigs([]); // 幂等调和:空表 → 全适配器 stop + 删表
  const down = h.engine.health();
  assert.equal(down.length, 1); // 已知通道保留健康快照行
  assert.equal(down[0]!.enabled, false);
  assert.equal(down[0]!.connected, false);
});

// 密钥门读 cfg.secret（2026-11-22 用户裁定：密钥内联条目可回显，env 槽退役）
test('② secret 缺失:telegram 平台 + 条目无 secret 字段 → health detail 含「密钥」;条目带 secret → 密钥门放行', () => {
  const h = makeHarness();
  h.engine.applyConfigs([mkCfg({ id: 'tg1', platform: 'telegram' })]); // 无 secret 字段
  const rows = h.engine.health();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.enabled, true);
  assert.equal(rows[0]!.connected, false); // fail-closed:密钥未配置拒绝启用,不抛
  assert.ok(rows[0]!.detail !== undefined && rows[0]!.detail.includes('密钥'));

  // 条目 secret 在场:密钥门放行(非 mock 平台无落地适配器 → 记 detail——detail 不再含「密钥」,
  // 证明门已过、失败点在适配器装配)。放行证明平台选 feishu 且不带 appId——适配器 start 同步抛
  // 「App ID 缺失」(零网络;telegram 在此会启动真长轮询,测试进程被网络句柄钉死不退)
  const h2 = makeHarness();
  h2.engine.applyConfigs([mkCfg({ id: 'fs1', platform: 'feishu', secret: 'tok-inline' })]);
  const rows2 = h2.engine.health();
  assert.equal(rows2[0]!.connected, false);
  assert.ok(
    rows2[0]!.detail === undefined || !rows2[0]!.detail.includes('密钥'),
    `条目 secret 在场不应再报密钥门,detail=${rows2[0]!.detail}`,
  );
});

test('③ test(id) dry-run:独立实例 start+health+stop 返回 ok,不起 sink 路由', async () => {
  const h = makeHarness();
  h.engine.applyConfigs([mkCfg()]);
  const r = await h.engine.test('m1');
  assert.equal(r.ok, true);
  assert.ok(r.botId !== undefined);
  assert.equal(r.error, undefined);
  const bad = await h.engine.test('nope'); // 未配置 id → ok:false
  assert.equal(bad.ok, false);
  assert.ok(bad.error !== undefined && bad.error.length > 0);
});

// D111 结构化失败档:测试连接失败携 code（GUI 按码映射文案,免 daemon 文案子串耦合——换回无
// code 实现此钉即红）。not-found=未配置 id;secret-missing=密钥门(fail-closed 与 launch 同源)
test('③b test(id) 失败档结构化 code:not-found/secret-missing', async () => {
  const h = makeHarness();
  const nope = await h.engine.test('nope');
  assert.equal(nope.code, 'not-found');
  h.engine.applyConfigs([mkCfg({ id: 'tg1', platform: 'telegram' })]); // telegram 无 secret 字段
  const gated = await h.engine.test('tg1');
  assert.equal(gated.ok, false);
  assert.equal(gated.code, 'secret-missing');
  assert.ok(gated.error !== undefined && gated.error.includes('密钥'));
});

test('④ mockAdapter(id).emit → router 全链路:binding 创建 + ack 进 mock.sent;单聊零 @', async () => {
  const h = makeHarness();
  h.engine.applyConfigs([mkCfg()]);
  const mock = h.engine.mockAdapter('m1');
  assert.ok(mock !== undefined);
  mock.emit(mkMsg({ msgId: 'e1', chatId: 'c1', userId: 'u1', userDisplay: 'Alice', text: '跑起来' }));
  await drain();
  const b = h.bindings.get(bindingKey('m1', 'c1')); // binding 创建
  assert.ok(b !== undefined);
  assert.ok(h.runtimes.get(b.sessionId)!.submits.length === 1); // 提交真实发生
  assert.ok(mock.sent.length >= 1); // ack 回环进 mock.sent
  assert.ok(mock.sent[0]!.text.includes('已受理'));
  assert.ok(!mock.sent[0]!.text.startsWith('@')); // 单聊零 @:回执式回复天然指向本人(2026-11-22 用户裁定)
});

test('④b 群聊出站定向 @:caps.mention 缺席=文本前缀 @display 退化(mock),且仅群聊注入', async () => {
  const h = makeHarness();
  h.engine.applyConfigs([mkCfg()]);
  const mock = h.engine.mockAdapter('m1');
  assert.ok(mock !== undefined);
  mock.emit(mkMsg({ msgId: 'e2', chatKind: 'group', atBot: true, userId: 'u1', userDisplay: 'Alice', text: '跑起来' }));
  await drain();
  assert.ok(mock.sent.length >= 1);
  assert.ok(mock.sent[0]!.text.startsWith('@Alice ')); // 群聊定向 @ 文本前缀退化(裁定 2①;feishu caps.mention=true 走结构化 mention)
});

test('⑥ 受理回执平台面(2026-11-22 用户裁定):accepted 走 ack 面免文本;贴失败退文本回执', async () => {
  // 适配器有 ack 面(实例补丁=feishu 形态):accepted → ack(inbound,'accepted') 单发,零文本
  const h = makeHarness();
  h.engine.applyConfigs([mkCfg()]);
  const mock = h.engine.mockAdapter('m1');
  assert.ok(mock !== undefined);
  const ackCalls: Array<{ msgId: string; kind: string }> = [];
  (mock as unknown as { ack: unknown }).ack = async (inbound: InboundMessage, kind: 'accepted' | 'queued') => {
    ackCalls.push({ msgId: inbound.msgId, kind });
  };
  mock.emit(mkMsg({ msgId: 'a1', text: 'hi' }));
  await drain();
  assert.deepEqual(ackCalls, [{ msgId: 'a1', kind: 'accepted' }]);
  assert.equal(mock.sent.length, 0); // 受理=纯表情免文本(文本零出站)

  // ack 面抛错(如表情无权限 403) → 文本回退,语义不分叉
  const h2 = makeHarness();
  h2.engine.applyConfigs([mkCfg()]);
  const mock2 = h2.engine.mockAdapter('m1');
  assert.ok(mock2 !== undefined);
  (mock2 as unknown as { ack: unknown }).ack = async () => {
    throw new Error('reaction 403');
  };
  mock2.emit(mkMsg({ msgId: 'a2', text: 'hi' }));
  await drain();
  assert.ok(mock2.sent.length >= 1);
  assert.ok(mock2.sent[0]!.text.includes('已受理')); // 文本兜底
});

test('⑤b GUI 发起轮抑制(2026-11-23 用户裁定「sunshinex 的输入回答不应该让飞书收到」):markGuiRun 后该会话帧全静默,done 清位恢复投影', async () => {
  const h = makeHarness([mkCfg()]);
  h.engine.start();
  h.runtimes.set('s1', makeRuntime());
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 's1', journalId: 'j1', updatedAt: 1 });
  const mock = h.engine.mockAdapter('m1')!;
  // 非绑定会话打标=零操作(集不收)
  h.engine.markGuiRun('s-other');
  h.pushFrame({ kind: 'event', sessionId: 's-other', seq: 1, e: { type: 'token', text: 'x', ts: 0 } });
  // 绑定会话打标 → token 帧静默(mock 流式出站零增量)
  h.engine.markGuiRun('s1');
  const before = mock.streamed.length;
  h.pushFrame({ kind: 'event', sessionId: 's1', seq: 1, e: { type: 'token', text: 'GUI 轮输出', ts: 0 } });
  await drain();
  assert.equal(mock.streamed.length, before, 'GUI 轮帧不进 IM 投影');
  // done 帧清位 → 下一轮 token 恢复投影(流式 mock:token 帧即同气泡全量替换出站)
  h.pushFrame({ kind: 'event', sessionId: 's1', seq: 2, e: { type: 'done', ts: 0 } });
  h.pushFrame({ kind: 'event', sessionId: 's1', seq: 3, e: { type: 'token', text: 'IM 轮输出', ts: 0 } });
  await drain();
  assert.ok(mock.streamed.length > before, 'done 清位后恢复投影');
  assert.ok(mock.streamed[mock.streamed.length - 1]!.fullText.includes('IM 轮输出'));
});

test('⑤ 终态武装补漏(F2):未武装绑定会话直接来 token 帧(模拟排队续跑轮)→ onRunEnd 被注册,触发即投终态注记', async () => {  const h = makeHarness([mkCfg()]);
  h.engine.start(); // projector.start() 挂帧泵 → frameSink 就位
  // 绑定 + runtime 预置,不经 router 提交(无 onSubmitted 武装)——session.ts 排队 steer 收尾内部续跑轮形态
  h.runtimes.set('s1', makeRuntime());
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 's1', journalId: 'j1', updatedAt: 1 });
  h.pushFrame({ kind: 'event', sessionId: 's1', seq: 1, e: { type: 'token', text: '续跑输出', ts: 0 } });
  const rt = h.runtimes.get('s1')!;
  assert.equal(rt.runEndCbs.length, 1); // ensureArmed → engine.armRunEnd 注册一次性 onRunEnd(session 桩断言)
  h.pushFrame({ kind: 'event', sessionId: 's1', seq: 2, e: { type: 'token', text: '更多输出', ts: 0 } });
  assert.equal(rt.runEndCbs.length, 1); // armed-once 幂等:逐帧不重复注册
  // 终态注记:观察者触发 → projector.onRunEnd → deliver → mock.sent(通道侧可见「任务失败」)
  const mock = h.engine.mockAdapter('m1')!;
  rt.runEndCbs[0]!({ stopReason: 'error-x' });
  await drain();
  assert.ok(mock.sent.some((m) => m.text.includes('任务失败: error-x')));
  // 未绑定会话帧不武装
  h.runtimes.set('s2', makeRuntime());
  h.pushFrame({ kind: 'event', sessionId: 's2', seq: 3, e: { type: 'token', text: '野帧', ts: 0 } });
  assert.equal(h.runtimes.get('s2')!.runEndCbs.length, 0);
});

// ⑥c run 起源气泡绑定（2026-11-24 用户裁定 bug2「回复没有正确回复给正确的气泡,固定绑定到了
// 第一个气泡」）：run 产物（token 缓冲 done 冲刷）回**触发消息气泡**（submitExternal 起源,经
// noteRunSubmit 记 runOrigin）,不随后续入站漂移;回执（受理/排队说明）显式回各自触发消息
test('⑥c run 起源气泡绑定:run 产物回触发消息,不随后续入站漂移;回执照各自触发消息', async () => {
  const cfg = mkCfg({ ident: { mockCaps: JSON.stringify({ streaming: false }) } }); // 分段档:token 缓冲 done 冲刷走 deliver/reply 面
  const h = makeHarness([cfg]);
  h.engine.start();
  const mock = h.engine.mockAdapter('m1')!;
  mock.emit(mkMsg({ msgId: 'e-a1', text: '开场任务' })); // msg A:idle submit → run 起源=A
  await drain();
  const b = h.bindings.get(bindingKey('m1', 'c1'));
  assert.ok(b !== undefined);
  const rt = h.runtimes.get(b.sessionId)!;
  rt._status = 'running'; // A 的 run 进行中
  mock.emit(mkMsg({ msgId: 'e-b1', text: '穿插消息' })); // msg B:排队
  await drain();
  // 回执寻址:受理回执回 A;排队说明回 B（deliverTo 显式入站寻址,不查 runOrigin）
  assert.ok(mock.replied.some((r) => r.msgId === 'e-a1' && r.msg.text.includes('已受理')));
  const queuedReceipt = mock.replied.find((r) => r.msgId === 'e-b1');
  assert.ok(queuedReceipt !== undefined && queuedReceipt.msg.text.includes('回复序号'), '排队回执附两选项(2026-11-24 bug1)');
  // run 产物:token 缓冲 → done 冲刷 → 回 A（bug2 根修:此前恒回最近入站 B）
  h.pushFrame({ kind: 'event', sessionId: b.sessionId, seq: 1, e: { type: 'token', text: '回答正文', ts: 0 } });
  h.pushFrame({ kind: 'event', sessionId: b.sessionId, seq: 2, e: { type: 'done', ts: 0 } });
  await drain();
  const body = mock.replied.filter((r) => r.msg.text.includes('回答正文'));
  assert.equal(body.length, 1);
  assert.equal(body[0]!.msgId, 'e-a1', 'run 产物回起源气泡,不随后续入站漂移');
});
