/** 通道入站管线（spec 2026-11-21-channels §4 绑定解析/提交分派，Task 5）：IM 聊天消息 →
 *  去重（(channel,msgId) LRU 4096）→ 配置门（缺失/!enabled 静默丢弃）→ 准入（群聊须 atBot；
 *  list 白名单 userIds/chatIds 命中其一；first-user 锁定 ≠ 发送者 → ack 拒绝）→ 审批回复截胡
 *  （deps.pendingReply 命中即消费，不发 ack——engine 接线 projector，Task 6/7）→ 指令短路
 *  （/help 帮助文案 / /stop 中断 / /new 新建重绑）→ 绑定解析三态（在座直用 → attach 重开 →
 *  新建；attach 失败释放残座走新建）→ 提交分派（idle→submit，409 回退 steer；running→steer）→
 *  ack 二态回执（计划 §4 第 6 条：受理「已受理，处理中」/ 排队「已加入排队…」）。平台无关——平台差异由上游 SPI 适配器吃掉，本模块只认 InboundMessage。
 *  root 解析（spec §4）：binding.rootOverride 优先（聊天信息条「绑定工作区切换」下次 /new 生效，
 *  spec §9.3）；cfg.root==='auto'（缺省形态）→ channelChatWorkspaceRoot 聊天专属域 workspace 铸造。
 *  契约（Task 5 预检裁定）：handleInbound **绝不抛**——整体 try/catch，失败尽力 ack「处理失败」；
 *  io.onFrame/resolveApproval router 自身不消费（engine Task 7 装配 projector/审批回执用），接口面收全。 */
import { writeSessionMeta } from '../../tui/session-journal';
import { channelChatWorkspaceRoot } from '../../config/channels';
import { bindingKey, CHANNEL_COMMANDS } from './model';
import type { Binding, ChannelConfig, InboundMessage } from './model';
import type { ChannelsBindingsStore } from './store';
import type { SessionRuntime } from '../session';
import type { DaemonFrame } from '../daemon-wire';
import type { AskUserAnswer } from '../../types';
import type { Result } from '../../result';

/** 会话 IO 面（engine/Task 7 装配 daemon 既有单点：createSession/attach 走 session-lifecycle、
 *  resolveApproval 接审批回执路由同款方法） */
export interface ChannelsSessionIo {
  createSession(root: string, opts?: { mode?: 'read-only' | 'acceptEdits' | 'full-access'; activate?: boolean; model?: string }): Result<{ sessionId: string }>;
  getSession(id: string): SessionRuntime | undefined;
  attach(id: string, journalId: string): Result<{ sessionId: string; root: string }>;
  releaseSession(id: string): void;
  activeSessionId(): string | undefined;
  /** 帧泵订阅（router 自身不消费——engine Task 7 装配 projector 用；帧型同 daemon 泵全并集，session.ts:41 import 先例） */
  onFrame(cb: (frame: DaemonFrame) => void): () => void;
  /** 审批回执单点（router 自身不消费——engine Task 7 消费） */
  resolveApproval(pid: string, decision: { approved: boolean; feedback?: string }): boolean;
  /** ask 挂起回执单点（终审修复波 F1 第 8 面，router 自身不消费——engine 装配 projector 消费）：
   *  daemon POST /ask/:pid/reply 内部方法 resolveAsk(pid, AskUserAnswer) 同参透传 */
  resolveAsk(pid: string, answer: AskUserAnswer): boolean;
}

