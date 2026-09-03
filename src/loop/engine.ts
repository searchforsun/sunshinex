import { LoopContext, LoopNodeKind, LoopResult } from '../types';

/** Loop 单节点 */
export interface LoopNode {
  kind: LoopNodeKind;
  run(ctx: LoopContext): LoopResult;
}

/** Loop 引擎：agent → check → gate → router 的生成-校验-修正闭环 */
export class LoopEngine {
  private nodes: LoopNode[] = [];
  private budget = 0;

  constructor(
    private maxIterations = 10,
    private maxTokens = 100_000,
  ) {}

  push(node: LoopNode): this {
    this.nodes.push(node);
    return this;
  }

  run(ctx: LoopContext): { result: LoopResult; iterations: number } {
    while (ctx.iteration < this.maxIterations && this.budget < this.maxTokens) {
      ctx.iteration += 1;
      for (const node of this.nodes) {
        const r = node.run(ctx);
        this.budget += 1; // 单节点计费占位
        if (r === 'done' || r === 'retry') {
          return { result: r, iterations: ctx.iteration };
        }
        if (r === 'fail') {
          return { result: 'fail', iterations: ctx.iteration };
        }
      }
    }
    return { result: 'fail', iterations: ctx.iteration };
  }
}
