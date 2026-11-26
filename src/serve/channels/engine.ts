/** 通道引擎(spec 2026-11-21-channels §2/§8.3,Task 7):生命周期与调和单点——把 router(入站管线)/
 *  ReplyProjector(出站投影)/平台适配器(SPI 收发)/ChannelsBindingsStore(绑定档)组装成有生命周期的
 *  整体:start() 装载配置调和起停、stop() 全量收口、health() 健康快照、test(id) dry-run 测试连接、
 *  mockAdapter() 测试注入面。
 *
 *  裁定引用(spec):
 *  - 裁定 1(router 接缝):ChannelRouterDeps.onSubmitted 可选回调——router 在 submit/steer 分派成功后
 *    回调,engine 据此武装终态观察(armed-once,见 armRunEnd)。
 *  - 裁定 2(engine 装配三线):① 定向回复——lastSender 表(router.noteSender 写入)命中且**群聊**
 *    才注入 OutboundMessage.mention(结构化,适配器按平台语法渲染;caps.mention 缺席=文本前缀退化;
 *    单聊回执式回复天然指向本人不加 @——权威口径 model.ts 定向提及字段注,streaming 全量替换帧不加,
 *    streamDeliver 不走 mention 路);
 *    ② 审批/提问接线——projector.resolveApproval ← io.resolveApproval、projector.resolveAsk ←
 *    io.resolveAsk,router.pendingReply ← projector.pendingReply;
 *    ③ 终态观察——runEndArmed 武装位,onSubmitted 首次回调即注册一次性 onRunEnd;投影器侧补武装:
 *    排队续跑轮(session.ts 轮收尾内部 submit)不经 onSubmitted → projector
 *    ensureArmed 透传 armRunEnd 补武装(armed-once 位幂等,双入口同一观察单点)。
 *  - 硬约束(上游裁定 M-4):帧流 done 必须先于 onRunEnd 投影——帧经 io.onFrame 泵入 projector
 *    (subscribe 直挂),onRunEnd 只发终态注记,engine 不自行重排(顺序天然成立)。
 *
 *  调和纪律(幂等,键=cfg.id):新增/启用且在座未起 → createChannelAdapter + start(失败→health
 *  error 记 detail,绝不抛);移除/停用 → stop + 删表;fail-closed(spec §4 存储总览 2):密钥门
 *  secretGateError 单点——非免密平台(现仅 mock)缺条目内联密钥(cfg.secret,内联裁定,权威口径
 *  model.ts 头注)拒绝启用,launch(health detail)与 test(dry-run error)双路同源不分叉。
 *  出站分派:每通道包一层 deliver/streamDeliver(adapter.reply? 优先退 send;stream 同理),router.ack
 *  与 projector 共用同款包装。 */
import { loadChannels } from '../../config/channels';
import type { ChannelConfig, ChannelPlatform, InboundMessage, OutboundMessage } from './model';
import type { ChannelsBindingsStore } from './store';
import { ChannelRouter } from './router';
import type { ChannelsSessionIo } from './router';
import { ReplyProjector } from './reply';
import type { ReplyTarget } from './reply';
import { createChannelAdapter, ChannelAdapterError } from './adapters/types';
import type { ChannelAdapter, ChannelPermissionRow, StreamDelta } from './adapters/types';
import { MockChannelAdapter } from './adapters/mock';
import { registeredWorkspaceRoots } from '../workspace-registry';
import { inboundSubmitText } from './model';
import { runCommand, contextBreakdownNotice } from '../session-commands';

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