export interface ChannelRouterDeps {
  io: ChannelsSessionIo;
  bindings: ChannelsBindingsStore;
  configs: () => ChannelConfig[];
  /** 回执:分发面文本(text 语义权威,平台无关);kind 二态受理标(engine 消费——平台 ack 面
   *  (feishu OnIt 表情)在场时 accepted 免文本;其余文本恒发) */
  ack: (m: InboundMessage, text: string, kind?: 'accepted' | 'queued') => Promise<void>;
  /** 审批 y/n 回复判据（engine 接线 projector，Task 6/7）：true=消息已被消费，router 不再走提交分派 */
  pendingReply?: (sessionId: string, text: string) => boolean;
  /** lastSender 表回写（engine 接线，Task 7 群聊定向回复消费）：结构化 sender——chatKind
   *  供引擎群聊限定 @（单聊回执式回复天然指向本人不加 @,权威口径 model.ts 定向提及字段注），
   *  userId 供平台原生提及语法（feishu `<at user_id>` 服务端渲人名） */
  noteSender?: (sessionId: string, sender: { display: string; userId: string; chatKind: 'direct' | 'group' }) => void;
  /** 提交分派成功回调（裁定 1，engine 接线）：submit/steer 分派成功后回调一次——engine 据此武装
   *  终态观察（armed-once onRunEnd，Task 7）。target 形同 ReplyTarget（reply.ts 结构同构类型——
   *  router 不 import reply，reply.ts 头注防环裁定） */
  onSubmitted?: (sessionId: string, target: { channelId: string; chatId: string }) => void;
  now?: () => number;
}

const DEDUP_MAX = 4096;

/** 命令未开放回执（命令配置化,权威口径 model.ts CHANNEL_COMMANDS 头注）：被配置关掉的命令不
 *  提交模型（/stop 之类当任务发没有意义），一句人性化提示即可——不暴露命令配置细节 */
const COMMAND_DISABLED_TEXT = '该命令未开启，可直接发送任务描述。';

export class ChannelRouter {
  /** 去重表：Map 插入序即 LRU 序（触达重插刷新、超限逐出最旧） */
  private readonly seen = new Map<string, true>();

  constructor(private readonly deps: ChannelRouterDeps) {}

  /** 契约：绝不抛——任何异常尽力 ack「处理失败」+ log，绝不向上抛（sink 调用方零击穿） */
  async handleInbound(msg: InboundMessage): Promise<void> {
    try {
      await this.route(msg);
    } catch (e) {
      console.error('[channels-router] inbound 处理失败:', e instanceof Error ? e.message : String(e));
      try {
        await this.deps.ack(msg, '处理失败，请稍后重试');
      } catch {
        /* ack 亦失败：尽力而为，不再上抛 */
      }
    }
  }

  private async route(msg: InboundMessage): Promise<void> {
    if (this.isDup(msg.channel, msg.msgId)) return; // ① 去重：重复投递静默丢弃
    const cfg = this.deps.configs().find((c) => c.id === msg.channel);
    if (cfg === undefined || !cfg.enabled) return; // ② 配置门：缺失/未启用丢弃
    if (!(await this.admit(msg, cfg))) return; // ③ 准入（first-user 拒绝在此 ack）
    const key = bindingKey(cfg.id, msg.chatId);
    const binding = this.deps.bindings.get(key);
    // ⑪ 审批回复截胡：有绑定且 pendingReply 判 true → 消息已被消费，不发 ack
    if (binding !== undefined && msg.text !== undefined && this.deps.pendingReply?.(binding.sessionId, msg.text) === true) return;
    const text = (msg.text ?? '').trim();
    // 命令门（命令配置化,权威口径 model.ts CHANNEL_COMMANDS 头注）：cfg.commands 缺席=全部开放，
    // 在场=子集；被关掉的命令一句提示即返回（不提交模型——/stop 当任务发没有意义）
    const cmd = CHANNEL_COMMANDS.find((c) => (c.match === 'prefix' ? text.startsWith(c.cmd) : text === c.cmd));
    if (cmd !== undefined && !this.commandEnabled(cfg, cmd.cmd)) {
      await this.deps.ack(msg, COMMAND_DISABLED_TEXT);
      return;
    }
    if (text === '/help') { // ⑥ 指令短路：帮助文案（按开放命令列举），零会话动作
      await this.deps.ack(msg, this.helpText(cfg));
      return;
    }
    if (text === '/stop') {
      await this.cmdStop(msg, key);
      return;
    }
    if (cmd?.cmd === '/status') {
      await this.cmdStatus(msg, key);
      return;
    }
    if (cmd?.cmd === '/new') {
      await this.cmdNew(msg, cfg, key, binding);
      return;
    }
    await this.dispatch(msg, cfg, key, binding); // ⑦⑧⑨⑫ 绑定解析三态 + 提交分派 + ack
  }

