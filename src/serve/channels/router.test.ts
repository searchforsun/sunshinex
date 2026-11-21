/** 通道入站管线测试(spec 2026-11-21-channels §4,Task 5 简报 ①~⑫ 逐条):桩 SessionRuntime
 *  (plain object:status/submit/steer/interrupt/ensureJournalMinted/attachedJournalId/dataDir)+
 *  io 桩 + ack 桩收集文本;bindings 走临时档 ChannelsBindingsStore(构造器注入,测试环境自洽)。
 *  域容器钉 SUNSHINEX_CHANNELS_DIR 临时目录(channelChatWorkspaceRoot mkdir 面防污染真实 ~/.sunshinex)。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChannelRouter } from './router';
import type { ChannelsSessionIo, ChannelRouterDeps } from './router';
import { ChannelsBindingsStore } from './store';
import { channelChatWorkspaceRoot } from '../../config/channels';
import { readSessionMeta } from '../../tui/session-journal';
import { bindingKey } from './model';
import type { Binding, ChannelConfig, InboundMessage } from './model';
import type { SessionRuntime } from '../session';

process.env.SUNSHINEX_CHANNELS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-router-'));

/** 桩 SessionRuntime:计数面(submits/steers/interrupts)+ 可塑状态(_status/409 注入) */
interface RtStub {
  _status: 'idle' | 'running';
  status: () => 'idle' | 'running';
  submit: (text: string, images?: string[]) => { ok: true } | { ok: false; status: 409; error: string };
  steer: (text: string, images?: string[]) => void;
  interrupt: () => { ok: boolean; error?: string };
  ensureJournalMinted: () => void;
  attachedJournalId: string;
  dataDir: string;
  submits: Array<{ text: string; images?: string[] }>;
  steers: Array<{ text: string; images?: string[] }>;
  interrupts: number;
}

function makeRuntime(opts: { status?: 'idle' | 'running'; journalId?: string; submit409?: boolean } = {}): RtStub {
  const rt: RtStub = {
    _status: opts.status ?? 'idle',
    status: () => rt._status,
    submits: [],
    steers: [],
    interrupts: 0,
    submit: (text, images) => {
      rt.submits.push({ text, images });
      return opts.submit409 ? { ok: false, status: 409, error: 'run in progress' } : { ok: true };
    },
    steer: (text, images) => {
      rt.steers.push({ text, images });
    },
    interrupt: () => {
      rt.interrupts += 1;
      return { ok: true };
    },
    ensureJournalMinted: () => {}, // 桩:attachedJournalId 出生即定
    attachedJournalId: opts.journalId ?? 'j1',
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'chan-rt-')),
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

interface HarnessOpts {
  configs?: ChannelConfig[];
  pendingReply?: (sessionId: string, text: string) => boolean;
  attachFail?: boolean;
  runtimeFactory?: (id: string) => RtStub;
}

function makeHarness(opts: HarnessOpts = {}) {
  const bindingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chan-bind-')), 'channels-bindings.json');
  const bindings = new ChannelsBindingsStore(bindingsFile);
  const configs = opts.configs ?? [mkCfg()];
  const acks: Array<{ msg: InboundMessage; text: string }> = [];
  const createCalls: Array<{ root: string; opts?: Parameters<ChannelsSessionIo['createSession']>[1] }> = [];
  const released: string[] = [];
  const attached: Array<{ id: string; journalId: string }> = [];
  const noteSenders: Array<{ sessionId: string; display: string }> = [];
  const runtimes = new Map<string, RtStub>();
  let seq = 0;
  const io: ChannelsSessionIo = {
    createSession: (root, o) => {
      const id = `s${++seq}`;
      runtimes.set(id, opts.runtimeFactory?.(id) ?? makeRuntime({ journalId: `j-${id}` }));
      createCalls.push({ root, opts: o });
      return { ok: true, value: { sessionId: id } };
    },
    getSession: (id) => runtimes.get(id) as unknown as SessionRuntime | undefined,
    attach: (id, journalId) => {
      if (opts.attachFail) return { ok: false, error: { code: 'not_found', message: 'attach failed' } };
      attached.push({ id, journalId });
      if (!runtimes.has(id)) runtimes.set(id, makeRuntime({ journalId }));
      return { ok: true, value: { sessionId: id, root: '/r' } };
    },
    releaseSession: (id) => {
      runtimes.delete(id);
      released.push(id);
    },
    activeSessionId: () => undefined,
    onFrame: () => () => {},
    resolveApproval: () => true,
  };
  const deps: ChannelRouterDeps = {
    io,
    bindings,
    configs: () => configs,
    ack: async (m, text) => {
      acks.push({ msg: m, text });
    },
    ...(opts.pendingReply !== undefined ? { pendingReply: opts.pendingReply } : {}),
    noteSender: (sessionId, display) => {
      noteSenders.push({ sessionId, display });
    },
  };
  return { router: new ChannelRouter(deps), io, bindings, acks, createCalls, released, attached, noteSenders, runtimes };
}

