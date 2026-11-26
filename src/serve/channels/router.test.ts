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
import { readSessionMeta } from '../../session/journal';
import { bindingKey } from './model';
import type { Binding, ChannelConfig, InboundMessage } from './model';
import type { SessionRuntime } from '../session';

process.env.SUNSHINEX_CHANNELS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-router-'));

/** 桩 SessionRuntime:计数面(submits/steers/interrupts)+ 可塑状态(_status/409 注入);命令面
 *  (snapshotResponse/setModel/setEffort/modelSwitcher/cancelSteer)测试按需补桩 */
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
  submitExternal: (text: string, images?: string[]) => { ok: boolean; status?: number };
  steers: Array<{ text: string; images?: string[] }>;
  interrupts: number;
  cancelSteer?: (seq: number) => boolean;
  steerFront?: (seq: number) => boolean;
  snapshotResponse?: () => { queued: Array<{ seq: number; text: string }>; effort?: string };
  setModel?: (id: string | undefined) => boolean;
  setEffort?: (v: string) => boolean;
  modelSwitcher?: { currentId(): string | undefined; choices(): Array<{ id: string; model: string }> } | null;
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
    submitExternal: (text, images) => {
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
    snapshotResponse: () => ({ queued: [], effort: undefined, model: undefined }), // /new 回执读档默认桩(空队列=不武装排队选择)
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
  workspaceRoots?: () => string[];
  /** /compact 执行桩(㉑;缺省不注=deps.compact 缺席,cmdCompact 走 unsupported 分支) */
  compact?: (rt: SessionRuntime) => Promise<'ok' | 'unsupported' | 'busy'>;
  /** 只读命令文本桩(㉓ /context;缺省不注=deps.commandText 缺席,cmdContext 回不可用提示) */
  commandText?: (rt: SessionRuntime, line: string) => Promise<string | undefined>;
  /** noteRunSubmit 捕获(bug2 run 起源):[sessionId, msgId] 序对 */
  noteRunSubmits?: Array<{ sessionId: string; msgId: string }>;
  /** config-changed 广播计数（模型/强度实时同步；裸序号选择路径同口径） */
  notifyCount?: { n: number };
}

function makeHarness(opts: HarnessOpts = {}) {
  const bindingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chan-bind-')), 'channels-bindings.json');
  const bindings = new ChannelsBindingsStore(bindingsFile);
  const configs = opts.configs ?? [mkCfg()];
  const acks: Array<{ msg: InboundMessage; text: string }> = [];
  const createCalls: Array<{ root: string; opts?: Parameters<ChannelsSessionIo['createSession']>[1] }> = [];
  const released: string[] = [];
  const attached: Array<{ id: string; journalId: string }> = [];
  const noteSenders: Array<{ sessionId: string; display: string; userId: string; chatKind: 'direct' | 'group' }> = [];
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
    resolveAsk: () => true, // 第 8 面(终审修复波 F1):router 自身不消费,桩仅满足 io 形
  };
  const deps: ChannelRouterDeps = {
    io,
    bindings,
    configs: () => configs,
    ack: async (m, text) => {
      acks.push({ msg: m, text });
    },
    ...(opts.pendingReply !== undefined ? { pendingReply: opts.pendingReply } : {}),
    noteSender: (sessionId, sender) => {
      noteSenders.push({ sessionId, ...sender });
    },
    ...(opts.noteRunSubmits !== undefined
      ? {
          noteRunSubmit: (sessionId: string, msg: InboundMessage) => {
            opts.noteRunSubmits!.push({ sessionId, msgId: msg.msgId });
          },
        }
      : {}),
    ...(opts.workspaceRoots !== undefined ? { workspaceRoots: opts.workspaceRoots } : {}),
    ...(opts.compact !== undefined ? { compact: opts.compact } : {}),
    ...(opts.commandText !== undefined ? { commandText: opts.commandText } : {}),
    ...(opts.notifyCount !== undefined
      ? { notifyConfigChanged: () => { opts.notifyCount!.n += 1; } }
      : {}),
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
  assert.ok(hNew.acks[0]!.text.includes('已切换到新会话'));
  assert.equal(hNew.createCalls.length, 1);
  assert.equal(hNew.createCalls[0]!.root, '/override/root'); // rootOverride 优先
  assert.equal(hNew.createCalls[0]!.opts?.activate, false);
  const nb = hNew.bindings.get(bindingKey('m1', 'c1'))!;
  assert.notEqual(nb.sessionId, 'old-s');
  assert.equal(nb.lockedUserId, 'u1'); // 元数据保留
  assert.equal(nb.rootOverride, '/override/root');
  assert.equal(nb.journalId, 'j-s1');
  // 旧 runtime 不释放(2026-11-23 用户裁定「切会话就切会话,就放着就可以」):旧座留注册表,
  // GUI 开着旧会话的 snapshot/pty 端点不 404
  assert.ok(!hNew.released.includes('old-s'));

  // /new 前缀形态(带参数)与 auto root 推导
  const hNew2 = makeHarness();
  await hNew2.router.handleInbound(mkMsg({ msgId: 'n2', text: '/new 换个话题' }));
  assert.equal(hNew2.createCalls.length, 1);
  assert.equal(hNew2.createCalls[0]!.root, channelChatWorkspaceRoot('m1', 'c1'));
  assert.ok(hNew2.acks[0]!.text.includes('已切换到新会话'));
  // ⑥b /status:一句话任务状态(2026-11-22 用户裁定「还有其他可以暴露给聊天的命令吗?可以加一下」)
  const hSt = makeHarness();
  await hSt.router.handleInbound(mkMsg({ msgId: 'st1', text: '/status' })); // 无绑定=未建立
  assert.ok(hSt.acks[0]!.text.includes('发送任意消息即可开始'));
  const hSt2 = makeHarness({ runtimeFactory: () => makeRuntime({ status: 'running' }) });
  await hSt2.router.handleInbound(mkMsg({ msgId: 'st2', text: '先聊一句' }));
  await hSt2.router.handleInbound(mkMsg({ msgId: 'st3', text: '/status' }));
  assert.ok(hSt2.acks[1]!.text.includes('任务进行中'), '运行中=/status 报进行中(acks[0]=首条受理回执)');
  assert.equal(rtOf(hSt2, bindingKey('m1', 'c1')).submits.length, 0); // 首条消息运行中走 steer;/status 未提交
  assert.equal(rtOf(hSt2, bindingKey('m1', 'c1')).steers.length, 1);
});