  /** 命令开放判定（单一目录点 CHANNEL_COMMANDS）：配置缺席=全开放，在场=子集 */
  private commandEnabled(cfg: ChannelConfig, cmd: string): boolean {
    return cfg.commands === undefined || cfg.commands.includes(cmd);
  }

  /** /help 文案（人性化,不透露底层实现）：只列开放命令+
   *  一句提交语义说明——无 steer/绑定/会话等内部术语 */
  private helpText(cfg: ChannelConfig): string {
    const lines: string[] = [];
    for (const c of CHANNEL_COMMANDS) {
      if (this.commandEnabled(cfg, c.cmd)) lines.push(`${c.cmd} — ${c.desc}`);
    }
    lines.push('其余消息直接发送给助手；任务进行中时会自动接续当前进度。');
    return lines.join('\n');
  }

  /** /status：一句话报任务状态（人性化——空闲/进行中/未建立，无内部字段） */
  private async cmdStatus(msg: InboundMessage, key: string): Promise<void> {
    const sid = this.deps.bindings.get(key)?.sessionId;
    const rt = sid !== undefined ? this.deps.io.getSession(sid) : undefined;
    const st = rt?.status();
    const text =
      st === 'running'
        ? '任务进行中，发送消息会自动接续当前进度。'
        : st === 'idle'
          ? '当前空闲，可直接发送任务。'
          : '发送任意消息即可开始。';
    await this.deps.ack(msg, text);
  }

  /** 去重（①）：(channel,msgId) LRU 4096——触达重插刷新序，超限逐出最旧 */
  private isDup(channelId: string, msgId: string): boolean {
    const k = `${channelId}:${msgId}`;
    if (this.seen.delete(k)) {
      this.seen.set(k, true);
      return true;
    }
    this.seen.set(k, true);
    if (this.seen.size > DEDUP_MAX) {
      const oldest = this.seen.keys().next();
      if (oldest.done !== true) this.seen.delete(oldest.value);
    }
    return false;
  }

  /** 准入（③④⑤）：群聊须 atBot；list 白名单查 userIds/chatIds 命中其一；first-user 既有锁定
   *  ≠ 发送者 → ack「此通道已绑定其他用户」并丢弃（群聊同判据，锁定按聊天 bindingKey 粒度） */
  private async admit(msg: InboundMessage, cfg: ChannelConfig): Promise<boolean> {
    if (msg.chatKind === 'group' && msg.atBot !== true) return false;
    if (cfg.allow.kind === 'list') {
      const uHit = cfg.allow.userIds?.includes(msg.userId) === true;
      const cHit = cfg.allow.chatIds?.includes(msg.chatId) === true;
      if (!uHit && !cHit) return false;
    }
    if (cfg.allow.kind === 'first-user') {
      const locked = this.deps.bindings.get(bindingKey(cfg.id, msg.chatId))?.lockedUserId;
      if (locked !== undefined && locked !== msg.userId) {
        await this.deps.ack(msg, '此通道已绑定其他用户，无法接入');
        return false;
      }
    }
    return true;
  }

  /** /stop：绑定会话在座 → interrupt（try/catch 尽力而为）+ ack「已请求停止」；无绑定/不在座
   *  （无从有 run）同样 ack，语义恒确定 */
  private async cmdStop(msg: InboundMessage, key: string): Promise<void> {
    const sid = this.deps.bindings.get(key)?.sessionId;
    const rt = sid !== undefined ? this.deps.io.getSession(sid) : undefined;
    if (rt !== undefined) {
      try {
        rt.interrupt();
      } catch {
        /* 中断失败不阻断 ack */
      }
    }
    await this.deps.ack(msg, '已请求停止');
  }

