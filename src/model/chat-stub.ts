import type { ModelAdapter } from './adapter';
import { parseLegacyEnvelope } from './adapter';
import type { ChatRequest, ChatResult } from '../types';
import type { UsageHooks } from './adapter';

/** 文本应答回调：入参（消息视图串接文本、用量钩子、中断信号），返回信封 DSL 文本（单工具/并行/done）；同步/异步皆可 */
export type TextReplyFn = (prompt: string, hooks?: UsageHooks, signal?: AbortSignal) => string | Promise<string>;

/** 测试桩桥接：文本应答回调 → chat 轮面。回调收到串接后的消息视图文本（消息拼装语义与 prompt 捕获类断言保持）；
 *  应答文本经信封 DSL 转译为结构化出牌。仅测试面消费，产品代码走适配器本体的 chat 实现 */
export function textReplyToChatFace(reply: TextReplyFn): (req: ChatRequest, hooks?: UsageHooks) => Promise<ChatResult> {
  return (req, hooks) => {
    const prompt = req.messages.map((m) => m.content).join('\n');
    return Promise.resolve(reply(prompt, hooks, req.signal)).then((text) => parseLegacyEnvelope(text));
  };
}

/** 便捷形态：直接产出 ModelAdapter（provider 自定） */
export function textReplyAdapter(provider: string, reply: TextReplyFn): ModelAdapter {
  return { provider, chat: textReplyToChatFace(reply) };
}
