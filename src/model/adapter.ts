/** 模型适配层：统一推理接口，多后端可插拔。H4 拆件后本件收编：契约类型（ModelAdapter/UsageHooks）、
 *  LLMConfig、StubAdapter、OpenAIAdapter（传输+编排+effort 探测状态机+SSE 流式重组）、ScriptedAdapter
 *  脚本 DSL；effort 档位原语/usage 三提取器/wire 序列化/三档路由已下沉 effort.ts/usage.ts/wire.ts/router.ts，
 *  此处按原路径再导出（对齐 tui/runtime.ts RunOutcome 注释先例），既有 './adapter' 导入点零改动 */
import { ReasoningEffort, ChatRequest, ChatResult, ToolCallSpec} from '../types';
import { t } from '../i18n';
import { contextWindowEnv } from '../config/termination-config';
import { parseEffort, buildFallbackSequence, isUnsupportedEffortError } from './effort';
import { extractUsage, extractPromptTokens, extractCacheTokens } from './usage';
import { toWireMessages, toWireTools, parseChatResult } from './wire';

// 四件原路径再导出（防既有导入点漂移）：值符号与类型符号各自走 export / export type
export { EFFORT_ORDER, parseEffort, buildFallbackSequence, isUnsupportedEffortError } from './effort';
export { extractUsage, extractPromptTokens, extractCacheTokens } from './usage';
export { toWireMessages, toWireTools, parseChatResult } from './wire';
export { ModelRouter } from './router';
export type { RouteHint } from './router';

/** 用量回调钩子：模型调用完成后回传本次真实 token 用量（无用量回传 0） */
export interface UsageHooks {
  onUsage?: (tokens: number) => void;
  /** prompt tokens（缓存命中率分母，与 cached_tokens 同量纲；端点不回传则永不触发） */
  onPrompt?: (tokens: number) => void;
  /** prompt 缓存命中 tokens（OpenAI 标准 usage.prompt_tokens_details.cached_tokens；端点不回传则永不触发） */
  onCache?: (tokens: number) => void;
  /** 思考增量（SSE reasoning_content / reasoning 键）；端点不回传则永不触发 */
  onReasoning?: (delta: string) => void;
}

