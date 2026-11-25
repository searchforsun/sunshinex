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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeSessionMeta } from '../../session/journal';
import { channelChatWorkspaceRoot } from '../../config/channels';
import { EFFORT_ORDER, parseEffort } from '../../model/effort';
import { listAgents } from '../../catalog/agents';
import { listTeams } from '../../catalog/teams';
import { bindingKey, inboundSubmitText, CHANNEL_COMMANDS } from './model';
import type { Binding, ChannelConfig, InboundMessage } from './model';
import type { ChannelsBindingsStore } from './store';
import type { SessionRuntime } from '../session';
import type { DaemonFrame } from '../daemon-wire';
import type { AskUserAnswer } from '../../types';
import type { Result } from '../../result';

/** 会话 IO 面（engine/Task 7 装配 daemon 既有单点：createSession/attach 走 session-lifecycle、
 *  resolveApproval 接审批回执路由同款方法） */
export interface ChannelsSessionIo {
  createSession(root: string, opts?: { mode?: 'read-only' | 'acceptEdits' | 'full-access'; activate?: boolean; model?: string; effort?: string; kind?: 'sunx'; name?: string; charter?: string; channelMeta?: { platform: string; chatId: string; appName?: string } }): Result<{ sessionId: string }>;
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
  /** 旧座让位（2026-11-25 结构性修「只有一个活的」）：绑定切到 keepSessionId 时,同聊天其他
   *  在座通道会话释放让位（在飞任务中断,ledger 孤儿经新座 redriveInterruptedTasks 重派;
   *  journal 留档可回看）;缺席=不讓位(窄桩) */
  retireOtherChatSessions?(chatId: string, keepSessionId: string): void;
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
  /** /compact 压缩执行单点（engine 缺省装配 serve runCommand——GUI/TUI 同链路;测试注入桩）：
   *  返回三态同 session-commands CommandRunResult */
  compact?: (rt: SessionRuntime) => Promise<'ok' | 'unsupported' | 'busy'>;
  /** 只读命令文本捕获（/context,engine 缺省装配 runCommand capture 旁路——命令气泡/三态行照落
   *  转录,回执文本旁路给 IM;测试注入桩）;undefined=命令不可用 */
  commandText?: (rt: SessionRuntime, line: string) => Promise<string | undefined>;
  now?: () => number;
}

const DEDUP_MAX = 4096;

/** 命令未开放回执（命令配置化,权威口径 model.ts CHANNEL_COMMANDS 头注）：被配置关掉的命令不
 *  提交模型（/stop 之类当任务发没有意义），一句人性化提示即可——不暴露命令配置细节 */
const COMMAND_DISABLED_TEXT = '该命令未开启，可直接发送任务描述。';

/** 排队回执+处理方式选择（2026-11-24 用户裁定「默认是 daemon 排队,1/2=模拟插入和立即发出」）：
 *  消息照常 rt.steer 入 **daemon 队列**（非通道侧——GUI 队列 chips 同源可见,收束续跑既有语义）,
 *  回执附两序号选项;下一条恰为序号的回复被消费为选择（takeQueueChoice 截胡） */
const QUEUE_CHOICE_TEXT = '已加入排队，当前任务完成后处理。\n回复序号可改变处理方式：\n1. 插入当前对话，让助手立即看到\n2. 暂停当前任务，本条消息立即执行';

/** 排队选择待答 TTL：超时未选择即作废（防陈座截胡——用户此后发的「1」是真实消息不再是选择） */
const QUEUE_CHOICE_TTL_MS = 10 * 60_000;

/** /workspace 候选列表展示上限 */
const WORKSPACE_LIST_MAX = 8;

/** 清单类命令展示上限（skills/agents/teams 消息可读性优先,超出给总数行） */
const LIST_MAX = 20;
const SKILL_LIST_MAX = 20;
/** 清单描述截断长（2026-11-25 用户裁定「描述有最大长度,超过省略」）:按码点计（CJK 一字一码点） */
const LIST_DESC_MAX = 60;

/** 描述截断单点：超长裁 LIST_DESC_MAX 码点+省略号 */
function clipDesc(desc: string): string {
  const pts = Array.from(desc);
  return pts.length > LIST_DESC_MAX ? pts.slice(0, LIST_DESC_MAX).join('') + '…' : desc;
}

/** 思考强度显示名（GUI effort-slider EFFORT_ZH 镜像 + none 档补位;协议值恒英文 EFFORT_ORDER 序） */
const EFFORT_LABELS: Partial<Record<string, string>> = { none: '关（最快）', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };

/** 排队选择待答条目：seq=daemon 队列寻址键（steerFront 置首/cancelSteer 撤销）;text/images=
 *  「2 暂停新发」的重提交原料;inbound=原消息（重提交成功后 noteRunSubmit 的 run 起源——回答回
 *  原气泡）;at=武装时刻（TTL） */
interface QueueChoice {
  sessionId: string;
  seq: number;
  text: string;
  images?: string[];
  inbound: InboundMessage;
  at: number;
}

/** 列表序号选择待答条目（issue① 根修）：kind=消费面（workspace 写 rootOverride/model 切模型/
 *  effort 切强度）;items=列表快照（武装时刻所见,序号语义钉快照）;at=武装时刻（TTL 同排队选择） */
interface ChatSelect {
  kind: 'workspace' | 'model' | 'effort';
  items: string[];
  at: number;
}

export class ChannelRouter {
  /** 去重表：Map 插入序即 LRU 序（触达重插刷新、超限逐出最旧） */
  private readonly seen = new Map<string, true>();
  /** 排队选择待答表：绑定键 → 待答条目——排队回执武装,下一条恰为「1/2」的回复消费;
   *  每键单条（新排队覆盖旧待答,同审批/提问挂起「最新覆盖」口径） */
  private readonly queueChoices = new Map<string, QueueChoice>();
  /** 列表序号选择待答（2026-11-25 用户裁定「回复序号被当作普通文本」根修）：/workspace /model
   *  /effort 无参列表武装——下一条恰为序号的回复消费为选择;items=列表快照（回复期注册表漂移
   *  不影响已列出的序号语义）;与排队选择互斥（新武装摘旧,最新意图优先） */
  private readonly chatSelects = new Map<string, ChatSelect>();

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
    // ⑪ 审批回复截胡：有绑定且 pendingReply 判 true → 消息已被消费，不发 ack。
    // 回答同时移 run 起源（2026-11-25 用户裁定「应该回复 4,对于测试的回答回复给了第一个消息」）:
    // ask/审批回答驱动本轮后续输出——回答气泡即新起源,不回旧起源气泡
    if (binding !== undefined && msg.text !== undefined && this.deps.pendingReply?.(binding.sessionId, msg.text) === true) {
      this.deps.noteRunSubmit?.(binding.sessionId, msg);
      return;
    }
    const text = (msg.text ?? '').trim();
    // 聊天名称回填（issue②：飞书群名/联系人名晚到/绑定早于能力——绑定档缺 chatTitle 而本条消息
    // 携带时即补写,GUI 悬浮卡 hover 随之显示名称不再回落 chatId;尽力而为不阻断）
    if (binding !== undefined) {
      const title = this.titleFromMsg(msg);
      if (title !== undefined && binding.chatTitle !== title) {
        this.deps.bindings.upsert({ ...binding, chatTitle: title, updatedAt: this.nowMs() });
      }
    }
    // 列表序号选择截胡（issue① 根修）：/workspace /model /effort 列表武装的序号回复消费为选择;
    // 位于审批/提问截胡之后（会话内 ask 序号语义优先）、排队选择之前（新武装互斥,最新意图优先）
    if (binding !== undefined && text !== '') {
      const sel = this.takeChatSelect(key, text);
      if (sel !== undefined) {
        await this.applyChatSelect(msg, binding, sel.kind, sel.items, sel.n);
        return;
      }
    }
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
    if (cmd?.cmd === '/compact') {
      await this.cmdCompact(msg, binding);
      return;
    }
    // 只读/记忆命令族（2026-11-25 用户裁定「/memory-gc /memory 等命令 gui 也要加上」）:统一
    // 走 deps.commandText 单点（engine 装配——/context=t() 摘要;memory 族=runCommand capture,
    // 回执 t() 双语）——整行透传（/memory-rm 2 的参数随行）
    if (cmd?.cmd === '/context' || cmd?.cmd === '/memory' || cmd?.cmd === '/memory-rm' || cmd?.cmd === '/memory-gc' || cmd?.cmd === '/memory-on' || cmd?.cmd === '/memory-off') {
      await this.cmdViaCommandText(msg, binding, text);
      return;
    }
    if (cmd?.cmd === '/skills-list') {
      await this.cmdSkillsList(msg, binding);
      return;
    }
    if (cmd?.cmd === '/agents-list') {
      await this.cmdAgentsList(msg, binding);
      return;
    }
    if (cmd?.cmd === '/teams-list') {
      await this.cmdTeamsList(msg, binding);
      return;
    }
    await this.dispatch(msg, cfg, key, binding); // ⑦⑧⑨⑫ 绑定解析三态 + 提交分派 + ack
  }

  /** 消息携带的聊天名称（issue② 回填原料）：平台聊天信息 API 名（群名/单聊会话名）优先,
   *  单聊回落发送者姓名（chatTitleOf 首绑铸形同源） */
  private titleFromMsg(msg: InboundMessage): string | undefined {
    if (msg.chatTitle !== undefined && msg.chatTitle !== '') return msg.chatTitle;
    if (msg.chatKind === 'direct' && msg.userDisplay !== undefined && msg.userDisplay !== '') return msg.userDisplay;
    return undefined;
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

  /** /workspace（2026-11-24 用户裁定「加切换工作区」）：无参=当前+注册工作区候选列表（序号,
   *  武装序号选择待答——issue① 根修:下一条裸序号即选择）;带参=序号/注册根全等/**任意存在的
   *  目录路径直填**（2026-11-25 用户裁定「不支持自己输出工作区路径吗」）→ 写 binding.rootOverride
   *  ——**下次新会话生效**（spec §9.3 同款语义:会话 root 出生定版不可变,当前会话不动），ack
   *  明示发 /new 立即切换。无绑定先引导开对话。候选上限 WORKSPACE_LIST_MAX（注册表大时列表
   *  可读性优先） */
  private async cmdWorkspace(msg: InboundMessage, cfg: ChannelConfig, binding: Binding | undefined, arg: string): Promise<void> {
    if (binding === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /workspace 查看与切换工作区。');
      return;
    }
    const key = bindingKey(msg.channel, msg.chatId);
    const roots = (this.deps.workspaceRoots?.() ?? []).slice(0, WORKSPACE_LIST_MAX);
    if (arg === '') {
      const lines = [`当前工作区：${this.resolveRoot(cfg, msg.chatId, binding)}`];
      if (roots.length === 0) lines.push('暂无其他已注册工作区——也可以发送 /workspace <完整路径> 直填。');
      else {
        lines.push('', '回复序号切换工作区（下次新会话生效），也可直接发送完整路径：');
        for (let i = 0; i < roots.length; i++) lines.push(`${i + 1}. ${roots[i]}`);
        lines.push('切换后发送 /new 立即在新工作区开始新会话。');
      }
      if (roots.length > 0) this.armChatSelect(key, 'workspace', roots); // issue①:列表武装,裸序号即选择
      await this.deps.ack(msg, lines.join('\n'));
      return;
    }
    const picked = this.pickWorkspaceRoot(key, roots, arg);
    if (picked === undefined) {
      await this.deps.ack(msg, '未找到该工作区（路径须为已存在的目录），回复 /workspace 查看可选列表。');
      return;
    }
    await this.applyWorkspacePick(msg, cfg, binding, picked);
  }

  /** 工作区参数解析（issue① 扩展）：序号=已武装列表/注册表兜底 → 注册根大小写不敏感全等 →
   *  **任意存在的目录路径**（fs 校验,resolve 绝对化）——三段兜底,miss=undefined */
  private pickWorkspaceRoot(key: string, roots: string[], arg: string): string | undefined {
    const armed = this.chatSelects.get(key);
    const byIdx = /^\d+$/.test(arg)
      ? (armed?.kind === 'workspace' ? armed.items : roots)[Number.parseInt(arg, 10) - 1]
      : undefined;
    if (byIdx !== undefined) return byIdx;
    const hit = roots.find((r) => r.toLowerCase() === arg.toLowerCase());
    if (hit !== undefined) return hit;
    try {
      const abs = path.resolve(arg);
      if (fs.statSync(abs).isDirectory()) return abs;
    } catch {
      /* 路径不存在:落 undefined */
    }
    return undefined;
  }

  /** 工作区切换落地（列表序号/带参两入口共用）：同根幂等提示,异根写 rootOverride+ack 明示
   *  /new 生效（spec §9.3 语义） */
  private async applyWorkspacePick(msg: InboundMessage, cfg: ChannelConfig, binding: Binding, picked: string): Promise<void> {
    if (picked === this.resolveRoot(cfg, msg.chatId, binding)) {
      await this.deps.ack(msg, '已经是当前工作区，新会话将继续在此进行。');
      return;
    }
    this.deps.bindings.upsert({ ...binding, rootOverride: picked, updatedAt: this.nowMs() });
    await this.deps.ack(msg, `已切换工作区到 ${picked}。当前会话不变——发送 /new 立即在新工作区开始新会话。`);
  }

  /** /model：无参=当前+可选列表（序号,id 括注,武装序号待答——issue① 根修）;带参=序号或 id →
   *  rt.setModel（daemon 级切换,下一条消息生效;运行中可切,提示呈现由会话 pendingModelNotice
   *  面自会承担）。单模型装配（无切换器）如实说明 */
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
        this.armChatSelect(bindingKey(msg.channel, msg.chatId), 'model', choices.map((c) => c.id)); // issue①
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

  /** /effort：无参=当前+档位列表（EFFORT_ORDER 权威序,显示名镜像 GUI effort-slider,武装序号
   *  待答——issue① 根修）;带参=序号或档位名（parseEffort 校验）→ rt.setEffort（per-run 注入,
   *  下一条消息生效,即改即落 meta 重启不回落） */
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
      this.armChatSelect(bindingKey(msg.channel, msg.chatId), 'effort', [...EFFORT_ORDER]); // issue①
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

  /** /compact（2026-11-24 用户裁定「sunx 模式也支持 workspace、compact 等命令」;普通会话同样
   *  可用）：先回执「正在压缩」再执行（deps.compact 单点=serve runCommand,GUI/TUI 同链路——
   *  压缩经模型摘要可能数十秒,IM 侧不能无声等待）;完成/失败/让位（busy=执行间隙被任务抢占）
   *  各有终态回执,回 /compact 命令气泡。运行中直接拒绝（压缩要求 idle,runCommand IDLE_ONLY
   *  同语义） */
  private async cmdCompact(msg: InboundMessage, binding: Binding | undefined): Promise<void> {
    const rt = binding !== undefined ? this.deps.io.getSession(binding.sessionId) : undefined;
    if (rt === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /compact 压缩上下文。');
      return;
    }
    if (rt.status() !== 'idle') {
      await this.deps.ack(msg, '任务进行中，等当前任务完成后再压缩。');
      return;
    }
    await this.deps.ack(msg, '正在压缩上下文，完成后会通知你。');
    try {
      const r = await (this.deps.compact?.(rt) ?? Promise.resolve('unsupported'));
      if (r === 'ok') {
        await this.deps.ack(msg, '上下文已压缩，窗口空间已释放。');
      } else {
        await this.deps.ack(msg, r === 'busy' ? '任务抢先开始，本次未压缩——稍后再试。' : '压缩未执行，请稍后重试。');
      }
    } catch {
      // 压缩异常:终态回执可见化即可（router 无日志面,handleInbound 外层契约继续兜底）
      await this.deps.ack(msg, '压缩失败，请稍后重试。');
    }
  }

  /** 只读/记忆命令族单点（/context /memory /memory-rm /memory-gc /memory-on /memory-off,
   *  2026-11-25 用户裁定「/memory-gc /memory 等命令 gui 也要加上」;原 /context 专点泛化）:
   *  deps.commandText 单点执行（engine 缺省=/context t() 摘要、其余 runCommand capture 旁路——
   *  命令气泡/三态行照落转录,回执文本给 IM）;idle 门按命令自带语义（IDLE_ONLY 集）在
   *  runCommand 内承载,此处不再前置拦;缺席/异常各自如实提示 */
  private async cmdViaCommandText(msg: InboundMessage, binding: Binding | undefined, line: string): Promise<void> {
    const rt = binding !== undefined ? this.deps.io.getSession(binding.sessionId) : undefined;
    if (rt === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可使用该命令。');
      return;
    }
    if (this.deps.commandText === undefined) {
      await this.deps.ack(msg, '该命令当前不可用。');
      return;
    }
    try {
      const text = await this.deps.commandText(rt, line);
      await this.deps.ack(msg, text !== undefined && text !== '' ? text : '该命令未执行成功，请稍后重试。');
    } catch {
      await this.deps.ack(msg, '执行失败，请稍后重试。');
    }
  }

  /** /skills-list（issue③）：harness 技能清单（id + 名称/说明一行一条,上限 20 防消息爆炸）+
   *  使用提示（聊天直接描述任务即触发）。技能面缺席（harness 未装配）如实说明 */
  private async cmdSkillsList(msg: InboundMessage, binding: Binding | undefined): Promise<void> {
    const rt = binding !== undefined ? this.deps.io.getSession(binding.sessionId) : undefined;
    if (rt === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /skills-list 查看可用技能。');
      return;
    }
    let skills: Array<{ id: string; name: string; description: string }>;
    try {
      skills = rt.runtime.harness.skills.list().map((m) => ({ id: m.id, name: m.name, description: m.description }));
    } catch {
      await this.deps.ack(msg, '技能清单暂不可用，请稍后重试。');
      return;
    }
    if (skills.length === 0) {
      await this.deps.ack(msg, '当前没有可用技能。技能由项目/全局目录装载，可在会话中沉淀学习。');
      return;
    }
    const lines = [`可用技能（${skills.length} 个）——聊天里直接描述任务，匹配的技能会自动使用：`];
    for (const s of skills.slice(0, SKILL_LIST_MAX)) lines.push(`- ${s.id} : ${clipDesc(s.description)}`);
    if (skills.length > SKILL_LIST_MAX) lines.push(`…等共 ${skills.length} 个`);
    await this.deps.ack(msg, lines.join('\n'));
  }

  /** /agents-list（issue③）：项目/全局两级子智能体清单（catalog 单点,root=会话工作区）+
   *  使用提示（描述任务时点名即委派）。启停状态随行（enabled=false 标注未启用） */
  private async cmdAgentsList(msg: InboundMessage, binding: Binding | undefined): Promise<void> {
    const rt = binding !== undefined ? this.deps.io.getSession(binding.sessionId) : undefined;
    if (rt === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /agents-list 查看可用子智能体。');
      return;
    }
    let agents: Array<{ id: string; name: string; description: string; enabled: boolean; shadowed: boolean }>;
    try {
      const listing = listAgents(rt.root);
      agents = listing.entries.map((e) => {
        const enabled = e.meta.enabled && !e.shadowed;
        return { id: e.id, name: e.meta.name, description: e.meta.description, enabled, shadowed: e.shadowed };
      });
    } catch {
      await this.deps.ack(msg, '子智能体清单暂不可用，请稍后重试。');
      return;
    }
    if (agents.length === 0) {
      await this.deps.ack(msg, '当前没有可用子智能体。可在项目 .sunshinex/agents/ 或全局目录定义，或让助手在会话中创建。');
      return;
    }
    const lines = [`可用子智能体（${agents.length} 个）——描述任务时点名即可委派（如「用 xx 来做…」）：`];
    for (const a of agents.slice(0, LIST_MAX)) lines.push(`- ${a.id} : ${clipDesc(a.description)}${a.enabled ? '' : '［未启用］'}`);
    if (agents.length > LIST_MAX) lines.push(`…等共 ${agents.length} 个`);
    await this.deps.ack(msg, lines.join('\n'));
  }

  /** /teams-list（issue③）：项目/全局两级智能体团队清单（catalog 单点）+ 使用提示（描述任务时
   *  点名团队即按团队协作） */
  private async cmdTeamsList(msg: InboundMessage, binding: Binding | undefined): Promise<void> {
    const rt = binding !== undefined ? this.deps.io.getSession(binding.sessionId) : undefined;
    if (rt === undefined) {
      await this.deps.ack(msg, '发送任意消息开始对话后，即可用 /teams-list 查看可用团队。');
      return;
    }
    let teams: Array<{ id: string; name: string; description: string }>;
    try {
      const listing = listTeams(rt.root);
      teams = listing.entries.map((e) => ({ id: e.id, name: e.name, description: e.description }));
    } catch {
      await this.deps.ack(msg, '团队清单暂不可用，请稍后重试。');
      return;
    }
    if (teams.length === 0) {
      await this.deps.ack(msg, '当前没有可用团队。可在设置页或项目 .sunshinex/teams/ 定义智能体团队。');
      return;
    }
    const lines = [`可用团队（${teams.length} 个）——描述任务时点名团队即可按团队协作：`];
    for (const tm of teams.slice(0, LIST_MAX)) lines.push(`- ${tm.id} : ${clipDesc(tm.description)}`);
    if (teams.length > LIST_MAX) lines.push(`…等共 ${teams.length} 个`);
    await this.deps.ack(msg, lines.join('\n'));
  }

  /** 列表序号选择待答武装（issue①）：覆盖旧待答并摘排队选择（互斥,最新意图优先） */
  private armChatSelect(key: string, kind: ChatSelect['kind'], items: string[]): void {
    this.queueChoices.delete(key);
    this.chatSelects.set(key, { kind, items, at: this.nowMs() });
  }

  /** 列表序号选择截胡判定（issue①）：恰为 1-3 位序号（容尾标点 . 。 、）→ 消费并摘座;
   *  非序号仅 TTL 兜底清座（超时后裸序号是真实消息不再截胡） */
  private takeChatSelect(key: string, text: string): { kind: ChatSelect['kind']; items: string[]; n: number } | undefined {
    const sel = this.chatSelects.get(key);
    if (sel === undefined) return undefined;
    const m = /^(\d{1,3})[.。、]?$/.exec(text.trim());
    if (m === null) {
      if (this.nowMs() - sel.at > QUEUE_CHOICE_TTL_MS) this.chatSelects.delete(key);
      return undefined;
    }
    this.chatSelects.delete(key);
    const n = Number.parseInt(m[1]!, 10);
    return { kind: sel.kind, items: sel.items, n: n >= 1 && n <= sel.items.length ? n : 0 }; // n=0=越界(消费+明确提示,不落模型)
  }

  /** 列表序号选择消费（issue①）：workspace=applyWorkspacePick 落 rootOverride;model=rt.setModel;
   *  effort=rt.setEffort——各保原有终态文案;越界（takeChatSelect 已滤）不可达 */
  private async applyChatSelect(msg: InboundMessage, binding: Binding, kind: ChatSelect['kind'], items: string[], n: number): Promise<void> {
    if (n === 0) {
      const again = kind === 'workspace' ? '/workspace' : kind === 'model' ? '/model' : '/effort';
      await this.deps.ack(msg, `这个序号不在列表里，回复 ${again} 查看最新列表。`);
      return;
    }
    const picked = items[n - 1]!;
    if (kind === 'workspace') {
      const cfg = this.deps.configs().find((c) => c.id === msg.channel);
      if (cfg === undefined) return;
      await this.applyWorkspacePick(msg, cfg, binding, picked);
      return;
    }
    const rt = this.deps.io.getSession(binding.sessionId);
    if (rt === undefined) {
      await this.deps.ack(msg, '会话已结束，请直接发送新消息。');
      return;
    }
    if (kind === 'model') {
      const sw = rt.modelSwitcher;
      if (sw === null || !rt.setModel(picked)) {
        await this.deps.ack(msg, '模型切换未生效，回复 /model 重新查看。');
        return;
      }
      await this.deps.ack(msg, `已切换模型到 ${picked}，下一条消息生效。`);
      return;
    }
    if (!rt.setEffort(picked)) {
      await this.deps.ack(msg, '思考强度切换未生效，回复 /effort 重新查看。');
      return;
    }
    await this.deps.ack(msg, `已切换思考强度到 ${EFFORT_LABELS[picked] ?? picked}，下一条消息生效。`);
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
    this.queueChoices.delete(key); // 旧会话排队条目的选择待答随之作废（绑定将换新座,选择语义失效;
    this.chatSelects.delete(key); // 列表序号选择待答同作废
    // daemon 队列本体不动——旧座生命照旧「就放着就可以」,队列条目随旧座既有语义自然接续）
    const created = this.deps.io.createSession(this.resolveRoot(cfg, msg.chatId, binding), this.createOpts(cfg, msg.chatId));
    if (!created.ok) {
      await this.deps.ack(msg, `新会话创建失败：${created.error.message}`);
      return;
    }
    const sessionId = created.value.sessionId;
    const seat = this.seatAndTag(cfg, sessionId, msg.chatId, this.chatTitleOf(binding, msg));
    if (seat.rt === undefined) {
      await this.deps.ack(msg, '新会话创建失败：运行时未入注册表');
      return;
    }
    // 旧运行时**不释放**（2026-11-23 用户裁定「就放着就可以」）：旧座留注册表——GUI 开着旧
    // 会话的 snapshot/pty 等端点不 404
    this.upsertBinding(key, sessionId, seat, cfg, binding, msg);
    // 旧座让位(2026-11-25 结构性修「只有一个活的」):绑定切到新座,同聊天旧座释放让位——
    // 在飞任务标「用户主动取消」(不重派);旧会话唤醒照常自愈,输出隔离不进飞书
    this.deps.io.retireOtherChatSessions?.(msg.chatId, sessionId);
    // /new 回执（2026-11-25 用户裁定「显示成功切换+当前模型和思考强度,调整用 /model /effort
    // 等,/help 查看」——不再提品性复用/留档可回看）:快照读当轮生效档
    const snap = seat.rt.snapshotResponse();
    const effort = snap.effort !== undefined ? (EFFORT_LABELS[snap.effort] ?? snap.effort) : '跟随全局默认';
    await this.deps.ack(
      msg,
      `已切换到新会话。当前模型：${snap.model ?? '默认主模型'}，思考强度：${effort}。\n调整请使用 /model、/effort 等命令，其他命令可使用 /help 查看。`,
    );
  }

  /** 绑定解析三态（⑦⑧⑨）+ 提交分派：在座直用 → attach 重开（失败释放残座）→ 新建；
   *  idle→submit（409 回退 daemon 队列）、running→daemon 队列（默认排队,GUI 队列 chips 同源;
   *  「1 插入」=steerFront 置首注入当前轮、「2 暂停」=撤队列+中断+立即执行,见 applyQueueChoice）；
   *  群聊注入发送者前缀（⑫）；绑定解析成功后 noteSender 回写（Task 7 lastSender 消费）；
   *  ack 二态回执（计划 §4 第 6 条） */
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
      const seat = this.seatAndTag(cfg, created.value.sessionId, msg.chatId, this.chatTitleOf(existing, msg));
      if (seat.rt === undefined) {
        await this.deps.ack(msg, '会话创建失败：运行时未入注册表');
        return;
      }
      sessionId = created.value.sessionId;
      rt = seat.rt;
      this.upsertBinding(key, sessionId, seat, cfg, existing, msg);
      // 旧座让位(裁定同上):在飞任务标「用户主动取消」,不重派
      this.deps.io.retireOtherChatSessions?.(msg.chatId, sessionId);
    }
    this.deps.noteSender?.(sessionId, { display: msg.userDisplay ?? msg.userId, userId: msg.userId, chatKind: msg.chatKind }); // ⑫ 绑定解析成功即回写
    const submitText = inboundSubmitText(msg); // ⑫ 群聊前缀/单聊原文（单点,drain 回显匹配同源）
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
      rt.steer(submitText, msg.images); // running → daemon 队列（默认排队,GUI 队列 chips 同源）
      queued = true;
    }
    this.deps.onSubmitted?.(sessionId, target); // 裁定 1：分派成功（submit 直达/409 回退 steer/running steer）即回调
    if (queued) this.armQueueChoice(sessionId, rt, msg, submitText); // 排队即武装两选项待答
    // ack 二态回执（计划 §4 第 6 条）：kind 二态受理标随行（engine 据此走平台 ack 面/文本回退——
    // 飞书 accepted=OnIt「处理中」表情免文本;排队回执附两序号选项(QUEUE_CHOICE_TEXT)）
    await this.deps.ack(msg, queued ? QUEUE_CHOICE_TEXT : '已受理，处理中', queued ? 'queued' : 'accepted');
  }

  /** 排队选择待答武装：steer 入 daemon 队列后取快照队尾 seq（同循环内同步入列,队尾即本条）——
   *  「1 插入」凭 seq 置首、「2 暂停」凭 seq 撤队列;快照失败=无待答,回执照发不阻断 */
  private armQueueChoice(sessionId: string, rt: SessionRuntime, msg: InboundMessage, submitText: string): void {
    this.chatSelects.delete(bindingKey(msg.channel, msg.chatId)); // 互斥:排队回执武装摘列表选择待答(最新意图优先)
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

  /** 排队选择截胡判定：待答在座且 trim 后恰为「1/2」（容尾标点 . 。 、）→ 消费并摘座;
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

  /** 排队选择消费（2026-11-24 用户裁定「默认 daemon 排队,1=模拟插入,2=暂停立即发出」）：
   *  1=插入当前对话——running 时 steerFront 置首（下一 step 边界即注入当前轮,助手立即看到）;
   *  idle 时队列不动不跑,插入即直接发出（cancelSteer+submitExternal）;2=暂停当前任务并立即
   *  执行本条——cancelSteer 撤队列 → interrupt 中断当前 run → 等 idle（≤10s,40×250ms 覆盖在飞
   *  模型调用收尾）→ submitExternal 立即执行（run 起源=原消息气泡,noteRunSubmit）;提交失败
   *  退回队列不丢消息。条目已出列（已自然注入/接续）则如实告知,零动作 */
  private async applyQueueChoice(msg: InboundMessage, ch: QueueChoice, n: 1 | 2): Promise<void> {
    const rt = this.deps.io.getSession(ch.sessionId);
    if (rt === undefined) {
      await this.deps.ack(msg, '会话已结束，请直接发送新消息。');
      return;
    }
    const stillQueued = rt.snapshotResponse().queued.some((q) => q.seq === ch.seq);
    if (n === 1) {
      if (!stillQueued) {
        await this.deps.ack(msg, '本条已进入对话，无需插入。');
        return;
      }
      if (rt.status() === 'running') {
        rt.steerFront(ch.seq); // 模拟插入:置首,下一 step 边界即注入当前轮
        this.deps.noteRunSubmit?.(ch.sessionId, ch.inbound); // 起源移被插入消息:插入后输出响应它
        await this.deps.ack(msg, '已插入当前对话，助手接下来会看到这条消息。');
        return;
      }
      rt.cancelSteer(ch.seq); // 已空闲:队列不动不跑——插入即直接发出
      const r = rt.submitExternal(ch.text, ch.images);
      if (r.ok) {
        this.deps.noteRunSubmit?.(ch.sessionId, ch.inbound);
        this.deps.onSubmitted?.(ch.sessionId, { channelId: msg.channel, chatId: msg.chatId });
        await this.deps.ack(msg, '当前空闲，本条已直接开始处理。');
      } else {
        await this.deps.ack(msg, '插入未成功，请稍后重试。');
      }
      return;
    }
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

  /** 新建后仪式：ensureJournalMinted → writeSessionMeta({channel, chatId, chatTitle})（⑩ 通道标
   *  出生写一次，侧栏「通道」分组消费 Task 13；chatId=平台聊天会话标识出生落档(2026-11-23)——
   *  悬浮卡显示/复制在绑定反查缺席（旧会话//new 后解绑）时仍可达；chatTitle=聊天名称出生落档
   *  (2026-11-24 用户裁定「hover 显示聊天名称」)；缺席=普通会话）——各步尽力而为
   *  try/catch；返回 runtime 与 journalId 供绑定 upsert */
  private seatAndTag(cfg: ChannelConfig, sessionId: string, chatId: string, chatTitle?: string): { rt: SessionRuntime | undefined; journalId?: string } {
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
        writeSessionMeta(rt.dataDir, journalId, {
          channel: cfg.id,
          ...(chatId !== '' ? { chatId } : {}),
          ...(chatTitle !== undefined && chatTitle !== '' ? { chatTitle } : {}),
        });
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

  /** createSession opts：mode 透传配置、activate:false（通道会话不抢 GUI 焦点）、model/effort 可选
   *  透传；sunx 三键（2026-11-24 用户裁定「通道支持 Sunx 模式,品性会话级,/new 仅品性复用」）——
   *  sessionKind==='sunx' 时 kind/name/charter 透传（name=应用名称作出生 title;charter 逐字进
   *  品性冻结层）；channelMeta（2026-11-23 用户裁定「平台/聊天 id/应用名进系统上下文」）——出生
   *  定版冻结层,同一聊天逐字节一致（前缀缓存零损失;动态发言用户走 ⑫ 消息级 [来自 x]: 前缀不入此层） */
  private createOpts(cfg: ChannelConfig, chatId: string): { mode: ChannelConfig['mode']; activate: false; model?: string; effort?: string; kind?: 'sunx'; name?: string; charter?: string; channelMeta: { platform: string; chatId: string; appName?: string } } {
    const sunx = cfg.sessionKind === 'sunx';
    return {
      mode: cfg.mode,
      activate: false,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}), // 通道缺省档(2026-11-23 用户裁定「可以选择默认的模型和强度」)
      ...(sunx ? { kind: 'sunx' as const } : {}),
      ...(sunx && cfg.name !== undefined && cfg.name !== '' ? { name: cfg.name } : {}),
      ...(sunx && cfg.charter !== undefined && cfg.charter !== '' ? { charter: cfg.charter } : {}),
      channelMeta: { platform: cfg.platform, chatId, ...(cfg.name !== undefined ? { appName: cfg.name } : {}) },
    };
  }

  /** first-user 锁定值：既有锁定原样保留（含 /new 原样带过）；无锁定且通道为 first-user → 锁到当前发送者 */
  private lockOf(cfg: ChannelConfig, binding: Binding | undefined, msg: InboundMessage): string | undefined {
    return binding?.lockedUserId ?? (cfg.allow.kind === 'first-user' ? msg.userId : undefined);
  }

  /** 聊天名称（2026-11-24 用户裁定「hover 显示聊天名称,单聊=聊天人名称,群聊=群聊名称」）：
   *  既有绑定名保留优先（含 /new 原样带过）;首绑自入站取——chatTitle（平台聊天信息 API,群聊名）
   *  优先,单聊回落发送者姓名（通讯录富化面 userDisplay） */
  private chatTitleOf(binding: Binding | undefined, msg: InboundMessage): string | undefined {
    if (binding?.chatTitle !== undefined && binding.chatTitle !== '') return binding.chatTitle;
    if (msg.chatTitle !== undefined && msg.chatTitle !== '') return msg.chatTitle;
    if (msg.chatKind === 'direct') return msg.userDisplay !== undefined && msg.userDisplay !== '' ? msg.userDisplay : undefined;
    return undefined;
  }

  /** 绑定 upsert 收敛单点（/new 重绑与 dispatch 新建腿共用）：journalId/lock/rootOverride/chatKind/
   *  chatTitle 保留优先拼装 + updatedAt——字段面一处承载，两调用点零漂移 */
  private upsertBinding(key: string, sessionId: string, seat: { journalId?: string }, cfg: ChannelConfig, binding: Binding | undefined, msg: InboundMessage): void {
    const lock = this.lockOf(cfg, binding, msg);
    const title = this.chatTitleOf(binding, msg);
    this.deps.bindings.upsert({
      key,
      sessionId,
      ...(seat.journalId !== undefined ? { journalId: seat.journalId } : {}),
      ...(lock !== undefined ? { lockedUserId: lock } : {}),
      ...(binding?.rootOverride !== undefined ? { rootOverride: binding.rootOverride } : {}),
      chatKind: binding?.chatKind ?? msg.chatKind, // 绑定元数据：保留优先，首绑自入站消息取（spec §9.3 信息条单聊/群聊标）
      ...(title !== undefined ? { chatTitle: title } : {}),
      updatedAt: this.nowMs(),
    });
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