function rtOf(h: ReturnType<typeof makeHarness>, key: string): RtStub {
  const b = h.bindings.get(key) as Binding;
  return h.runtimes.get(b.sessionId)!;
}

test('① 去重:同 (channel,msgId) 第二次静默丢弃(ack 零调用)', async () => {
  const h = makeHarness();
  const m = mkMsg({ msgId: 'dup1', text: 'hi' });
  await h.router.handleInbound(m);
  await h.router.handleInbound(m); // 同 (channel,msgId) 重复投递
  assert.equal(h.acks.length, 1);
  assert.ok(h.acks[0]!.text.includes('已受理'));
  assert.equal(rtOf(h, bindingKey('m1', 'c1')).submits.length, 1); // 只真实提交一次
});

test('② 配置缺失/未启用:丢弃', async () => {
  const h = makeHarness({ configs: [mkCfg({ enabled: false })] });
  await h.router.handleInbound(mkMsg({ channel: 'm1' }));
  assert.equal(h.acks.length, 0);
  assert.equal(h.createCalls.length, 0);
  const h2 = makeHarness({ configs: [mkCfg({ id: 'other' })] });
  await h2.router.handleInbound(mkMsg({ channel: 'm1' })); // 查无此通道配置
  assert.equal(h2.acks.length, 0);
  assert.equal(h2.createCalls.length, 0);
});

test('③ allow=list:白名单外 userId 丢弃;命中通过', async () => {
  const cfgList = mkCfg({ allow: { kind: 'list', userIds: ['u1'], chatIds: ['chat-ok'] } });
  const h = makeHarness({ configs: [cfgList] });
  await h.router.handleInbound(mkMsg({ msgId: 'd1', userId: 'u2', chatId: 'c-x' })); // 双双不中
  assert.equal(h.acks.length, 0);
  assert.equal(h.createCalls.length, 0);
  await h.router.handleInbound(mkMsg({ msgId: 'd2', userId: 'u1' })); // userId 命中
  assert.equal(h.acks.length, 1);
  const h3 = makeHarness({ configs: [cfgList] });
  await h3.router.handleInbound(mkMsg({ msgId: 'd3', userId: 'u9', chatId: 'chat-ok' })); // chatId 命中其一亦通过
  assert.equal(h3.acks.length, 1);
});

test('④ first-user:首条 direct 锁定 lockedUserId 并 upsert;他用户(含群聊)被拒', async () => {
  const h = makeHarness({ configs: [mkCfg({ allow: { kind: 'first-user' } })] });
  await h.router.handleInbound(mkMsg({ msgId: 'd1', userId: 'uA', chatId: 'c1' }));
  assert.equal(h.acks.length, 1);
  const b = h.bindings.get(bindingKey('m1', 'c1'))!;
  assert.equal(b.lockedUserId, 'uA');
  assert.equal(b.sessionId, 's1');
  await h.router.handleInbound(mkMsg({ msgId: 'd2', userId: 'uB', chatId: 'c1' })); // 他人 direct
  assert.equal(h.acks.length, 2);
  assert.ok(h.acks[1]!.text.includes('已绑定其他用户'));
  await h.router.handleInbound(mkMsg({ msgId: 'd3', userId: 'uC', chatId: 'c1', chatKind: 'group', atBot: true })); // 群聊同判据
  assert.ok(h.acks[2]!.text.includes('已绑定其他用户'));
  assert.equal(h.createCalls.length, 1); // 未为他人再建会话
  assert.equal(rtOf(h, bindingKey('m1', 'c1')).submits.length, 1); // 他人消息未提交
});

