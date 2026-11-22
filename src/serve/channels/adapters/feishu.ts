/**
 * 飞书适配器（2026-11-22 用户裁定「先提供飞书一个能力,飞书我可以直接测试」）：官方 SDK
 * （@larksuiteoapi/node-sdk）**WS 长连接**收事件（自建应用,无需公网回调）、HTTP 面回消息。
 * - 入站:im.message.receive_v1 → 规范化 InboundMessage（P0 仅 text 消息;群聊 mentions 在场=atBot,
 *   私聊恒 true——群聊仅 @ 机器人才会推消息的语义由飞书侧保证,mentions 是双保险）。
 * - 出站:reply 走 im.message.reply（引用入站 message_id,raw 携带）;send 走 im.message.create
 *   （receive_id_type=chat_id）;均 msg_type=text（P0 纯文本,caps.markdown=false 走投影降级链）。
 * - 测试连接(dry-run):WS 连上 + GET /open-apis/bot/v3/info 取 bot.app_name 作 botId。
 * - 受理回执(2026-11-22 用户裁定「受理不用自动弹出来,用官方处理中 icon」):ack 贴官方 OnIt
 *   「处理中」表情回应,回答送达(reply)自动摘除;失败由 engine 退文本回执不分叉。
 * - 定向 @(2026-11-22 用户裁定「群聊才 @ 人」):caps.mention=true——群聊出站前缀 `<at user_id>`
 *   标签由飞书服务端渲染真实姓名(单聊零 @,回执式回复天然指向本人);发送者姓名富化走通讯录
 *   API+缓存(权限未开静默降级 open_id,不影响 @ 标签渲名)。
 * - 凭证:App ID 走 cfg.ident.appId,App Secret 走 deps.secret（cfg.secret 内联,2026-11-22 裁定）。
 * SDK 靠 start() 内动态 import——加载延迟到首个飞书通道启用;连接保活/断线重连由 SDK 内部负责
 * （Reconnect/pingLoop）,stop() = ws.close() 主动退场。
 */
import type { AdapterDeps, ChannelAdapter, ChatRef } from './types';
import type { ChannelConfig, DeliveryCaps, InboundMessage, OutboundMessage } from '../model';

/** 飞书 App ID 形态（SDK start() 同款校验——非法形态 SDK 静默不连,此处提前给可读错误） */
const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;

/** 飞书 text 消息 content JSON 上限防御（正常 <1KB;超限按畸形丢正文） */
const CONTENT_PARSE_MAX = 64 * 1024;

/** 受理 ack 表情（2026-11-22 用户裁定「受理不用自动弹出来，用官方处理中 icon」）：OnIt=飞书
 *  官方「正在处理」表情，贴在入站消息上作受理回执，回答到达（reply）后自动摘除 */
const ACK_EMOJI = 'OnIt';

/** 纯函数（单测锚点）：受理 ack → 表情回应请求形状（POST reactions，emoji_type=OnIt） */
export function feishuAckReactionPayload(messageId: string): { method: string; url: string; data: unknown } {
  return { method: 'POST', url: `/open-apis/im/v1/messages/${messageId}/reactions`, data: { reaction_type: { emoji_type: ACK_EMOJI } } };
}

/** 纯函数（单测锚点）：群聊定向 @ 前缀——`<at user_id>` 标签由飞书服务端渲染成真实姓名
 *  （无需通讯录权限；open_id 形态受 APP_ID_RE 同族约束，无注入面）；无 mention → 空串 */
export function feishuMentionPrefix(mention: { userId: string; display?: string } | undefined): string {
  if (mention === undefined || mention.userId === '') return '';
  return `<at user_id="${mention.userId}"></at> `;
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
  sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
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
interface LarkUserResponse {
  data?: { user?: { name?: string } };
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

  constructor(_cfg: ChannelConfig, private readonly deps: AdapterDeps) {
    this.id = _cfg.id;
  }

  caps(): DeliveryCaps {
    return { streaming: false, markdown: false, card: false, maxTextLength: 4000, mention: true };
  }

  async start(sink: (msg: InboundMessage) => void): Promise<void> {
    const appId = this.deps.ident['appId'] ?? '';
    if (!APP_ID_RE.test(appId)) {
      this.connected = false;
      this.detail = 'App ID 无效';
      throw new Error(this.detail);
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
        try {
          // 发送者姓名富化（缓存命中零等待；首见一次通讯录查询）：群聊 [来自 x]: 前缀与
          // 绑定锁定展示可读；权限未开/失败静默保 open_id（@ 标签由飞书侧渲名不受影响）
          const name = inbound.userId !== '' ? await this.userName(inbound.userId) : undefined;
          sink(name !== undefined ? { ...inbound, userDisplay: name } : inbound);
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
      throw new Error(this.detail);
    }
    this.connected = true;
    this.detail = '飞书长连接运行中';
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.processingReactions.clear();
    this.nameCache.clear();
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

  private async deliverText(target: ChatRef, text: string, replyMessageId?: string): Promise<void> {
    if (this.client === undefined) throw new Error('feishu adapter not started');
    const content = JSON.stringify({ text });
    if (replyMessageId !== undefined && replyMessageId !== '') {
      await this.client.im.message.reply({ path: { message_id: replyMessageId }, data: { msg_type: 'text', content } });
      return;
    }
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.chatId, msg_type: 'text', content },
    });
  }

  async send(target: ChatRef, msg: OutboundMessage): Promise<void> {
    await this.deliverText(target, feishuMentionPrefix(msg.mention) + (msg.text ?? ''));
  }

  /** 回执式回复:引用入站 message_id(飞书群聊内呈现为楼中楼);raw 缺 id 退化为 send。
   *  回答送达即摘「处理中」表情（受理 ack 贴的 OnIt,2026-11-22 用户裁定语义闭环） */
  async reply(inbound: InboundMessage, msg: OutboundMessage): Promise<void> {
    const raw = inbound.raw as { message?: { message_id?: string } } | undefined;
    const messageId = raw?.message?.message_id;
    await this.deliverText({ channelId: inbound.channel, chatId: inbound.chatId }, feishuMentionPrefix(msg.mention) + (msg.text ?? ''), messageId);
    if (messageId !== undefined && messageId !== '') void this.unmarkProcessing(messageId);
  }

  /** 受理回执平台面（2026-11-22 用户裁定）：入站消息贴 OnIt「处理中」表情——失败上抛由
   *  engine ack 包装捕获退文本回执,语义不分叉（缺 message_id 同上抛走文本兜底） */
  async ack(inbound: InboundMessage, _kind: 'accepted' | 'queued'): Promise<void> {
    void _kind; // accepted/queued 同贴 OnIt;排队说明文本由 engine 并发
    const messageId = (inbound.raw as { message?: { message_id?: string } } | undefined)?.message?.message_id;
    if (this.client === undefined || messageId === undefined || messageId === '') throw new Error('feishu ack: no message_id');
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

  /** 发送者姓名（通讯录 API + 进程内缓存,含失败缓存）：权限未开（需 contact:user.base:readonly
   *  等通讯录读域）静默降级 open_id */
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
        const name = resp?.data?.user?.name;
        return typeof name === 'string' && name !== '' ? name : undefined;
      } catch {
        return undefined;
      }
    })();
    this.nameCache.set(openId, p);
    return p;
  }
}
