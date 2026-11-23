/** 通道引擎(spec 2026-11-21-channels §2/§8.3,Task 7):生命周期与调和单点——把 router(入站管线)/
 *  ReplyProjector(出站投影)/平台适配器(SPI 收发)/ChannelsBindingsStore(绑定档)组装成有生命周期的
 *  整体:start() 装载配置调和起停、stop() 全量收口、health() 健康快照、test(id) dry-run 测试连接、
 *  mockAdapter() 测试注入面。
 *
 *  裁定引用:
 *  - 裁定 1(router 接缝):ChannelRouterDeps.onSubmitted 可选回调——router 在 submit/steer 分派成功后
 *    回调,engine 据此武装终态观察(armed-once,见 armRunEnd)。
 *  - 裁定 2(engine 装配三线):① 定向回复——lastSender 表(router.noteSender 写入)命中且**群聊**
 *    才注入 OutboundMessage.mention(结构化,适配器按平台语法渲染;caps.mention 缺席=文本前缀退化;
 *    单聊回执式回复天然指向本人不加 @,streaming 全量替换帧不加,streamDeliver 不走 mention 路);
 *    ② 审批/提问接线——projector.resolveApproval ← io.resolveApproval、projector.resolveAsk ←
 *    io.resolveAsk(终审修复波 F1 第 8 面),router.pendingReply ← projector.pendingReply;
 *    ③ 终态观察——runEndArmed 武装位,onSubmitted 首次回调即注册一次性 onRunEnd;终审修复波 F2
 *    补投影器侧缺口:排队续跑轮(session.ts 轮收尾内部 submit)不经 onSubmitted → projector
 *    ensureArmed 透传 armRunEnd 补武装(armed-once 位幂等,双入口同一观察单点)。
 *  - 硬约束(上游裁定 M-4):帧流 done 必须先于 onRunEnd 投影——帧经 io.onFrame 泵入 projector
 *    (subscribe 直挂),onRunEnd 只发终态注记,engine 不自行重排(顺序天然成立)。
 *
 *  调和纪律(幂等,键=cfg.id):新增/启用且在座未起 → createChannelAdapter + start(失败→health
 *  error 记 detail,绝不抛);移除/停用 → stop + 删表;fail-closed(spec §4 存储总览 2):密钥门
 *  secretGateError 单点——非免密平台(现仅 mock)缺条目内联密钥(cfg.secret,2026-11-22 内联裁定)
 *  拒绝启用,launch(health detail)与 test(dry-run error)双路同源不分叉。
 *  出站分派:每通道包一层 deliver/streamDeliver(adapter.reply? 优先退 send;stream 同理),router.ack
 *  与 projector 共用同款包装。 */
import { loadChannels } from '../../config/channels';
import type { ChannelConfig, ChannelPlatform, InboundMessage, OutboundMessage } from './model';
import type { ChannelsBindingsStore } from './store';
import { ChannelRouter } from './router';
import type { ChannelsSessionIo } from './router';
import { ReplyProjector } from './reply';
import type { ReplyTarget } from './reply';
import { createChannelAdapter } from './adapters/types';
import type { ChannelAdapter, StreamDelta } from './adapters/types';
import { MockChannelAdapter } from './adapters/mock';

/** 健康快照行:enabled 取当前配置快照(移除/停用即 false);connected 取在座适配器 health(缺席/起失败即 false) */
export interface ChannelHealthRow {
  id: string;
  platform: ChannelPlatform;
  enabled: boolean;
  connected: boolean;
  detail?: string;
}

/** 免密平台清单(mock=测试夹具无外连;新增免密平台在此登记)——secretGateError 单点消费 */
const SECRET_FREE_PLATFORMS: ReadonlySet<string> = new Set(['mock']);

export class ChannelsEngine {
  readonly router: ChannelRouter;
  readonly projector: ReplyProjector;