/** 投递暂存每通道上限（boot 唤醒轮窗口量级;溢出丢最旧） */
const PENDING_OUT_MAX = 20;

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
   *  chatKind 群聊限定——单聊回执式回复天然指向本人不加 @,权威口径 model.ts 定向提及字段注) */
  private readonly lastSender = new Map<string, { display: string; userId: string; chatKind: 'direct' | 'group' }>();
  /** 终态观察武装位(裁定 2③ armed-once):sessionId → 已注册 onRunEnd(跑完即拆,下一轮重武装) */
  private readonly runEndArmed = new Map<string, boolean>();
  /** 最近入站表:`${channelId}:${chatId}` → 最近一条 InboundMessage——回执式 adapter.reply(inbound)
   *  需要原始入站坐标,sink 记最近一条供 deliver 查用 */
  private readonly lastInbound = new Map<string, InboundMessage>();
  /** run 起源表（bug2 根修,2026-11-24 用户裁定「回复没有正确回复给正确的气泡,固定绑定到了
   *  第一个气泡」）:sessionId → 当前 run 的起源入站——run 产物（正文/终态注记/挂起投影/主动
   *  推送）reply 寻址**优先回起源气泡**,不随更新入站漂移（此前恒回最近入站:多消息穿插后回答
   *  全绑到最后一条气泡上）。submitExternal 成功即覆写（router noteRunSubmit 回调）;不清位——
   *  排队续跑轮链式接续共享同一起源气泡;缺席（无 IM 提交过）回退 lastInbound 旧语义 */
  private readonly runOrigin = new Map<string, InboundMessage>();
  /** 投递暂存队列（2026-11-25 用户裁定「中断自动唤醒和任务自动唤醒不要被过滤,要显示给飞书」
   *  根修:boot 恢复唤醒轮在适配器长连接建立完成前起跑——token 帧到投影时 deliver 撞「未启动,
   *  投递丢弃」直接丢失。通道启用但适配器未就绪(缺席/health 未连)的投递改**暂存**,适配器
   *  start 成功即按序冲刷;每通道上限 PENDING_OUT_MAX,溢出丢最旧 */
  private readonly pendingOut = new Map<string, Array<{ target: ReplyTarget; msg: OutboundMessage }>>();
  /** 最近入站环（drain 回显配对原料,2026-11-25 用户裁定①「最后一个应该回复给 1」）：
   *  key=`${channelId}:${chatId}` → 最近 8 条入站——排队消息出队注入时广播的 user 回显帧按
   *  提交文本回配,run 起源移到被 drain 消息（输出跟随它,不再回轮起源气泡） */
  private readonly recentInbounds = new Map<string, InboundMessage[]>();
  /** GUI 发起轮抑制集（2026-11-23 用户裁定「sunshinex 的输入回答不应该让飞书收到,两者是隔离的,
   *  只是同一个显示在上下文中,过滤一下」;复裁定「共享轮正常显示给飞书用户回答」）:daemon HTTP
   *  **空闲提交**面对通道绑定会话打标(markGuiRun)——GUI 发起的新轮,投影器帧过滤跳过该会话全部
   *  帧(正文/终态/挂起投影均不进 IM),done 帧清位;IM 轮进行中的 GUI 穿插**不打标**——共享轮
   *  回答照常给飞书。同一会话上下文共享(GUI 与 IM 同源转录),出站各回各家 */
  private readonly guiRuns = new Set<string>();

  constructor(
    private readonly io: ChannelsSessionIo,
    private readonly bindings: ChannelsBindingsStore,
    private readonly opts?: {
      configs?: () => ChannelConfig[];
      log?: (s: string) => void;
      /** 模型/强度变更广播（2026-11-25 用户裁定「飞书侧更改实时同步 GUI 输入框」）：daemon 注入
       *  config-changed settings 帧广播——GUI 模型 pill/强度 chip 随帧重拉;缺席=GUI 不刷新 */
      notifyConfigChanged?: () => void;
    },
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
      subscribe: (cb) =>
        this.io.onFrame((f) => {
          // GUI 发起轮过滤(裁定见 guiRuns 字段注):抑制集会话的全部帧不进 IM 投影(config-changed
          // 帧无 sessionId 直通);done 帧清位(该轮结束,后续 IM 消息照常投影)
          if ('sessionId' in f && this.guiRuns.has(f.sessionId)) {
            if (f.kind === 'event' && f.e.type === 'done') this.guiRuns.delete(f.sessionId);
            return;
          }
          // drain 回显移起源（issue① 根修,见 recentInbounds 字段注）:user 回显帧=排队消息
          // 出队注入,run 起源移到被 drain 消息——后续输出回复它的气泡
          if ('sessionId' in f && f.kind === 'event' && f.e.type === 'user' && typeof f.e.text === 'string') {
            const origin = this.matchDrainedOrigin(f.sessionId, f.e.text);
            if (origin !== undefined) this.runOrigin.set(f.sessionId, origin);
          }
          // 子智能体帧过滤(2026-11-25 用户裁定「子 agent 的内容没有必要返回给用户网关,用户只和
          // 主 agent 交互」):子 runner 事件流转发进父会话帧泵时带 payload.subagent 标——IM 投影
          // 只认主链,子 token/notice 全部静默(GUI 面照常收,域枚举/看板不受影响)
          if ('sessionId' in f && f.kind === 'event' && f.e.payload?.['subagent'] !== undefined) return;
          cb(f);
        }),
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
        // 平台 ack 面(受理=官方处理中 icon,权威口径 adapters/feishu.ts 头注):飞书
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
        await this.deliverTo(m, { text }); // 回执显式入站寻址:回触发消息气泡,不查 runOrigin
      },
      pendingReply: (sessionId, text) => this.projector.pendingReply(sessionId, text),
      noteSender: (sessionId, sender) => {
        this.lastSender.set(sessionId, sender);
      },
      onSubmitted: (sessionId, target) => this.armRunEnd(sessionId, target),
      noteRunSubmit: (sessionId, msg) => {
        this.runOrigin.set(sessionId, msg);
      },
      workspaceRoots: () => registeredWorkspaceRoots(),
      notifyConfigChanged: () => this.opts?.notifyConfigChanged?.(),
      // /compact 压缩执行单点(2026-11-24 用户裁定「sunx 模式也支持 workspace、compact 等命令」):
      // serve runCommand 直通——GUI/TUI 聊天命令同链路(命令气泡/工具三态行/压缩回执全落转录)
      compact: (rt) => runCommand(rt, '/compact'),
      // 只读命令文本捕获(2026-11-25 用户裁定「tui 的 /context 等等业务的命令也加上」):runCommand
      // capture 旁路——命令气泡/三态行照落转录,回执文本旁路给 IM 回执面
      commandText: async (rt, line) => {
        // /context=通道面中文摘要(2026-11-25 用户裁定「context 根据当前语言 i18n 化」;命令气泡
        // /三态行仍走 runCommand 落转录——runCommand 不重复执行,此处只取格式化面)
        if (line === '/context') return contextBreakdownNotice(rt);
        let text: string | undefined;
        const r = await runCommand(rt, line, (t) => {
          text = t;
        });
        return r === 'ok' ? text : undefined;
      },
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
    this.guiRuns.clear();
  }

  /** 配置调和(幂等,键=cfg.id):新增/启用且在座未起 → launch(失败记 health detail 不抛);
   *  移除/停用 → teardown(stop+删表);router configs() 门持本快照 */
  applyConfigs(configs: ChannelConfig[]): void {
    const prev = this.snapshot;
    this.snapshot = [...configs];
    this.broadcastAppNameChanges(prev, configs); // 应用名称变更 → 该通道全部活会话改名广播
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
    // 已知表随删即清（2026-11-25 用户裁定「不要有配置缓存,彻底清除」根修):原 union 保留已移除
    // 通道行——GET /channels 健康行僵尸复活,设置页重进即见死卡(disconnected 默认字段),重启才清。
    // 停用≠移除:停用条目仍在快照,行保留(enabled:false);移除=快照缺席,行即清
    for (const id of [...this.knownConfigs.keys()]) {
      if (!nextIds.has(id)) this.knownConfigs.delete(id);
    }
  }

  /** 应用名称变更广播（2026-11-25 用户裁定「通道中更新名称要广播给所有的活的会话的 rename」）：
   *  通道 Sunx 的 agent 身份=通道配置应用名称（出生品性冻结层定版,见 session-handlers rename
   *  门槛注）——设置页改应用名称即身份变更,必须让该通道**每一个活会话**（bindings 档反查在座
   *  runtime）收到 [rename] 尾追行,否则各聊天里模型仍自称旧名。prev 无该 id（首次装载/重启
   *  播种）或名称未变/清空 → 零注入（重启不产生噪音改名行）;未在座（无活 runtime）跳过——
   *  链已封存无处可追,下次 attach 靠出生冻结层 + 会话显示名 */
  private broadcastAppNameChanges(prev: ChannelConfig[], next: ChannelConfig[]): void {
    for (const cfg of next) {
      const before = prev.find((c) => c.id === cfg.id);
      if (before === undefined) continue; // 首次装载/新增:无可比的旧名
      const from = before.name ?? '';
      const to = cfg.name ?? '';
      if (from === to || to === '') continue; // 同名/清空:零注入
      let hit = 0;
      for (const b of this.bindings.all()) {
        if (!b.key.startsWith(`${cfg.id}:`)) continue;
        const rt = this.io.getSession(b.sessionId);
        if (rt === undefined) continue; // 只广播活会话
        try {
          rt.runtime.harness.context.appendChain([
            { action: 'note', observation: `[rename] The user renamed you to "${to}" — use this name from now on.` },
          ]);
          hit += 1;
        } catch (e) {
          this.log(`appName broadcast(${cfg.id}/${b.sessionId}) 失败吞错: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.log(`通道 ${cfg.id} 应用名称 ${from === '' ? '(未命名)' : from} → ${to}，已广播 ${hit} 个活会话`);
    }
  }

  /** 健康快照:当前配置快照逐行(2026-11-25 用户裁定「彻底清除」:移除的通道零残留行)——
   *  在座查 adapter.health,缺席/起失败 connected:false + detail;停用条目行保留(enabled:false) */
  health(): ChannelHealthRow[] {
    const rows: ChannelHealthRow[] = [];
    for (const [id, cfg] of this.knownConfigs) {
      if (!this.snapshot.some((c) => c.id === id)) continue; // 已移除(快照缺席)=零残留
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
   *  路由、不动在座表);fail-closed 密钥门同 launch(secretGateError 单点,缺密钥直接 ok:false)。
   *  失败携结构化 code（D111：GUI 按码映射文案,免 daemon 文案子串耦合）——not-found/secret-missing/
   *  ident-invalid/connect-failed/start-failed（未知错误归此);message 仍原样随行供人读 */
  async test(id: string): Promise<{ ok: boolean; botId?: string; error?: string; code?: string }> {
    const cfg =
      this.snapshot.find((c) => c.id === id) ??
      this.knownConfigs.get(id) ??
      this.opts?.configs?.().find((c) => c.id === id);
    if (cfg === undefined) return { ok: false, error: `通道 ${id} 未配置`, code: 'not-found' };
    try {
      const gate = this.secretGateError(cfg); // fail-closed 密钥门(单点,与 launch 同源)
      if (gate !== undefined) return { ok: false, error: gate, code: 'secret-missing' };
      const adapter = createChannelAdapter(cfg, { secret: cfg.secret ?? '', ident: cfg.ident ?? {}, log: (s) => this.log(s) });
      await adapter.start(() => {});
      let h: { connected: boolean; detail?: string };
      try {
        h = adapter.health();
      } catch (e) {
        await adapter.stop().catch(() => {});
        return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'start-failed' };
      }
      if (!h.connected) {
        await adapter.stop().catch(() => {});
        return { ok: false, error: h.detail ?? '适配器报告未连接', code: 'connect-failed' };
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
      const code = e instanceof ChannelAdapterError ? e.code : 'start-failed';
      return { ok: false, error: e instanceof Error ? e.message : String(e), code };
    }
  }

  /** 通道权限自检（2026-11-25 用户裁定「创建通道时主动检测缺少哪些权限,给弹窗说明」）:与 test()
   *  同款 dry-run 独立实例（空 sink、不动在座表、同源密钥门）;适配器无 probePermissions（mock/
   *  telegram 等）返回空列——GUI 弹窗以平台能力如实呈现 */
  async permissions(id: string): Promise<{ ok: boolean; rows: ChannelPermissionRow[]; error?: string }> {
    const cfg =
      this.snapshot.find((c) => c.id === id) ??
      this.knownConfigs.get(id) ??
      this.opts?.configs?.().find((c) => c.id === id);
    if (cfg === undefined) return { ok: false, rows: [], error: `通道 ${id} 未配置` };
    const gate = this.secretGateError(cfg); // fail-closed 密钥门（与 launch/test 同源）
    if (gate !== undefined) return { ok: false, rows: [], error: gate };
    let adapter: ChannelAdapter | undefined;
    try {
      adapter = createChannelAdapter(cfg, { secret: cfg.secret ?? '', ident: cfg.ident ?? {}, log: (s) => this.log(s) });
      await adapter.start(() => {});
      const rows = adapter.probePermissions !== undefined ? await adapter.probePermissions() : [];
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (adapter !== undefined) await adapter.stop().catch(() => {});
    }
  }

  /** 测试注入面:mock 平台在座适配器(emit/sent/replied/streamed),非 mock/未起 → undefined */
  mockAdapter(id: string): { emit(msg: InboundMessage): void; sent: OutboundMessage[]; replied: Array<{ msgId: string; msg: OutboundMessage }>; streamed: StreamDelta[] } | undefined {
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
      void adapter
        .start((msg) => this.onInbound(msg))
        .then(() => this.flushPendingOut(cfg.id)) // 就绪即冲刷暂存投递(boot 唤醒轮丢失根修,见 pendingOut 注)
        .catch((e) => {
          if (this.adapters.get(cfg.id) === adapter) this.adapters.delete(cfg.id);
          this.startErrors.set(cfg.id, e instanceof Error ? e.message : String(e));
        });
    } catch (e) {
      this.startErrors.set(cfg.id, e instanceof Error ? e.message : String(e)); // 失败→health error 记 detail,不抛
    }
  }

  /** send_channel_message 工具出口（spec §6;2026-11-23 用户裁定「补上 send_channel_message」）：
   *  主动推送正文到该会话绑定的聊天——经 deliver 出站包装（纯文本推送无定向 @；未绑定/投递
   *  失败=false，工具报 not_bound/投递失败） */
  async sendToSessionChat(sessionId: string, text: string): Promise<boolean> {
    const t = this.boundTargets().get(sessionId);
    if (t === undefined) return false;
    try {
      await this.deliver(t, { text });
      return true;
    } catch (e) {
      this.log(`sendToSessionChat(${sessionId}) 失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** GUI 发起轮打标（daemon HTTP 提交/穿插面消费，裁定见 guiRuns 字段注）：仅通道绑定会话入集
   *  （非绑定会话的 GUI 提交与通道无关,不标——投影器过滤零开销面） */
  markGuiRun(sessionId: string): void {
    if (this.boundTargets().has(sessionId)) this.guiRuns.add(sessionId);
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
    const key = `${msg.channel}:${msg.chatId}`;
    const ring = this.recentInbounds.get(key) ?? [];
    ring.push(msg);
    while (ring.length > 8) ring.shift();
    this.recentInbounds.set(key, ring);
    void this.router.handleInbound(msg).catch(() => {});
  }

  /** 出站投递(裁定 2①):lastSender 查表命中(经绑定反解 sessionId)且**群聊**才注入定向 @——
   *  结构化 mention 交适配器按平台语法渲染(feishu `<at user_id>` 服务端渲人名,caps.mention);
   *  无平台提及面 → 文本前缀 @<display> 退化(telegram 等);单聊零 @(回执式回复天然指向本人,
   *  权威口径 model.ts 定向提及字段注)。适配器分派 reply 优先(回执式),寻址=run 起源气泡
   *  (bug2:run 产物回触发消息,不随更新入站漂移),缺席回退最近入站 */
  private async deliver(t: ReplyTarget, msg: OutboundMessage): Promise<void> {
    const sid = this.sessionIdFor(t);
    const inbound = (sid !== undefined ? this.runOrigin.get(sid) : undefined) ?? this.lastInbound.get(`${t.channelId}:${t.chatId}`);
    await this.deliverInbound(t, inbound, msg);
  }

  /** 回执寻址投递（router ack 面）：**显式入站寻址**——回执必须回触发消息气泡（受理/排队说明/
   *  命令回执/处理失败），不查 runOrigin（回执不是 run 产物,随起源漂移反而绑错气泡） */
  private async deliverTo(m: InboundMessage, msg: OutboundMessage): Promise<void> {
    await this.deliverInbound({ channelId: m.channel, chatId: m.chatId }, m, msg);
  }

  private async deliverInbound(t: ReplyTarget, inbound: InboundMessage | undefined, msg: OutboundMessage): Promise<void> {
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
    try {
      if (adapter.reply !== undefined && inbound !== undefined) await adapter.reply(inbound, out);
      else await adapter.send(t, out);
    } catch (e) {
      // 未就绪暂存（根修见 pendingOut 字段注）：通道启用而适配器缺席/未连=时序窗,暂存待冲刷;
      // 其余投递异常(平台 API 错误等)原样上抛——调用方面(safeDeliver/sendToSessionChat)语义不变
      const cfg = this.snapshot.find((c) => c.id === t.channelId);
      const ready = adapter.health().connected;
      if (cfg !== undefined && cfg.enabled && !ready) {
        this.queuePendingOut(t.channelId, t, msg);
        this.log(`deliver 暂存(适配器未就绪): ${t.channelId}/${t.chatId} — ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      throw e;
    }
  }

  /** 暂存入队单点：每通道 FIFO,超上限丢最旧 */
  private queuePendingOut(channelId: string, target: ReplyTarget, msg: OutboundMessage): void {
    const q = this.pendingOut.get(channelId) ?? [];
    q.push({ target, msg });
    while (q.length > PENDING_OUT_MAX) q.shift();
    this.pendingOut.set(channelId, q);
  }

  /** drain 回显配对（issue①）：按提交文本回配最近入站（新→旧首个命中,群聊前缀同源计算） */
  private matchDrainedOrigin(sessionId: string, text: string): InboundMessage | undefined {
    for (const [sid, t] of this.boundTargets()) {
      if (sid !== sessionId) continue;
      const list = this.recentInbounds.get(`${t.channelId}:${t.chatId}`);
      if (list === undefined) continue;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i]!;
        if (inboundSubmitText(m) === text) return m;
      }
    }
    return undefined;
  }

  /** 暂存冲刷（adapter start 成功后调用）：按序重投;冲刷期再失败=真失败,落日志丢弃不回队 */
  private flushPendingOut(channelId: string): void {
    const q = this.pendingOut.get(channelId);
    if (q === undefined || q.length === 0) return;
    this.pendingOut.delete(channelId);
    this.log(`flushPendingOut(${channelId}): ${q.length} 条暂存投递冲刷`);
    for (const { target, msg } of q) {
      void this.deliver(target, msg).catch((e) =>
        this.log(`flushPendingOut(${channelId}) 丢弃: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
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
      // 活会话门禁(2026-11-25 用户裁定「活会话隔离」):让位会话(绑定已切走=无绑定)的终态注记
      // 不进飞书——让位中断旧 run 时 onRunEnd 必触发,「任务已停止」回旧聊天正是要拦的面
      if (!this.boundTargets().has(sessionId)) return;
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