test('⑥c 命令门控(2026-11-22 用户裁定「配置可以给聊天执行的命令」):cfg.commands 子集外的命令不进模型,一句未开启提示', async () => {
  const h = makeHarness({ configs: [mkCfg({ commands: ['/help'] })] });
  await h.router.handleInbound(mkMsg({ msgId: 'g0', text: '先聊一句' })); // 建绑定
  const rt = rtOf(h, bindingKey('m1', 'c1'));
  await h.router.handleInbound(mkMsg({ msgId: 'g1', text: '/stop' }));
  await h.router.handleInbound(mkMsg({ msgId: 'g2', text: '/new' }));
  assert.equal(rt.interrupts, 0); // /stop 被关:不中断
  assert.equal(rt.submits.length, 1); // 两条命令都未提交
  assert.equal(h.createCalls.length, 1); // /new 被关:不新建
  assert.equal(h.acks.length, 3);
  assert.ok(h.acks[1]!.text.includes('该命令未开启'));
  assert.ok(h.acks[2]!.text.includes('该命令未开启'));
  // 开放命令照常:/help 在子集内 → 帮助文案(只列开放命令)
  await h.router.handleInbound(mkMsg({ msgId: 'g3', text: '/help' }));
  const help = h.acks[3]!.text;
  assert.ok(help.includes('/help — 显示本帮助'));
  assert.ok(!help.includes('/stop'), '关闭的命令不进帮助列表');
  assert.ok(help.includes('其余消息直接发送给助手'), '提交语义一句话(无内部术语)');
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

test('⑨ 有绑定但运行时不在注册表:铸壳+attach journal 收编重开(2026-11-25 重启恢复终版);attach 失败释放走新建', async () => {
  // attach 成功:铸壳后以壳 id 收编 journal,提交照走,绑定翻新到壳 id
  const h = makeHarness();
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 'ghost-s', journalId: 'j-ghost', updatedAt: 1 });
  await h.router.handleInbound(mkMsg({ msgId: 'r1', text: '重新接上' }));
  assert.deepEqual(h.attached, [{ id: 's1', journalId: 'j-ghost' }]);
  assert.equal(h.runtimes.get('s1')!.submits.length, 1);
  assert.equal(h.bindings.get(bindingKey('m1', 'c1'))!.sessionId, 's1', '绑定翻新到壳 id');
  assert.ok(h.acks[0]!.text.includes('已受理'));

  // attach 失败:残座释放 + 新建 + 重绑新 sessionId
  const h2 = makeHarness({ attachFail: true });
  h2.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 'ghost2', journalId: 'j-g2', updatedAt: 1 });
  await h2.router.handleInbound(mkMsg({ msgId: 'r2', text: '接不上就重建' }));
  assert.deepEqual(h2.released, ['s1', 'ghost2'], '壳清扫+⑨b 旧 id 释放(旧 id 不在座=无害 no-op)');
  assert.equal(h2.createCalls.length, 2);
  const nb = h2.bindings.get(bindingKey('m1', 'c1'))!;
  assert.equal(nb.sessionId, 's2', '新建腿重绑新座');
  assert.notEqual(nb.sessionId, 'ghost2');
  assert.equal(h2.runtimes.get('s2')!.submits.length, 1);
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

test('⑫ 群聊 submit 注入 [From x]: 英文前缀;单聊原文;noteSender 回调(结构化 sender 含 chatKind/userId)', async () => {
  const h = makeHarness();
  await h.router.handleInbound(mkMsg({ msgId: 'g1', chatKind: 'group', atBot: true, userId: 'u1', userDisplay: 'Alice', text: '跑个测试' }));
  assert.equal(rtOf(h, bindingKey('m1', 'c1')).submits[0]!.text, '[From Alice (u1)]: 跑个测试'); // 名字+id 括注(2026-11-25 hover 显 id 可复制)
  assert.deepEqual(h.noteSenders, [{ sessionId: 's1', display: 'Alice', userId: 'u1', chatKind: 'group' }]);

  const h2 = makeHarness();
  await h2.router.handleInbound(mkMsg({ msgId: 'g2', chatKind: 'direct', userId: 'u1', userDisplay: 'Alice', text: '原文不加' }));
  assert.equal(rtOf(h2, bindingKey('m1', 'c1')).submits[0]!.text, '原文不加');
  assert.deepEqual(h2.noteSenders, [{ sessionId: 's1', display: 'Alice', userId: 'u1', chatKind: 'direct' }]);

  // userDisplay 缺省回退 userId
  const h3 = makeHarness();
  await h3.router.handleInbound(mkMsg({ msgId: 'g3', chatKind: 'group', atBot: true, userId: 'u9', text: 'hi' }));
  assert.equal(rtOf(h3, bindingKey('m1', 'c1')).submits[0]!.text, '[From u9]: hi'); // 姓名缺席=id 兜底不重复括注
  assert.deepEqual(h3.noteSenders, [{ sessionId: 's1', display: 'u9', userId: 'u9', chatKind: 'group' }]);
});

