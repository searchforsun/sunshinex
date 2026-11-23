/** 通道平台适配器 SPI(spec 2026-11-21-channels §3)——唯一每平台一变的接口:
 *  一个平台实现一个类,只声明 caps + 实现收发,降级链(流式→分段 send→终稿 send、
 *  markdown→纯文本、卡片→文字 y/n)在 router 不在适配器。
 *  本文件另承载注册表工厂 createChannelAdapter(按 cfg.platform 分派到具体适配器,
 *  未落地平台抛错、engine 捕获记 health error),供 Task 5 router / Task 7 engine
 *  与 telegram/飞书/钉钉 平台侧共同消费。 */
import type { ChannelConfig, DeliveryCaps, InboundMessage, OutboundMessage } from '../model';
import { MockChannelAdapter } from './mock';
import { TelegramAdapter } from './telegram';
import { FeishuAdapter } from './feishu';

/** 出站投递目标:通道 id + 平台会话标识 */
export interface ChatRef {
  channelId: string;
  chatId: string;
}

/** 适配器可分类错误（D111：start/健康失败的结构化归档——message 供人读，code 供 GUI 测试连接
 *  按码映射文案，免子串匹配 daemon 文案硬耦合）。非分类错误（SDK 抛出等）由 engine 归
 *  'start-failed'。 */
export class ChannelAdapterError extends Error {
  constructor(message: string, readonly code: 'ident-invalid' | 'connect-failed') {
    super(message);
    this.name = 'ChannelAdapterError';
  }
}

/** 流式增量(同气泡全量替换语义):fullText 为累积全文,done 标记终稿 */
export interface StreamDelta {
  fullText: string;
  done: boolean;
}

/** 适配器 SPI:必选 id/caps/start/stop/health/send;可选 reply(回执式回复,未实现时
 *  router 回退 send)、stream(同气泡流式替换,未实现时 router 走分段 send 降级链)、
 *  ack(受理回执平台面——飞书 OnIt「处理中」表情回应;未实现时 engine 回退文本 ack)、
 *  botName(平台侧 bot 身份名,测试连接回显用——飞书 bot/v3/info app_name;未实现时
 *  engine 退化通用健康文案)、emit(测试/注入用,仅 mock 实现——把 InboundMessage 塞给
 *  start 存下的 sink)。 */
export interface ChannelAdapter {
  readonly id: string;
  caps(): DeliveryCaps;
  start(sink: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  health(): { connected: boolean; detail?: string };
  send(target: ChatRef, msg: OutboundMessage): Promise<void>;
  reply?(inbound: InboundMessage, msg: OutboundMessage): Promise<void>;
  stream?(target: ChatRef, delta: StreamDelta): Promise<void>;
  ack?(inbound: InboundMessage, kind: 'accepted' | 'queued'): Promise<void>;
  botName?(): Promise<string | undefined>;
  emit?(msg: InboundMessage): void;
}

/** 适配器依赖注入:平台密钥(secret 来自通道条目内联 secret 字段,内联裁定——权威口径
 *  serve/channels/model.ts 头注)
 *  + 平台非密钥标识(ident,如 feishu appId)+ 可选 fetch 注入(测试替身)与日志钩子。 */
export interface AdapterDeps {
  secret: string;
  ident: Record<string, string>;
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
}

/** 注册表工厂:按 cfg.platform 分派到具体适配器;未落地平台 throw——engine 捕获记 health error。
 *  telegram 分支已接 ./telegram(Task 10,long-poll 真实现);feishu 已接 ./feishu(首发平台裁定,
 *  SDK WS 长连接——权威口径 ./feishu 头注);dingtalk/wecom 后续任务接入。 */
export function createChannelAdapter(cfg: ChannelConfig, deps: AdapterDeps): ChannelAdapter {
  switch (cfg.platform) {
    case 'mock':
      return new MockChannelAdapter(cfg, deps);
    case 'telegram':
      return new TelegramAdapter(cfg, deps);
    case 'feishu':
      return new FeishuAdapter(cfg, deps);
    case 'dingtalk':
    case 'wecom':
      throw new Error('platform not implemented yet');
  }
}
