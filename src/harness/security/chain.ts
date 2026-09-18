import * as fs from 'fs';
import * as path from 'path';
import { GuardDecision, SecurityGuard } from './guard';
import { ToolBackend } from '../../types';
import { resolveDataDir } from '../../config/data-dir';
import { resolveMemoryConfig } from '../../config/memory-config';
import { isMemoryPath, MemoryScope } from '../memory/paths';
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
    /** 记忆写 scope（规格 §4.2）：undefined=主链可写 memory/** 整子树；子代理 fork 传自身 agents/<id> 收窄 */
    readonly memoryScope?: MemoryScope,
  ) {
    // root 可能经符号链接传入；不存在时原样回退；归一遇异常（如权限类）同样防御性原样回退（spec 2.1 兜底条款同源，evaluate 判界层再统一兜底）
    try {
      this.rootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
    } catch {
      this.rootReal = root;
    }
  }

  evaluate(tool: string, input: unknown): GuardDecision {
    const decision = this.guard.preToolUse(tool, input);
    if (!decision.allowed) return decision;

    if (PATH_TOOLS.has(tool)) {
      const raw = typeof input === 'object' && input !== null ? (input as { path?: unknown }).path : undefined;
      return this.resolveSafe(raw, tool);
    }
    return { allowed: true };
  }

  /** 异步决策：与 evaluate 同一语义，但 guard 段走 preToolUseAsync（manual ask 标记接入终端化审批） */
  async evaluateAsync(tool: string, input: unknown): Promise<GuardDecision> {
    const decision = await this.guard.preToolUseAsync(tool, input);
    if (!decision.allowed) return decision;

    if (PATH_TOOLS.has(tool)) {
      const raw = typeof input === 'object' && input !== null ? (input as { path?: unknown }).path : undefined;
      return this.resolveSafe(raw, tool);
    }
    return { allowed: true };
  }

  /**
   * 路径归一判界：存在段 realpathSync 解析符号链接，新建段字面拼接（resolve 产物无 .. 残留）；基准 rootReal；异常按拒绝处理不放行（spec 2.1 兜底条款）。
   * 数据目录白名单（auto memory 规格 D6 + 对齐规格 §4.2）：Read/Grep 访问 dataDir 子树放行（记忆索引/主题文件按需召回；
   * Full trace 归档、tool-outputs 路径同受益）；Write 只在 <dataDir>/memory/** 放行（记忆写入窄口，总开关关闭即失效）——
   * 写面接缝与只读放行同源判界，一律作用于 realpath 归一后的真实路径：dataDir 内由模型植入的符号链接指向子树之外时被拒（不再有「写面全拒故链接无威胁」的前提）。
   */
  private resolveSafe(raw: unknown, tool: string): GuardDecision {
    try {
      const abs = path.resolve(this.root, String(raw ?? ''));
      let anchor = abs;
      while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
      const real = fs.realpathSync(anchor) + abs.slice(anchor.length);
      if (real !== this.rootReal && !real.startsWith(this.rootReal + path.sep)) {
        if (tool !== 'Write' && this.underDataDir(real)) return { allowed: true, safePath: real };
        if (tool === 'Write' && this.memoryWriteAllowed(real)) return { allowed: true, safePath: real };
        return { allowed: false, reason: `COMMAND_DENIED: 路径越出项目 root（真实路径）：${real}` };
      }
      return { allowed: true, safePath: real };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { allowed: false, reason: `COMMAND_DENIED: 路径判界失败：${msg.slice(0, 120)}` };
    }
  }

  /** 派生带记忆 scope 的克隆（子代理 fork 用）：其余依赖引用共享，仅 scope 收窄；原实例零突变 */
  withMemoryScope(scope: MemoryScope): SafetyChain {
    return new SafetyChain(this.guard, this.backend, this.dryrun, this.root, scope);
  }

  /** 记忆写入窄口（规格 §4.2）：仅 <dataDir>/memory/** 放行，且总开关开启；判定两侧同走 realpath 归一（数据目录自身含符号链接段时不再误拒合法写入），符号链接逃逸仍被拒 */
  private memoryWriteAllowed(real: string): boolean {
    if (!resolveMemoryConfig().autoMemory) return false;
    return isMemoryPath(this.dataDirReal(), real, this.memoryScope) !== null;
  }

  /**
   * 数据目录真实路径：存在段逐级 realpathSync 归一（与 rootReal 同源策略），新建段字面拼接；归一失败按字面路径兜底。
   * underDataDir（只读判界）与 memoryWriteAllowed（写窄口）共用本单点，防两处口径漂移。
   */
  private dataDirReal(): string {
    const dir = resolveDataDir(this.root);
    try {
      let anchor = dir;
      while (anchor.length > 1 && !fs.existsSync(anchor)) anchor = path.dirname(anchor);
      return fs.realpathSync(anchor) + dir.slice(anchor.length);
    } catch {
      return dir;
    }
  }

  /** 路径是否落在数据目录子树内（每次惰性求值对齐运行期求值先例，SUNSHINEX_DATA_DIR 测试可重定向） */
  private underDataDir(real: string): boolean {
    const dir = this.dataDirReal();
    return real === dir || real.startsWith(dir + path.sep);
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