test('⑮ chatKind 持久化:direct/group 首绑自入站消息落 binding;/new 重绑保留(spec §9.3)', async () => {
  // direct 消息建绑定 → chatKind==='direct'
  const hDirect = makeHarness();
  await hDirect.router.handleInbound(mkMsg({ msgId: 'k1', chatKind: 'direct' }));
  assert.equal(hDirect.bindings.get(bindingKey('m1', 'c1'))!.chatKind, 'direct');
  // group 消息(带 atBot)建绑定 → chatKind==='group'
  const hGroup = makeHarness();
  await hGroup.router.handleInbound(mkMsg({ msgId: 'k2', chatKind: 'group', atBot: true }));
  assert.equal(hGroup.bindings.get(bindingKey('m1', 'c1'))!.chatKind, 'group');
  // /new 重绑 → chatKind 属绑定元数据,保留语义同 lockedUserId/rootOverride(direct 消息不覆写 group)
  const hNew = makeHarness();
  hNew.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 'old-k', journalId: 'j-k', chatKind: 'group', updatedAt: 1 });
  await hNew.router.handleInbound(mkMsg({ msgId: 'k3', chatKind: 'direct', text: '/new' }));
  const nb = hNew.bindings.get(bindingKey('m1', 'c1'))!;
  assert.equal(nb.chatKind, 'group');
  assert.notEqual(nb.sessionId, 'old-k');
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

test('⑭ ack 二态回执:running/409 回退 ack「排队」;idle 受理 ack「已受理」', async () => {
  // running → steer 排队文案(Task 8 e2e 回修:计划 §4 第 6 条「受理即回执」二态)
  const h = makeHarness();
  await h.router.handleInbound(mkMsg({ msgId: 'q1', text: '开场' }));
  const rt = rtOf(h, bindingKey('m1', 'c1'));
  assert.ok(h.acks[0]!.text.includes('已受理'));
  rt._status = 'running';
  await h.router.handleInbound(mkMsg({ msgId: 'q2', text: '排队发言' }));
  assert.ok(h.acks[1]!.text.includes('排队'));
  assert.ok(!h.acks[1]!.text.includes('已受理'));

  // 409 竞态回退同排队文案
  const h2 = makeHarness({ runtimeFactory: () => makeRuntime({ submit409: true }) });
  await h2.router.handleInbound(mkMsg({ msgId: 'q3', text: '撞锁发言' }));
  assert.ok(h2.acks[0]!.text.includes('排队'));
  assert.ok(!h2.acks[0]!.text.includes('已受理'));

  // idle 受理照旧「已受理」,不含「排队」
  const h3 = makeHarness();
  await h3.router.handleInbound(mkMsg({ msgId: 'q4', text: '直答' }));
  assert.ok(h3.acks[0]!.text.includes('已受理'));
  assert.ok(!h3.acks[0]!.text.includes('排队'));
});

// ⑯ /workspace（2026-11-24 用户裁定「加切换工作区」）：无绑定引导;无参列表;序号切换写
// rootOverride（下次新会话生效,零会话动作）;同根幂等;未知提示;切换后 /new 落新根
test('⑯ /workspace:无参列表;序号切换写 rootOverride;幂等/未知提示;/new 落新根', async () => {
  const h0 = makeHarness({ workspaceRoots: () => ['/proj/a', '/proj/b'] });
  await h0.router.handleInbound(mkMsg({ msgId: 'w0', text: '/workspace' }));
  assert.ok(h0.acks[0]!.text.includes('发送任意消息开始对话'));
  assert.equal(h0.createCalls.length, 0); // 未建会话

  const h = makeHarness({ workspaceRoots: () => ['/proj/a', '/proj/b'] });
  await h.router.handleInbound(mkMsg({ msgId: 'w1', text: '先聊一句' })); // 建绑定
  await h.router.handleInbound(mkMsg({ msgId: 'w2', text: '/workspace' }));
  assert.ok(h.acks[1]!.text.includes('当前工作区'));
  assert.ok(h.acks[1]!.text.includes('1. /proj/a'));
  assert.ok(h.acks[1]!.text.includes('2. /proj/b'));
  await h.router.handleInbound(mkMsg({ msgId: 'w3', text: '/workspace 2' }));
  assert.equal(h.createCalls.length, 1); // 切换零会话动作(当前会话不动)
  assert.equal(h.bindings.get(bindingKey('m1', 'c1'))!.rootOverride, '/proj/b');
  assert.ok(h.acks[2]!.text.includes('已切换工作区到 /proj/b'));
  assert.ok(h.acks[2]!.text.includes('/new'));
  await h.router.handleInbound(mkMsg({ msgId: 'w4', text: '/workspace 2' }));
  assert.ok(h.acks[3]!.text.includes('已经是当前工作区'));
  await h.router.handleInbound(mkMsg({ msgId: 'w5', text: '/workspace /nope' }));
  assert.ok(h.acks[4]!.text.includes('未找到该工作区'));
  await h.router.handleInbound(mkMsg({ msgId: 'w6', text: '/new' }));
  assert.equal(h.createCalls[1]!.root, '/proj/b'); // rootOverride 优先(既有裁定)
});

