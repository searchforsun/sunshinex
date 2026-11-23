/** mock 平台适配器(spec 2026-11-21-channels §3 SPI 的测试夹具实现)——注册表工厂唯一
 *  现役平台:无外连,`start` 存 sink、`emit` 注入 InboundMessage 直达 sink,出站全量记入
 *  公开 `sent` 日志供测试断言;caps 可由 `ident.mockCaps`(JSON 字符串,解析失败回缺省)
 *  覆写,供下游 router 降级链用例捏造能力组合。供 Task 5 router / Task 7 engine 测试消费。 */
import { CHANNEL_MAX_TEXT_LENGTH } from '../model';
import type { ChannelConfig, DeliveryCaps, InboundMessage, OutboundMessage } from '../model';
import type { AdapterDeps, ChannelAdapter, ChatRef, StreamDelta } from './types';

const DEFAULT_MOCK_CAPS: DeliveryCaps = { streaming: true, markdown: true, card: false, maxTextLength: CHANNEL_MAX_TEXT_LENGTH };

/** 解析 ident.mockCaps(JSON 字符串):缺省/解析失败/非普通对象一律回缺省,允许部分字段覆写 */
function parseMockCaps(raw: string | undefined): DeliveryCaps {
  const fallback = (): DeliveryCaps => ({ ...DEFAULT_MOCK_CAPS });
  if (raw === undefined || raw === '') return fallback();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback();
  return { ...DEFAULT_MOCK_CAPS, ...(parsed as Partial<DeliveryCaps>) };
}

export class MockChannelAdapter implements ChannelAdapter {
  readonly id: string;
  private readonly capsValue: DeliveryCaps;
  private sink: ((msg: InboundMessage) => void) | null = null;
  /** 出站日志(测试断言用):send/reply 全量追加 */
  readonly sent: OutboundMessage[] = [];
  /** 流式日志(测试断言用):stream 增量全量追加(选择「记录」而非直通 send,便于下游断言降级链) */
  readonly streamed: StreamDelta[] = [];

  constructor(cfg: ChannelConfig, deps: AdapterDeps) {
    this.id = cfg.id;
    this.capsValue = parseMockCaps(deps.ident['mockCaps']);
  }

  caps(): DeliveryCaps {
    return { ...this.capsValue };
  }

  async start(sink: (msg: InboundMessage) => void): Promise<void> {
    this.sink = sink;
  }

  async stop(): Promise<void> {
    this.sink = null;
  }

  health(): { connected: boolean; detail?: string } {
    return { connected: true, detail: 'mock 适配器恒健康(无外连)' };
  }

  async send(target: ChatRef, msg: OutboundMessage): Promise<void> {
    void target;
    this.sent.push(msg);
  }

  /** 回执式回复与 send 同义(mock 无平台回执语义),target 取 inbound 自带坐标 */
  async reply(inbound: InboundMessage, msg: OutboundMessage): Promise<void> {
    await this.send({ channelId: inbound.channel, chatId: inbound.chatId }, msg);
  }

  async stream(target: ChatRef, delta: StreamDelta): Promise<void> {
    void target;
    this.streamed.push(delta);
  }

  /** 测试/注入用:把 InboundMessage 塞给 start 存下的 sink;未 start(sink 为空)时静默忽略 */
  emit(msg: InboundMessage): void {
    if (this.sink !== null) this.sink(msg);
  }
}
