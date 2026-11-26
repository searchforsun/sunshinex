/**
 * 飞书适配器（2026-11-22 用户裁定「先提供飞书一个能力,飞书我可以直接测试」）：官方 SDK
 * （@larksuiteoapi/node-sdk）**WS 长连接**收事件（自建应用,无需公网回调）、HTTP 面回消息。
 * - 入站:im.message.receive_v1 → 规范化 InboundMessage（P0 仅 text 消息;群聊 mentions 在场=atBot,
 *   私聊恒 true——群聊仅 @ 机器人才会推消息的语义由飞书侧保证,mentions 是双保险）。
 * - 出站:reply 走 im.message.reply（引用入站 message_id,raw 携带）;send 走 im.message.create
 *   （receive_id_type=chat_id）;均 msg_type=text（P0 纯文本,caps.markdown=false 走投影降级链）。
 * - 测试连接(dry-run):WS 连上 + GET /open-apis/bot/v3/info 取 bot.app_name 作 botId。
 * - 接收 icon(2026-11-23 用户裁定「任何输入都要有接收 icon,这就是已读标记,包括命令输入」):
 *   入站即贴官方 OnIt「处理中」表情——命令/回执/任务全消息统一已读标记,回答送达(reply)自动
 *   摘除;同消息幂等(重投/受理链路复入不双贴);失败静默(icon 是确认面,不阻断处理);
 *   ack 平台面对飞书即空操作(已读标记已贴,受理免文本/排队文本由 engine 文案路负责)。
 * - 定向 @(2026-11-22 用户裁定「群聊才 @ 人」):caps.mention=true——群聊出站 @ 标签由飞书服务端
 *   渲染真实姓名(单聊零 @,回执式回复天然指向本人;text 面 `<at user_id>`/卡片面 `<at id>`
 *   两套语法各随其面);发送者姓名富化走通讯录 API+缓存(权限未开静默降级 open_id)。
 * - markdown(2026-11-23 用户裁定「不是卡片,是普通文本中显示 md 格式化——可复制」):
 *   caps.markdown=true/card=false——投影正文走 post 富文本单 `md` 标签:标准消息气泡保留
 *   完整右键菜单(复制/回复/转发),语法=CommonMark 0.31+GFM(标题/GFM 表格(前后空行分隔)/
 *   围栏代码块/任务列表/引用);at 提及=<at user_id>(与 text 面同语法,md 标签内直用)。
 * - 凭证:App ID 走 cfg.ident.appId,App Secret 走 deps.secret（cfg.secret 内联,2026-11-22 裁定）。
 * SDK 靠 start() 内动态 import——加载延迟到首个飞书通道启用;连接保活/断线重连由 SDK 内部负责
 * （Reconnect/pingLoop）,stop() = ws.close() 主动退场。
 */
import { CHANNEL_MAX_TEXT_LENGTH } from '../model';
import { ChannelAdapterError } from './types';
import type { AdapterDeps, ChannelAdapter, ChannelPermissionRow, ChatRef } from './types';
import type { ChannelConfig, DeliveryCaps, InboundMessage, OutboundMessage } from '../model';

/** 飞书 App ID 形态（SDK start() 同款校验——非法形态 SDK 静默不连,此处提前给可读错误） */
const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;

/** 飞书 text 消息 content JSON 上限防御（正常 <1KB;超限按畸形丢正文） */
const CONTENT_PARSE_MAX = 64 * 1024;

/** 接收 icon 表情（2026-11-23 用户裁定「任何输入都要有接收 icon,这就是已读标记」）：OnIt=
 *  飞书官方「正在处理」表情，入站即贴（命令/回执/任务全消息统一），回答到达（reply）后摘除 */
const ACK_EMOJI = 'OnIt';

/** 纯函数（单测锚点）：接收 icon → 表情回应请求形状（POST reactions，emoji_type=OnIt） */
export function feishuAckReactionPayload(messageId: string): { method: string; url: string; data: unknown } {
  return { method: 'POST', url: `/open-apis/im/v1/messages/${messageId}/reactions`, data: { reaction_type: { emoji_type: ACK_EMOJI } } };
}