  /** 在座适配器表(键=cfg.id)——调和/投递/caps/健康全部查此表 */
  private readonly adapters = new Map<string, ChannelAdapter>();
  /** 起/建失败 detail(health error 记录不抛;成功即清,下次调和同 id 重试) */
  private readonly startErrors = new Map<string, string>();
  /** 已知通道快照(union 全量保留):health() 对已移除通道保留行呈现 disconnected(空表调和可观测全停) */
  private readonly knownConfigs = new Map<string, ChannelConfig>();
  /** 当前生效配置快照(router configs() 配置门与 test(id) 查档消费) */
  private snapshot: ChannelConfig[] = [];
  /** 定向回复表(裁定 2①):sessionId → 最近发送者(router.noteSender 写入,deliver 群聊 @ 消费;
   *  chatKind 群聊限定——单聊回执式回复天然指向本人不加 @,2026-11-22 用户裁定) */
  private readonly lastSender = new Map<string, { display: string; userId: string; chatKind: 'direct' | 'group' }>();
  /** 终态观察武装位(裁定 2③ armed-once):sessionId → 已注册 onRunEnd(跑完即拆,下一轮重武装) */
  private readonly runEndArmed = new Map<string, boolean>();
  /** 最近入站表:`${channelId}:${chatId}` → 最近一条 InboundMessage——回执式 adapter.reply(inbound)
   *  需要原始入站坐标,sink 记最近一条供 deliver 查用 */
  private readonly lastInbound = new Map<string, InboundMessage>();