test('⑤ group 且 !atBot 丢弃;atBot 通过', async () => {
  const h = makeHarness();
  await h.router.handleInbound(mkMsg({ msgId: 'g1', chatKind: 'group', atBot: false }));
  await h.router.handleInbound(mkMsg({ msgId: 'g1b', chatKind: 'group', atBot: undefined })); // 缺席=未 at
  assert.equal(h.acks.length, 0);
  assert.equal(h.createCalls.length, 0);
  await h.router.handleInbound(mkMsg({ msgId: 'g2', chatKind: 'group', atBot: true }));
  assert.equal(h.acks.length, 1);
  assert.ok(h.acks[0]!.text.includes('已受理'));
});

test('⑥ 指令:/help 不进模型;/stop 调 interrupt;/new 重绑保留元数据', async () => {
  // /help:ack 帮助文案,submit/steer/createSession 零调用;trim 后精确匹配
  const hHelp = makeHarness();
  await hHelp.router.handleInbound(mkMsg({ msgId: 'h1', text: '/help' }));
  await hHelp.router.handleInbound(mkMsg({ msgId: 'h2', text: '  /help  ' }));
  assert.equal(hHelp.acks.length, 2);
  assert.ok(hHelp.acks[0]!.text.includes('/new'));
  assert.equal(hHelp.createCalls.length, 0);

  // /stop:绑定+在座 runtime → interrupt 调用,不提交
  const hStop = makeHarness();
  await hStop.router.handleInbound(mkMsg({ msgId: 's0', text: '先聊一句' })); // 建绑定
  const rtStop = rtOf(hStop, bindingKey('m1', 'c1'));
  await hStop.router.handleInbound(mkMsg({ msgId: 's1', text: '/stop' }));
  assert.equal(rtStop.interrupts, 1);
  assert.ok(hStop.acks[1]!.text.includes('停止'));
  assert.equal(rtStop.submits.length, 1); // /stop 本身未提交

  // /new:重绑同 key,lockedUserId/rootOverride 原样带过,旧 runtime 释放,rootOverride 生效
  const hNew = makeHarness();
  hNew.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 'old-s', journalId: 'j-old', lockedUserId: 'u1', rootOverride: '/override/root', updatedAt: 1 });
  await hNew.router.handleInbound(mkMsg({ msgId: 'n1', text: '/new' }));
  assert.ok(hNew.acks[0]!.text.includes('新会话'));
  assert.equal(hNew.createCalls.length, 1);
  assert.equal(hNew.createCalls[0]!.root, '/override/root'); // rootOverride 优先
  assert.equal(hNew.createCalls[0]!.opts?.activate, false);
  const nb = hNew.bindings.get(bindingKey('m1', 'c1'))!;
  assert.notEqual(nb.sessionId, 'old-s');
  assert.equal(nb.lockedUserId, 'u1'); // 元数据保留
  assert.equal(nb.rootOverride, '/override/root');
  assert.equal(nb.journalId, 'j-s1');
  assert.ok(hNew.released.includes('old-s')); // 旧 runtime 释放

  // /new 前缀形态(带参数)与 auto root 推导
  const hNew2 = makeHarness();
  await hNew2.router.handleInbound(mkMsg({ msgId: 'n2', text: '/new 换个话题' }));
  assert.equal(hNew2.createCalls.length, 1);
  assert.equal(hNew2.createCalls[0]!.root, channelChatWorkspaceRoot('m1', 'c1'));
  assert.ok(hNew2.acks[0]!.text.includes('新会话'));
});