/** 纯函数（单测锚点）：群聊定向 @ 前缀——`<at user_id>` 标签由飞书服务端渲染成真实姓名
 *  （无需通讯录权限；open_id 形态受 APP_ID_RE 同族约束，无注入面）；无 mention → 空串 */
export function feishuMentionPrefix(mention: { userId: string; display?: string } | undefined): string {
  if (mention === undefined || mention.userId === '') return '';
  return `<at user_id="${mention.userId}"></at> `;
}

/** 纯函数（单测锚点）：markdown 消息内容 JSON——**post 富文本单 `md` 标签**（2026-11-23
 *  用户裁定「不是卡片,是普通文本中显示 md 格式化——可复制」:md 标签在标准消息气泡内渲染,
 *  保留完整消息右键菜单(复制/回复/转发);语法=CommonMark 0.31+GFM——标题/GFM 表格(前后
 *  空行分隔)/围栏代码块/任务列表/引用/`<at user_id>` 提及;md 标签独占段落,整段正文入单标签） */
export function feishuPostContent(text: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } });
}

/** im.message.receive_v1 事件最小形状(只取消费字段;SDK 全量类型不进本文件) */
interface FeishuMessageEvent {
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: unknown[];
  };
  sender?: { sender_id?: { open_id?: string; user_id?: string } };
}

/** 事件归一:WS 分发可能给 {header,event} 全量或直接 event 本体——取含 message 的一侧 */
function eventOf(data: unknown): FeishuMessageEvent {
  if (typeof data !== 'object' || data === null) return {};
  const rec = data as Record<string, unknown>;
  const inner = rec['event'];
  if (typeof inner === 'object' && inner !== null) {
    const innerRec = inner as Record<string, unknown>;
    if (typeof innerRec['message'] === 'object') return inner as FeishuMessageEvent;
  }
  return rec as FeishuMessageEvent;
}

/** 纯函数（单测锚点）：飞书文本消息里的 @ 提及占位符（`@_user_1`）→ 真实姓名
 *  （2026-11-25 用户报障「agent 上下文里只看到 @_user_1,不知道是谁」）:mentions 数组自带
 *  key/name/id——按 key 全文替换成 `@姓名`（姓名缺席用 open_id 兜底;机器人自身也会在这份名单）;
 *  非文本/无占位符/形状不符零改动 */
export function feishuResolveMentions(text: string, mentions: unknown): string {
  if (text === '') return text;
  // 残留占位符一律清除（mentions 缺失/形状不符时也不得把平台内部编码送进模型与转录）:
  // 新消息的用户气泡只含用户内容（2026-11-25 用户裁定「不兼容老记录,保证新气泡只包含用户消息」）
  const stripLeftovers = (v: string): string => v.replace(/@_user_\d+\s*/g, '');
  if (!Array.isArray(mentions)) return stripLeftovers(text);
  let out = text;
  for (const m of mentions) {
    if (typeof m !== 'object' || m === null) continue;
    const rec = m as Record<string, unknown>;
    const key = typeof rec['key'] === 'string' ? rec['key'] : '';
    if (!key.startsWith('@_')) continue;
    const name = typeof rec['name'] === 'string' && rec['name'] !== '' ? rec['name'] : '';
    const idObj = typeof rec['id'] === 'object' && rec['id'] !== null ? (rec['id'] as Record<string, unknown>) : undefined;
    const openId = typeof idObj?.['open_id'] === 'string' ? idObj['open_id'] : '';
    const display = name !== '' ? name : openId;
    if (display === '') continue;
    out = out.split(key).join(`@${display}`);
  }
  // 残留占位符一律清除（mentions 缺失/形状不符时也不得把平台内部编码送进模型与转录）:
  // 新消息的用户气泡只含用户内容（2026-11-25 用户裁定「不兼容老记录,保证新气泡只包含用户消息」）
  return out.replace(/@_user_\d+\s*/g, '');
}

