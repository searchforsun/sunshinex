/** 模型适配层：统一推理接口，多后端可插拔 */
import { ModelTier, RouteDecision } from '../types';

export type { ModelTier };
/** 用量回调钩子：complete 完成后回传本次真实 token 用量（无用量回传 0） */
export interface UsageHooks {
  onUsage?: (tokens: number) => void;
  /** 思考增量（SSE reasoning_content / reasoning 键）；端点不回传则永不触发 */
  onReasoning?: (delta: string) => void;
}

export interface ModelAdapter {
  readonly provider: string;
  complete(prompt: string, hooks?: UsageHooks): Promise<string>;
}

/** 从 OpenAI 兼容响应 JSON 解析 usage.total_tokens；缺失/非数字回 0（无占位计数） */
export function extractUsage(data: unknown): number {
  const tokens = (data as { usage?: { total_tokens?: unknown } } | null)?.usage?.total_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
}

/** 占位适配器：不实际调用云端，返回标记文本 */
export class StubAdapter implements ModelAdapter {
  readonly provider = 'stub';
  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    hooks?.onUsage?.(0); // 占位适配器无真实用量
    return `[stub reply] ${prompt}`;
  }

  async completeStream(prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    const out = await this.complete(prompt, hooks);
    onDelta(out);
    return out;
  }
}

export interface LLMConfig {
  provider: 'openai' | 'stub' | 'scripted';
  baseURL?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/** OpenAI 兼容适配器：Node 内置 fetch 直连 REST API，带超时控制 */
export class OpenAIAdapter implements ModelAdapter {
  readonly provider = 'openai';
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(private cfg: LLMConfig) {
    this.baseURL = cfg.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = cfg.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.timeoutMs = cfg.timeoutMs ?? 600_000;
  }

  async complete(prompt: string, hooks?: UsageHooks): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY 未配置');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }] }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`OpenAI 请求失败：${resp.status}`);
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      hooks?.onUsage?.(extractUsage(data));
      return data.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error('模型调用超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 流式补全：stream:true SSE 输出，\n\n 分帧缓冲（容忍跨 chunk 半帧），data:[DONE] 终止；usage 取自携带用量的事件帧 */
  async completeStream(prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY 未配置');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], stream: true }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`OpenAI 请求失败：${resp.status}`);
      let full = '';
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of resp.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            const data = line.replace(/^data:\s*/, '');
            if (!data || data === '[DONE]') continue;
            try {
              const ev = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
              const d = ev.choices?.[0]?.delta;
              const reason = d?.reasoning_content ?? d?.reasoning;
              if (reason) hooks?.onReasoning?.(reason);
              if (d?.content) {
                full += d.content;
                onDelta(d.content);
              }
              const usage = extractUsage(ev);
              if (usage > 0) hooks?.onUsage?.(usage);
            } catch {
              // 非 JSON 的 data 行（服务端注释/心跳）忽略，不中断流
            }
          }
        }
      }
      return full;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error('模型调用超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 脚本化适配器：预置决策序列逐步回放（测试/离线兜底） */
export class ScriptedAdapter implements ModelAdapter {
  readonly provider = 'scripted';
  private i = 0;
  constructor(private steps: string[]) {}

  async complete(_prompt: string, hooks?: UsageHooks): Promise<string> {
    hooks?.onUsage?.(0); // 脚本化回放无真实用量
    const s = this.steps[this.i];
    this.i = Math.min(this.i + 1, this.steps.length - 1);
    return s ?? '{"done":true}';
  }

  /** 无流式通道：当前步逐字回调投递（压测消费端增量处理路径），返回全文 */
  async completeStream(_prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    hooks?.onUsage?.(0); // 脚本化回放无真实用量
    const s = this.steps[this.i];
    this.i = Math.min(this.i + 1, this.steps.length - 1);
    const text = s ?? '{"done":true}';
    for (const ch of text) onDelta(ch);
    return text;
  }
}

/** 路由提示：调用方对本次任务的算力信号（Graph 角色/复杂度） */
export interface RouteHint {
  complexity?: 'low' | 'mid' | 'high';
  role?: string;
}

/** 业务规则：评审/编码类角色需要更强模型，规划类居中 */
const ROLE_TIER: Record<string, ModelTier> = {
  critic: 'large',
  coder: 'large',
  planner: 'medium',
};

const COMPLEXITY_TIER: Record<NonNullable<RouteHint['complexity']>, ModelTier> = {
  low: 'small',
  mid: 'medium',
  high: 'large',
};

/** 三档算力路由：small/medium/large */

export class ModelRouter {
  private adapters = new Map<ModelTier, ModelAdapter>();
  private fallback: ModelAdapter | null = null;

  /** 默认档：所有未显式绑定的档位回退到此 adapter */
  bindDefault(adapter: ModelAdapter): this {
    this.fallback = adapter;
    return this;
  }

  bind(tier: ModelTier, adapter: ModelAdapter): void {
    this.adapters.set(tier, adapter);
  }

  /** 该档已绑定 → 直取；未绑定但有默认 → 回退默认；两者皆无 → 抛错（装配错误快速失败） */
  resolve(tier: ModelTier): ModelAdapter {
    const a = this.adapters.get(tier);
    if (a) return a;
    if (this.fallback) return this.fallback;
    throw new Error(`no adapter bound for tier ${tier}`);
  }

  /** 显式绑定档快照（不含默认回退） */
  boundTiers(): ModelTier[] {
    return [...this.adapters.keys()];
  }

  /** 提示感知路由：role 优先于 complexity，均缺省回退 medium；reason 留痕决策依据 */
  route(hint?: RouteHint): RouteDecision {
    let tier: ModelTier = 'medium';
    let source = 'default:medium';
    if (hint?.role && ROLE_TIER[hint.role]) {
      tier = ROLE_TIER[hint.role];
      source = `role:${hint.role}`;
    } else if (hint?.complexity) {
      tier = COMPLEXITY_TIER[hint.complexity];
      source = `complexity:${hint.complexity}`;
    }
    const bound = this.adapters.has(tier);
    const reason = bound ? source : `${source} fallback:default`;
    return { tier, reason, adapterProvider: this.resolve(tier).provider, bound };
  }
}
