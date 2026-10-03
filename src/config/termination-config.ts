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

/** run 级窗口解析（当前模型窗口 > env > 缺省 200k）：适配器自带 contextWindow（/model 多源每模型配置，
 *  ModelAdapter 可选成员）优先——预算与观测分母随当前生效模型走；结构化参数避免 config→model 反向依赖。
 *  非法值（≤0/非有限数）视同未配置回退链（providers 解析面已告警拦截，此处只做防御） */
export function resolveRunWindow(adapter?: { contextWindow?: number }): number {
  const w = adapter?.contextWindow;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : contextWindowTokens();
}

/** 主链单 run token 硬上限（缺省不设——护栏只靠步数/墙钟，预算是兜底不是限制；见 src/loop/nodes.ts agentNode） */
export function mainTokenCapEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_MAX_TOKENS');
}

/** 子代理 token 硬上限（缺省不设，与父级剩余解耦——spawn/graph 两通道同口径；见 src/harness/reactor.ts spawn 预算源） */
export function subagentTokenCapEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveIntOrUndefined(env, 'SUNSHINEX_SUBAGENT_TOKEN_CAP');
}

/** 模型调用超时 env 解析（J9b 迁入，2026-10-04 归口 termination-config——超时旋钮单点，先例 contextWindowEnv；
 *  对齐 CLAUDE §12「模型调用超时 600s」的可调口径）：SUNSHINEX_MODEL_TIMEOUT_MS 正整数生效，
 * 未设/空串/非正整数静默忽略回适配器内建 600s。**刻意不并入本文件 positiveIntOrUndefined 的
 * fail-fast 口径**（批F 裁决：装配根不打断启动，与 runtime.ts resolveEffortConfig 对非法 env 同宽；
 * 消费点为 runtime.buildModel/buildTierRouter 与 model/catalog（/model 切换路径），装配期解析一次） */
export function modelTimeoutMsEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.SUNSHINEX_MODEL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
