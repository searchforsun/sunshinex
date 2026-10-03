/**
 * 可切换适配器（/model 多源多模型单点）：实现 ModelAdapter 的转发外壳——持有者
 * （reactor / 子代理 runner / 压缩 / 沉淀管线 / banner）引用不变，switchTo 换内芯即时全局生效，
 * 免整 runtime 重建（会话链、账本、MCP 连接现场全保留）。
 * 换模型与换档位同口径（CLAUDE.md §11）：用户级会话参数、整场恒定（对后续任务生效）、
 * 不进提示词、系统侧零自动切换——用户显式触发的跨模型重算事件。
 */
import { ModelAdapter, OpenAIAdapter, UsageHooks, LLMConfig } from './adapter';
import type { ChatRequest, ChatResult, ReasoningEffort } from '../types';
import type { ModelChoice } from '../config/providers';
import { resolveProviderApiKey } from '../config/providers';

export interface ModelSwitcherOpts {
  /** 可选清单（settings providers 键展开）；空 = /model 无可切换项 */
  choices: readonly ModelChoice[];
  /** 缺省主适配器（单模型装配产物；/model 选 default 或未切换时用它） */
  default: ModelAdapter;
  /** 主模型是否显式配置（settings model 键 / SUNSHINEX_MODEL）：为真时 default 才作为可选项露出——
   *  未显式配置时缺省内芯即首个 provider 模型，「回 default」只会回到没人要的端点内置缺省，是陷阱选项 */
  explicitDefault?: boolean;
  /** 缺省思考强度（与单模型装配同源 --effort/env）：各源适配器同基继承，防配了多源后 effort 缺省丢失 */
  reasoningEffort?: ReasoningEffort;
}

/**
 * 源条目 → 适配器 cfg 纯函数（密钥按源名解析专用槽/主槽；effort 两级：条目 reasoningEffort > 装配级
 * 全局缺省（--effort/env）；窗口进 cfg——run 级窗口解析（resolveRunWindow）随当前内芯走）。
 *  抽为导出纯函数：优先级链可钉（protected 工厂测试子类钉不了构造入参），buildAdapter 单点消费
 */
export function choiceAdapterConfig(choice: ModelChoice, defs: { reasoningEffort?: ReasoningEffort }): LLMConfig {
  return {
    provider: 'openai',
    baseURL: choice.baseUrl,
    apiKey: resolveProviderApiKey(choice.provider),
    model: choice.model,
    ...(choice.contextWindow !== undefined ? { contextWindow: choice.contextWindow } : {}),
    ...(choice.reasoningEffort !== undefined ? { reasoningEffort: choice.reasoningEffort } : defs.reasoningEffort !== undefined ? { reasoningEffort: defs.reasoningEffort } : {}),
  };
}

export class ModelSwitcher implements ModelAdapter {
  private readonly defs: ModelSwitcherOpts;
  private readonly def: ModelAdapter;
  private readonly choiceAdapters = new Map<string, ModelAdapter>();
  private selectedId?: string;

  constructor(opts: ModelSwitcherOpts) {
    this.defs = opts;
    this.def = opts.default;
    for (const c of opts.choices) this.choiceAdapters.set(c.id, this.buildAdapter(c));
  }

  /** 源条目 → OpenAI 协议适配器（cfg 经 choiceAdapterConfig 纯函数：密钥/窗口/两级 effort 单点）。
   *  protected 工厂：测试子类可注入假内芯钉「换内芯即生效」的转发语义，生产面零额外 API */
  protected buildAdapter(choice: ModelChoice): ModelAdapter {
    return new OpenAIAdapter(choiceAdapterConfig(choice, this.defs));
  }

  /** 当前生效内芯（选择在场取对应适配器；未选/失配回缺省主适配器） */
  private get current(): ModelAdapter {
    return (this.selectedId !== undefined ? this.choiceAdapters.get(this.selectedId) : undefined) ?? this.def;
  }

  get provider(): string {
    return this.current.provider;
  }

  /** 展示标签：选择在场为 `源/模型` id（多源下同模型名可辨）；缺省态透传主适配器标签（与单模型形态一致） */
  get label(): string {
    return this.selectedId !== undefined ? this.selectedId : (this.current.label ?? this.current.provider);
  }

  /** 当前模型最大上下文 tokens（透传内芯；undefined = 回退全局链 SUNSHINEX_CONTEXT_WINDOW / 200k） */
  get contextWindow(): number | undefined {
    return this.current.contextWindow;
  }

  /** 可选清单（settings providers 展开） */
  choices(): readonly ModelChoice[] {
    return this.defs.choices;
  }

  /** 主模型是否显式配置（决定 default 选项是否露出） */
  hasExplicitDefault(): boolean {
    return this.defs.explicitDefault === true;
  }

  /** 当前选择 id（undefined = 缺省主模型） */
  currentId(): string | undefined {
    return this.selectedId;
  }

  /** 切换单点：undefined 回缺省主模型；未知 id 幂等 false 不动现状（恢复档遇配置漂移的防御） */
  switchTo(id: string | undefined): boolean {
    if (id === undefined) {
      this.selectedId = undefined;
      return true;
    }
    if (!this.choiceAdapters.has(id)) return false;
    this.selectedId = id;
    return true;
  }

  async chat(req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult> {
    return this.current.chat(req, hooks);
  }

  /** 流式转发：内芯未实现流式时回落非流式 chat（消费方本就按该口径降级，此处同构） */
  async chatStream(req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    const cur = this.current;
    if (cur.chatStream) return cur.chatStream(req, onDelta, hooks);
    return cur.chat(req, hooks);
  }

  /** effort 探测缓存透传：内芯未实现/未探测回 undefined（调用方回退请求档，与直连内芯同语义） */
  resolvedEffort(requested: ReasoningEffort): ReasoningEffort | undefined {
    return this.current.resolvedEffort?.(requested);
  }
}