  /** /new 语义（⑥）：同聊天新建会话（activate:false）+ 重绑同 key——binding 元数据保留
   *  （lockedUserId/rootOverride/chatKind 原样带过，仅覆写 sessionId/journalId/updatedAt；rootOverride
   *  在此生效，spec §9.3）+ 旧 runtime 释放、旧 journal 留盘可回看 */
  private async cmdNew(msg: InboundMessage, cfg: ChannelConfig, key: string, binding: Binding | undefined): Promise<void> {
    const created = this.deps.io.createSession(this.resolveRoot(cfg, msg.chatId, binding), this.createOpts(cfg));
    if (!created.ok) {
      await this.deps.ack(msg, `新会话创建失败：${created.error.message}`);
      return;
    }
    const sessionId = created.value.sessionId;
    const seat = this.seatAndTag(cfg, sessionId);
    if (seat.rt === undefined) {
      await this.deps.ack(msg, '新会话创建失败：运行时未入注册表');
      return;
    }
    if (binding !== undefined && binding.sessionId !== sessionId) this.deps.io.releaseSession(binding.sessionId);
    this.upsertBinding(key, sessionId, seat, cfg, binding, msg);
    await this.deps.ack(msg, '已开启新会话，原会话留档可回看');
  }

  /** 绑定解析三态（⑦⑧⑨）+ 提交分派：在座直用 → attach 重开（失败释放残座）→ 新建；
   *  idle→submit（409 回退 steer）、running→steer；群聊注入发送者前缀（⑫）；
   *  绑定解析成功后 noteSender 回写（Task 7 lastSender 消费）；ack 二态回执（计划 §4 第 6 条） */
  private async dispatch(msg: InboundMessage, cfg: ChannelConfig, key: string, existing: Binding | undefined): Promise<void> {
    let sessionId: string | undefined;
    let rt: SessionRuntime | undefined;
    if (existing !== undefined) {
      rt = this.deps.io.getSession(existing.sessionId); // ⑧ 在座直用
      if (rt === undefined && existing.journalId !== undefined) {
        const r = this.deps.io.attach(existing.sessionId, existing.journalId); // ⑨ attach 重开
        if (r.ok) rt = this.deps.io.getSession(existing.sessionId);
      }
      if (rt !== undefined) sessionId = existing.sessionId;
    }
    if (rt === undefined || sessionId === undefined) {
      if (existing !== undefined) this.deps.io.releaseSession(existing.sessionId); // ⑨b attach 失败/无 journalId → 残座释放走新建
      const root = this.resolveRoot(cfg, msg.chatId, existing);
      const created = this.deps.io.createSession(root, this.createOpts(cfg)); // ⑦ 新建
      if (!created.ok) {
        await this.deps.ack(msg, `会话创建失败：${created.error.message}`);
        return;
      }
      const seat = this.seatAndTag(cfg, created.value.sessionId);
      if (seat.rt === undefined) {
        await this.deps.ack(msg, '会话创建失败：运行时未入注册表');
        return;
      }
      sessionId = created.value.sessionId;
      rt = seat.rt;
      this.upsertBinding(key, sessionId, seat, cfg, existing, msg);
    }
    this.deps.noteSender?.(sessionId, { display: msg.userDisplay ?? msg.userId, userId: msg.userId, chatKind: msg.chatKind }); // ⑫ 绑定解析成功即回写
    const body = msg.text ?? '';
    const submitText = msg.chatKind === 'group' ? `[来自 ${msg.userDisplay ?? msg.userId}]: ${body}` : body; // ⑫ 单聊原文
    const target = { channelId: cfg.id, chatId: msg.chatId };
    // ack 二态回执（计划 §4 第 6 条「受理即回执」，Task 8 e2e 回修）：idle submit 受理 →
    // 「已受理，处理中」；steer 排队（running 直排 / 409 竞态回退）→「已加入排队，当前任务完成后处理」
    // ——IM 用户凭回执即分辨消息是立即处理还是排队
    let queued = false;
    if (rt.status() === 'idle') {
      const r = rt.submit(submitText, msg.images);
      if (!r.ok && r.status === 409) {
        rt.steer(submitText, msg.images); // 受理间隙竞态：回退穿插
        queued = true;
      }
    } else {
      rt.steer(submitText, msg.images); // running → steer
      queued = true;
    }
    this.deps.onSubmitted?.(sessionId, target); // 裁定 1：分派成功（submit 直达/409 回退 steer/running steer）即回调
    // ack 二态回执（计划 §4 第 6 条）：kind 二态受理标随行（engine 据此走平台 ack 面/文本回退——
    // 飞书 accepted=OnIt「处理中」表情免文本;排队态仍发文本说明）
    await this.deps.ack(msg, queued ? '已加入排队，当前任务完成后处理' : '已受理，处理中', queued ? 'queued' : 'accepted');
  }

