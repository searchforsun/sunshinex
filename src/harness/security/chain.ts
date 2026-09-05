import * as fs from 'fs';
import * as path from 'path';
import { GuardDecision, SecurityGuard } from './guard';
import { ToolBackend } from '../../types';
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

/** 导出给重读等链外安全通道复用同一模式集（唯一权威定义在链内） */
export function maskText(text: string): string {
  let out = text;
  for (const re of MASK_PATTERNS) out = out.replace(re, '***');
  return out;
}

/** 统一安全链：guard 守门 → 路径边界 → 后端执行 + dryrun 预览（mask 出口见 maskResult） */
export class SafetyChain {
  /** 判界基准：root 归一后真实路径（root 可能位于符号链接路径上；不存在时原样回退） */
  private readonly rootReal: string;

  constructor(
    private guard: SecurityGuard,
    readonly backend: ToolBackend,
    private dryrun: DryRun,
    private readonly root: string,
  ) {
    this.rootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
  }

  evaluate(tool: string, input: unknown): GuardDecision {
    const decision = this.guard.preToolUse(tool, input);
    if (!decision.allowed) return decision;

    if (PATH_TOOLS.has(tool)) {
      const raw = typeof input === 'object' && input !== null ? (input as { path?: unknown }).path : undefined;
      return this.resolveSafe(raw);
    }
    return { allowed: true };
  }

  /** 路径归一判界：存在段 realpathSync 解析符号链接，新建段字面拼接（resolve 产物无 .. 残留）；基准 rootReal（spec 2.1） */
  private resolveSafe(raw: unknown): GuardDecision {
    const abs = path.resolve(this.root, String(raw ?? ''));
    let anchor = abs;
    while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
    const real = fs.realpathSync(anchor) + abs.slice(anchor.length);
    if (real !== this.rootReal && !real.startsWith(this.rootReal + path.sep)) {
      return { allowed: false, reason: `COMMAND_DENIED: 路径越出项目 root（真实路径）：${real}` };
    }
    return { allowed: true, safePath: real };
  }

  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    return this.backend.exec(cmd, opts);
  }

  /** 工具结果跨链的唯一脱敏出口：stdout 与 stderr 统一过凭据模式集 */
  maskResult(_tool: string, result: ExecResult): ExecResult {
    return { ...result, stdout: maskText(result.stdout), stderr: maskText(result.stderr) };
  }

  preview(cmd: string): string {
    return maskText(this.dryrun.preview(cmd));
  }
}
