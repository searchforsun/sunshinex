/**
 * 长任务终止参数解析单点（规格 §3.3）：env 槽 > 内置缺省（消费点 `??` 兜底）。
 * 口径沿 memory-config positiveInt：未设/空串回 undefined；非正整数 fail-fast 抛错带槽名——
 * 配置错误显式暴露，不静默吞。环境变量运行期不变，消费点 run/assemble 内解析一次
 * （对齐 CONTEXT_WINDOW / STRUCTURED_OUTPUT 先例）。
 */
function positiveIntOrUndefined(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${key}: ${raw} (expect positive integer)`);
  }
  return n;
}

/** Reactor 单 run 步数上限（缺省 400，见 src/harness/reactor.ts） */
export function reactorMaxStepsEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_STEPS');
}

/** Loop 修正环节点执行步上限（缺省 200，见 src/loop/templates.ts） */
export function loopIterationsEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_LOOP_ITERATIONS');
}

/** Graph 全链路节点步累计上限（缺省 1000，见 src/graph/templates.ts） */
export function graphNodesEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_GRAPH_NODES');
}

/** 上下文窗口缺省 tokens（200k，对标长上下文安全水位）；预算基线与观测面（状态栏分母、/context）共用单点 */
export const CONTEXT_WINDOW_DEFAULT = 200_000;

/** 上下文窗口 tokens（缺省 200k，见 src/harness/reactor.ts：状态栏「上下文占用」分母与压缩占比共用基准） */
export function contextWindowEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_CONTEXT_WINDOW');
}

/** 上下文窗口解析定值（env 覆盖 > 缺省 200k）：Reactor 预算与 /context 观测面同源取值，防两处 `?? 200_000` 漂移 */
export function contextWindowTokens(env: NodeJS.ProcessEnv = process.env): number {
  return contextWindowEnv(env) ?? CONTEXT_WINDOW_DEFAULT;
}

/** 主链单 run token 硬上限（缺省不设——护栏只靠步数/墙钟，预算是兜底不是限制；见 src/loop/nodes.ts agentNode） */
export function mainTokenCapEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_TOKENS');
}

/** 子代理 token 硬上限（缺省不设，与父级剩余解耦——spawn/graph 两通道同口径；见 src/harness/reactor.ts spawn 预算源） */
export function subagentTokenCapEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_SUBAGENT_TOKEN_CAP');
}
