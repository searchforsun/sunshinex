/** 通道引擎测试(spec 2026-11-21-channels §2/§8.3,Task 7 简报四用例逐条):io 桩(桩 SessionRuntime
 *  含 onRunEnd 观察面)+ 临时档 ChannelsBindingsStore + configs 注入;① applyConfigs 调和(起→connected,
 *  空表→全停 disconnected);② secret 缺失 fail-closed(telegram + 无 env,存/删 + try/finally);
 *  ③ test(id) dry-run 独立实例;④ mockAdapter(id).emit 全链路(binding 创建 + ack 进 mock.sent +
 *  定向回复 @前缀,裁定 2 deliver 包装面)。域容器钉 SUNSHINEX_CHANNELS_DIR 临时目录(防污染真实
 *  ~/.sunshinex,router.test.ts 同款)。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChannelsEngine } from './engine';
import type { ChannelsSessionIo } from './router';
import { ChannelsBindingsStore } from './store';
import { bindingKey, channelSecretEnv } from './model';
import type { ChannelConfig, InboundMessage } from './model';
import type { SessionRuntime } from '../session';

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
    onFrame: () => () => {},
    resolveApproval: () => true,
  };
  const engine = new ChannelsEngine(io, bindings, { configs: () => configs });
  return { engine, bindings, runtimes, io };
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

test('② secret 缺失:telegram 平台 + 无 SUNSHINEX_CHANNEL_SECRET_<名> env → health detail 含「密钥」', () => {
  const envName = channelSecretEnv('tg1');
  const saved = process.env[envName];
  delete process.env[envName];
  try {
    const h = makeHarness();
    h.engine.applyConfigs([mkCfg({ id: 'tg1', platform: 'telegram' })]);
    const rows = h.engine.health();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.enabled, true);
    assert.equal(rows[0]!.connected, false); // fail-closed:密钥未配置拒绝启用,不抛
    assert.ok(rows[0]!.detail !== undefined && rows[0]!.detail.includes('密钥'));
  } finally {
    if (saved !== undefined) process.env[envName] = saved;
    else delete process.env[envName];
  }
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

test('④ mockAdapter(id).emit → router 全链路:binding 创建 + ack 进 mock.sent', async () => {
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
  assert.ok(mock.sent[0]!.text.startsWith('@Alice ')); // 定向回复前缀(裁定 2:deliver 包装查 lastSender)
});
