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