test('⑦ 无绑定:新建会话(auto root/mode/activate:false/model)+upsert 绑定+submit+ack 已受理', async () => {
  const h = makeHarness();
  await h.router.handleInbound(mkMsg({ msgId: 'c1', text: '帮我建个文件', images: ['data:image/png;base64,x'] }));
  assert.equal(h.createCalls.length, 1);
  assert.equal(h.createCalls[0]!.root, channelChatWorkspaceRoot('m1', 'c1')); // auto → 聊天域 workspace
  assert.equal(h.createCalls[0]!.opts?.activate, false);
  assert.equal(h.createCalls[0]!.opts?.mode, 'acceptEdits');
  const b = h.bindings.get(bindingKey('m1', 'c1'))!;
  assert.equal(b.sessionId, 's1');
  assert.equal(b.journalId, 'j-s1');
  const rt = rtOf(h, bindingKey('m1', 'c1'));
  assert.deepEqual(rt.submits, [{ text: '帮我建个文件', images: ['data:image/png;base64,x'] }]);
  assert.equal(rt.steers.length, 0);
  assert.ok(h.acks[0]!.text.includes('已受理'));

  // 显式 root + model 透传
  const h2 = makeHarness({ configs: [mkCfg({ model: 'glm-4', root: '/explicit/root', mode: 'read-only' })] });
  await h2.router.handleInbound(mkMsg({ msgId: 'c2' }));
  assert.equal(h2.createCalls[0]!.root, '/explicit/root');
  assert.equal(h2.createCalls[0]!.opts?.model, 'glm-4');
  assert.equal(h2.createCalls[0]!.opts?.mode, 'read-only');
});

test('⑧ 有绑定运行时在座:idle→submit;running→steer;submit 409→回退 steer', async () => {
  // idle → submit 直达
  const h1 = makeHarness();
  await h1.router.handleInbound(mkMsg({ msgId: 'a1', text: '第一句' }));
  const rt1 = rtOf(h1, bindingKey('m1', 'c1'));
  await h1.router.handleInbound(mkMsg({ msgId: 'a2', text: '第二句' }));
  assert.equal(rt1.submits.length, 2);
  assert.equal(rt1.steers.length, 0);

  // running → steer
  const h2 = makeHarness();
  await h2.router.handleInbound(mkMsg({ msgId: 'b1', text: '开场' }));
  const rt2 = rtOf(h2, bindingKey('m1', 'c1'));
  rt2._status = 'running';
  await h2.router.handleInbound(mkMsg({ msgId: 'b2', text: '穿插一句' }));
  assert.equal(rt2.submits.length, 1);
  assert.equal(rt2.steers.length, 1);
  assert.equal(rt2.steers[0]!.text, '穿插一句');

  // idle 表面但 submit 撞 409(受理间隙竞态)→ 回退 steer
  const h3 = makeHarness({ runtimeFactory: () => makeRuntime({ submit409: true }) });
  await h3.router.handleInbound(mkMsg({ msgId: 'c3', text: '撞锁发言' }));
  const rt3 = rtOf(h3, bindingKey('m1', 'c1'));
  assert.equal(rt3.submits.length, 1);
  assert.equal(rt3.steers.length, 1);
  assert.equal(rt3.steers[0]!.text, '撞锁发言');
});

test('⑨ 有绑定但运行时不在注册表:attach 重开后走提交;attach 失败释放走新建', async () => {
  // attach 成功:同 sessionId 重开,提交照走
  const h = makeHarness();
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 'ghost-s', journalId: 'j-ghost', updatedAt: 1 });
  await h.router.handleInbound(mkMsg({ msgId: 'r1', text: '重新接上' }));
  assert.deepEqual(h.attached, [{ id: 'ghost-s', journalId: 'j-ghost' }]);
  assert.equal(h.runtimes.get('ghost-s')!.submits.length, 1);
  assert.ok(h.acks[0]!.text.includes('已受理'));

  // attach 失败:残座释放 + 新建 + 重绑新 sessionId
  const h2 = makeHarness({ attachFail: true });
  h2.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 'ghost2', journalId: 'j-g2', updatedAt: 1 });
  await h2.router.handleInbound(mkMsg({ msgId: 'r2', text: '接不上就重建' }));
  assert.deepEqual(h2.released, ['ghost2']);
  assert.equal(h2.createCalls.length, 1);
  const nb = h2.bindings.get(bindingKey('m1', 'c1'))!;
  assert.equal(nb.sessionId, 's1');
  assert.notEqual(nb.sessionId, 'ghost2');
  assert.equal(h2.runtimes.get('s1')!.submits.length, 1);
  assert.ok(h2.acks[0]!.text.includes('已受理'));
});

