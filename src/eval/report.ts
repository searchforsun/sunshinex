/** O3 基准集报告聚合（纯函数）：单任务结果 → 汇总（完成率/干预合计/成本合计）——runner 与测试共用 */

export interface TaskRunResult {
  readonly id: string;
  /** 权威判定（脚本验盘 + run 退出面），非模型自报 */
  readonly pass: boolean;
  readonly problem?: string;
  readonly status?: string;
  readonly iterations?: number;
  readonly tokensUsed?: number;
  readonly durationMs: number;
  readonly approvals: number;
  readonly asks: number;
}

export interface BenchReport {
  readonly total: number;
  readonly passed: number;
  /** 完成率（0-1，两位小数截断） */
  readonly passRate: number;
  readonly tokensUsed: number;
  readonly approvals: number;
  readonly asks: number;
  readonly durationMs: number;
  readonly tasks: readonly TaskRunResult[];
}

export function aggregate(results: readonly TaskRunResult[]): BenchReport {
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  return {
    total,
    passed,
    passRate: total === 0 ? 0 : Math.round((passed / total) * 100) / 100,
    tokensUsed: results.reduce((a, r) => a + (r.tokensUsed ?? 0), 0),
    approvals: results.reduce((a, r) => a + r.approvals, 0),
    asks: results.reduce((a, r) => a + r.asks, 0),
    durationMs: results.reduce((a, r) => a + r.durationMs, 0),
    tasks: results,
  };
}
