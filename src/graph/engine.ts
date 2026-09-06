import type {
  GraphContext,
  GraphDeps,
  GraphNodeKind,
  GraphNodeOutput,
  GraphRunResult,
  GraphTermination,
} from '../types';

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

/** Graph 引擎：Kahn 分层并发调度 + 数据流 + 错误局部化 + 预算/超时/步数边界 + 断点续跑 */
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
        if (!indeg.has(d)) throw new Error(`依赖引用不存在的节点：${d}`);
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
      throw new Error(`工作流含环，未入层节点（环成员及其下游）：${cycle.join(' -> ')}`);
    }
    return out;
  }

  /** 拓扑扁平序（兼容保留） */
  topo(): string[] {
    return this.layers().flat();
  }

  async run(goal: string, opts: { dryRun?: boolean; state?: Record<string, unknown> } = {}): Promise<GraphRunResult> {
    if (!this.ctx) {
      this.ctx = { state: { goal, ...(opts.state ?? {}) }, tokensUsed: 0, startedAt: Date.now(), results: {}, termination: this.term };
      this.completed.clear();
      this.steps = 0;
    } else if (opts.state) {
      Object.assign(this.ctx.state, opts.state);
    }
    if (opts.dryRun) this.ctx.state.__dryRun = true;
    return this.walk(this.layers());
  }

  /** 断点续跑：审批合入 + 可调预算；已 pass 节点幂等跳过 */
  async resume(
    approvals?: Record<string, boolean>,
    opts: { budget?: Partial<GraphTermination> } = {},
  ): Promise<GraphRunResult> {
    if (!this.ctx) throw new Error('尚未运行，无断点可续');
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
        if (ctx.state.__dryRun === true) {
          const preview: GraphNodeOutput = { nodeId: id, status: 'pass', reply: `[dry-run] 预览: ${id}(${node.kind})`, tokens: 0 };
          ctx.results[id] = preview;
          this.completed.add(id);
          continue;
        }
        runnable.push(node);
      }
      if (runnable.length === 0) continue;
      // 边界三查（层边界；顺序固定：预算 → 超时 → 步数；并发层内不做中途打断）
      if (ctx.tokensUsed >= this.term.maxTokens) return this.finish('paused', 'Token 预算超支，已暂停');
      if (Date.now() - ctx.startedAt > this.term.timeoutMs) return this.finish('failed', `执行超时（超过 ${this.term.timeoutMs}ms）`);
      if (this.steps >= this.term.maxNodes) return this.finish('failed', `节点步数耗尽（maxNodes=${this.term.maxNodes}）`);
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
    if (pausedGates.length > 0) return this.finish('paused', `等待人工审批：${pausedGates.join(', ')}`, pausedGates);
    const failedNodes = all.filter((r) => r.status === 'failed').map((r) => r.nodeId);
    if (failedNodes.length > 0) return this.finish('failed', `存在失败节点：${failedNodes.join(', ')}`, [], failedNodes);
    return this.finish('done', '全部节点完成');
  }

  private finish(
    status: GraphRunResult['status'],
    reply: string,
    pendingGates: string[] = [],
    failedNodes?: string[],
  ): GraphRunResult {
    const ctx = this.ctx!;
    const failed = failedNodes ?? Object.values(ctx.results).filter((r) => r.status === 'failed').map((r) => r.nodeId);
    return {
      status,
      iterations: this.steps,
      tokensUsed: ctx.tokensUsed,
      failedNodes: failed,
      pendingGates,
      reply,
      results: ctx.results,
    };
  }
}
