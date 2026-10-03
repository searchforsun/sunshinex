import type {
  GraphContext,
  GraphDeps,
  GraphNodeKind,
  GraphNodeOutput,
  GraphRunResult,
  GraphTermination,
  StopReason,
} from '../types';
import { guardrailStop, describeGuardrailHit } from '../harness/guardrail';
import { t } from '../i18n';

export type { GraphDeps, GraphTermination };

/** Graph 节点：DAG 调度单元，执行体复用 Loop/Reactor/Harness 既有通道（graph 不自建执行路径） */
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  deps: string[];
  run: (
    ctx: GraphContext,
    deps: GraphDeps,
    inputs: Record<string, GraphNodeOutput>,
  ) => Promise<GraphNodeOutput> | GraphNodeOutput;
}

export interface GraphHooks {
  onNodeEnd?: (node: GraphNode, output: GraphNodeOutput) => void;
}

/** Graph 引擎：Kahn 分层并发调度 + 数据流 + 错误局部化 + 超时/预算/步数边界 + 断点续跑 */
export class GraphEngine {
  private nodes = new Map<string, GraphNode>();
  private completed = new Set<string>();
  private ctx: GraphContext | null = null;
  private steps = 0;
  private term: GraphTermination;

  constructor(
    nodes: GraphNode[],
    private deps: GraphDeps,
    termination: GraphTermination,
    private hooks?: GraphHooks,
  ) {
    for (const n of nodes) this.nodes.set(n.id, n);
    this.term = { ...termination };
  }

