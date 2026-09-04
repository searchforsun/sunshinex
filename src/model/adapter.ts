/** 模型适配层：统一推理接口，多后端可插拔 */
export interface ModelAdapter {
  readonly provider: string;
  complete(prompt: string): Promise<string>;
}

/** 占位适配器：不实际调用云端，返回标记文本 */
export class StubAdapter implements ModelAdapter {
  readonly provider = 'stub';
  async complete(prompt: string): Promise<string> {
    return `[stub reply] ${prompt}`;
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
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
  }

  async complete(prompt: string): Promise<string> {
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
      return data.choices?.[0]?.message?.content ?? '';
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

  async complete(_prompt: string): Promise<string> {
    const s = this.steps[this.i];
    this.i = Math.min(this.i + 1, this.steps.length - 1);
    return s ?? '{"done":true}';
  }
}

/** 三档算力路由：small/medium/large */
export type ModelTier = 'small' | 'medium' | 'large';

export class ModelRouter {
  private adapters = new Map<ModelTier, ModelAdapter>();

  bind(tier: ModelTier, adapter: ModelAdapter): void {
    this.adapters.set(tier, adapter);
  }

  resolve(tier: ModelTier): ModelAdapter {
    const a = this.adapters.get(tier);
    if (!a) throw new Error(`no adapter bound for tier ${tier}`);
    return a;
  }
}