/** 纯映射(单测锚点):飞书事件 → 规范化 InboundMessage;非 text 消息/字段缺失 → undefined(丢弃) */
export function feishuEventToInbound(channelId: string, data: unknown): InboundMessage | undefined {
  const ev = eventOf(data);
  const msg = ev.message;
  if (msg === undefined || msg.message_type !== 'text' || typeof msg.chat_id !== 'string' || msg.chat_id === '') return undefined;
  let text = '';
  try {
    if (typeof msg.content === 'string' && msg.content.length <= CONTENT_PARSE_MAX) {
      const parsed: unknown = JSON.parse(msg.content);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { text?: unknown }).text === 'string') {
        text = (parsed as { text: string }).text;
      }
    }
  } catch {
    text = ''; // 畸形 content 降级空文本(消息仍受理,无正文)
  }
  // @ 提及占位符还原成姓名（模型上下文可读;群聊准入判据仍看 mentions 原数组）
  text = feishuResolveMentions(text, msg.mentions);
  const chatKind = msg.chat_type === 'group' ? 'group' : 'direct';
  const senderId = ev.sender?.sender_id?.open_id ?? ev.sender?.sender_id?.user_id ?? '';
  return {
    channel: channelId,
    chatId: msg.chat_id,
    chatKind,
    userId: senderId,
    msgId: String(msg.message_id ?? ''),
    text,
    atBot: chatKind === 'direct' ? true : (msg.mentions?.length ?? 0) > 0,
    raw: data,
  };
}

/** Lark 客户端实例最小面(动态 import 后按此消费;SDK 全量类型不进编译面) */
interface LarkClient {
  request(opts: { method: string; url: string; params?: Record<string, string>; data?: unknown }): Promise<unknown>;
  im: {
    message: {
      create(payload: { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }): Promise<unknown>;
      reply(payload: { path: { message_id: string }; data: { msg_type: string; content: string } }): Promise<unknown>;
    };
  };
}

/** Lark WS 客户端实例最小面 */
interface LarkWs {
  start(params: { eventDispatcher: unknown }): Promise<void>;
  close(force?: boolean): void;
  getConnectionStatus(): { state: string };
}

/** Lark 模块最小面(动态 import 的重定型目标——构造器返回实例最小面,规避 SDK 全量类型) */
interface LarkModule {
  Client: new (opts: { appId: string; appSecret: string; loggerLevel?: number }) => LarkClient;
  WSClient: new (opts: { appId: string; appSecret: string; loggerLevel?: number }) => LarkWs;
  EventDispatcher: new (opts?: unknown) => { register(handlers: Record<string, (data: unknown) => Promise<void> | void>): void };
  LoggerLevel: { warn: number };
}

/** Lark 响应体最小形状(/open-apis/bot/v3/info:bot 在 body 顶层) */
interface LarkBotInfoResponse {
  bot?: { app_name?: string };
}

/** Lark 表情回应响应体最小形状(POST reactions:data.reaction_id 摘除时用) */
interface LarkReactionResponse {
  data?: { reaction_id?: string };
}

/** Lark 通讯录响应体最小形状(GET contact/v3/users/:open_id:data.user.name) */
interface LarkUserResponse extends LarkRespBase {
  data?: { user?: { name?: string } };
}

/** Lark 业务响应公共头（2026-11-25 排查:SDK request 对 code!==0 的**业务错误不抛异常**,
 *  直接回 {code,msg}——旧实现只看 data 字段,权限失败被静默吞掉且日志永不触发） */
interface LarkRespBase {
  code?: number;
  msg?: string;
}

/** Lark 聊天信息响应体最小形状(GET im/v1/chats/:chat_id:data.name——群聊名;单聊常空/不支持) */
interface LarkChatResponse extends LarkRespBase {
  data?: { name?: string };
}

/** Lark 群成员响应体最小形状(GET im/v1/chats/:chat_id/members:data.items[]——
 *  member_id+name 建姓名表,单聊名称回落也取 name;分页 has_more/page_token) */
