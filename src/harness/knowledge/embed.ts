import { EmbeddingProvider } from '../../types';

export interface EmbeddingsConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** OpenAI 兼容 /embeddings 默认 Provider：批量 POST，data[].embedding 按 index 归位；配置由装配层经 resolveKbEnv 注入（本类不读进程环境） */
export class OpenAICompatEmbeddings implements EmbeddingProvider {
  constructor(private cfg: EmbeddingsConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
    try {
      const resp = await fetch(`${this.cfg.baseURL}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({ model: this.cfg.model, input: texts }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`Embedding 请求失败：${resp.status}`);
      const data = (await resp.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
      if (!Array.isArray(data.data)) throw new Error('Embedding 响应格式非法：data 缺失或非数组');
      const out: number[][] = new Array(texts.length);
      for (const item of data.data) {
        if (typeof item.index !== 'number' || !Array.isArray(item.embedding)) {
          throw new Error('Embedding 响应格式非法：条目缺 index/embedding');
        }
        out[item.index] = item.embedding;
      }
      if (out.length !== texts.length || out.some((v) => !v)) {
        throw new Error('Embedding 响应格式非法：向量数量与输入不一致');
      }
      return out;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error('Embedding 请求超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
