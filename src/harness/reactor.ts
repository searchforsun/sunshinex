import { ContextItem, ExecResult } from '../types';
import { Result } from '../result';
import { ModelAdapter } from '../model/adapter';
import { ToolRegistry } from './tools';
import { SecurityGuard } from './security/guard';
import { Sandbox } from './security/sandbox';
import { ContextManager } from './context';

export interface Task { goal: string; }
export interface StepRecord { step: number; action?: string; observation: string; }
export interface RunResult { steps: StepRecord[]; done: boolean; reply?: string; }

export interface ReactorDeps {
  registry: ToolRegistry;
  guard: SecurityGuard;
  sandbox: Sandbox;
  context: ContextManager;
  model: ModelAdapter;
}

interface Action { tool?: string; input?: Record<string, unknown>; done: boolean; }

/** 最小 Reactor：observe → think → act → observe 线性循环 */
export class Reactor {
  constructor(private deps: ReactorDeps) {}

  async run(task: Task, opts?: { maxSteps?: number }): Promise<RunResult> {
    const maxSteps = opts?.maxSteps ?? 8;
    const steps: StepRecord[] = [];
    let done = false;
    let reply: string | undefined;

    for (let step = 1; step <= maxSteps; step++) {
      // observe: 装配上下文（阶段一：直接注入任务与历史轨迹）
      let history = this.assemble(task, steps);

      // 压缩稳定性集成：observe 后检查预算，必要时压缩并重注入（对齐 spec 9.3）
      const est = this.deps.context.window.estimate(history);
      if (this.deps.context.window.shouldCompact({ total: 200_000, used: est.used, reserve: 40_000 })) {
        const chunks = await this.deps.context.window.compact(history);
        if (!this.deps.context.window.verifyChecksum(chunks)) {
          history = [
            { kind: 'instruction' as const, content: task.goal },
            ...this.deps.context.window.reinject(),
          ];
        }
      }

      // think: 经 ModelAdapter 决策
      let action: Action;
      try {
        const raw = await this.deps.model.complete(JSON.stringify({ goal: task.goal, history }));
        action = this.parse(raw);
      } catch (e) {
        action = { done: true };
        reply = e instanceof Error ? e.message : '模型调用失败';
      }

      if (action.done) { done = true; reply = reply ?? '完成'; break; }

      // act: 经安全链执行
      let observation: string;
      if (!action.tool) { observation = '无动作'; }
      else {
        const r = await this.deps.registry.execute(action.tool, action.input ?? {}, this.deps.guard, this.deps.sandbox);
        observation = this.describe(r);
      }

      steps.push({ step, action: action.tool, observation });
      // observe: 写回记忆
      this.deps.context.memory.record('project', `step ${step}: ${observation}`);
    }

    return { steps, done, reply };
  }

  private assemble(task: Task, steps: StepRecord[]): ContextItem[] {
    return [
      { kind: 'instruction', content: task.goal },
      ...steps.map((s) => ({ kind: 'history' as const, content: `${s.step}: ${s.action ?? ''} -> ${s.observation}` })),
    ];
  }

  private parse(raw: string): Action {
    try {
      const j = JSON.parse(raw) as Action;
      return { tool: j.tool, input: j.input, done: j.done === true };
    } catch {
      return { done: true };
    }
  }

  private describe(r: Result<ExecResult>): string {
    if (r.ok) return r.value.stdout || 'ok';
    return `${r.error.code}: ${r.error.message}`;
  }
}
