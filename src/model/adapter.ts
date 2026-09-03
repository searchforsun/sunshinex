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