  /** 新建后仪式：ensureJournalMinted → writeSessionMeta({channel})（⑩ 通道标出生写一次，
   *  侧栏「通道」分组消费 Task 13；缺席=普通会话）——各步尽力而为 try/catch；
   *  返回 runtime 与 journalId 供绑定 upsert */
  private seatAndTag(cfg: ChannelConfig, sessionId: string): { rt: SessionRuntime | undefined; journalId?: string } {
    const rt = this.deps.io.getSession(sessionId);
    if (rt === undefined) return { rt: undefined };
    try {
      rt.ensureJournalMinted();
    } catch {
      /* 尽力而为：journal 铸造失败由绑定缺 journalId 的三态回退兜底 */
    }
    const journalId = rt.attachedJournalId;
    if (journalId !== undefined) {
      try {
        writeSessionMeta(rt.dataDir, journalId, { channel: cfg.id });
      } catch {
        /* 尽力而为：通道标缺席=普通会话 */
      }
    }
    return { rt, journalId };
  }

  /** root 解析（spec §4）：binding.rootOverride 优先（「绑定工作区切换」下次 /new 生效，§9.3）；
   *  cfg.root==='auto'（缺省形态）→ 聊天专属域 workspace 铸造单点（与 data 平级隔离）；显式 root 直用 */
  private resolveRoot(cfg: ChannelConfig, chatId: string, binding: Binding | undefined): string {
    if (binding?.rootOverride !== undefined) return binding.rootOverride;
    return cfg.root === 'auto' ? channelChatWorkspaceRoot(cfg.id, chatId) : cfg.root;
  }

  /** createSession opts：mode 透传配置、activate:false（通道会话不抢 GUI 焦点）、model 可选透传 */
  private createOpts(cfg: ChannelConfig): { mode: ChannelConfig['mode']; activate: false; model?: string } {
    return { mode: cfg.mode, activate: false, ...(cfg.model !== undefined ? { model: cfg.model } : {}) };
  }

  /** first-user 锁定值：既有锁定原样保留（含 /new 原样带过）；无锁定且通道为 first-user → 锁到当前发送者 */
  private lockOf(cfg: ChannelConfig, binding: Binding | undefined, msg: InboundMessage): string | undefined {
    return binding?.lockedUserId ?? (cfg.allow.kind === 'first-user' ? msg.userId : undefined);
  }

  /** 绑定 upsert 收敛单点（/new 重绑与 dispatch 新建腿共用）：journalId/lock/rootOverride/chatKind
   *  保留优先拼装 + updatedAt——七元字段面一处承载，两调用点零漂移 */
  private upsertBinding(key: string, sessionId: string, seat: { journalId?: string }, cfg: ChannelConfig, binding: Binding | undefined, msg: InboundMessage): void {
    const lock = this.lockOf(cfg, binding, msg);
    this.deps.bindings.upsert({
      key,
      sessionId,
      ...(seat.journalId !== undefined ? { journalId: seat.journalId } : {}),
      ...(lock !== undefined ? { lockedUserId: lock } : {}),
      ...(binding?.rootOverride !== undefined ? { rootOverride: binding.rootOverride } : {}),
      chatKind: binding?.chatKind ?? msg.chatKind, // 绑定元数据：保留优先，首绑自入站消息取（spec §9.3 信息条单聊/群聊标）
      updatedAt: this.nowMs(),
    });
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