test('⑩ meta 通道标:新绑定会话 writeSessionMeta 落 channel 字段', async () => {
  const h = makeHarness();
  await h.router.handleInbound(mkMsg({ msgId: 'meta1' }));
  const b = h.bindings.get(bindingKey('m1', 'c1'))!;
  const rt = h.runtimes.get(b.sessionId)!;
  const meta = readSessionMeta(rt.dataDir, b.journalId!);
  assert.equal(meta.channel, 'm1'); // 侧栏「通道」分组消费(Task 13)
});

test('⑪ 审批 y/n 回复截胡:pendingReply 命中即消费,不提交不应答', async () => {
  const h = makeHarness({ pendingReply: (_sessionId, text) => text.trim().toLowerCase() === 'y' });
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 's9', journalId: 'j9', updatedAt: 1 });
  h.runtimes.set('s9', makeRuntime({ journalId: 'j9' }));
  await h.router.handleInbound(mkMsg({ msgId: 'y1', text: 'y' }));
  assert.equal(h.acks.length, 0); // 已消费:不发「已受理」
  const rt = h.runtimes.get('s9')!;
  assert.equal(rt.submits.length, 0);
  assert.equal(rt.steers.length, 0);
  await h.router.handleInbound(mkMsg({ msgId: 'y2', text: '继续' })); // 未命中 → 正常管线
  assert.equal(h.acks.length, 1);
  assert.equal(rt.submits.length, 1);
});

test('⑫ 群聊 submit 注入 [来自 x]: 前缀;单聊原文;noteSender 回调', async () => {
  const h = makeHarness();
  await h.router.handleInbound(mkMsg({ msgId: 'g1', chatKind: 'group', atBot: true, userId: 'u1', userDisplay: 'Alice', text: '跑个测试' }));
  assert.equal(rtOf(h, bindingKey('m1', 'c1')).submits[0]!.text, '[来自 Alice]: 跑个测试');
  assert.deepEqual(h.noteSenders, [{ sessionId: 's1', display: 'Alice' }]);

  const h2 = makeHarness();
  await h2.router.handleInbound(mkMsg({ msgId: 'g2', chatKind: 'direct', userId: 'u1', userDisplay: 'Alice', text: '原文不加' }));
  assert.equal(rtOf(h2, bindingKey('m1', 'c1')).submits[0]!.text, '原文不加');
  assert.deepEqual(h2.noteSenders, [{ sessionId: 's1', display: 'Alice' }]);

  // userDisplay 缺省回退 userId
  const h3 = makeHarness();
  await h3.router.handleInbound(mkMsg({ msgId: 'g3', chatKind: 'group', atBot: true, userId: 'u9', text: 'hi' }));
  assert.equal(rtOf(h3, bindingKey('m1', 'c1')).submits[0]!.text, '[来自 u9]: hi');
  assert.deepEqual(h3.noteSenders, [{ sessionId: 's1', display: 'u9' }]);
});

test('⑬ 契约:io 异常不击穿 handleInbound,尽力 ack 处理失败', async () => {
  const h = makeHarness();
  h.io.createSession = () => {
    throw new Error('boom');
  };
  await h.router.handleInbound(mkMsg({ msgId: 'x1' }));
  assert.equal(h.acks.length, 1);
  assert.ok(h.acks[0]!.text.includes('处理失败'));
});
