import { CriterionResult, GraphContext, GraphNodeOutput, LoopContext, LoopTermination } from '../types';
import { GraphNode } from './engine';
import { SPAWN_TOOL_NAME } from '../harness/subagent';
import { codeRefactorTemplate, codeReviewTemplate, testLoopTemplate } from '../loop/templates';
import { toReactorBudget } from '../loop/nodes';
import { Reactor } from '../harness/reactor';
import { t } from '../i18n';

/** 规则校验器：对内嵌 Loop 的验收项做进程内判定（io.ctx 为 Loop 子流程上下文） */
export type RuleChecker = (io: { ctx: LoopContext; goal: string }) => Promise<boolean> | boolean;

/** loop 节点配置：内嵌三模板之一的 Loop 子流程（预算贯通：Graph remaining → Loop maxTokens） */
export interface LoopNodeConfig {
  template: 'test-loop' | 'code-refactor' | 'code-review';
  /** 子流程目标（须含「验收标准：id=描述」段——check 依赖结构化验收清单，缺省回退 ctx.state.goal） */
  goal?: string;
  ruleCheckers?: Record<string, RuleChecker>;
  /** 子流程终止参数覆盖（如修正环轮数 maxIterations；缺省沿用模板默认） */
  termination?: Partial<LoopTermination>;
  deps?: string[];
}

/** 内嵌 Loop 子流程的 Graph 节点（ROADMAP 验收点：Loop 子流程可嵌入 Graph 节点） */
export function makeLoopNode(id: string, config: LoopNodeConfig): GraphNode {
  return {
    id,
    kind: 'loop',
    deps: config.deps ?? [],
    run: async (ctx, deps) => {
      const remaining = Math.max(0, ctx.termination.maxTokens - ctx.tokensUsed);
      const factory = {
        'test-loop': testLoopTemplate,
        'code-refactor': codeRefactorTemplate,
        'code-review': codeReviewTemplate,
      }[config.template];
      // fork 化：内嵌 Loop 以 fork 作用域私有执行（零主链回写），种子 = 主链快照 + 节点任务行
      const taskText = config.goal ?? String(ctx.state.goal ?? '');
      const base = deps.context.chainView();
      const seedHistory = [
        ...base,
        {
          step: (base.length > 0 ? base[base.length - 1].step : 0) + 1,
          action: 'task',
          observation: `Current instruction: ${taskText}`,
        },
      ];
      const tpl = factory(
        // fork 私有面收口（「spawn 只在主链工具面」全局不变量）：内嵌 Loop 子面剔除 spawn
        { ...deps, registry: deps.registry.derive({ exclude: [SPAWN_TOOL_NAME] }), scope: 'fork' as const },
        {
          ruleCheckers: config.ruleCheckers,
          termination: { maxTokens: remaining, ...(config.termination ?? {}) },
        },
      );
      const r = await tpl.engine.run(taskText, { state: { seedHistory } });
      // 子代理返回制：私有步骤不回主链，终态仅回写一行结论/补丁（下游 fork 经主链快照天然可见）
      if (r.status === 'done' && r.reply) {
        deps.context.appendChain([{ action: 'node', observation: `${id}: ${r.reply}` }]);
      } else {
        deps.context.appendChain([{ action: 'note', observation: `${id}: loop node did not finish (${r.status})` }]);
      }
      const status: GraphNodeOutput['status'] =
        r.status === 'done' ? 'pass' : r.status === 'paused' ? 'paused' : 'failed';
      const criteria = r.criteria as CriterionResult[] | undefined;
      return {
        nodeId: id,
        status,
        reply: r.reply,
        tokens: r.tokensUsed,
        ...(criteria ? { criteria } : {}),
      };
    },
  };
}

/** 人工审批节点配置 */
export interface GateNodeConfig {
  prompt?: string;
  deps?: string[];
}

/** 人工审批节点：未审批 paused（挂起待 resume），approve→pass，reject→failed */
export function makeGateNode(id: string, config: GateNodeConfig = {}): GraphNode {
  const label = config.prompt ?? id;
  return {
    id,
    kind: 'gate',
    deps: config.deps ?? [],
    run: async (ctx) => {
      const approvals = ctx.state.approvals as Record<string, boolean> | undefined;
      if (approvals?.[id] === true) {
        return { nodeId: id, status: 'pass', reply: t('Approval granted: ' + label, '审批通过：' + label), tokens: 0 };
      }
      if (approvals?.[id] === false) {
        return { nodeId: id, status: 'failed', reply: t('Approval rejected: ' + label, '审批拒绝：' + label), tokens: 0 };
      }
      return { nodeId: id, status: 'paused', reply: t('Waiting for approval: ' + label, '等待人工审批：' + label), tokens: 0 };
    },
  };
}

/** CI/CD 节点配置：命令注入（真实云端触发由用户配置命令承载，平台 API 集成不做——spec §6 边界） */
export interface CiNodeConfig {
  command: string;
  deps?: string[];
}

/** CI/CD 节点：经 registry+SafetyChain 执行注入命令（零旁路），exit 0 → pass */
export function makeCiNode(id: string, config: CiNodeConfig): GraphNode {
  return {
    id,
    kind: 'ci',
    deps: config.deps ?? [],
    run: async (ctx, deps) => {
      if (ctx.state.__dryRun === true) {
        return { nodeId: id, status: 'pass', reply: t('[dry-run] will run: ' + config.command, '[dry-run] 将执行: ' + config.command), tokens: 0 };
      }
      const r = await deps.registry.execute('exec', { command: config.command }, deps.safety);
      if (r.ok && r.value.exitCode === 0) {
        const tail = (r.value.stdout || t('(no output)', '（无输出）')).slice(-200);
        return { nodeId: id, status: 'pass', reply: t('CI passed: ' + tail, 'CI 通过：' + tail), tokens: 0 };
      }
      const detail = r.ok
        ? `exit ${r.value.exitCode}：${(r.value.stderr || r.value.stdout || t('(no output)', '（无输出）')).slice(-200)}`
        : typeof r.error === 'string'
          ? r.error
          : JSON.stringify(r.error);
      return { nodeId: id, status: 'failed', reply: t('CI failed: ' + detail, 'CI 失败：' + detail), tokens: 0 };
    },
  };
}