// ⑰ /model:无参列表(切换器桩);序号切换 rt.setModel;未知提示;单模型装配如实说明
test('⑰ /model:无参列表;序号切换 setModel;未知提示;无切换器说明', async () => {
  let rtRef: RtStub | undefined;
  const notifyCount = { n: 0 };
  const h = makeHarness({
    notifyCount,
    runtimeFactory: () => {
      const rt = makeRuntime();
      rt.modelSwitcher = { currentId: () => 'glm', choices: () => [{ id: 'glm', model: 'glm-4.6' }, { id: 'ds', model: 'deepseek-v3' }] };
      rt.setModel = () => true;
      rtRef = rt;
      return rt;
    },
  });
  await h.router.handleInbound(mkMsg({ msgId: 'd1', text: '先聊一句' }));
  const rt = rtRef!;
  await h.router.handleInbound(mkMsg({ msgId: 'd2', text: '/model' }));
  assert.ok(h.acks[1]!.text.includes('当前模型：glm'));
  assert.ok(h.acks[1]!.text.includes('2. deepseek-v3（ds）'));
  assert.equal(notifyCount.n, 0, '列表不算切换');
  const setIds: Array<string | undefined> = [];
  rt.setModel = (id) => {
    setIds.push(id);
    return true;
  };
  await h.router.handleInbound(mkMsg({ msgId: 'd3', text: '/model 2' }));
  assert.deepEqual(setIds, ['ds']);
  assert.ok(h.acks[2]!.text.includes('已切换模型到 ds'));
  assert.equal(notifyCount.n, 1, '带参切换广播 config-changed（GUI pill 实时同步）');
  // 裸序号选择（列表武装后回「1」）同口径广播（2026-11-25 用户报障根修）
  await h.router.handleInbound(mkMsg({ msgId: 'd3b', text: '/model' })); // 重新武装列表
  await h.router.handleInbound(mkMsg({ msgId: 'd3c', text: '1' }));
  assert.deepEqual(setIds, ['ds', 'glm']);
  assert.ok(h.acks[4]!.text.includes('已切换模型到 glm'));
  assert.equal(notifyCount.n, 2, '裸序号选择路径也广播（此前漏=会话里没主动切换）');
  await h.router.handleInbound(mkMsg({ msgId: 'd4', text: '/model nope' }));
  assert.ok(h.acks[5]!.text.includes('未找到该模型'));
  assert.equal(notifyCount.n, 2, '失败不广播');

  const h2 = makeHarness({
    runtimeFactory: () => {
      const r2 = makeRuntime();
      r2.modelSwitcher = null;
      return r2;
    },
  });
  await h2.router.handleInbound(mkMsg({ msgId: 'd5', text: '先聊一句' }));
  await h2.router.handleInbound(mkMsg({ msgId: 'd6', text: '/model' }));
  assert.ok(h2.acks[1]!.text.includes('单一模型'));
});

// ⑱ /effort:无参列表(EFFORT_ORDER 序,显示名镜像 GUI);序号/档位名切换 rt.setEffort;非法提示
test('⑱ /effort:无参列表;序号/名切换 setEffort;非法提示', async () => {
  const notifyCount = { n: 0 };
  const h = makeHarness({ notifyCount });
  await h.router.handleInbound(mkMsg({ msgId: 'f1', text: '先聊一句' }));
  const rt = rtOf(h, bindingKey('m1', 'c1'));
  rt.snapshotResponse = () => ({ queued: [], effort: 'medium' });
  const efforts: string[] = [];
  rt.setEffort = (v) => {
    efforts.push(v);
    return true;
  };
  await h.router.handleInbound(mkMsg({ msgId: 'f2', text: '/effort' }));
  assert.ok(h.acks[1]!.text.includes('当前思考强度：中'));
  assert.ok(h.acks[1]!.text.includes('1. 关（最快）'));
  assert.ok(h.acks[1]!.text.includes('7. 最大'));
  await h.router.handleInbound(mkMsg({ msgId: 'f3', text: '/effort 5' })); // 序号 5=high
  assert.deepEqual(efforts, ['high']);
  assert.ok(h.acks[2]!.text.includes('已切换思考强度到 高'));
  assert.equal(notifyCount.n, 1, '带参切换广播 config-changed');
  await h.router.handleInbound(mkMsg({ msgId: 'f4', text: '/effort xhigh' })); // 档位名直切
  assert.deepEqual(efforts, ['high', 'xhigh']);
  assert.equal(notifyCount.n, 2);
  // 裸序号选择（列表武装后回「5」）同口径广播（2026-11-25 用户报障根修）
  await h.router.handleInbound(mkMsg({ msgId: 'f4b', text: '/effort' })); // 重新武装
  await h.router.handleInbound(mkMsg({ msgId: 'f4c', text: '5' }));
  assert.deepEqual(efforts, ['high', 'xhigh', 'high']);
  assert.equal(notifyCount.n, 3, '裸序号选择路径也广播（此前漏=会话里没主动切换）');
  await h.router.handleInbound(mkMsg({ msgId: 'f5', text: '/effort ultra' }));
  assert.ok(h.acks[6]!.text.includes('未识别该思考强度'));
  assert.equal(efforts.length, 3); // 非法值未落 setEffort
  assert.equal(notifyCount.n, 3, '失败不广播');
});

