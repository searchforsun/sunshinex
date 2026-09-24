import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GuardDecision, SecurityGuard } from './guard';
import { matchAnyRule } from '../../config/permissions';
import type { PermissionsConfig } from '../../config/permissions';
import { ExecOpts, ExecResult, ToolBackend } from '../../types';
import { dataDirReal, resolveDataDir } from '../../config/data-dir';
import { userConfigDir } from '../../config/env';
import { loadGlobalSettings, loadProjectSettings } from '../../config/settings';
import { resolveMemoryConfig } from '../../config/memory-config';
import { isMemoryPath, MemoryScope } from '../memory/paths';
import { isWithin } from '../../paths';
import { DryRun } from './dryrun';
import { Result, fail } from '../../result';

/** 需要路径边界校验的工具（安全链规范名） */
const PATH_TOOLS = new Set(['Read', 'Write', 'Grep']);

/** .git 内部路径判据（spec D6）：路径任一段为 .git 即命中（仓库 .git 目录与 worktree 指针文件同护） */
function isGitInternalPath(real: string): boolean {
  return real.split(path.sep).includes('.git');
}

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

  /** 异步决策：guard 段走 preToolUseAsync；路径工具判界后，manual 审批请求经 guard.resolveAsk 路由（spec 5.1 写/读分支：
   *  'always' 目录登记，会话内同目录后续读写免批；asker 缺失/失败维持原拒绝，宁停不误）。非路径工具语义不变。 */
  async evaluateAsync(tool: string, input: unknown): Promise<GuardDecision> {
    const decision = await this.guard.preToolUseAsync(tool, input);
    if (!decision.allowed) return decision;
    if (!PATH_TOOLS.has(tool)) return { allowed: true };
    const resolved = this.resolveSafe(this.rawPath(input), tool);
    if (resolved.allowed || resolved.ask !== true) return resolved;
    // 链侧 ask 路由（spec 5.1 写/读分支）：'always' 目录登记，会话内同目录后续读写免批
    const askDecision = await this.guard.resolveAsk({
      id: this.guard.nextApprovalId(),
      kind: tool === 'Write' ? 'write' : 'read',
      subject: this.rawPath(input),
      reason: resolved.reason,
    });
    if (askDecision === null) return resolved;
    if (askDecision === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: rejected by user' };
    if (askDecision === 'always' && resolved.askDir !== undefined) this.guard.allowSessionDir(resolved.askDir);
    return { allowed: true, safePath: resolved.safePath };
  }

  /** D1 读围栏开关（SUNSHINEX_READ_FENCE，onOff，缺省关） */
  private readFenceEnabled(): boolean {
    const v = process.env.SUNSHINEX_READ_FENCE;
    if (v === 'on' || v === 'true') return true;
    if (v === 'off' || v === 'false') return false;
    return false;
  }

  /** fence 触发后的读判据（spec 5.1 读分支：manual=ask、其余档=拒） */
  private readFenceDecision(real: string): GuardDecision {
    if (this.guard.mode === 'manual') {
      return {
        allowed: false,
        ask: true,
        askDir: path.dirname(real),
        safePath: real,
        reason: `COMMAND_DENIED: read outside trusted roots requires approval (read fence enabled): ${real}`,
      };
    }
    return { allowed: false, reason: `COMMAND_DENIED: read fence blocks reads outside trusted roots: ${real}` };
  }

  /** 文件工具规则匹配 specifiers：绝对 posix（去首 /）/ root 相对 posix / basename */
  private pathRuleSpecifiers(real: string): string[] {
    const posix = real.split(path.sep).join('/');
    const noLead = posix.startsWith('/') ? posix.slice(1) : posix;
    const rel = path.relative(this.rootReal, real).split(path.sep).join('/');
    const base = posix.slice(posix.lastIndexOf('/') + 1);
    return [...new Set([noLead, rel, base])];
  }

  /** 路径工具输入的 path 字段归一读取 */
  private rawPath(input: unknown): string {
    if (typeof input === 'object' && input !== null && typeof (input as { path?: unknown }).path === 'string') {
      return (input as { path: string }).path;
    }
    return String(input ?? '');
  }

  /**
   * 路径归一判界（spec §5.1 判定序）：存在段 realpathSync 解析符号链接，新建段字面拼接（resolve 产物无 .. 残留）；
   * 异常按拒绝处理不放行（spec 2.1 兜底条款）。求值序：settings.json → .git → 记忆写窄口（字面∪real 双查）→
   * worktree 主根拒写 → 用户 deny → 会话目录放行 → 用户 allow → 读分支 → 写分支（信任域放行 → 隔离链根外恒拒 → 数据目录只读 → 档位）。
   * 产品硬底线先于用户规则（规则只可收窄不可放宽）；
   * 读分支（D1）信任域内直放、域外缺省全放（fence 开启才收窄：manual=ask、其余档=拒）；
   * 写分支（D2/D3）信任域放行、域外按档位（manual=ask 且 askDir 记目录），隔离链根外恒拒；
   * 数据目录只读在写分支信任域之后求值：root/活动工作树落在 dataDir 子树内的布局（SUNSHINEX_DATA_DIR 重定向、
   * worktreesRoot 归 dataDir）不得被只读条款误伤——信任域命中即放行，仅两域之外的 dataDir 子树保持只读定性。
   */
  private resolveSafe(raw: unknown, tool: string): GuardDecision {
    try {
      // 判界基准：活动根在场（worktree 会话）时相对路径锚活动根，缺省回退主根——相对路径与 exec cwd 同源切换；
      // 两根均取 realpath 归一后的真实路径为锚（root 经符号链接传入时判界仍正确；归一异常沿构造先例回退词形态）
      const baseRoot = this.activeRootReal ?? this.rootReal;
      const abs = path.resolve(baseRoot, String(raw ?? ''));
      let anchor = abs;
      while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
      const real = fs.realpathSync(anchor) + abs.slice(anchor.length);

      // ── 产品硬底线（spec 5.1：先于用户规则；规则只可收窄不可放宽）──
      // ① settings.json 两级写保护（用户裁决：配置正名不可被模型改写；拒绝文案英文单语（入链），两级路径各归一一次）
      if (tool === 'Write' && this.isProtectedSettingsPath(real)) {
        return { allowed: false, reason: `COMMAND_DENIED: settings.json is protected (edit it manually): ${real}` };
      }
      // ② .git/** 写保护（D6）
      if (tool === 'Write' && isGitInternalPath(real)) {
        return { allowed: false, reason: `COMMAND_DENIED: .git is protected (git state changes go through exec git): ${real}` };
      }
      // ③ 记忆写窄口（既有；先于信任域放行，不绕记忆总开关与 scope）。
      // 字面∪real 双查（对齐 realpath 判界不可逃逸语义）：仅查 real 时，dataDir 内 memory 下由模型植入的
      // 符号链接指向子树之外，realpath 后即不呈记忆形态，窄口失察、写面落到下方写分支档位放行（安全回归）；
      // 字面形态先查保证「链接形式上是记忆路径」一律进窄口定论，real 形态维持既有判定（链接目标真实落位）
      const dataDirLiteral = resolveDataDir(this.root);
      if (
        tool === 'Write' &&
        (isMemoryPath(dataDirReal(this.root), real) !== null || isMemoryPath(dataDirReal(this.root), abs) !== null ||
          isMemoryPath(dataDirLiteral, real) !== null || isMemoryPath(dataDirLiteral, abs) !== null)
      ) {
        const memory = this.memoryWriteAllowed(real);
        return memory.allowed
          ? { allowed: true, safePath: real }
          : { allowed: false, reason: `COMMAND_DENIED: ${memory.reason}: ${real}` };
      }
      // ⑤ worktree 主根拒写（既有硬底线；主根读类恒开放）
      if (this.activeRootReal !== null && tool === 'Write' && (real === this.rootReal || isWithin(this.rootReal, real))) {
        return { allowed: false, reason: `COMMAND_DENIED: path escapes active worktree root (write outside worktree session): ${real}` };
      }

      // ── 用户规则面（D5：deny → 会话目录放行 → allow）──
      const ruleSpecifiers = this.pathRuleSpecifiers(real);
      if (this.permissions !== undefined && matchAnyRule(this.permissions.deny, tool, ruleSpecifiers)) {
        return { allowed: false, reason: `COMMAND_DENIED: denied by user permissions rule: ${real}` };
      }
      if (this.guard.sessionDirAllowed(real)) return { allowed: true, safePath: real };
      if (this.permissions !== undefined && matchAnyRule(this.permissions.allow, tool, ruleSpecifiers)) {
        return { allowed: true, safePath: real };
      }

      // ── 信任域 ──
      const cfgReal = fs.existsSync(userConfigDir()) ? fs.realpathSync(userConfigDir()) : userConfigDir();
      const inUserConfig = real === cfgReal || isWithin(cfgReal, real);
      const inActiveRoot = this.activeRootReal !== null && (real === this.activeRootReal || isWithin(this.activeRootReal, real));
      const inMainRoot = real === this.rootReal || isWithin(this.rootReal, real);
      const inAdditional = this.additionalDirs.some((d) => real === d || isWithin(d, real));

      // 读分支（D1）：信任域内直放；域外全盘放行，fence 开启时收窄（manual=ask、其余档=拒）
      if (tool !== 'Write') {
        if (inUserConfig || inActiveRoot || inAdditional || inMainRoot) return { allowed: true, safePath: real };
        if (this.underDataDir(real)) return { allowed: true, safePath: real };
        if (this.readFenceEnabled()) return this.readFenceDecision(real);
        return { allowed: true, safePath: real };
      }

      // 写分支（D2/D3）：信任域放行；隔离链根外恒拒（程序化隔离，spec D2 边界）；
      // 数据目录只读在信任域之后求值（上移会误伤 root/活动树落 dataDir 内的布局，见方法注释）；
      // 两域之外的 dataDir 子树写仍恒拒（不借档位放行），只保留 <dataDir>/memory/** 记忆窄口一个写通道
      if (inUserConfig || inActiveRoot || inAdditional || inMainRoot) return { allowed: true, safePath: real };
      if (this.isolatedRootReal !== null) {
        return { allowed: false, reason: `COMMAND_DENIED: path escapes the isolated worktree root: ${real}` };
      }
      if (this.underDataDir(real)) {
        return {
          allowed: false,
          reason: `COMMAND_DENIED: data directory is read-only (only <dataDir>/memory/** is writable): ${real}`,
        };
      }
      const mode = this.guard.mode;
      if (mode === 'plan') return { allowed: false, reason: 'COMMAND_DENIED: plan mode allows read-only operations only' };
      if (mode === 'dontAsk') return { allowed: true, safePath: real };
      return {
        allowed: false,
        ask: true,
        askDir: path.dirname(real),
        safePath: real,
        reason: `COMMAND_DENIED: write outside trusted roots requires approval: ${real}`,
      };
    } catch (error) {
      return { allowed: false, reason: `COMMAND_DENIED: path boundary check failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}` };
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
    child.permissions = this.permissions;
    child.additionalDirs = this.additionalDirs;
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

  /** D5 用户规则（settings permissions 注入面）与 D3 信任目录集（原地变更保引用，fork 克隆共享同一实例） */
  private permissions: PermissionsConfig | undefined = undefined;
  private additionalDirs: string[] = [];

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

  /** D5 用户规则注入（路径工具消费；Bash/mcp/web 通道在 guard PolicyEngine） */
  setPermissions(config: PermissionsConfig): void {
    this.permissions = config;
  }

  /** D3 信任目录集：realpath 归一（缺失锚定向上）；原地变更保引用——fork 克隆共享同一实例 */
  setAdditionalDirs(dirs: string[]): void {
    const normalized = dirs.map((d) => {
      try {
        const abs = path.resolve(d);
        let anchor = abs;
        while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
        return fs.realpathSync(anchor) + abs.slice(anchor.length);
      } catch {
        return path.resolve(d);
      }
    });
    this.additionalDirs.length = 0;
    this.additionalDirs.push(...normalized);
  }

  /** D3 追加单个信任目录（/add-dir 运行期通道；与 settings/CLI 三面同源） */
  addAdditionalDir(dir: string): void {
    this.setAdditionalDirs([...this.additionalDirs, dir]);
  }

  preview(cmd: string): string {
    return maskText(this.dryrun.preview(cmd));
  }
}