interface LarkChatMembersResponse extends LarkRespBase {
  data?: { items?: Array<{ member_id?: string; name?: string }>; has_more?: boolean; page_token?: string };
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id: string;
  private connected = false;
  private detail: string | undefined;
  private ws?: LarkWs;
  private client?: LarkClient;
  /** 在贴「处理中」表情表：message_id → reaction_id（回答到达 reply 成功后摘除） */
  private readonly processingReactions = new Map<string, string>();
  /** 发送者姓名缓存（含失败=undefined——权限未开不再反复打 403） */
  private readonly nameCache = new Map<string, Promise<string | undefined>>();
  /** 聊天名称缓存（chatId → 群名,含失败=undefined 不再反复打）：hover 聊天名称行富化面 */
  private readonly chatCache = new Map<string, Promise<string | undefined>>();
  /** 群成员姓名表缓存（chatId → open_id→name;2026-11-25 用户报障「群聊权限已有,用户名还是拿不到」）:
   *  通讯录取名失败时按群成员列表回落——同一 im:chat:readonly 权限即可取成员姓名;只缓存成功 */
  private readonly memberNamesCache = new Map<string, Promise<Map<string, string> | undefined>>();

  constructor(_cfg: ChannelConfig, private readonly deps: AdapterDeps) {
    this.id = _cfg.id;
  }

  caps(): DeliveryCaps {
    // markdown=true(权威口径本文件头注 markdown 档):投影正文走
    // post 富文本单 md 标签——标准消息气泡(保留复制菜单)+CommonMark/GFM 渲染;card=false
    return { streaming: false, markdown: true, card: false, maxTextLength: CHANNEL_MAX_TEXT_LENGTH, mention: true };
  }