export interface ModelAdapter {
  readonly provider: string;
  /** 展示标签（banner/日志）：缺省回退 provider；openai 侧为「模型名」 */
  readonly label?: string;
  /** 该模型最大上下文 tokens（可选）：run 级窗口解析优先取此（resolveRunWindow）——多源每模型配置窗口的
   *  贯穿通道；未声明回退 SUNSHINEX_CONTEXT_WINDOW / 内置缺省 200k（单模型既有口径） */
  readonly contextWindow?: number;
  /** 能力位声明（J2）：本适配器具备哪些**真实模型**面的显式自述——「真实模型」判定不再以 provider 字符串
   *  近似。OpenAIAdapter 置 { chat: true }；Stub/Scripted 测试桩不置（桩也有 chat 方法，但不算真实模型）。
   *  消费单点：harness/context/summarizer.isModelSummarizer（模型摘要/记忆提取/整理三管线共门禁）——
   *  新增真实 provider 只要声明能力位即自动获得这些能力，静默退化消除 */
  readonly capabilities?: { chat?: boolean };
  /** function calling 轮面：消息视图进、聚合轮结果出（tool_choice auto）；effort 走 req.effort 请求级字段 */
  chat(req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult>;
  /** 流式轮面（可选）：content 增量照旧回调，轮终聚合 ChatResult；未实现者消费方回落非流式 chat */
  chatStream?(req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult>;
  /** effort 探测缓存读取（§5.2 生效档回执）：请求档经降级探测后的实际生效档；未探测回 undefined（调用方回退请求档） */
  resolvedEffort?(requested: ReasoningEffort): ReasoningEffort | undefined;
}

/** 占位适配器：不实际调用云端。轮面以 stop 收束回未接线提示，绝不回显 prompt——回显会把系统提示词经渲染层泄露到界面 */
export class StubAdapter implements ModelAdapter {
  readonly provider = 'stub';
  /** 展示标签属界面外观（banner/状态栏）→ t() 双语；错误与答复经 model-error 通道进链 → 英文单语 */
  readonly label = t('stub (no real model wired)', 'stub（未接入真实模型）');
  async chat(_req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult> {
    hooks?.onUsage?.(0); // 占位适配器无真实用量
    return {
      finish: 'stop',
      content: '[stub] no real model wired: set SUNSHINEX_API_KEY / SUNSHINEX_BASE_URL / SUNSHINEX_MODEL in ~/.sunshinex/settings.json, then retry',
      toolCalls: [],
    };
  }

  async chatStream(req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    const r = await this.chat(req, hooks);
    onDelta(r.content);
    return r;
  }
}

export interface LLMConfig {
  provider: 'openai' | 'stub' | 'scripted';
  baseURL?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** 该模型最大上下文 tokens（cfg > SUNSHINEX_CONTEXT_WINDOW > 未声明）：/model 多源每模型窗口的 cfg 通道 */
  contextWindow?: number;
  /** 缺省思考强度（SUNSHINEX_REASONING_EFFORT）：非法值忽略回缺省态（零穿参） */
  reasoningEffort?: ReasoningEffort;
}

/** OpenAI 兼容适配器：Node 内置 fetch 直连 REST API，带超时控制 */
export class OpenAIAdapter implements ModelAdapter {
  readonly provider = 'openai';
  /** banner/状态栏展示标签：纯模型名（provider 前缀已摘除，横幅与状态栏同源） */
  readonly label: string;
  /** 该模型最大上下文 tokens（cfg > env；undefined = 未配置，窗口解析回退全局链） */
  readonly contextWindow: number | undefined;
  /** 能力位（J2）：真实 chat 面在场的显式声明——isModelSummarizer 门禁据此判定，provider 字符串退役为纯标识 */
  readonly capabilities: { chat?: boolean } = { chat: true };
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private effort: ReasoningEffort | undefined;
  /** effort 探测缓存（进程内会话级）：请求档 → 端点实际生效档；换请求档自动失效按新序列重探 */
  private effortResolved?: { requested: ReasoningEffort; resolved: ReasoningEffort };
  /** 已判不支持 reasoning_effort 的档位（逐档记忆，跨请求档共享，防重复打无效请求） */
  private effortUnsupported = new Set<ReasoningEffort>();

  constructor(cfg: LLMConfig) {
    this.baseURL = cfg.baseURL ?? process.env.SUNSHINEX_BASE_URL ?? 'https://api.openai.com/v1';
    this.apiKey = cfg.apiKey ?? process.env.SUNSHINEX_API_KEY ?? '';
    this.model = cfg.model ?? process.env.SUNSHINEX_MODEL ?? 'gpt-4o-mini';
    this.label = this.model;
    this.contextWindow = cfg.contextWindow ?? contextWindowEnv();
    this.timeoutMs = cfg.timeoutMs ?? 600_000;
    this.effort = cfg.reasoningEffort ?? parseEffort(process.env.SUNSHINEX_REASONING_EFFORT);
  }

  /** 当前生效的缺省思考强度（undefined=未配置，请求零穿参） */
  resolveEffort(): ReasoningEffort | undefined {
    return this.effort;
  }

  /** 请求体发送单点（超时/中断合并/错误形态统一） */
  private doFetch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    // 外部中断 signal 与超时合并（AbortSignal.any，Node ≥20.3）：用户 Esc/Ctrl+C 即刻中止在途请求
    const merged = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
    return fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: merged,
    }).finally(() => clearTimeout(timer));
  }

  /** 非 ok 响应转错误：消息附端点响应体（截断 300 字符），供 effort 不支持识别与问题定位 */
  private async requestError(resp: Response): Promise<Error> {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch {
      // 响应体不可读时仅报状态码
    }
    return new Error(`OpenAI request failed: ${resp.status}${detail ? ` ${detail}` : ''}`);
  }

  /** effort 探测缓存读取（§5.2 生效档回执）：请求档经降级探测后的实际生效档；未探测回 undefined（调用方回退请求档） */
  resolvedEffort(requested: ReasoningEffort): ReasoningEffort | undefined {
    return this.effortResolved?.requested === requested ? this.effortResolved.resolved : undefined;
  }

  /** effort 感知发送：显式档位按降级序列逐档试探（仅参数不支持类错误降级），探测结果缓存后直发生效档；
   *  全序列不支持则省略参数用模型默认。无 effort 配置时请求体形态与旧版逐字节一致 */
  private async sendWithEffort(base: Record<string, unknown>, effort: ReasoningEffort | undefined, signal?: AbortSignal): Promise<Response> {
    if (!effort) return this.doFetch(base, signal);
    const cached = this.effortResolved?.requested === effort ? this.effortResolved.resolved : undefined;
    if (cached) return this.doFetch({ ...base, reasoning_effort: cached }, signal);
    const seq = buildFallbackSequence(effort).filter((e) => !this.effortUnsupported.has(e));
    for (const e of seq) {
      const resp = await this.doFetch({ ...base, reasoning_effort: e }, signal);
      if (resp.ok) {
        this.effortResolved = { requested: effort, resolved: e };
        return resp;
      }
      const err = await this.requestError(resp);
      if (!isUnsupportedEffortError(err)) throw err;
      this.effortUnsupported.add(e);
    }
    return this.doFetch(base, signal); // 全序列不支持：省略参数，用模型默认
  }