// ⑲ 排队两选项（2026-11-24 用户裁定「默认是 daemon 排队,1/2=模拟插入和立即发出」）：消息照常
// steer 入 daemon 队列,回执附选项;「1」=模拟插入（steerFront 置首,running;idle=直接发出）;
// 「2」=撤队列+中断+立即执行（run 起源=原消息气泡）;非序号回复不作选择照常分派
test('⑲ 排队两选项:回执附选项;1=置首模拟插入(idle=直接发出);2=撤队列+中断+立即执行;非序号照常分派', async () => {
  const noteRunSubmits: Array<{ sessionId: string; msgId: string }> = [];
  const h = makeHarness({ noteRunSubmits });
  await h.router.handleInbound(mkMsg({ msgId: 'p1', text: '开场' })); // idle submit
  const rt = rtOf(h, bindingKey('m1', 'c1'));
  rt._status = 'running';
  rt.snapshotResponse = () => ({ queued: [{ seq: 0, text: '加个需求' }] });
  const fronts: number[] = [];
  rt.steerFront = (seq) => {
    fronts.push(seq);
    return true;
  };
  await h.router.handleInbound(mkMsg({ msgId: 'p2', text: '加个需求' })); // daemon 队列+选项回执
  assert.equal(rt.steers.length, 1); // 默认=daemon 队列(非通道侧托管)
  assert.ok(h.acks[1]!.text.includes('已加入排队'));
  assert.ok(h.acks[1]!.text.includes('1. 插入当前对话'));
  assert.ok(h.acks[1]!.text.includes('2. 暂停当前任务'));

  await h.router.handleInbound(mkMsg({ msgId: 'p3', text: '1' })); // 模拟插入:置首,零 steer 增量零中断
  assert.deepEqual(fronts, [0]);
  assert.equal(rt.steers.length, 1);
  assert.equal(rt.interrupts, 0);
  assert.ok(h.acks[2]!.text.includes('已插入当前对话'));

  await h.router.handleInbound(mkMsg({ msgId: 'p4', text: '再排一条' }));
  assert.equal(rt.steers.length, 2);
  rt.cancelSteer = (seq) => {
    rt._status = 'idle'; // 桩:撤队列即 run 收口(idle)
    rt.snapshotResponse = () => ({ queued: [] });
    return seq === 0;
  };
  await h.router.handleInbound(mkMsg({ msgId: 'p5', text: '2' })); // 暂停并立即执行
  assert.equal(rt.interrupts, 1);
  assert.equal(rt.steers.length, 2); // 无新增穿插
  assert.equal(rt.submits[rt.submits.length - 1]!.text, '再排一条'); // 原文本重提交
  assert.ok(h.acks[4]!.text.includes('已暂停当前任务'));
  const sid = h.bindings.get(bindingKey('m1', 'c1'))!.sessionId;
  // run 起源三次落账:p1 idle submit 起源=p1;p3「1 插入」起源移被插入消息=p2(后续输出回它);
  // p5「2 暂停重发」起源=p4(原消息气泡)——三处同 noteRunSubmit 单点
  assert.deepEqual(noteRunSubmits, [
    { sessionId: sid, msgId: 'p1' },
    { sessionId: sid, msgId: 'p2' },
    { sessionId: sid, msgId: 'p4' },
  ]);

  rt._status = 'running';
  rt.snapshotResponse = () => ({ queued: [{ seq: 0, text: '普通消息' }] });
  await h.router.handleInbound(mkMsg({ msgId: 'p6', text: '普通消息' })); // 非序号:照常 steer 分派
  assert.equal(rt.steers.length, 3);
  assert.ok(h.acks[5]!.text.includes('已加入排队'));

  // 「1」当会话已空闲:队列不动不跑——插入=直接发出
  rt._status = 'running';
  rt.snapshotResponse = () => ({ queued: [{ seq: 0, text: '空闲前排队' }] });
  await h.router.handleInbound(mkMsg({ msgId: 'p7', text: '空闲前排队' }));
  assert.equal(rt.steers.length, 4);
  rt._status = 'idle'; // run 自然收束,条目仍在队列
  await h.router.handleInbound(mkMsg({ msgId: 'p8', text: '1' }));
  assert.equal(rt.submits[rt.submits.length - 1]!.text, '空闲前排队');
  assert.ok(h.acks[7]!.text.includes('当前空闲，本条已直接开始处理'));
});

