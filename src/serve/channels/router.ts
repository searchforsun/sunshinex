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
import { writeSessionMeta } from '../../session/journal';
import { channelChatWorkspaceRoot } from '../../config/channels';
import { EFFORT_ORDER, parseEffort } from '../../model/effort';
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
  createSession(root: string, opts?: { mode?: 'read-only' | 'acceptEdits' | 'full-access'; activate?: boolean; model?: string; channelMeta?: { platform: string; chatId: string; appName?: string } }): Result<{ sessionId: string }>;
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
  /** run 起源消息回写（2026-11-24 用户裁定 bug2「回复没有正确回复给正确的气泡」根修,engine 接线）：
   *  submitExternal 成功即回调——engine 记该会话当前 run 的起源入站,run 产物（正文/终态/挂起投影）
   *  reply 寻址优先回此气泡,不随更新入站漂移;缺席回退最近入站 */
  noteRunSubmit?: (sessionId: string, msg: InboundMessage) => void;
  /** 注册工作区根清单（/workspace 候选,engine 缺省装配 workspace-registry 扫描;测试注入桩） */
  workspaceRoots?: () => string[];
  now?: () => number;
}

const DEDUP_MAX = 4096;

/** 命令未开放回执（命令配置化,权威口径 model.ts CHANNEL_COMMANDS 头注）：被配置关掉的命令不
 *  提交模型（/stop 之类当任务发没有意义），一句人性化提示即可——不暴露命令配置细节 */
const COMMAND_DISABLED_TEXT = '该命令未开启，可直接发送任务描述。';

/** 排队回执+处理方式选择（2026-11-24 用户裁定 bug1「正常进入队列中,同时给用户两个选项」）：
 *  消息照常排队,回执附两序号选项——保持排队 / 暂停当前任务本条立即执行;下一条恰为序号的回复
 *  被消费为选择（takeQueueChoice 截胡） */
const QUEUE_CHOICE_TEXT = '已加入排队，当前任务完成后处理。\n回复序号可改变处理方式：\n1. 保持排队，随当前任务完成后处理\n2. 暂停当前任务，本条消息立即执行';

/** 排队选择待答 TTL：超时未选择即作废（防陈座截胡——用户此后发的「1」是真实消息不再是选择） */
const QUEUE_CHOICE_TTL_MS = 10 * 60_000;

/** /workspace 候选列表展示上限 */
const WORKSPACE_LIST_MAX = 8;

/** 思考强度显示名（GUI effort-slider EFFORT_ZH 镜像 + none 档补位;协议值恒英文 EFFORT_ORDER 序） */
const EFFORT_LABELS: Partial<Record<string, string>> = { none: '关（最快）', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };

/** 排队选择待答条目（bug1）：seq=撤队列寻址键（rt.cancelSteer）;text/images=立即执行重提交原料;
 *  inbound=原消息（「2」成功后 noteRunSubmit 的 run 起源——回答回原气泡）;at=武装时刻（TTL） */
interface QueueChoice {
  sessionId: string;
  seq: number;
  text: string;
  images?: string[];
  inbound: InboundMessage;
  at: number;
}

