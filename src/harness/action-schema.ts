/** 结构化输出（请求级 response_format）：把动作信封协议镜像为 JSON Schema 随请求下发，
 * 由端点侧约束输出形态，畸形信封在源头收敛（json_object 档仅约束合法 JSON、不约束形状）。
 * 提示词协议段保留不动——schema 是协议行的机器可读镜像而非替代，前缀缓存零影响；
 * 端点不支持 response_format 时的请求失败走 model-error，此时文本协议通道仍完整可用 */
import { ResponseFormat } from '../model/adapter';

/** 信封 JSON Schema（oneOf 三形态：单工具 / 并行清单 / 完成答复），与 reactor.buildPrompt 协议段同源镜像。
 * strict:false——input 为任意工具入参对象，strict 模式的全字段穷举不现实，schema 定位为引导而非强约束；
 * required 取最小承重集（tool / tools / done），与 parse 容错语义一致（reply 可缺省、input 可缺省） */
export const ACTION_ENVELOPE_FORMAT: ResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'sunshinex_action',
    strict: false,
    schema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            input: { type: 'object' },
            done: { type: 'boolean', enum: [false] },
            phase: { type: 'string' },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string' },
                  input: { type: 'object' },
                },
                required: ['tool'],
                additionalProperties: false,
              },
            },
            done: { type: 'boolean', enum: [false] },
            phase: { type: 'string' },
          },
          required: ['tools'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            done: { type: 'boolean', enum: [true] },
            reply: { type: 'string' },
            phase: { type: 'string' },
          },
          required: ['done'],
          additionalProperties: false,
        },
      ],
    },
  },
};

/** 环境开关 → 请求级 response_format：SUNSHINEX_STRUCTURED_OUTPUT
 * - 未设/空/非法值 → json_schema（缺省开启，非法静默回退缺省，对齐 CONTEXT_WINDOW 先例）
 * - 'json' → json_object（仅约束合法 JSON 的兼容档，适合端点不支持 json_schema 时降级）
 * - 'off' → undefined（显式关闭，请求体不带 response_format 字段） */
export function resolveStructuredFormat(env: string | undefined): ResponseFormat | undefined {
  const v = (env ?? '').trim().toLowerCase();
  if (v === 'json') return { type: 'json_object' };
  if (v === 'off') return undefined;
  return ACTION_ENVELOPE_FORMAT;
}
