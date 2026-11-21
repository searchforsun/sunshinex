/** telegram 平台适配器(spec 2026-11-21-channels §10,第一个真实平台/SPI 中立性样板)——
 *  收:long-poll getUpdates 循环(update→InboundMessage 映射经 sink);推:sendMessage 全量。
 *  caps 全量覆盖 {streaming:false, markdown:true, card:false, maxTextLength:4096}:不实现
 *  reply/stream(SPI 可选成员),router 据此走「分段 send→终稿 send」降级链;>4096 由
 *  projector 分片,适配器不再切。测试零真外连:fetchImpl/delayImpl 双注入(AdapterDeps 无
 *  delayImpl 槽,经构造器第三参注入,生产缺省 setTimeout 让出事件循环)。错误退避(spec §10):
 *  fetch 抛错/HTTP 非 ok → log + delay(5000) 续轮;正常轮零间隔(0ms 仅让出事件循环,避免
 *  微任务自旋烧 CPU)。裁定(P0):只认 update.message 字段,edited_message/channel_post 等变体
 *  一律忽略;atBot 私聊恒 true,群聊 /^@\w+bot\b/i(机器人在群里被 @ 时 username 出现在文本头部)。 */
import type { ChannelConfig, DeliveryCaps, InboundMessage, OutboundMessage } from '../model';
import type { AdapterDeps, ChannelAdapter, ChatRef } from './types';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** long-poll 服务端挂秒数(Telegram 上限 50 取 25;仅是 URL 参数——注入 fetchImpl 即返回时不影响测试) */
const LONG_POLL_TIMEOUT_SECONDS = 25;
/** 错误退避毫秒(spec §10:fetch 抛错/HTTP 非 ok → delay(5000) 续轮) */
const ERROR_BACKOFF_MS = 5000;
/** 群聊 @ 判定:@ 机器人在文本头部(spec §10 裁定;私聊不经此,恒 true) */
const AT_BOT_RE = /^@\w+bot\b/i;

/** Telegram Bot API 返回的宽松形状(只取所需字段,P0 不做严格校验) */
interface TgMessage {
  message_id?: number;
  from?: { id?: number; first_name?: string; username?: string };
  chat?: { id?: number | string; type?: string };
  text?: string;
}
interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
}
interface TgUpdatesResponse {
  result?: TgUpdate[];
}

/** 生产缺省延时:setTimeout 让出事件循环(正常轮 0ms 也不会微任务自旋) */
function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly delayImpl: (ms: number) => Promise<void>;
  private readonly log: (s: string) => void;
  /** 下一次 getUpdates 的 offset(= 上批最大 update_id+1;0 = 从最早未确认更新起) */
  private offset = 0;
  private stopped = false;
  private connected = false;

  constructor(cfg: ChannelConfig, deps: AdapterDeps, delayImpl: (ms: number) => Promise<void> = defaultDelay) {
    this.id = cfg.id;
    this.secret = deps.secret;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? (() => {});
    this.delayImpl = delayImpl;
  }

  caps(): DeliveryCaps {
    return { streaming: false, markdown: true, card: false, maxTextLength: 4096 };
  }

  /** 起 long-poll 循环:后台自驱(void 异步循环),start 立即返回;stop 置位可复用重启 */
  async start(sink: (msg: InboundMessage) => void): Promise<void> {
    this.stopped = false;
    this.connected = true;
    void this.pollLoop(sink);
  }

  /** 停:置位即 disconnected;当前长轮询返回后循环下一拍退出,不再发起新请求 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
  }

  health(): { connected: boolean; detail?: string } {
    return this.connected
      ? { connected: true, detail: `long-poll 运行中(offset=${this.offset})` }
      : { connected: false, detail: '长轮询未运行(未 start 或已 stop)' };
  }

  /** 出站:POST sendMessage body {chat_id, text}(markdown 直传,caps.markdown=true);
   *  HTTP 非 ok 抛错——engine/router 记投递失败,适配器不做静默重试。 */
  async send(target: ChatRef, msg: OutboundMessage): Promise<void> {
    const res = await this.fetchImpl(`${TELEGRAM_API_BASE}/bot${this.secret}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: target.chatId, text: msg.text }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage HTTP ${res.status}`);
  }

  /** 收循环:每拍 getUpdates → 逐 update 映射 → sink;尾拍 delay(错误 5000/正常 0)续轮,
   *  while 复查 stopped 退场(stop 置位后当前长轮询返回即退,不阉割在途请求)。 */
  private async pollLoop(sink: (msg: InboundMessage) => void): Promise<void> {
    try {
      while (!this.stopped) {
        let backoffMs = 0;
        try {
          for (const update of await this.fetchUpdates()) this.dispatchUpdate(sink, update);
        } catch (err) {
          backoffMs = ERROR_BACKOFF_MS;
          this.log(`telegram getUpdates 失败(${ERROR_BACKOFF_MS}ms 退避): ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.delayImpl(backoffMs); // 正常轮 0ms:零间隔续拍且让出事件循环
      }
    } finally {
      this.connected = false;
    }
  }

  /** 一拍 getUpdates:URL 带 timeout=25&offset=<n>;HTTP 非 ok 抛错(统一走退避);
   *  offset 推进 = 本批最大 update_id+1(Telegram 确认语义,与该 update 是否含 message 无关)。 */
  private async fetchUpdates(): Promise<TgUpdate[]> {
    const res = await this.fetchImpl(
      `${TELEGRAM_API_BASE}/bot${this.secret}/getUpdates?timeout=${LONG_POLL_TIMEOUT_SECONDS}&offset=${this.offset}`,
      { method: 'GET' },
    );
    if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
    const body = (await res.json()) as TgUpdatesResponse;
    const updates = Array.isArray(body.result) ? body.result : [];
    for (const u of updates) {
      if (typeof u.update_id === 'number' && u.update_id >= this.offset) this.offset = u.update_id + 1;
    }
    return updates;
  }

  /** update → InboundMessage → sink。裁定(P0):只认 message 字段,edited_message/channel_post
   *  等变体一律忽略;userDisplay 取 first_name ?? username(两者皆无则缺省);
   *  atBot 私聊恒 true,群聊按头部 @ 判定;text 缺失(图片等非文本)时 atBot 群聊为 false。 */
  private dispatchUpdate(sink: (msg: InboundMessage) => void, update: TgUpdate): void {
    const m = update.message;
    if (!m) return;
    const text = typeof m.text === 'string' ? m.text : undefined;
    const isPrivate = m.chat?.type === 'private';
    const display = m.from?.first_name ?? m.from?.username;
    sink({
      channel: this.id,
      chatId: String(m.chat?.id ?? ''),
      chatKind: isPrivate ? 'direct' : 'group',
      userId: String(m.from?.id ?? ''),
      ...(display !== undefined ? { userDisplay: display } : {}),
      msgId: String(m.message_id ?? ''),
      ...(text !== undefined ? { text } : {}),
      atBot: isPrivate ? true : AT_BOT_RE.test(text ?? ''),
      raw: update,
    });
  }
}