  /** 用量三钩子回传（cache → prompt → usage） */
  private emitUsage(data: unknown, hooks?: UsageHooks): void {
    hooks?.onCache?.(extractCacheTokens(data));
    hooks?.onPrompt?.(extractPromptTokens(data));
    hooks?.onUsage?.(extractUsage(data));
  }

  /** function calling 轮面：messages + tools 下发（tool_choice 缺省 auto），请求体不带 response_format；usage 三钩子回传与流式路同源 */
  async chat(req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult> {
    if (!this.apiKey) throw new Error('SUNSHINEX_API_KEY is not configured');
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: toWireMessages(req.messages),
        tool_choice: 'auto',
        ...(req.tools && req.tools.length > 0 ? { tools: toWireTools(req.tools) } : {}),
      };
      const resp = await this.sendWithEffort(body, req.effort ?? this.effort, req.signal);
      if (!resp.ok) throw await this.requestError(resp);
      const data = (await resp.json()) as unknown;
      const r = parseChatResult(data);
      this.emitUsage(data, hooks);
      return r;
    } catch (e) {
      if (req.signal?.aborted) throw new Error('Task interrupted');
      if (e instanceof Error && e.name === 'AbortError') throw new Error('Model call timed out');
      throw e;
    }
  }

  /** 流式轮面：content 增量照旧回调、reasoning 增量经 hooks 回传；tool_calls 增量按 index 分片聚合（乱序到达按 index 拼装、arguments 逐片拼接） */
  async chatStream(req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    if (!this.apiKey) throw new Error('SUNSHINEX_API_KEY is not configured');
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: toWireMessages(req.messages),
        stream: true,
        stream_options: { include_usage: true },
        tool_choice: 'auto',
        ...(req.tools && req.tools.length > 0 ? { tools: toWireTools(req.tools) } : {}),
      };
      const resp = await this.sendWithEffort(body, req.effort ?? this.effort, req.signal);
      if (!resp.ok || !resp.body) throw await this.requestError(resp);
      let full = '';
      let reasoningFull = ''; // 思考增量聚合（续轮回传载荷；非思考端点恒空串零穿参）
      let buffer = '';
      /** index → 聚合中的调用分片（id/name 首片带、arguments 逐片拼接） */
      const shards = new Map<number, { id?: string; name?: string; args: string }>();
      let finish: ChatResult['finish'] = 'stop';
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
              const ev = JSON.parse(data) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    reasoning?: string;
                    tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
                  };
                  finish_reason?: string;
                }>;
              };
              const choice = ev.choices?.[0];
              const d = choice?.delta;
              const reason = d?.reasoning_content ?? d?.reasoning;
              if (reason) {
                reasoningFull += reason;
                hooks?.onReasoning?.(reason);
              }
              if (d?.content) {
                full += d.content;
                onDelta(d.content);
              }
              for (const tc of d?.tool_calls ?? []) {
                const shard = shards.get(tc.index) ?? { args: '' };
                if (tc.id !== undefined) shard.id = tc.id;
                if (tc.function?.name !== undefined) shard.name = tc.function.name;
                if (tc.function?.arguments !== undefined) shard.args += tc.function.arguments;
                shards.set(tc.index, shard);
              }
              if (choice?.finish_reason === 'tool_calls') finish = 'tool_calls';
              const cached = extractCacheTokens(ev);
              if (cached > 0) hooks?.onCache?.(cached);
              const ptokens = extractPromptTokens(ev);
              if (ptokens > 0) hooks?.onPrompt?.(ptokens);
              const usage = extractUsage(ev);
              if (usage > 0) hooks?.onUsage?.(usage);
            } catch {
              // 非 JSON 的 data 行（服务端注释/心跳）忽略，不中断流
            }
          }
        }
      }
      const toolCalls: ToolCallSpec[] = [...shards.keys()].sort((a, b) => a - b).map((i) => {
        const s = shards.get(i)!;
        return { id: s.id ?? `call_${i}`, name: s.name ?? '', argsJson: s.args };
      });
      return { finish, content: full, toolCalls: finish === 'tool_calls' ? toolCalls : [], ...(reasoningFull ? { reasoning: reasoningFull } : {}) };
    } catch (e) {
      if (req.signal?.aborted) throw new Error('Task interrupted');
      if (e instanceof Error && e.name === 'AbortError') throw new Error('Model call timed out');
      throw e;
    }
  }
}