// ㉒ 聊天名称回填（2026-11-25 用户报障「hover 还是显示聊天 id,不是聊天名称」）：既有绑定
// chatTitle 缺省/变化时,后续消息带得到名称即补写绑定档（群聊=群名;单聊回落发送者姓名）
test('㉒ 聊天名称回填:绑定缺名时按消息补写;单聊回落姓名;无名称零动作;改名同步新名', async () => {
  const h = makeHarness();
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 's1', journalId: 'j1', updatedAt: 1 });
  h.runtimes.set('s1', makeRuntime({ journalId: 'j1' }));
  await h.router.handleInbound(mkMsg({ msgId: 'bt1', chatKind: 'group', atBot: true, userId: 'u1', chatTitle: '算法组' }));
  assert.equal(h.bindings.get(bindingKey('m1', 'c1'))!.chatTitle, '算法组', '既有绑定补写群名');
  // 群改名:名称变化同步（hover/侧栏随消息跟到新名,不永久钉旧名）
  await h.router.handleInbound(mkMsg({ msgId: 'bt2', chatKind: 'group', atBot: true, userId: 'u1', chatTitle: '算法组改名' }));
  assert.equal(h.bindings.get(bindingKey('m1', 'c1'))!.chatTitle, '算法组改名');
  // 单聊有发送者姓名 → 回落人名补写（单聊名称=聊天人名称）
  const h2 = makeHarness();
  h2.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 's1', journalId: 'j1', updatedAt: 1 });
  h2.runtimes.set('s1', makeRuntime({ journalId: 'j1' }));
  await h2.router.handleInbound(mkMsg({ msgId: 'bt3', chatKind: 'direct', userId: 'u1', userDisplay: '景楷' }));
  assert.equal(h2.bindings.get(bindingKey('m1', 'c1'))!.chatTitle, '景楷');
  // 单聊无 userDisplay → 无名称可补,零动作（卡面回落 chatId）
  const h3 = makeHarness();
  h3.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 's1', journalId: 'j1', updatedAt: 1 });
  h3.runtimes.set('s1', makeRuntime({ journalId: 'j1' }));
  await h3.router.handleInbound(mkMsg({ msgId: 'bt4', chatKind: 'direct', userId: 'u1' }));
  assert.equal(h3.bindings.get(bindingKey('m1', 'c1'))!.chatTitle, undefined);
});

// ⑳ Sunx 模式（2026-11-24 用户裁定「通道支持 Sunx,品性会话级,/new 仅品性复用」）：新建腿
// createOpts 透传 kind/name/charter;/new 同样透传（品性沿用,对话全新）;ack 文案明示品性沿用
test('⑳ Sunx 模式:新建与 /new 都透传 kind/name/charter;ack 明示品性沿用', async () => {
  const cfg = mkCfg({ sessionKind: 'sunx', name: '飞书助手', charter: '品行章程原文' });
  const h = makeHarness({ configs: [cfg] });
  await h.router.handleInbound(mkMsg({ msgId: 'sx1', text: '开场' }));
  assert.deepEqual(h.createCalls[0]!.opts, {
    mode: 'acceptEdits',
    activate: false,
    kind: 'sunx',
    name: '飞书助手',
    charter: '品行章程原文',
    channelMeta: { platform: 'mock', chatId: 'c1', appName: '飞书助手', userId: 'u1' }, // 单聊用户身份入冻结层(2026-11-25)
  });
  await h.router.handleInbound(mkMsg({ msgId: 'sx2', text: '/new' }));
  assert.deepEqual(h.createCalls[1]!.opts, {
    mode: 'acceptEdits',
    activate: false,
    kind: 'sunx',
    name: '飞书助手',
    charter: '品行章程原文',
    channelMeta: { platform: 'mock', chatId: 'c1', appName: '飞书助手', userId: 'u1' }, // 单聊用户身份入冻结层(2026-11-25)
  });
  assert.ok(h.acks[1]!.text.includes('已切换到新会话'), '/new 回执=成功切换+当前档(2026-11-25 裁定,不再提品性复用)');
  // 普通会话通道:opts 无 sunx 三键（零变化面）;ack 旧文案
  const h2 = makeHarness();
  await h2.router.handleInbound(mkMsg({ msgId: 'sx3', text: '开场' }));
  assert.equal(h2.createCalls[0]!.opts?.kind, undefined);
  assert.equal(h2.createCalls[0]!.opts?.charter, undefined);
  await h2.router.handleInbound(mkMsg({ msgId: 'sx4', text: '/new' }));
  assert.ok(h2.acks[1]!.text.includes('已切换到新会话'));
  assert.ok(!h2.acks[1]!.text.includes('品性'));
});