export class ChannelRouter {
  /** 去重表：Map 插入序即 LRU 序（触达重插刷新、超限逐出最旧） */
  private readonly seen = new Map<string, true>();
  /** 排队选择待答表（bug1）：绑定键 → 待答条目——排队回执武装,下一条恰为「1/2」的回复消费;
   *  每键单条（新排队覆盖旧待答,同审批/提问挂起「最新覆盖」口径） */
  private readonly queueChoices = new Map<string, QueueChoice>();

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
    // 排队处理方式选择截胡（bug1）：排队回执给出两序号选项,恰为「1/2」的下一条回复消费为选择;
    // 位于审批/提问截胡之后（会话内 ask 序号语义优先）,命令门之前（序号非命令）
    if (binding !== undefined && text !== '') {
      const hit = this.takeQueueChoice(key, text);
      if (hit !== undefined) {
        await this.applyQueueChoice(msg, hit.choice, hit.n);
        return;
      }
    }
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
    if (cmd?.cmd === '/workspace') {
      await this.cmdWorkspace(msg, cfg, binding, text.slice('/workspace'.length).trim());
      return;
    }
    if (cmd?.cmd === '/model') {
      await this.cmdModel(msg, binding, text.slice('/model'.length).trim());
      return;
    }
    if (cmd?.cmd === '/effort') {
      await this.cmdEffort(msg, binding, text.slice('/effort'.length).trim());
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

  /** /workspace（2026-11-24 用户裁定「加切换工作区」）：无参=当前+注册工作区候选列表（序号）;
   *  带参=序号或注册根全等（大小写不敏感）→ 写 binding.rootOverride——**下次新会话生效**（spec
   *  §9.3 同款语义:会话 root 出生定版不可变,当前会话不动），ack 明示发 /new 立即切换。无绑定
   *  先引导开对话。候选上限 WORKSPACE_LIST_MAX（注册表大时列表可读性优先） */
  private async cmdWorkspace(msg: InboundMessage, cfg: ChannelConfig, binding: Binding | undefined, arg: string): Promise<void> {
    if (binding === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /workspace 查看与切换工作区。');
      return;
    }
    const roots = this.deps.workspaceRoots?.() ?? [];
    if (arg === '') {
      const lines = [`当前工作区：${this.resolveRoot(cfg, msg.chatId, binding)}`];
      if (roots.length === 0) lines.push('暂无其他已注册工作区。');
      else {
        lines.push('', '回复序号切换工作区（下次新会话生效）：');
        for (let i = 0; i < Math.min(roots.length, WORKSPACE_LIST_MAX); i++) lines.push(`${i + 1}. ${roots[i]}`);
        lines.push('切换后发送 /new 立即在新工作区开始新会话。');
      }
      await this.deps.ack(msg, lines.join('\n'));
      return;
    }
    const picked = /^\d+$/.test(arg) ? roots[Number.parseInt(arg, 10) - 1] : roots.find((r) => r.toLowerCase() === arg.toLowerCase());
    if (picked === undefined) {
      await this.deps.ack(msg, '未找到该工作区，回复 /workspace 查看可选列表。');
      return;
    }
    if (picked === this.resolveRoot(cfg, msg.chatId, binding)) {
      await this.deps.ack(msg, '已经是当前工作区，新会话将继续在此进行。');
      return;
    }
    this.deps.bindings.upsert({ ...binding, rootOverride: picked, updatedAt: this.nowMs() });
    await this.deps.ack(msg, `已切换工作区到 ${picked}。当前会话不变——发送 /new 立即在新工作区开始新会话。`);
  }

  /** /model：无参=当前+可选列表（序号,id 括注）;带参=序号或 id → rt.setModel（daemon 级切换,
   *  下一条消息生效;运行中可切,提示呈现由会话 pendingModelNotice 面自会承担）。单模型装配
   *  （无切换器）如实说明 */
  private async cmdModel(msg: InboundMessage, binding: Binding | undefined, arg: string): Promise<void> {
    const rt = binding !== undefined ? this.deps.io.getSession(binding.sessionId) : undefined;
    if (rt === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /model 查看与切换模型。');
      return;
    }
    const sw = rt.modelSwitcher;
    if (sw === null) {
      await this.deps.ack(msg, '当前装配为单一模型，无需切换。');
      return;
    }
    const choices = sw.choices();
    if (arg === '') {
      const lines = [`当前模型：${sw.currentId() ?? '默认主模型'}`];
      if (choices.length === 0) lines.push('暂无可切换的模型。');
      else {
        lines.push('', '回复序号切换模型（下一条消息生效）：');
        for (let i = 0; i < choices.length; i++) lines.push(`${i + 1}. ${choices[i]!.model}（${choices[i]!.id}）`);
      }
      await this.deps.ack(msg, lines.join('\n'));
      return;
    }
    const picked = /^\d+$/.test(arg) ? choices[Number.parseInt(arg, 10) - 1]?.id : choices.find((c) => c.id === arg)?.id;
    if (picked === undefined || picked === sw.currentId()) {
      await this.deps.ack(msg, picked !== undefined ? '已经是当前模型。' : '未找到该模型，回复 /model 查看可选列表。');
      return;
    }
    if (!rt.setModel(picked)) {
      await this.deps.ack(msg, '模型切换未生效，请稍后重试。');
      return;
    }
    await this.deps.ack(msg, `已切换模型到 ${picked}，下一条消息生效。`);
  }

  /** /effort：无参=当前+档位列表（EFFORT_ORDER 权威序,显示名镜像 GUI effort-slider）;
   *  带参=序号或档位名（parseEffort 校验）→ rt.setEffort（per-run 注入,下一条消息生效,
   *  即改即落 meta 重启不回落） */
  private async cmdEffort(msg: InboundMessage, binding: Binding | undefined, arg: string): Promise<void> {
    const rt = binding !== undefined ? this.deps.io.getSession(binding.sessionId) : undefined;
    if (rt === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /effort 查看与切换思考强度。');
      return;
    }
    if (arg === '') {
      const cur = rt.snapshotResponse().effort;
      const lines = [`当前思考强度：${cur !== undefined ? (EFFORT_LABELS[cur] ?? cur) : '跟随全局默认'}`, '', '回复序号切换思考强度（下一条消息生效）：'];
      for (let i = 0; i < EFFORT_ORDER.length; i++) lines.push(`${i + 1}. ${EFFORT_LABELS[EFFORT_ORDER[i]!] ?? EFFORT_ORDER[i]}`);
      await this.deps.ack(msg, lines.join('\n'));
      return;
    }
    const byIdx = /^\d+$/.test(arg) ? EFFORT_ORDER[Number.parseInt(arg, 10) - 1] : undefined;
    const v = byIdx ?? parseEffort(arg);
    if (v === undefined || !rt.setEffort(v)) {
      await this.deps.ack(msg, '未识别该思考强度，回复 /effort 查看档位列表。');
      return;
    }
    await this.deps.ack(msg, `已切换思考强度到 ${EFFORT_LABELS[v] ?? v}，下一条消息生效。`);
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
   *  在此生效，spec §9.3）。**旧运行时留在座**（2026-11-23 用户裁定「切会话就切会话，不应该
   *  影响之前会话的内容，就放着就可以」）：/new 不 release 旧座——GUI 开着旧会话时 snapshot/
   *  pty 等会话维端点照常寻址（404 根修），旧转录/终端原样可回看，注册表容量交 daemon 既有面 */
  private async cmdNew(msg: InboundMessage, cfg: ChannelConfig, key: string, binding: Binding | undefined): Promise<void> {
    this.queueChoices.delete(key); // 旧会话排队条目的选择待答随之作废（绑定将换新座,选择语义失效）
    const created = this.deps.io.createSession(this.resolveRoot(cfg, msg.chatId, binding), this.createOpts(cfg, msg.chatId));
    if (!created.ok) {
      await this.deps.ack(msg, `新会话创建失败：${created.error.message}`);
      return;
    }
    const sessionId = created.value.sessionId;
    const seat = this.seatAndTag(cfg, sessionId, msg.chatId);
    if (seat.rt === undefined) {
      await this.deps.ack(msg, '新会话创建失败：运行时未入注册表');
      return;
    }
    // 旧运行时**不释放**（2026-11-23 用户裁定「就放着就可以」）：旧座留注册表——GUI 开着旧
    // 会话的 snapshot/pty 等端点不 404
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
      const created = this.deps.io.createSession(root, this.createOpts(cfg, msg.chatId)); // ⑦ 新建
      if (!created.ok) {
        await this.deps.ack(msg, `会话创建失败：${created.error.message}`);
        return;
      }
      const seat = this.seatAndTag(cfg, created.value.sessionId, msg.chatId);
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
      // submitExternal=submit+user 回显帧(2026-11-23 用户裁定「还是没有显示用户的气泡」根修:
      // IM 提交无 GUI 乐观回显,纯 submit 不产帧——GUI 观看该会话时用户气泡要等重播;外部提交
      // 走回显帧广播,GUI live 即显;GUI 自身提交走 submit+本地乐观回显不双气泡)
      const r = rt.submitExternal(submitText, msg.images);
      if (!r.ok && r.status === 409) {
        rt.steer(submitText, msg.images); // 受理间隙竞态：回退穿插
        queued = true;
      } else if (r.ok) {
        this.deps.noteRunSubmit?.(sessionId, msg); // run 起源=本消息气泡（bug2 根修:run 产物回此气泡）
      }
    } else {
      rt.steer(submitText, msg.images); // running → steer
      queued = true;
    }
    this.deps.onSubmitted?.(sessionId, target); // 裁定 1：分派成功（submit 直达/409 回退 steer/running steer）即回调
    if (queued) this.armQueueChoice(sessionId, rt, msg, submitText); // bug1:排队即武装两选项待答
    // ack 二态回执（计划 §4 第 6 条）：kind 二态受理标随行（engine 据此走平台 ack 面/文本回退——
    // 飞书 accepted=OnIt「处理中」表情免文本;排队回执附两序号选项(QUEUE_CHOICE_TEXT)）
    await this.deps.ack(msg, queued ? QUEUE_CHOICE_TEXT : '已受理，处理中', queued ? 'queued' : 'accepted');
  }

  /** 排队选择待答武装（bug1）：steer 入列后取快照队尾 seq（同循环内同步入列,队尾即本条）——
   *  选择「2」凭 seq 撤队列;快照失败=无待答,回执照发不阻断 */
  private armQueueChoice(sessionId: string, rt: SessionRuntime, msg: InboundMessage, submitText: string): void {
    try {
      const items = rt.snapshotResponse().queued;
      const last = items[items.length - 1];
      if (last !== undefined) {
        this.queueChoices.set(bindingKey(msg.channel, msg.chatId), {
          sessionId,
          seq: last.seq,
          text: submitText,
          ...(msg.images !== undefined ? { images: msg.images } : {}),
          inbound: msg,
          at: this.nowMs(),
        });
      }
    } catch {
      /* 尽力而为 */
    }
  }

  /** 排队选择截胡判定（bug1）：待答在座且 trim 后恰为「1/2」（容尾标点 . 。 、）→ 消费并摘座;
   *  非序号回复时仅作 TTL 兜底清座（超时未选择,此后「1」是真实消息不再是选择） */
  private takeQueueChoice(key: string, text: string): { choice: QueueChoice; n: 1 | 2 } | undefined {
    const ch = this.queueChoices.get(key);
    if (ch === undefined) return undefined;
    const m = /^([12])[.。、]?$/.exec(text.trim());
    if (m === null) {
      if (this.nowMs() - ch.at > QUEUE_CHOICE_TTL_MS) this.queueChoices.delete(key);
      return undefined;
    }
    this.queueChoices.delete(key);
    return { choice: ch, n: Number(m[1]) as 1 | 2 };
  }

  /** 排队选择消费（bug1，2026-11-24 用户裁定「1 插入当前会话,2 暂停当前会话发出新消息」）：
   *  1=保持排队（已入列,一句确认零动作）;2=暂停当前任务并立即执行本条——撤队列（cancelSteer,
   *  GUI pauseAndSend 同款）→ 中断当前 run → 等 idle（≤10s,40×250ms 覆盖在飞模型调用收尾）→
   *  submitExternal 立即执行（run 起源=原消息气泡,noteRunSubmit）;提交失败退回排队不丢消息。
   *  条目已出列（已自然接续）则如实告知,零动作 */
  private async applyQueueChoice(msg: InboundMessage, ch: QueueChoice, n: 1 | 2): Promise<void> {
    if (n === 1) {
      await this.deps.ack(msg, '好的，本条保持排队，当前任务完成后处理。');
      return;
    }
    const rt = this.deps.io.getSession(ch.sessionId);
    if (rt === undefined) {
      await this.deps.ack(msg, '会话已结束，请直接发送新消息。');
      return;
    }
    const stillQueued = rt.snapshotResponse().queued.some((q) => q.seq === ch.seq);
    if (!stillQueued) {
      await this.deps.ack(msg, '本条已开始处理，无需暂停。');
      return;
    }
    rt.cancelSteer(ch.seq); // 撤队列：条目已确认在列;失败不阻断（下方 idle 等待兜底）
    try {
      rt.interrupt();
    } catch {
      /* 中断失败不阻断：下方等 idle,超时 submit 竞态由 409 回退如实提示 */
    }
    for (let i = 0; i < 40 && rt.status() !== 'idle'; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const r = rt.submitExternal(ch.text, ch.images);
    if (r.ok) {
      this.deps.noteRunSubmit?.(ch.sessionId, ch.inbound); // run 起源=原消息气泡（回答回原气泡）
      this.deps.onSubmitted?.(ch.sessionId, { channelId: msg.channel, chatId: msg.chatId }); // 终态武装同 dispatch
      await this.deps.ack(msg, '已暂停当前任务，本条消息立即执行。');
      return;
    }
    rt.steer(ch.text, ch.images); // 立即执行未成（收口竞态撞 409）：退回排队不丢消息
    await this.deps.ack(msg, '暂停成功，但立即执行未成功——本条已回到排队，任务停止后会处理。');
  }

  /** 新建后仪式：ensureJournalMinted → writeSessionMeta({channel, chatId})（⑩ 通道标出生写一次，
   *  侧栏「通道」分组消费 Task 13；chatId=平台聊天会话标识出生落档(2026-11-23)——悬浮卡
   *  显示/复制在绑定反查缺席（旧会话//new 后解绑）时仍可达；缺席=普通会话）——各步尽力而为
   *  try/catch；返回 runtime 与 journalId 供绑定 upsert */
  private seatAndTag(cfg: ChannelConfig, sessionId: string, chatId: string): { rt: SessionRuntime | undefined; journalId?: string } {
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
        writeSessionMeta(rt.dataDir, journalId, { channel: cfg.id, ...(chatId !== '' ? { chatId } : {}) });
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

  /** createSession opts：mode 透传配置、activate:false（通道会话不抢 GUI 焦点）、model 可选透传；
   *  channelMeta（2026-11-23 用户裁定「平台/聊天 id/应用名进系统上下文」）——出生定版冻结层,
   *  同一聊天逐字节一致（前缀缓存零损失;动态发言用户走 ⑫ 消息级 [来自 x]: 前缀不入此层） */
  private createOpts(cfg: ChannelConfig, chatId: string): { mode: ChannelConfig['mode']; activate: false; model?: string; effort?: string; channelMeta: { platform: string; chatId: string; appName?: string } } {
    return {
      mode: cfg.mode,
      activate: false,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}), // 通道缺省档(2026-11-23 用户裁定「可以选择默认的模型和强度」)
      channelMeta: { platform: cfg.platform, chatId, ...(cfg.name !== undefined ? { appName: cfg.name } : {}) },
    };
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