/** 脚本步骤（function calling 出牌）：toolCalls 空 = stop 收束（content 即 reply）；多调用即并行批 */
interface ScriptStep {
  /** 本轮旁白（phase 载体，可空） */
  content?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
}

const EXHAUSTED_FALLBACK = '{"done":true}';

/** 脚本字符串步（JSON 文本 DSL）→ 轮结果转译：单工具/并行/done 三形态；坏 JSON → 空批纠偏（原文随 content 供回喂可见） */
export function parseScriptStep(s: string): ChatResult {
  try {
    let parsed = JSON.parse(s) as unknown;
    // 数组畸形归一：数组包装取首元素；裸调用清单整体视为并行动作
    if (Array.isArray(parsed)) {
      const allCalls =
        parsed.length > 0 &&
        parsed.every((c) => !!c && typeof c === 'object' && typeof (c as { tool?: unknown }).tool === 'string');
      parsed = allCalls ? { tools: parsed } : parsed[0];
    }
    const j = parsed as {
      tool?: string;
      input?: unknown;
      tools?: Array<{ tool?: string; input?: Record<string, unknown> }>;
      done?: boolean;
      reply?: string;
    };
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an envelope');
    // tools 误装单工具形态（{"tool":"tools","input":[...]}）归一为并行动作
    let calls: Array<{ tool?: string; input?: Record<string, unknown> }> | undefined = Array.isArray(j.tools) ? j.tools : undefined;
    if (!calls && j.tool === 'tools' && Array.isArray(j.input)) calls = j.input as Array<{ tool?: string; input?: Record<string, unknown> }>;
    if (calls) {
      const converted = calls
        .filter((t): t is { tool: string; input?: Record<string, unknown> } => typeof t?.tool === 'string')
        .map((t, i) => ({ id: `call_${i}`, name: t.tool, argsJson: JSON.stringify(t.input ?? {}) }));
      if (converted.length > 0) return { finish: 'tool_calls', content: '', toolCalls: converted };
    }
    if (typeof j.tool === 'string' && j.tool !== 'tools') {
      return {
        finish: 'tool_calls',
        content: '',
        toolCalls: [{ id: 'call_0', name: j.tool, argsJson: JSON.stringify(j.input && typeof j.input === 'object' ? j.input : {}) }],
      };
    }
    if (j.done === true) return { finish: 'stop', content: j.reply ?? 'Done', toolCalls: [] };
  } catch {
    // 非 JSON 文本：空批纠偏
  }
  return { finish: 'tool_calls', content: s, toolCalls: [] };
}

/** 脚本化适配器：预置决策序列逐步回放（测试/离线兜底）。步骤两态：字符串（JSON 文本 DSL，经 parseScriptStep 转译）与结构化 ScriptStep */
export class ScriptedAdapter implements ModelAdapter {
  readonly provider = 'scripted';
  private i = 0;
  constructor(private steps: Array<string | ScriptStep>) {}

  private next(): string | ScriptStep {
    const s = this.steps[this.i];
    this.i = Math.min(this.i + 1, this.steps.length - 1);
    return s ?? EXHAUSTED_FALLBACK;
  }

  /** 轮面：字符串步骤经 DSL 转译（parseScriptStep 单点）；结构化步骤直接出牌；usage 记 0（脚本化回放无真实用量） */
  async chat(_req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult> {
    hooks?.onUsage?.(0);
    const s = this.next();
    if (typeof s === 'string') return parseScriptStep(s);
    if (s.toolCalls && s.toolCalls.length > 0) {
      return {
        finish: 'tool_calls',
        content: s.content ?? '',
        toolCalls: s.toolCalls.map((t, i) => ({ id: t.id ?? `call_${i}`, name: t.name, argsJson: JSON.stringify(t.args) })),
      };
    }
    return { finish: 'stop', content: s.content ?? '', toolCalls: [] };
  }

  async chatStream(_req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    const r = await this.chat(_req, hooks);
    for (const ch of r.content) onDelta(ch);
    return r;
  }
}
