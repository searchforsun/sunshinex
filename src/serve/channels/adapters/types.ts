/** 通道平台适配器 SPI(spec 2026-11-21-channels §3)——唯一每平台一变的接口:
 *  一个平台实现一个类,只声明 caps + 实现收发,降级链(流式→分段 send→终稿 send、
 *  markdown→纯文本、卡片→文字 y/n)在 router 不在适配器。
 *  本文件另承载注册表工厂 createChannelAdapter(按 cfg.platform 分派到具体适配器,
 *  未落地平台抛错、engine 捕获记 health error),供 Task 5 router / Task 7 engine
 *  与 telegram/飞书/钉钉 平台侧共同消费。 */
import type { ChannelConfig, DeliveryCaps, InboundMessage, OutboundMessage } from '../model';
import { MockChannelAdapter } from './mock';

/** 出站投递目标:通道 id + 平台会话标识 */
export interface ChatRef {
  channelId: string;
  chatId: string;
}

/** 流式增量(同气泡全量替换语义):fullText 为累积全文,done 标记终稿 */
export interface StreamDelta {
  fullText: string;
  done: boolean;
}

/** 适配器 SPI:必选 id/caps/start/stop/health/send;可选 reply(回执式回复,未实现时
 *  router 回退 send)、stream(同气泡流式替换,未实现时 router 走分段 send 降级链)、
 *  emit(测试/注入用,仅 mock 实现——把 InboundMessage 塞给 start 存下的 sink)。 */
export interface ChannelAdapter {
  readonly id: string;
  caps(): DeliveryCaps;
  start(sink: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  health(): { connected: boolean; detail?: string };
  send(target: ChatRef, msg: OutboundMessage): Promise<void>;
  reply?(inbound: InboundMessage, msg: OutboundMessage): Promise<void>;
  stream?(target: ChatRef, delta: StreamDelta): Promise<void>;
  emit?(msg: InboundMessage): void;
}

/** 适配器依赖注入:平台密钥(secret,来自 env 槽 SUNSHINEX_CHANNEL_SECRET_*,D6 不经配置)
 *  + 平台非密钥标识(ident,如 feishu appId)+ 可选 fetch 注入(测试替身)与日志钩子。 */
export interface AdapterDeps {
  secret: string;
  ident: Record<string, string>;
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
}

/** 注册表工厂:按 cfg.platform 分派到具体适配器;未落地平台 throw——engine 捕获记 health error。
 *  telegram 分支 Task 10 接入 ./telegram 适配器;feishu/dingtalk/wecom 后续任务接入。 */
export function createChannelAdapter(cfg: ChannelConfig, deps: AdapterDeps): ChannelAdapter {
  switch (cfg.platform) {
    case 'mock':
      return new MockChannelAdapter(cfg, deps);
    case 'telegram':
      throw new Error('telegram adapter lands in a later task');
    case 'feishu':
    case 'dingtalk':
    case 'wecom':
      throw new Error('platform not implemented yet');
  }
}