// ㉑ /compact（2026-11-24 用户裁定「sunx 模式也支持 workspace、compact 等命令」）：无绑定引导;
// 运行中拒绝;idle → 先回执「正在压缩」再执行,ok/busy/异常三终态各有回执
test('㉑ /compact:无绑定引导;运行中拒绝;idle 执行 ok/busy/异常三终态', async () => {
  // 无绑定
  const h0 = makeHarness();
  await h0.router.handleInbound(mkMsg({ msgId: 'k0', text: '/compact' }));
  assert.ok(h0.acks[0]!.text.includes('发送任意消息开始对话'));
  assert.equal(h0.createCalls.length, 0);

  // 运行中拒绝
  const hRun = makeHarness();
  await hRun.router.handleInbound(mkMsg({ msgId: 'k1', text: '开场' }));
  const rtRun = rtOf(hRun, bindingKey('m1', 'c1'));
  rtRun._status = 'running';
  await hRun.router.handleInbound(mkMsg({ msgId: 'k2', text: '/compact' }));
  assert.ok(hRun.acks[1]!.text.includes('任务进行中'));

  // idle → ok 终态:先「正在压缩」后「已压缩」
  let calls = 0;
  const compactResults: Array<'ok' | 'busy'> = ['ok', 'busy'];
  const h = makeHarness({
    compact: () => Promise.resolve(compactResults[calls++] ?? 'ok'),
  });
  await h.router.handleInbound(mkMsg({ msgId: 'k3', text: '开场' }));
  await h.router.handleInbound(mkMsg({ msgId: 'k4', text: '/compact' }));
  assert.equal(calls, 1);
  assert.ok(h.acks[1]!.text.includes('正在压缩'));
  assert.ok(h.acks[2]!.text.includes('上下文已压缩'));
  // busy 终态(执行间隙被任务抢占)
  await h.router.handleInbound(mkMsg({ msgId: 'k5', text: '/compact' }));
  assert.ok(h.acks[3]!.text.includes('正在压缩'));
  assert.ok(h.acks[4]!.text.includes('任务抢先开始'));

  // 执行抛异常 → 失败终态回执,不击穿 handleInbound
  const hBad = makeHarness({ compact: () => Promise.reject(new Error('summarize boom')) });
  await hBad.router.handleInbound(mkMsg({ msgId: 'k6', text: '开场' }));
  await hBad.router.handleInbound(mkMsg({ msgId: 'k7', text: '/compact' }));
  assert.ok(hBad.acks[2]!.text.includes('压缩失败'));
  assert.ok(!hBad.acks.some((a) => a.text.includes('处理失败')), 'cmdCompact 自捕异常,不走外层处理失败兜底');
});

// ㉒ 列表序号选择（2026-11-25 用户裁定「回复序号被当作普通文本」根修）：/workspace 列表武装
// → 裸序号回复=选择写 rootOverride;越界=明确提示不落模型;/model /effort 同机制
test('㉒ 列表序号选择:workspace 裸序号落 rootOverride;越界提示;model/effort 序号切换', async () => {
  const h = makeHarness({ workspaceRoots: () => ['/proj/a', '/proj/b', '/proj/c'] });
  await h.router.handleInbound(mkMsg({ msgId: 's1', text: '先聊一句' }));
  const rt = rtOf(h, bindingKey('m1', 'c1'));
  await h.router.handleInbound(mkMsg({ msgId: 's2', text: '/workspace' })); // 列表+武装
  await h.router.handleInbound(mkMsg({ msgId: 's3', text: '2' })); // 裸序号=选择
  assert.equal(h.bindings.get(bindingKey('m1', 'c1'))!.rootOverride, '/proj/b');
  assert.ok(h.acks[2]!.text.includes('已切换工作区到 /proj/b'));
  assert.equal(rt.submits.length, 1); // 序号未落模型
  // 越界序号:消费+明确提示,不落模型
  await h.router.handleInbound(mkMsg({ msgId: 's4', text: '/workspace' }));
  await h.router.handleInbound(mkMsg({ msgId: 's5', text: '9' }));
  assert.ok(h.acks[4]!.text.includes('这个序号不在列表里'));
  assert.equal(rt.submits.length, 1);
  // 带参直填完整路径(任意存在的目录——借桩自带的临时 dataDir 证存在性)
  await h.router.handleInbound(mkMsg({ msgId: 's6', text: `/workspace ${rt.dataDir}` }));
  assert.ok(h.acks[5]!.text.includes('已切换工作区到'));
  assert.notEqual(h.bindings.get(bindingKey('m1', 'c1'))!.rootOverride, undefined);

  // /model 序号选择
  const hM = makeHarness({
    runtimeFactory: () => {
      const r = makeRuntime();
      r.modelSwitcher = { currentId: () => 'glm', choices: () => [{ id: 'glm', model: 'glm-4.6' }, { id: 'ds', model: 'deepseek-v3' }] };
      r.setModel = () => true;
      return r;
    },
  });
  await hM.router.handleInbound(mkMsg({ msgId: 's7', text: '先聊一句' }));
  const rtM = rtOf(hM, bindingKey('m1', 'c1'));
  const setIds: Array<string | undefined> = [];
  rtM.setModel = (id) => {
    setIds.push(id);
    return true;
  };
  await hM.router.handleInbound(mkMsg({ msgId: 's8', text: '/model' }));
  await hM.router.handleInbound(mkMsg({ msgId: 's9', text: '2' }));
  assert.deepEqual(setIds, ['ds']);
  assert.ok(hM.acks[2]!.text.includes('已切换模型到 ds'));

  // /effort 序号选择
  const hE = makeHarness();
  await hE.router.handleInbound(mkMsg({ msgId: 's10', text: '先聊一句' }));
  const rtE = rtOf(hE, bindingKey('m1', 'c1'));
  rtE.snapshotResponse = () => ({ queued: [], effort: 'medium' }); // /effort 无参读当前档
  const efforts: string[] = [];
  rtE.setEffort = (v) => {
    efforts.push(v);
    return true;
  };
  await hE.router.handleInbound(mkMsg({ msgId: 's11', text: '/effort' }));
  await hE.router.handleInbound(mkMsg({ msgId: 's12', text: '2' }));
  assert.deepEqual(efforts, ['minimal']);
  assert.ok(hE.acks[2]!.text.includes('已切换思考强度到'));
});

