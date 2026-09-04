import { GuardDecision, SecurityGuard } from './guard';
import { Sandbox } from './sandbox';
import { DryRun } from './dryrun';
import { ExecResult } from '../../types';
import { Result } from '../../result';

/** 统一安全链：guard 守门 + sandbox 执行 + dryrun 预览（mask/越界校验留待 1B） */
export class SafetyChain {
  constructor(
    private guard: SecurityGuard,
    private sandbox: Sandbox,
    private dryrun: DryRun,
  ) {}

  evaluate(tool: string, input: unknown): GuardDecision {
    return this.guard.preToolUse(tool, input);
  }

  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    return this.sandbox.run(cmd, opts);
  }

  preview(cmd: string): string {
    return this.dryrun.preview(cmd);
  }
}
