/** wire 序列化与非流式响应解析（OpenAI 协议面无状态纯函数）——自 adapter.ts 纯搬移（H4 拆件，
 *  原 OpenAIAdapter 私有静态方法，三函数均零实例状态：cfg/effort 探测态不进本件，OpenAIAdapter 直接调用）；
 *  仅依赖 src/types.ts；adapter.ts 对本件公开符号按原路径再导出，既有 './adapter' 导入点零改动 */
import type { ChatMessage, ChatResult, ChatTool, ToolCallSpec } from '../types';

/** 消息视图 → wire 形态（assistant.toolCalls → tool_calls；tool → role:tool + tool_call_id）。
 *  assistant.reasoning 原样回传为 reasoning_content：交错思考端点（DeepSeek/Qwen 系思考模式）的
 *  硬约束是**字段在场**——实测空串 200、缺字段 400 "must be passed back"（思考模式默认开但模型偶尔
 *  整轮零思考，buildMessages 对当轮批消息兜底空串）；字段未定义（旧任务轮/非思考端点）零穿参 */
export function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
        ...(m.toolCalls && m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.argsJson } })) }
          : {}),
      };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
    return { role: m.role, content: m.content };
  });
}

/** 注册表工具 → API tools 字段 */
export function toWireTools(tools: ChatTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ type: 'function', function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } }));
}

/** 非 streaming 响应 choices[0] → 轮聚合结果（finish=tool_calls 之外一律归 stop 保守收束）；
 *  reasoning_content（思考模式端点扩展）捕获进结果供续轮回传 */
export function parseChatResult(data: unknown): ChatResult {
  const choice = (data as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>} | null)?.choices?.[0];
  const msg = choice?.message;
  const calls: ToolCallSpec[] = (msg?.tool_calls ?? []).map((t, i) => ({
    id: t.id ?? `call_${i}`,
    name: t.function?.name ?? '',
    argsJson: t.function?.arguments ?? '',
  }));
  const finish = choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop';
  const reasoning = msg?.reasoning_content ?? msg?.reasoning;
  return { finish, content: msg?.content ?? '', toolCalls: finish === 'tool_calls' ? calls : [], ...(reasoning ? { reasoning } : {}) };
}
