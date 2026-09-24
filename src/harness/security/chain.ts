import * as fs from 'fs';
import * as path from 'path';
import { GuardDecision, SecurityGuard } from './guard';
import { ExecOpts, ExecResult, ToolBackend } from '../../types';
import { dataDirReal } from '../../config/data-dir';
import { userConfigDir } from '../../config/env';
import { loadGlobalSettings, loadProjectSettings } from '../../config/settings';
import { resolveMemoryConfig } from '../../config/memory-config';
import { isMemoryPath, MemoryScope } from '../memory/paths';
import { isWithin } from '../../paths';
import { DryRun } from './dryrun';
import { Result, fail } from '../../result';

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
  /** 判界基准：root 归一后真实路径（root 可能位于符号链接路径上；不存在时原样回退）。
   *  公开只读：builtin write 的 SUNSHINE.md 回执判据共用同一归一根（§9.3，防双套归一漂移） */
  readonly rootReal: string;

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
   * 判定一律作用于 realpath 归一后的真实路径：dataDir 内由模型植入的符号链接指向子树之外时被拒（不再有「写面全拒故链接无威胁」的前提）。
   * 记忆写窄口**先于** root 内外分支定论（2026-09-18 审查裁决）：数据目录回退 <root>/.data 布局（HOME 不可写，见 config/data-dir 形态③）下记忆目录落在 root 内，
   * 若让「root 内一律放行」分支先短路，总开关对写面即失效（规格把开关定义为「不注入 / 不提取 / 不整理 / **写被拒**」四贯通）。命中记忆形态即在此定论，不再下探 root 分支；
   * 非记忆路径的 root 内外语义保持原样（root 内全放行、root 外拒、dataDir 只读放行），Read/Grep 的只读放行与总开关无关。
   */
  private resolveSafe(raw: unknown, tool: string): GuardDecision {
    try {
      // 判界基准：活动根在场（worktree 会话）时相对路径锚活动根，缺省回退主根——相对路径与 exec cwd 同源切换
      const baseRoot = this.activeRootPath ?? this.root;
      const abs = path.resolve(baseRoot, String(raw ?? ''));
      let anchor = abs;
      while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
      const real = fs.realpathSync(anchor) + abs.slice(anchor.length);
      // settings.json 两级硬保护（用户裁决：配置正名不可被模型改写）：命中即拒，先于一切放行分支；
      // 拒绝文案英文单语（入链），两级路径各归一一次（文件缺失时按字面拼接，合法确定态）
      if (tool === 'Write' && this.isProtectedSettingsPath(real)) {
        return { allowed: false, reason: `COMMAND_DENIED: settings.json is protected (edit it manually): ${real}` };
      }
      // 记忆写窄口只约束 Write（只读放行走下方 dataDir 分支，与总开关无关）；命中记忆形态即定论：开关关闭 / 越 scope 在此拒，文案为记忆侧可辨识的英文拒绝原因
      if (tool === 'Write' && isMemoryPath(dataDirReal(this.root), real) !== null) {
        const memory = this.memoryWriteAllowed(real);
        return memory.allowed
          ? { allowed: true, safePath: real }
          : { allowed: false, reason: `COMMAND_DENIED: ${memory.reason}: ${real}` };
      }
      // ~/.sunshinex 子树放行（用户级资产：全局技能根等，模型可自助安装技能；判据同 realpath 归一）。
      // 置于记忆窄口之后：缺省数据目录（<userConfigDir>/projects/<slug>/data）也落在该子树内，先放行会让记忆写绕过总开关与 scope；
      // settings.json 硬保护已在其前定论，此处不会放行配置正名
      const cfgReal = fs.existsSync(userConfigDir()) ? fs.realpathSync(userConfigDir()) : userConfigDir();
      if (real === cfgReal || isWithin(cfgReal, real)) return { allowed: true, safePath: real };
      // 活动 root 判定（规格 §11）：worktree 会话中活动根命中即按项目路径语义放行（读/写两面）；
      // 主根与活动根互为界外——主根写类拒（回执提及 worktree 会话），读类恒开放（对比审查语义）；
      // 真正外部路径（两根皆外）维持既有拒绝语义与文案，活动根在场零漂移
      if (this.activeRootReal !== null) {
        if (real === this.activeRootReal || isWithin(this.activeRootReal, real)) return { allowed: true, safePath: real };
        if (tool === 'Write' && (real === this.rootReal || isWithin(this.rootReal, real))) {
          return { allowed: false, reason: `COMMAND_DENIED: path escapes active worktree root (write outside worktree session): ${real}` };
        }
      }
      if (real !== this.rootReal && !isWithin(this.rootReal, real)) {
        if (tool !== 'Write' && this.underDataDir(real)) return { allowed: true, safePath: real };
        return { allowed: false, reason: `COMMAND_DENIED: path escapes project root (real path): ${real}` };
      }
      return { allowed: true, safePath: real };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { allowed: false, reason: `COMMAND_DENIED: path boundary check failed: ${msg.slice(0, 120)}` };
    }
  }

  /** 派生带记忆 scope 的克隆（子代理 fork 用）：其余依赖引用共享，仅 scope 收窄；原实例零突变 */
  withMemoryScope(scope: MemoryScope): SafetyChain {
    return new SafetyChain(this.guard, this.backend, this.dryrun, this.root, scope);
  }

  /** 派生换根克隆（隔离子代理专用，规格 2026-09-23-subagent-worktree-isolation D6）：root 置换为专属树并携带
   * isolatedRoot 标记——exec 判界三查仅隔离子链生效；guard/backend/dryrun/scope 引用共享，活动根态不继承（克隆从缺省态起步，子链 exec cwd 与路径判界天然锚树） */
  withRoot(root: string): SafetyChain {
    const child = new SafetyChain(this.guard, this.backend, this.dryrun, root, this.memoryScope);
    child.isolatedRootPath = root;
    try {
      child.isolatedRootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
    } catch {
      child.isolatedRootReal = root;
    }
    return child;
  }

  /** exec cwd 判定单点（规格 §11：exec 的 cwd 锚活动根）：活动根在场取活动根，缺省取装配根——
   * 链自身持态，主链/子链各自正确（子面 exec 经共享 executor 时不误锚主根） */
  execCwd(): string {
    return this.activeRootPath ?? this.root;
  }

  /**
   * 记忆写入窄口（规格 §4.2）：仅 <dataDir>/memory/** 放行，且总开关开启、scope 覆盖三者齐备；判定两侧同走 realpath 归一（数据目录自身含符号链接段时不误拒合法写入），符号链接逃逸仍被拒。
   * 返回**带原因的判定**而非裸 boolean（2026-09-18 审查次要项）：三种拒绝成因（总开关关闭 / 不在记忆子树内 / 越出本代理 scope）分别给出记忆侧可读原因，
   * 不再与「路径越出项目 root」共用文案——写窄口先于 root 内外分支定论时，调用方只能转述本方法的结论，笼统文案会让「开关在起作用」这一事实不可辨识。
   * 拒绝理由经工具结果入链（进模型上下文）→ 英文单语，不随 --language 分叉。
   */
  private memoryWriteAllowed(real: string): { allowed: true } | { allowed: false; reason: string } {
    if (!resolveMemoryConfig().autoMemory) {
      return {
        allowed: false,
        reason: 'memory write denied: auto memory is off',
      };
    }
    const dataDir = dataDirReal(this.root);
    if (isMemoryPath(dataDir, real) === null) {
      return {
        allowed: false,
        reason: 'memory write denied: outside the memory subtree (<dataDir>/memory/**)',
      };
    }
    if (this.memoryScope !== undefined && isMemoryPath(dataDir, real, this.memoryScope) === null) {
      return {
        allowed: false,
        reason: `memory write denied: outside the writable memory scope (${this.memoryScope})`,
      };
    }
    return { allowed: true };
  }

  /**
   * 路径是否落在数据目录子树内（每次惰性求值对齐运行期求值先例，SUNSHINEX_DATA_DIR 测试可重定向）
   */
  private underDataDir(real: string): boolean {
    return isWithin(dataDirReal(this.root), real);
  }

  /** settings.json 两级硬保护判据（项目级 <root>/.sunshinex/settings.json + 全局 <userConfigDir>/settings.json）：
   *  两侧同走 realpath 归一（配置文件自身在符号链接路径上时不误判），文件缺失按字面路径比对（合法确定态） */
  private isProtectedSettingsPath(real: string): boolean {
    for (const p of [loadProjectSettings(this.root), loadGlobalSettings()]) {
      let candidate = p;
      try {
        candidate = fs.existsSync(p) ? fs.realpathSync(p) : p;
      } catch {
        /* 归一异常按字面比对 */
      }
      if (real === candidate) return true;
    }
    return false;
  }

  run(cmd: string, opts?: ExecOpts): Promise<Result<ExecResult>> {
    const gate = this.execCommandAllowed(cmd);
    if (!gate.allowed) return Promise.resolve(fail('EXEC_OUT_OF_TREE', gate.reason));
    return this.backend.exec(cmd, opts);
  }

  /** 活动根（worktree 会话）：切换时防御性 realpath 沿构造先例；null=缺省（既有语义逐字节保持） */
  private activeRootPath: string | null = null;
  private activeRootReal: string | null = null;

  /** 隔离子链专属树（withRoot 设置；null=非隔离子链，判界零介入） */
  private isolatedRootPath: string | null = null;
  private isolatedRootReal: string | null = null;

  /** 隔离子链 exec 命令判界（规格 2026-09-23-subagent-worktree-isolation §5/D6，对标 CC v2.1.203）：
   * cwd 恒由程序锚树（execCwd），越树通道只剩命令文本——② git 指针参数越树拒；③ GIT_* 环境赋值/cd 越树拒；
   * 含运行期替换（$()`）/反引号）的 git 命令不可验证即拒（fail-closed）。非隔离子链零介入。
   * 拒绝 reason 经工具结果入链（进模型上下文）→ 英文单语 */
  execCommandAllowed(cmd: string): { allowed: true } | { allowed: false; reason: string } {
    if (this.isolatedRootReal === null) return { allowed: true };
    const base = this.isolatedRootPath ?? this.isolatedRootReal;
    const within = (p: string): boolean => {
      try {
        return isWithin(this.isolatedRootReal!, path.resolve(base, p));
      } catch {
        return false;
      }
    };
    const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const kv = /^(--git-dir|--work-tree)=(.*)$/.exec(t);
      if (kv) {
        if (!within(kv[2])) return { allowed: false, reason: `command rejected: git pointer escapes the isolated worktree: ${kv[2]}` };
        continue;
      }
      if (t === '--git-dir' || t === '--work-tree' || t === '-C' || t === '-c') {
        const v = tokens[i + 1];
        if (v !== undefined && !within(v) && t !== '-c') {
          return { allowed: false, reason: `command rejected: git pointer escapes the isolated worktree: ${v}` };
        }
        if (t === '-c' && v !== undefined && v.includes('=')) {
          const cfg = v.split('=');
          const key = cfg[0];
          const val = cfg.slice(1).join('=');
          if (key === 'core.worktree' && !within(val)) {
            return { allowed: false, reason: `command rejected: core.worktree escapes the isolated worktree: ${val}` };
          }
        }
        continue;
      }
      const env = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=(.*)$/.exec(t);
      if (env) {
        if (!within(env[2])) return { allowed: false, reason: `command rejected: GIT_* env escapes the isolated worktree: ${env[2]}` };
        continue;
      }
      if (t === 'cd') {
        const v = tokens[i + 1];
        if (v !== undefined && !within(v)) return { allowed: false, reason: `command rejected: cd escapes the isolated worktree: ${v}` };
      }
    }
    if (/\$\(|`/.test(cmd) && /(^|\s|["'()])git(\s|$|["'])/.test(cmd)) {
      return { allowed: false, reason: 'command rejected: runtime-computed git command cannot be verified to stay inside the isolated worktree' };
    }
    return { allowed: true };
  }

  /** 工具结果跨链的唯一脱敏出口：stdout 与 stderr 统一过凭据模式集 */
  maskResult(_tool: string, result: ExecResult): ExecResult {
    return { ...result, stdout: maskText(result.stdout), stderr: maskText(result.stderr) };
  }

  /** 活动根原始路径只读视图（builtinTools exec cwd 接缝与 Harness 转发消费；T4 接线） */
  get activeRoot(): string | null {
    return this.activeRootPath;
  }

  /** 进入 worktree 会话：切换活动根（引用不重建即生效）；路径归一沿构造先例（存在段 realpath，异常原样回退） */
  enterWorktree(tree: string): void {
    try {
      this.activeRootReal = fs.existsSync(tree) ? fs.realpathSync(tree) : tree;
    } catch {
      this.activeRootReal = tree;
    }
    this.activeRootPath = tree;
  }

  /** 退出 worktree 会话：活动根复位为 null，判定序回落既有 root 语义 */
  exitWorktree(): void {
    this.activeRootReal = null;
    this.activeRootPath = null;
  }

  preview(cmd: string): string {
    return maskText(this.dryrun.preview(cmd));
  }
}
