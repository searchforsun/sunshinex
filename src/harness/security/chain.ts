import * as path from 'path';
import { GuardDecision, SecurityGuard } from './guard';
import { Sandbox } from './sandbox';
import { DryRun } from './dryrun';
import { ExecResult } from '../../types';
import { Result } from '../../result';

/** 需要路径边界校验的工具（安全链规范名） */
const PATH_TOOLS = new Set(['Read', 'Write', 'Grep']);

/** 内置凭据模式集：命中替换为 ***（零依赖；spec 2.3 逐字清单） */
const MASK_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /"(api[_-]?key|secret|token|password)"\s*:\s*"[^"]+"/gi,
  /(?:api[_-]?key|secret|token|password)\s*[=:]\s*\S+/gi,
];

function maskText(text: string): string {
  let out = text;
  for (const re of MASK_PATTERNS) out = out.replace(re, '***');
  return out;
}

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

  /** 工具结果跨链的唯一脱敏出口：stdout 与 stderr 统一过凭据模式集 */
  maskResult(_tool: string, result: ExecResult): ExecResult {
    return { ...result, stdout: maskText(result.stdout), stderr: maskText(result.stderr) };
  }

  preview(cmd: string): string {
    return maskText(this.dryrun.preview(cmd));
  }
}