// ㉓ 只读命令与清单（2026-11-25 用户裁定「/skills-list /agents-list /teams-list…tui 的 /context
// 等等业务的命令也加上」）：/context 走 commandText 捕获;三清单各回目录行+使用提示;无绑定引导
test('㉓ /context 捕获回执;agents/teams 清单回行+使用提示;无绑定引导', async () => {
  // /context
  const h = makeHarness({ commandText: async () => 'Context breakdown:\ninstructions: 1.2k (10%)' });
  await h.router.handleInbound(mkMsg({ msgId: 'c1', text: '先聊一句' }));
  await h.router.handleInbound(mkMsg({ msgId: 'c2', text: '/context' }));
  assert.ok(h.acks[1]!.text.includes('Context breakdown'));

  // agents/teams 清单:listAgents/listTeams(root) 目录扫描——临时 root 下落 .sunshinex 两族条目
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-list-'));
  const agentsDir = path.join(root, '.sunshinex', 'agents', 'reviewer');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agent.md'), '---\nname: 评审员\ndescription: 严谨评审\n---\n正文', 'utf8');
  const teamsDir = path.join(root, '.sunshinex', 'teams', 'crew');
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.writeFileSync(path.join(teamsDir, 'team.md'), '---\nname: 突击队\ndescription: 快速分工\nmembers:\n  - reviewer\n---\n正文', 'utf8');
  const hL = makeHarness({
    runtimeFactory: () => {
      const r = makeRuntime();
      (r as unknown as { root: string }).root = root;
      return r;
    },
  });
  await hL.router.handleInbound(mkMsg({ msgId: 'c3', text: '先聊一句' }));
  await hL.router.handleInbound(mkMsg({ msgId: 'c4', text: '/agents-list' }));
  assert.ok(hL.acks[1]!.text.includes('reviewer'), 'agents 清单含目录条目');
  assert.ok(hL.acks[1]!.text.includes('点名'), '使用提示随行');
  await hL.router.handleInbound(mkMsg({ msgId: 'c5', text: '/teams-list' }));
  assert.ok(hL.acks[2]!.text.includes('crew'), 'teams 清单含目录条目');
  // skills 清单:桩无 runtime 面——运行读 throw → 「暂不可用」如实降级钉
  await hL.router.handleInbound(mkMsg({ msgId: 'c6', text: '/skills-list' }));
  assert.ok(hL.acks[3]!.text.includes('暂不可用') || hL.acks[3]!.text.includes('可用技能'));
  // 无绑定引导
  const h0 = makeHarness();
  await h0.router.handleInbound(mkMsg({ msgId: 'c7', text: '/skills-list' }));
  assert.ok(h0.acks[0]!.text.includes('发送任意消息开始对话'));
});

// ⑳b ask/审批回答移 run 起源（2026-11-25 用户裁定「应该回复 4,对于测试的回答回复给了第一个
// 消息」根修）:pendingReply 消费即 noteRunSubmit——回答气泡成为后续输出的 reply 起源
test('⑳b 回答移 run 起源:pendingReply 消费即 noteRunSubmit(回答气泡)', async () => {
  const noteRunSubmits: Array<{ sessionId: string; msgId: string }> = [];
  const h = makeHarness({ pendingReply: () => true, noteRunSubmits });
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 's9', journalId: 'j9', updatedAt: 1 });
  h.runtimes.set('s9', makeRuntime({ journalId: 'j9' }));
  await h.router.handleInbound(mkMsg({ msgId: 'a9', text: '1' }));
  assert.deepEqual(noteRunSubmits, [{ sessionId: 's9', msgId: 'a9' }]);
  assert.equal(h.acks.length, 0); // 已消费:无回执
});

// ⑳b 重启恢复（2026-11-25 用户裁定「应用重启后还是接之前的会话」根修）：daemon 重启注册表
// 即空,旧 runtime id 不在座——铸壳+attach journal 收编(two-step),绑定翻新到壳 id;转录/记录
// 全保,不再「重启换新会话」
test('⑳b 重启恢复:旧 id 不在座→铸壳+attach 收编,绑定翻新壳 id;转录延续', async () => {
  const h = makeHarness();
  // 预置绑定:旧 runtime id 'dead-id'(重启后不在座),journalId 'j-keep'
  h.bindings.upsert({ key: bindingKey('m1', 'c1'), sessionId: 'dead-id', journalId: 'j-keep', updatedAt: 1 });
  await h.router.handleInbound(mkMsg({ msgId: 'r1', text: '重启后的第一条消息' }));
  // 铸壳+收编:createSession 先行,attach 以壳 id+旧 journal 调用
  assert.deepEqual(h.attached, [{ id: 's1', journalId: 'j-keep' }]);
  const nb = h.bindings.get(bindingKey('m1', 'c1'))!;
  assert.equal(nb.sessionId, 's1', '绑定翻新到壳 id');
  assert.equal(nb.journalId, 'j-keep', 'journal 不变(转录/记录全保)');
  // 提交进收编后的会话
  assert.equal(h.runtimes.get('s1')!.submits.length, 1);
  assert.ok(h.acks[0]!.text.includes('已受理'));
  // 不 release(壳=活会话)
  assert.deepEqual(h.released, []);
});