  constructor(
    private readonly io: ChannelsSessionIo,
    private readonly bindings: ChannelsBindingsStore,
    private readonly opts?: { configs?: () => ChannelConfig[]; log?: (s: string) => void },
  ) {
    // 出站投影装配(裁定 2):boundSessions ← bindings 档反解;capsOf ← 在座适配器;deliver/streamDeliver
    // ← 本引擎包装;subscribe ← io.onFrame 帧泵直挂(M-4 顺序成立面:done 帧先入投影,onRunEnd 只补注记);
    // resolveApproval ← io.resolveApproval 审批回执单点透传(裁定 2②);resolveAsk ← io.resolveAsk
    // ask 回执单点透传(终审修复波 F1 第 8 面);ensureArmed ← armRunEnd 透传(终审修复波 F2——
    // 排队续跑轮不经 onSubmitted 的终态武装缺口,投影器 token/done 帧补调,armed-once 位幂等)
    this.projector = new ReplyProjector({
      boundSessions: () => this.boundTargets(),
      capsOf: (channelId) => this.adapters.get(channelId)?.caps(),
      deliver: (t, msg) => this.deliver(t, msg),
      streamDeliver: (t, delta) => this.streamDeliver(t, delta),
      subscribe: (cb) => this.io.onFrame(cb),
      resolveApproval: (pid, decision) => this.io.resolveApproval(pid, decision),
      resolveAsk: (pid, answer) => this.io.resolveAsk(pid, answer),
      ensureArmed: (sessionId, target) => this.armRunEnd(sessionId, target),
      log: (s) => this.log(s),
    });
    // 入站路由装配(裁定 2):ack ← 同款 deliver(定向回复前缀统一走此);pendingReply ← projector
    // (审批 y/n 截胡,裁定 2②);noteSender → lastSender(裁定 2①);onSubmitted → armRunEnd(裁定 1/2③)
    this.router = new ChannelRouter({
      io: this.io,
      bindings: this.bindings,
      configs: () => this.snapshot,
      ack: async (m, text, kind) => {
        const adapter = this.adapters.get(m.channel);
        const inbound = this.lastInbound.get(`${m.channel}:${m.chatId}`);
        // 平台 ack 面(2026-11-22 用户裁定「受理不用自动弹出来,用官方处理中 icon」):飞书
        // OnIt「处理中」表情回应——accepted 免文本;queued 表情+文本并存(排队需文字说明);
        // 无 ack 面/无最近入站(表情无从贴)/贴失败 → 文本回退,router 语义零分叉
        let acked = false;
        if (kind !== undefined && adapter !== undefined && adapter.ack !== undefined && inbound !== undefined) {
          try {
            await adapter.ack(inbound, kind);
            acked = true;
          } catch (e) {
            this.log(`ack(${kind}) 平台面失败,文本回退: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (acked && kind === 'accepted') return; // 受理=纯表情免文本;排队/失败继续发说明文本
        }
        await this.deliver({ channelId: m.channel, chatId: m.chatId }, { text });
      },
      pendingReply: (sessionId, text) => this.projector.pendingReply(sessionId, text),
      noteSender: (sessionId, sender) => {
        this.lastSender.set(sessionId, sender);
      },
      onSubmitted: (sessionId, target) => this.armRunEnd(sessionId, target),
    });
  }

  /** 启动:帧订阅先挂(先于适配器起,防早到帧丢)→ 配置调和(opts.configs 注入优先,缺省读全局档) */
  start(): void {
    this.projector.start();
    this.applyConfigs(this.opts?.configs?.() ?? loadChannels().value);
  }

  /** 收口:全适配器 stop + projector 摘帧订阅(挂起审批表保留——reply.ts stop 语义,重启不丢回执面) */
  stop(): void {
    for (const id of [...this.adapters.keys()]) this.teardown(id);
    this.projector.stop();
  }

  /** 配置调和(幂等,键=cfg.id):新增/启用且在座未起 → launch(失败记 health detail 不抛);
   *  移除/停用 → teardown(stop+删表);router configs() 门持本快照 */
  applyConfigs(configs: ChannelConfig[]): void {
    this.snapshot = [...configs];
    const nextIds = new Set(configs.map((c) => c.id));
    for (const cfg of configs) {
      this.knownConfigs.set(cfg.id, cfg);
      if (!cfg.enabled) {
        this.teardown(cfg.id); // 停用 → stop+删表
        continue;
      }
      if (this.adapters.has(cfg.id)) continue; // 幂等:在座已起不动
      this.launch(cfg); // 新增/启用 → create+start
    }
    for (const id of [...this.adapters.keys()]) {
      if (!nextIds.has(id)) this.teardown(id); // 移除 → stop+删表
    }
  }

  /** 健康快照:已知通道 union 逐行——在座查 adapter.health,缺席/起失败 connected:false + detail */
  health(): ChannelHealthRow[] {
    const rows: ChannelHealthRow[] = [];
    for (const [id, cfg] of this.knownConfigs) {
      const enabled = this.snapshot.some((c) => c.id === id && c.enabled);
      const adapter = this.adapters.get(id);
      if (adapter === undefined) {
        const err = this.startErrors.get(id);
        rows.push({ id, platform: cfg.platform, enabled, connected: false, ...(err !== undefined ? { detail: err } : {}) });
        continue;
      }
      const h = adapter.health();
      const detail = this.startErrors.get(id) ?? h.detail;
      rows.push({ id, platform: cfg.platform, enabled, connected: h.connected, ...(detail !== undefined ? { detail } : {}) });
    }
    return rows;
  }

  /** dry-run 测试连接:按配置独立 createChannelAdapter + start + health + stop(空 sink,不起 sink
   *  路由、不动在座表);fail-closed 密钥门同 launch(secretGateError 单点,缺密钥直接 ok:false) */
  async test(id: string): Promise<{ ok: boolean; botId?: string; error?: string }> {
    const cfg =
      this.snapshot.find((c) => c.id === id) ??
      this.knownConfigs.get(id) ??
      this.opts?.configs?.().find((c) => c.id === id);
    if (cfg === undefined) return { ok: false, error: `通道 ${id} 未配置` };
    try {
      const gate = this.secretGateError(cfg); // fail-closed 密钥门(单点,与 launch 同源)
      if (gate !== undefined) return { ok: false, error: gate };
      const adapter = createChannelAdapter(cfg, { secret: cfg.secret ?? '', ident: cfg.ident ?? {}, log: (s) => this.log(s) });
      await adapter.start(() => {});
      let h: { connected: boolean; detail?: string };
      try {
        h = adapter.health();
      } catch (e) {
        await adapter.stop().catch(() => {});
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (!h.connected) {
        await adapter.stop().catch(() => {});
        return { ok: false, error: h.detail ?? '适配器报告未连接' };
      }
      // bot 身份:适配器 botName SPI 面则取真名(飞书 bot/v3/info),否则退化为通用健康文案
      // (无 botName 适配器——mock 等——ok 载荷不空尾,engine.test ③ 口径)
      let botId: string | undefined;
      if (typeof adapter.botName === 'function') {
        try {
          botId = await adapter.botName();
        } catch {
          botId = undefined;
        }
      }
      await adapter.stop().catch(() => {});
      return { ok: true, botId: botId ?? 'OK' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 测试注入面:mock 平台在座适配器(emit/sent),非 mock/未起 → undefined */
  mockAdapter(id: string): { emit(msg: InboundMessage): void; sent: OutboundMessage[] } | undefined {
    const a = this.adapters.get(id);
    return a instanceof MockChannelAdapter ? a : undefined;
  }

  /** 密钥门单点(fail-closed,spec §4 存储总览 2;审查收敛裁定):免密平台清单与「密钥未配置」
   *  文案裁决都收在此一处——launch(health detail)与 test(dry-run error)双路消费不分叉;
   *  undefined=放行,否则返回 detail 文案 */
  private secretGateError(cfg: ChannelConfig): string | undefined {
    if (SECRET_FREE_PLATFORMS.has(cfg.platform)) return undefined; // 免密平台(测试夹具无外连)
    return (cfg.secret ?? '') === '' ? '密钥未配置,通道拒绝启用' : undefined;
  }

  /** 起(调和正路):fail-closed 密钥门(secretGateError 单点,spec §4 存储总览 2)→ create+start;
   *  同步抛(未落地平台/构造失败)记 startErrors 不抛;异步 start 失败摘座+记 detail(下次调和重试) */
  private launch(cfg: ChannelConfig): void {
    const gate = this.secretGateError(cfg); // fail-closed 密钥门(单点,与 test 同源)
    if (gate !== undefined) {
      this.startErrors.set(cfg.id, gate);
      return;
    }
    try {
      const adapter = createChannelAdapter(cfg, { secret: cfg.secret ?? '', ident: cfg.ident ?? {}, log: (s) => this.log(s) });
      this.adapters.set(cfg.id, adapter);
      this.startErrors.delete(cfg.id);
      void adapter.start((msg) => this.onInbound(msg)).catch((e) => {
        if (this.adapters.get(cfg.id) === adapter) this.adapters.delete(cfg.id);
        this.startErrors.set(cfg.id, e instanceof Error ? e.message : String(e));
      });
    } catch (e) {
      this.startErrors.set(cfg.id, e instanceof Error ? e.message : String(e)); // 失败→health error 记 detail,不抛
    }
  }

  /** 停(调和逆路):stop 尽力而为吞错 + 删表 + 清起失败痕 */
  private teardown(id: string): void {
    const adapter = this.adapters.get(id);
    if (adapter !== undefined) {
      this.adapters.delete(id);
      void adapter.stop().catch((e) => this.log(`stop(${id}) 失败吞错: ${e instanceof Error ? e.message : String(e)}`));
    }
    this.startErrors.delete(id);
  }

  /** 适配器入站 sink:记最近入站(回执式 reply 寻址原料)→ 交 router 全管线(handleInbound 契约不抛,防御吞) */
  private onInbound(msg: InboundMessage): void {
    this.lastInbound.set(`${msg.channel}:${msg.chatId}`, msg);
    void this.router.handleInbound(msg).catch(() => {});
  }

  /** 出站投递(裁定 2①):lastSender 查表命中(经绑定反解 sessionId)且**群聊**才注入定向 @——
   *  结构化 mention 交适配器按平台语法渲染(feishu `<at user_id>` 服务端渲人名,caps.mention);
   *  无平台提及面 → 文本前缀 @<display> 退化(telegram 等);单聊零 @(回执式回复天然指向本人,
   *  2026-11-22 用户裁定)。适配器分派 reply 优先(回执式,需原始入站),退 send */
  private async deliver(t: ReplyTarget, msg: OutboundMessage): Promise<void> {
    const adapter = this.adapters.get(t.channelId);
    if (adapter === undefined) throw new Error(`通道 ${t.channelId} 未启动,投递丢弃`);
    const sid = this.sessionIdFor(t);
    const sender = sid !== undefined ? this.lastSender.get(sid) : undefined;
    const out =
      sender !== undefined && sender.chatKind === 'group'
        ? adapter.caps().mention === true
          ? { ...msg, mention: { userId: sender.userId, display: sender.display } }
          : { ...msg, text: `@${sender.display} ${msg.text}` }
        : msg;
    const inbound = this.lastInbound.get(`${t.channelId}:${t.chatId}`);
    if (adapter.reply !== undefined && inbound !== undefined) await adapter.reply(inbound, out);
    else await adapter.send(t, out);
  }

  /** 流式投递(裁定 2① 例外面):同气泡全量替换帧**不加** @前缀(reply 流式已不发前缀);
   *  无 stream 能力退分段 send(全量文本一发) */
  private async streamDeliver(t: ReplyTarget, delta: StreamDelta): Promise<void> {
    const adapter = this.adapters.get(t.channelId);
    if (adapter === undefined) throw new Error(`通道 ${t.channelId} 未启动,流式丢弃`);
    if (adapter.stream !== undefined) await adapter.stream(t, delta);
    else await adapter.send(t, { text: delta.fullText });
  }

  /** 终态观察武装(裁定 1/2③,armed-once):onSubmitted(router 提交分派)与 ensureArmed(投影器
   *  token/done 帧补调,终审修复波 F2——排队续跑轮缺口)双入口同一单点:武装位在场即跳过(幂等),
   *  否则注册一次性 onRunEnd——跑完即拆(delete 武装位)下一轮重武装;只发终态注记,不重排帧序
   *  (M-4:done 帧已先经 io.onFrame 泵入投影,此处天然后至) */
  private armRunEnd(sessionId: string, target: ReplyTarget): void {
    if (this.runEndArmed.has(sessionId)) return;
    const rt = this.io.getSession(sessionId);
    if (rt === undefined) return;
    this.runEndArmed.set(sessionId, true);
    rt.onRunEnd((info) => {
      this.runEndArmed.delete(sessionId);
      void this.projector.onRunEnd(target, info);
    });
  }

  /** 绑定档 → sessionId→target 反解(bindingKey=`${channelId}:${chatId}`,channelId 惯例不含 ':',
   *  首冒号切分;chatId 含 ':' 安全)——projector boundSessions 面与 deliver 前缀查表共用 */
  private boundTargets(): ReadonlyMap<string, ReplyTarget> {
    const m = new Map<string, ReplyTarget>();
    for (const b of this.bindings.all()) {
      const i = b.key.indexOf(':');
      if (i <= 0) continue;
      m.set(b.sessionId, { channelId: b.key.slice(0, i), chatId: b.key.slice(i + 1) });
    }
    return m;
  }

  /** target → sessionId 反查(boundTargets 逆):deliver 前缀查 lastSender 用;同聊天一绑定,首中即回 */
  private sessionIdFor(t: ReplyTarget): string | undefined {
    for (const [sid, tt] of this.boundTargets()) {
      if (tt.channelId === t.channelId && tt.chatId === t.chatId) return sid;
    }
    return undefined;
  }

  private log(s: string): void {
    this.opts?.log?.(s);
  }
}
