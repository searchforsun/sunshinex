import * as path from 'path';
import { GuardDecision, SecurityGuard } from './guard';
import { Sandbox } from './sandbox';
import { DryRun } from './dryrun';
import { ExecResult } from '../../types';
import { Result } from '../../result';

/** 需要路径边界校验的工具（安全链规范名） */
const PATH_TOOLS = new Set(['Read', 'Write', 'Grep']);

/** 统一安全链：guard 守门 → 路径边界 → sandbox 执行 + dryrun 预览（mask 出口见 maskResult） */
export class SafetyChain {
  constructor(
    private guard: SecurityGuard,
    private sandbox: Sandbox,
    private dryrun: DryRun,
    private readonly root: string,
  ) {}

  evaluate(tool: string, input: unknown): GuardDecision {
    const decision = this.guard.preToolUse(tool, input);
    if (!decision.allowed) return decision;

    if (PATH_TOOLS.has(tool)) {
      const raw = typeof input === 'object' && input !== null ? (input as { path?: unknown }).path : undefined;
      const abs = path.resolve(this.root, String(raw ?? ''));
      if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
        return { allowed: false, reason: `COMMAND_DENIED: 路径越出项目 root：${abs}` };
      }
      return { allowed: true, safePath: abs };
    }
    return { allowed: true };
  }

  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    return this.sandbox.run(cmd, opts);
  }

  preview(cmd: string): string {
    return this.dryrun.preview(cmd);
  }
}