  async start(sink: (msg: InboundMessage) => void): Promise<void> {
    const appId = this.deps.ident['appId'] ?? '';
    if (!APP_ID_RE.test(appId)) {
      this.connected = false;
      this.detail = 'App ID 无效';
      throw new ChannelAdapterError(this.detail, 'ident-invalid');
    }
    const log = this.deps.log ?? (() => {});
    const lark = (await import('@larksuiteoapi/node-sdk')) as unknown as LarkModule;
    const client = new lark.Client({ appId, appSecret: this.deps.secret, loggerLevel: lark.LoggerLevel.warn });
    this.client = client;
    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        const inbound = feishuEventToInbound(this.id, data);
        if (inbound === undefined) return;
        // 接收 icon（权威口径本文件头注+ACK_EMOJI 注）：入站即贴 OnIt——命令/回执/任务统一已读标记,
        // 回答送达(reply)即摘;尽力而为失败静默
        // （icon 是确认面,不阻断消息处理）;markProcessing 同消息幂等,重投不双贴
        const receiptMessageId = (inbound.raw as { message?: { message_id?: string } } | undefined)?.message?.message_id;
        if (receiptMessageId !== undefined && receiptMessageId !== '') void this.markProcessing(receiptMessageId);
        try {
          // 发送者姓名+聊天名称富化（缓存命中零等待;首见各一次查询）：群聊 [来自 x]: 前缀、
          // 绑定锁定展示与悬浮卡聊天名称行可读;权限未开/失败静默降级（姓名保 open_id——@
          // 标签由飞书侧渲名不受影响;聊天名称缺席由 router 单聊回落发送者姓名）
          const [contactName, chat] = await Promise.all([
            inbound.userId !== '' ? this.userName(inbound.userId) : Promise.resolve(undefined),
            this.chatName(inbound.chatId, inbound.chatKind), // 形态入参:单聊按成员列表回落人名
          ]);
          // 通讯录取名失败（权限/可见范围）→ 群成员列表回落（im:chat:readonly 已有即可）
          const name = contactName ?? (inbound.userId !== '' ? await this.memberName(inbound.chatId, inbound.userId) : undefined);
          const enriched: InboundMessage = { ...inbound, ...(name !== undefined ? { userDisplay: name } : {}), ...(chat !== undefined ? { chatTitle: chat } : {}) };
          sink(enriched);
        } catch (e) {
          log(`feishu sink error: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
    const ws = new lark.WSClient({ appId, appSecret: this.deps.secret, loggerLevel: lark.LoggerLevel.warn });
    this.ws = ws;
    await ws.start({ eventDispatcher: dispatcher });
    // SDK start() 返回时连接仍在建立(state=connecting)——轮询至多 10s 等 connected,
    // 期间 closed/错误态提前失败;超时给出可读指引(实测约 2s 内连上)
    let state = ws.getConnectionStatus().state;
    const deadline = Date.now() + 10_000;
    while (state !== 'connected' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      state = ws.getConnectionStatus().state;
      if (state === 'closed' || state.includes('error')) break;
    }
    if (state !== 'connected') {
      this.connected = false;
      this.detail = `长连接未建立(${state})`;
      throw new ChannelAdapterError(this.detail, 'connect-failed');
    }
    this.connected = true;
    this.detail = '飞书长连接运行中';
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.processingReactions.clear();
    this.nameCache.clear();
    this.chatCache.clear();
    this.memberNamesCache.clear();
    try {
      this.ws?.close(true);
    } catch {
      /* SDK close 幂等;异常不阻断退场 */
    }
    this.ws = undefined;
  }

  health(): { connected: boolean; detail?: string } {
    return { connected: this.connected, ...(this.detail !== undefined ? { detail: this.detail } : {}) };
  }

  /** dry-run bot 身份(GET /open-apis/bot/v3/info 的 app_name)——失败静默,交调用方退化文案 */
  async botName(): Promise<string | undefined> {
    if (this.client === undefined) return undefined;
    try {
      const resp = (await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as LarkBotInfoResponse;
      return resp?.bot?.app_name;
    } catch {
      return undefined;
    }
  }

  private async deliverText(target: ChatRef, text: string, replyMessageId?: string, markdown?: boolean): Promise<void> {
    if (this.client === undefined) throw new Error('feishu adapter not started');
    // markdown 档=post 富文本单 md 标签(权威口径本文件头注 markdown 档——
    // 标准消息气泡+CommonMark/GFM 渲染);纯文本档照旧 text 面
    const content = markdown === true ? feishuPostContent(text) : JSON.stringify({ text });
    const msgType = markdown === true ? 'post' : 'text';
    if (replyMessageId !== undefined && replyMessageId !== '') {
      await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { msg_type: msgType, content } });
      return;
    }
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.chatId, msg_type: msgType, content },
    });
  }

  async send(target: ChatRef, msg: OutboundMessage): Promise<void> {
    await this.deliverText(target, feishuMentionPrefix(msg.mention) + (msg.text ?? ''), undefined, msg.markdown === true);
  }

  /** 回执式回复:引用入站 message_id(飞书群聊内呈现为楼中楼);raw 缺 id 退化为 send。
   *  回答送达即摘「处理中」表情（入站接收 icon——已读标记语义闭环,权威口径本文件头注） */
  async reply(inbound: InboundMessage, msg: OutboundMessage): Promise<void> {
    const raw = inbound.raw as { message?: { message_id?: string } } | undefined;
    const messageId = raw?.message?.message_id;
    await this.deliverText({ channelId: inbound.channel, chatId: inbound.chatId }, feishuMentionPrefix(msg.mention) + (msg.text ?? ''), messageId, msg.markdown === true);
    if (messageId !== undefined && messageId !== '') void this.unmarkProcessing(messageId);
  }

  /** 受理回执平台面：接收 icon 已在**入站即贴**（统一已读标记,权威口径本文件头注），
   *  本面即空操作：受理免文本语义由 engine 的
   *  accepted 短路承担,排队说明文本由 engine 文案路并发——这里不重复贴表情防双 icon */
  async ack(_inbound: InboundMessage, _kind: 'accepted' | 'queued'): Promise<void> {
    void _inbound;
    void _kind;
  }

  /** 贴「处理中」表情（入站接收 icon）：同消息幂等（飞书重投/受理链路复入不双贴） */
  private async markProcessing(messageId: string): Promise<void> {
    if (this.client === undefined || messageId === '' || this.processingReactions.has(messageId)) return;
    const resp = (await this.client.request(feishuAckReactionPayload(messageId))) as LarkReactionResponse;
    const rid = resp?.data?.reaction_id;
    if (typeof rid === 'string' && rid !== '') this.processingReactions.set(messageId, rid);
  }

  /** 摘「处理中」表情（尽力而为,吞错——摘除失败仅残留表情,不影响消息送达） */
  private async unmarkProcessing(messageId: string): Promise<void> {
    const rid = this.processingReactions.get(messageId);
    if (rid === undefined || this.client === undefined) return;
    this.processingReactions.delete(messageId);
    try {
      await this.client.request({ method: 'DELETE', url: `/open-apis/im/v1/messages/${messageId}/reactions/${rid}` });
    } catch {
      /* 尽力而为 */
    }
  }

  /** 发送者姓名（通讯录 API + 进程内缓存）:权限未开（需 contact:user.base:readonly 等通讯录
   *  读域）静默降级 open_id。**只缓存成功**（2026-11-25 根修:失败曾永久缓存→权限后来开通也
   *  再不重试,直到进程重启）——失败即摘缓存,下条消息再试 */
  private userName(openId: string): Promise<string | undefined> {
    const hit = this.nameCache.get(openId);
    if (hit !== undefined) return hit;
    const p = (async () => {
      if (this.client === undefined) return undefined;
      try {
        const resp = (await this.client.request({
          method: 'GET',
          url: `/open-apis/contact/v3/users/${openId}`,
          params: { user_id_type: 'open_id' },
        })) as LarkUserResponse;
        this.logBiz('用户姓名读取', resp, openId);
        const name = resp?.data?.user?.name;
        return typeof name === 'string' && name !== '' ? name : undefined;
      } catch (e) {
        // 可诊断日志（2026-11-25 用户报障「群聊权限已有,用户名拿不到」）:姓名走通讯录 API,
        // 需「通讯录」读权限（contact:user.base:readonly）且应用可见范围含该用户——与群权限无关
        (this.deps.log ?? (() => {}))(`feishu 用户姓名读取失败(${openId}): ${e instanceof Error ? e.message : String(e)}；通讯录读权限 contact:user.base:readonly 未授权或用户不在应用可见范围`);
        return undefined;
      }
    })().then((name) => {
      if (name === undefined) this.nameCache.delete(openId); // 失败不缓存:权限后开可重试
      return name;
    });
    this.nameCache.set(openId, p);
    return p;
  }

  /** 聊天名称（GET im/v1/chats/:chat_id 的 name;需 im:chat:readonly 域）：群聊=群名（悬浮卡
   *  聊天名称行,2026-11-24 用户裁定「群聊就是群聊名称」）;单聊群名常空甚至群信息接口直接报错
   *  ——**按消息 chatKind 回落成员列表**（chats/:chat_id/members 同域可取成员姓名,2026-11-25
   *  用户报障「有 im:chat 权限仍拿不到单聊名称」根修:不再依赖通讯录读域,也不以群信息成功为前提）。
   *  失败**不缓存**（2026-11-25 同轮根修:失败曾永久缓存→权限后开/版本发布后仍恒 undefined,
   *  直到进程重启才重试）——成功才进 chatCache,失败即摘,下条消息自然重试（每消息至多一次调用） */
  private chatName(chatId: string, chatKind: 'direct' | 'group'): Promise<string | undefined> {
    const hit = this.chatCache.get(chatId);
    if (hit !== undefined) return hit;
    const p = (async (): Promise<string | undefined> => {
      if (this.client === undefined) return undefined;
      try {
        const resp = (await this.client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${chatId}` })) as LarkChatResponse;
        this.logBiz('聊天信息读取', resp, chatId);
        const name = resp?.data?.name;
        if (typeof name === 'string' && name !== '') return name;
      } catch (e) {
        // 读取失败可诊断（2026-11-25 用户报障「hover 还是显示聊天 id」）:群聊名称需应用开通
        // 「获取群组信息」(im:chat:readonly)——失败静默降级,但留一行日志供排查（单聊仍走下方
        // 成员回落,不受此失败影响）
        (this.deps.log ?? (() => {}))(`feishu chat info 读取失败(${chatId}): ${e instanceof Error ? e.message : String(e)}；群聊名称需应用开通 im:chat:readonly`);
      }
      // 单聊名=聊天人名称:群名接口对 p2p 常为空/不支持,按消息形态直接回落成员列表（同一
      // im:chat:readonly 权限;群聊不回落——成员姓名不是群名,避免张冠李戴）
      if (chatKind !== 'direct') return undefined;
      try {
        const members = (await this.client.request({
          method: 'GET',
          url: `/open-apis/im/v1/chats/${chatId}/members`,
          params: { member_id_type: 'open_id' },
        })) as LarkChatMembersResponse;
        for (const m of members?.data?.items ?? []) {
          if (typeof m.name === 'string' && m.name !== '') return m.name;
        }
        return undefined;
      } catch (e) {
        (this.deps.log ?? (() => {}))(`feishu chat members 读取失败(${chatId}): ${e instanceof Error ? e.message : String(e)}；单聊名称需应用开通 im:chat:readonly`);
        return undefined;
      }
    })().then((name) => {
      if (name === undefined) this.chatCache.delete(chatId); // 失败不缓存:权限后开/发布后可重试
      return name;
    });
    this.chatCache.set(chatId, p);
    return p;
  }

  /** 业务错误日志单点（code!==0 时打一行;成功/无 code 零动作）——权限失败从此可诊断 */
  private logBiz(name: string, resp: LarkRespBase, key: string): void {
    if (resp.code === undefined || resp.code === 0) return;
    (this.deps.log ?? (() => {}))(`feishu ${name} 失败(${key}): code=${resp.code} msg=${resp.msg ?? ''}`);
  }

  /** 权限自检（2026-11-25 用户裁定「创建通道时主动检测缺少哪些权限,给弹窗说明,哪些必须/哪些可选,
   *  缺失时兜底显示什么」）:空聊天态可探测的两项 + 发送权限（无法探测,提示需确认）——
   *  ① im:chat:readonly:GET /im/v1/chats 探群信息/成员读取（缺→聊天名称与发送者姓名无法富化,
   *     回落显示聊天 id/用户 id）;
   *  ② contact:user.base:readonly:用无效 open_id 探通讯录读域——权限缺失与「用户不存在」按错误码
   *     区分（缺权限码集/消息含 scope/permission → granted:false）;
   *  ③ im:message:send_as_bot:发送消息权限无法在无目标聊天时探测,granted:null 提示自行确认。 */
  async probePermissions(): Promise<ChannelPermissionRow[]> {
    if (this.client === undefined) return [];
    const rows: ChannelPermissionRow[] = [];
    const call = async (
      method: 'GET' | 'POST',
      url: string,
      extra?: { params?: Record<string, string>; data?: unknown },
    ): Promise<LarkRespBase & { data?: unknown }> => {
      try {
        return (await this.client!.request({ method, url, ...(extra?.params !== undefined ? { params: extra.params } : {}), ...(extra?.data !== undefined ? { data: extra.data } : {}) })) as LarkRespBase & { data?: unknown };
      } catch (e) {
        return { code: -1, msg: e instanceof Error ? e.message : String(e) };
      }
    };
    // ① 群信息/成员读取
    const chat = await call('GET', '/open-apis/im/v1/chats', { params: { page_size: '1' } });
    rows.push({
      scope: 'im:chat:readonly',
      label: '获取群组信息 / 群成员',
      required: true,
      granted: chat.code === 0,
      fallback: '缺失时聊天名称、发送者姓名无法富化——hover 与消息来源行回落显示聊天 id / 用户 id',
    });
    // ② 通讯录读（用无效 open_id 探测权限面:缺权限码集判定）
    const DENIED = new Set([99991672, 99991663, 99991668, 99991679]);
    const probe = await call('GET', '/open-apis/contact/v3/users/ou_00000000000000000000000000000000', { params: { user_id_type: 'open_id' } });
    const deniedByMsg = /scope|permission|access denied|权限/i.test(probe.msg ?? '');
    rows.push({
      scope: 'contact:user.base:readonly',
      label: '获取用户基本信息（通讯录）',
      required: false,
      granted: probe.code === 0 ? true : !(deniedByMsg || (probe.code !== undefined && DENIED.has(probe.code))),
      fallback: '缺失时发送者姓名回落为群成员列表（需 im:chat:readonly）;两者都缺失则显示用户 id',
    });
    // ③ 发送消息:以**无效接收目标**试探（user 全零 open_id 必不存在）——缺权限=权限错误码/文案,
    // 有权限=「接收方不存在」类业务错;真正发不出去的误伤为零（2026-11-25 用户指正「该项已开通
    // 却标未探测」:空聊天态并非不可探测,试探目标非法即可安全区分）
    const sendProbe = await call('POST', '/open-apis/im/v1/messages', {
      params: { receive_id_type: 'open_id' },
      data: { receive_id: 'ou_00000000000000000000000000000000', msg_type: 'text', content: JSON.stringify({ text: 'permission probe' }) },
    });
    const sendDenied = /scope|permission|access denied|无权限|权限不足/i.test(sendProbe.msg ?? '') || (sendProbe.code !== undefined && DENIED.has(sendProbe.code));
    rows.push({
      scope: 'im:message:send_as_bot',
      label: '以应用身份发送消息',
      required: true,
      granted: sendProbe.code === -1 ? null : sendProbe.code === 0 ? true : !sendDenied,
      fallback: '缺失时机器人无法回复消息',
    });
    return rows;
  }

  /** 群成员姓名回落（2026-11-25 用户报障「群聊权限已有,用户名拿不到」根修）:通讯录取名需
   *  contact 读域——改用 GET im/v1/chats/:chat_id/members（im:chat:readonly 同域）建
   *  open_id→name 表;按 chat 缓存,只缓存成功。分页至多 3 页(300 人)防大群卡顿,超出者回落 id */
  private memberName(chatId: string, openId: string): Promise<string | undefined> {
    const hit = this.memberNamesCache.get(chatId);
    const load = hit ?? this.loadMemberNames(chatId);
    return load.then((m) => m?.get(openId));
  }

  /** 拉群成员姓名表（成功才入缓存;失败留诊断日志,下条消息重试） */
  private loadMemberNames(chatId: string): Promise<Map<string, string> | undefined> {
    const p = (async (): Promise<Map<string, string> | undefined> => {
      if (this.client === undefined) return undefined;
      const names = new Map<string, string>();
      let pageToken = '';
      for (let page = 0; page < 3; page += 1) {
        const resp = (await this.client.request({
          method: 'GET',
          url: `/open-apis/im/v1/chats/${chatId}/members`,
          params: { member_id_type: 'open_id', page_size: '100', ...(pageToken !== '' ? { page_token: pageToken } : {}) },
        })) as LarkChatMembersResponse;
        this.logBiz('群成员列表读取', resp, chatId);
        for (const m of resp?.data?.items ?? []) {
          if (typeof m.member_id === 'string' && typeof m.name === 'string' && m.name !== '') names.set(m.member_id, m.name);
        }
        const next = resp?.data?.page_token;
        if (resp?.data?.has_more !== true || typeof next !== 'string' || next === '') break;
        pageToken = next;
      }
      return names.size > 0 ? names : undefined;
    })().then(
      (m) => {
        if (m === undefined) this.memberNamesCache.delete(chatId); // 失败不缓存:可重试
        return m;
      },
      (e: unknown) => {
        this.memberNamesCache.delete(chatId);
        (this.deps.log ?? (() => {}))(`feishu 群成员列表读取失败(${chatId}): ${e instanceof Error ? e.message : String(e)}；成员姓名回落需 im:chat:readonly`);
        return undefined;
      },
    );
    this.memberNamesCache.set(chatId, p);
    return p;
  }
}
