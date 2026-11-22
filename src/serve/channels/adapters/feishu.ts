/**
 * 飞书适配器（2026-11-22 用户裁定「先提供飞书一个能力,飞书我可以直接测试」）：官方 SDK
 * （@larksuiteoapi/node-sdk）**WS 长连接**收事件（自建应用,无需公网回调）、HTTP 面回消息。
 * - 入站:im.message.receive_v1 → 规范化 InboundMessage（P0 仅 text 消息;群聊 mentions 在场=atBot,
 *   私聊恒 true——群聊仅 @ 机器人才会推消息的语义由飞书侧保证,mentions 是双保险）。
 * - 出站:reply 走 im.message.reply（引用入站 message_id,raw 携带）;send 走 im.message.create
 *   （receive_id_type=chat_id）;均 msg_type=text（P0 纯文本,caps.markdown=false 走投影降级链）。
 * - 测试连接(dry-run):WS 连上 + GET /open-apis/bot/v3/info 取 bot.app_name 作 botId。
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
  request(opts: { method: string; url: string }): Promise<unknown>;
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

export class FeishuAdapter implements ChannelAdapter {
  readonly id: string;
  private connected = false;
  private detail: string | undefined;
  private ws?: LarkWs;
  private client?: LarkClient;

  constructor(_cfg: ChannelConfig, private readonly deps: AdapterDeps) {
    this.id = _cfg.id;
  }

  caps(): DeliveryCaps {
    return { streaming: false, markdown: false, card: false, maxTextLength: 4000 };
  }

  async start(sink: (msg: InboundMessage) => void): Promise<void> {
    const appId = this.deps.ident['appId'] ?? '';
    if (!APP_ID_RE.test(appId)) {
      this.connected = false;
      this.detail = 'App ID 缺失或格式非法(cli_ 开头 16 位十六进制)';
      throw new Error(this.detail);
    }
    const log = this.deps.log ?? (() => {});
    const lark = (await import('@larksuiteoapi/node-sdk')) as unknown as LarkModule;
    const client = new lark.Client({ appId, appSecret: this.deps.secret, loggerLevel: lark.LoggerLevel.warn });
    this.client = client;
    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': (data: unknown) => {
        const inbound = feishuEventToInbound(this.id, data);
        if (inbound === undefined) return;
        try {
          sink(inbound);
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
      this.detail = `长连接未建立(${state})——检查 App ID/Secret 与开放平台「事件订阅-长连接模式」配置`;
      throw new Error(this.detail);
    }
    this.connected = true;
    this.detail = '飞书长连接运行中';
  }

  async stop(): Promise<void> {
    this.connected = false;
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
    await this.deliverText(target, msg.text ?? '');
  }

  /** 回执式回复:引用入站 message_id(飞书群聊内呈现为楼中楼);raw 缺 id 退化为 send */
  async reply(inbound: InboundMessage, msg: OutboundMessage): Promise<void> {
    const raw = inbound.raw as { message?: { message_id?: string } } | undefined;
    const messageId = raw?.message?.message_id;
    await this.deliverText({ channelId: inbound.channel, chatId: inbound.chatId }, msg.text ?? '', messageId);
  }
}