  /** Kahn 分层：同层可并发；分层后余量节点即环成员及其下游，抛错含清单 */
  layers(): string[][] {
    const indeg = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of this.nodes.keys()) {
      indeg.set(id, 0);
      dependents.set(id, []);
    }
    for (const n of this.nodes.values()) {
      for (const d of n.deps) {
        if (!indeg.has(d)) throw new Error(`Dependency references a missing node: ${d}`);
        indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
        dependents.get(d)!.push(n.id);
      }
    }
    let frontier = [...this.nodes.keys()].filter((id) => indeg.get(id) === 0);
    const out: string[][] = [];
    let placed = 0;
    while (frontier.length > 0) {
      out.push(frontier);
      placed += frontier.length;
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of dependents.get(id)!) {
          indeg.set(dep, (indeg.get(dep) ?? 1) - 1);
          if (indeg.get(dep) === 0) next.push(dep);
        }
      }
      frontier = next;
    }
    if (placed < this.nodes.size) {
      const cycle = [...this.nodes.keys()].filter((id) => (indeg.get(id) ?? 0) > 0);
      throw new Error(`Workflow has a cycle; nodes not layered (cycle members and downstream): ${cycle.join(' -> ')}`);
    }
    return out;
  }

  async run(goal: string, opts: { state?: Record<string, unknown> } = {}): Promise<GraphRunResult> {
    if (!this.ctx) {
      this.ctx = { state: { goal, ...(opts.state ?? {}) }, tokensUsed: 0, startedAt: Date.now(), results: {}, termination: this.term };
      this.completed.clear();
      this.steps = 0;
    } else if (opts.state) {
      Object.assign(this.ctx.state, opts.state);
    }
    return this.walk(this.layers());
  }

  /** 断点续跑：审批合入 + 可调预算；已 pass 节点幂等跳过 */
  async resume(
    approvals?: Record<string, boolean>,
    opts: { budget?: Partial<GraphTermination> } = {},
  ): Promise<GraphRunResult> {
    if (!this.ctx) throw new Error('No checkpoint available to resume');
    if (approvals) {
      this.ctx.state.approvals = {
        ...((this.ctx.state.approvals as Record<string, boolean>) ?? {}),
        ...approvals,
      };
    }
    if (opts.budget) {
      this.term = { ...this.term, ...opts.budget };
      if (this.ctx) this.ctx.termination = this.term;
    }
    return this.walk(this.layers());
  }

  private async walk(layers: string[][]): Promise<GraphRunResult> {
    const ctx = this.ctx!;
    const failed = new Set<string>();
    for (const layer of layers) {
      const runnable: GraphNode[] = [];
      for (const id of layer) {
        if (this.completed.has(id)) continue;
        const node = this.nodes.get(id)!;
        // 错误局部化：上游 failed → skipped；上游 paused → 阻塞（暂停传播，resume 后续跑）
        if (node.deps.some((d) => failed.has(d) || ctx.results[d]?.status === 'skipped' || ctx.results[d]?.status === 'paused')) {
          ctx.results[id] = { nodeId: id, status: 'skipped', tokens: 0 };
          continue;
        }
        runnable.push(node);
      }
      if (runnable.length === 0) continue;
      // 边界三查（层边界）：统一判定函数，顺序 超时 → 预算 → 步数（D7 时间优先；并发层内不做中途打断）
      const hit = guardrailStop({
        now: Date.now(),
        deadlineAt: ctx.startedAt + this.term.timeoutMs,
        tokensUsed: ctx.tokensUsed,
        tokenCap: this.term.maxTokens,
        iteration: this.steps,
        maxIterations: this.term.maxNodes,
      });
      // 状态映射与文案单点（describeGuardrailHit）：与 loop 引擎共用——文案已分叉（此处旧超时消息
      // 多个 over、budget 无明细、步数措辞另一套），收单点后两引擎同类错误提示恒一致
      if (hit) {
        const m = describeGuardrailHit(hit, {
          timeoutMs: this.term.timeoutMs,
          maxTokens: this.term.maxTokens,
          maxIterations: this.term.maxNodes,
          tokensUsed: ctx.tokensUsed,
        });
        return this.finish(m.status, m.error, { stopReason: hit });
      }
      await Promise.allSettled(
        runnable.map(async (node) => {
          const inputs: Record<string, GraphNodeOutput> = {};
          for (const d of node.deps) {
            const r = ctx.results[d];
            if (r) inputs[d] = r;
          }
          try {
            const o = await node.run(ctx, this.deps, inputs);
            const output: GraphNodeOutput = { ...o, nodeId: node.id };
            ctx.results[node.id] = output;
            ctx.tokensUsed += output.tokens;
            this.steps += 1;
            if (output.status === 'pass') this.completed.add(node.id);
            else if (output.status === 'failed') failed.add(node.id);
            this.hooks?.onNodeEnd?.(node, output);
          } catch (e) {
            const output: GraphNodeOutput = {
              nodeId: node.id,
              status: 'failed',
              reply: e instanceof Error ? e.message : String(e),
              tokens: 0,
            };
            ctx.results[node.id] = output;
            this.steps += 1;
            failed.add(node.id);
            this.hooks?.onNodeEnd?.(node, output);
          }
        }),
      );
    }
    return this.collect();
  }

  private collect(): GraphRunResult {
    const ctx = this.ctx!;
    const all = Object.values(ctx.results);
    const pausedGates = all.filter((r) => r.status === 'paused').map((r) => r.nodeId);
    if (pausedGates.length > 0)
      return this.finish('paused', t('Waiting for human approval: ' + pausedGates.join(', '), '等待人工审批：' + pausedGates.join(', ')), { pendingGates: pausedGates });
    const failedNodes = all.filter((r) => r.status === 'failed').map((r) => r.nodeId);
    if (failedNodes.length > 0)
      return this.finish('failed', t('Failed nodes: ' + failedNodes.join(', '), '存在失败节点：' + failedNodes.join(', ')), { failedNodes });
    return this.finish('done', t('All nodes completed', '全部节点完成'), { stopReason: 'done' });
  }

  private finish(
    status: GraphRunResult['status'],
    reply: string,
    opts: { pendingGates?: string[]; failedNodes?: string[]; stopReason?: StopReason } = {},
  ): GraphRunResult {
    const ctx = this.ctx!;
    const pendingGates = opts.pendingGates ?? [];
    const failed =
      opts.failedNodes ?? Object.values(ctx.results).filter((r) => r.status === 'failed').map((r) => r.nodeId);
    return {
      status,
      iterations: this.steps,
      tokensUsed: ctx.tokensUsed,
      failedNodes: failed,
      pendingGates,
      reply,
      results: ctx.results,
      ...(opts.stopReason !== undefined ? { stopReason: opts.stopReason } : {}),
    };
  }
}
