import { ContextItem, ExecResult } from '../types';
import { Result } from '../result';
import { ModelAdapter } from '../model/adapter';
import { ToolRegistry } from './tools';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';

export interface Task { goal: string; }
export interface StepRecord { step: number; action?: string; observation: string; }
export interface RunResult { steps: StepRecord[]; done: boolean; reply?: string; }

export interface ReactorDeps {
  registry: ToolRegistry;
  safety: SafetyChain;
  context: ContextManager;
  model: ModelAdapter;
}

interface Action { tool?: string; input?: Record<string, unknown>; done: boolean; reply?: string; }

type ParseResult =
  | { ok: true; action: Action }
  | { ok: false; raw: string };

/** 最小 Reactor：observe → think → act → observe 线性循环 */
export class Reactor {
  constructor(private deps: ReactorDeps) {}

  async run(task: Task, opts?: { maxSteps?: number }): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? 8;
    const steps: StepRecord[] = [];
    let done = false;
    let reply: string | undefined;

    for (let step = 1; step <= maxSteps; step++) {
      // observe: 上下文统一装配 + 压缩稳定性检查
      const items = this.deps.context.assemble(task.goal, this.toHistory(steps));
      const est = this.deps.context.window.estimate(items);
      if (this.deps.context.window.shouldCompact({ total: 200_000, used: est.used, reserve: 40_000 })) {
        const chunks = await this.deps.context.window.compact(items);
        this.deps.context.window.verifyChecksum(chunks);
      }

      // think: 经 ModelAdapter 决策（带动作协议 prompt）
      let raw: string;
      try {
        raw = await this.deps.model.complete(this.buildPrompt(items));
      } catch (e) {
        reply = e instanceof Error ? e.message : '模型调用失败';
        break;
      }

      const parsed = this.parse(raw);
      if (!parsed.ok) {
        // 模型未按 JSON 输出：把原文回填为观察，给模型一次自我纠正机会
        steps.push({ step, observation: `模型输出非 JSON（截断）：${raw.slice(0, 400)}` });
        this.deps.context.memory.record('project', `step ${step}: 模型输出未解析`);
        continue;
      }

      const action = parsed.action;
      if (action.done) {
        done = true;
        reply = action.reply ?? '完成';
        break;
      }

      if (!action.tool) {
        steps.push({ step, observation: '动作缺少 tool 字段' });
        this.deps.context.memory.record('project', `step ${step}: 动作缺 tool`);
        continue;
      }

      // act: 经安全链执行
      const r = await this.deps.registry.execute(action.tool, action.input ?? {}, this.deps.safety);
      const observation = this.describe(r);
      steps.push({ step, action: action.tool, observation });
      // observe: 写回记忆
      this.deps.context.memory.record('project', `step ${step}: ${observation}`);
    }

    return { steps, done, reply };
  }

  private buildPrompt(items: ContextItem[]): string {
    const tools = this.deps.registry.list().map((t) => `- ${t.name}: ${t.description}`).join('\n');
    const contextText = items.map((i) => i.content).join('\n');
    return [
      '你是 SunshineX 智能体，通过调用工具完成任务。',
      '可用工具：',
      tools,
      '',
      '每次只回复一个 JSON 对象，不要输出任何其它文字。格式二选一：',
      '1) 调用工具：{"tool":"<工具名>","input":{...},"done":false}',
      '2) 任务完成：{"done":true,"reply":"<最终答复>"}',
      '',
      '上下文：',
      contextText,
    ].join('\n');
  }

  private toHistory(steps: StepRecord[]): ContextItem[] {
    return steps.map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` }));
  }

  private parse(raw: string): ParseResult {
    try {
      const j = JSON.parse(raw) as Action;
      return { ok: true, action: { tool: j.tool, input: j.input, done: j.done === true, reply: j.reply } };
    } catch {
      return { ok: false, raw };
    }
  }

  private describe(r: Result<ExecResult>): string {
    if (r.ok) {
      const out = r.value.stdout || r.value.stderr || 'ok';
      return out.length > 2000 ? `${out.slice(0, 2000)}\n...(截断)` : out;
    }
    return r.error.message.startsWith(r.error.code) ? r.error.message : `${r.error.code}: ${r.error.message}`;
  }
}
