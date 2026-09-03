import { SubAgent } from './agents';

/** Graph 节点 */
export interface GraphNode {
  id: string;
  run(): Promise<void> | void;
  deps: string[];
}

/** Graph 引擎：DAG 拓扑执行（无环校验 + 串行/并行编排占位） */
export class GraphEngine {
  private nodes = new Map<string, GraphNode>();
  private agents = new Map<string, SubAgent>();

  addNode(node: GraphNode): this {
    this.nodes.set(node.id, node);
    return this;
  }

  registerAgent(agent: SubAgent): this {
    this.agents.set(agent.role, agent);
    return this;
  }

  /** 简单拓扑排序；检测到环则抛错 */
  topo(): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`cycle detected at node ${id}`);
      visiting.add(id);
      const node = this.nodes.get(id);
      for (const d of node?.deps ?? []) visit(d);
      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };
    for (const id of this.nodes.keys()) visit(id);
    return order;
  }

  async run(): Promise<void> {
    for (const id of this.topo()) {
      await this.nodes.get(id)!.run();
    }
  }
}
