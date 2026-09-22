import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExecResult, ToolBackend } from '../../types';
import { Result, ok, fail } from '../../result';

/** process 执行后端：命令与文件 IO 的统一执行面；Docker/SSH 后端同接口预留，1D 不实现 */
export class ProcessSandbox implements ToolBackend {
  readonly name = 'process';

  async exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    const timeoutMs = opts?.timeoutMs ?? 1_800_000;
    const shell = resolveShell();
    return new Promise((resolve) => {
      execFile(shell.file, [...shell.args, cmd], { cwd: opts?.cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed) {
            resolve(fail('EXEC_TIMEOUT', `command timed out: ${cmd}`));
          } else {
            resolve(fail('EXEC_FAILED', stderr || err.message || 'command failed'));
          }
          return;
        }
        resolve(ok({ exitCode: 0, stdout, stderr, timedOut: false }));
      });
    });
  }

  readFile(absPath: string): string {
    return fs.readFileSync(absPath, 'utf8');
  }

  /** 后台执行（后台任务线）：detached spawn 自成进程组，task_stop 按组收割；stdout/stderr 增量回调供 TaskRegistry 流式落盘。
   *  提交即返回 pid，不等待进程退出；进程退出经 onExit 回调落终态（exitCode 语义同 exec：0=成功，非 0/信号=失败）。
   *  平台形态（spawn/detached/进程组收割）只允许落本文件（CLAUDE.md §14） */
  async execBackground(cmd: string, opts?: { cwd?: string; onData?: (chunk: string) => void; onExit?: (exitCode: number) => void }): Promise<Result<{ pid: number }>> {
    const shell = resolveShell();
    const child = spawn(shell.file, [...shell.args, cmd], {
      cwd: opts?.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (d: Buffer) => opts?.onData?.(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => opts?.onData?.(d.toString('utf8')));
    child.on('error', (err: Error) => {
      opts?.onData?.(err.message);
      opts?.onExit?.(1);
    });
    child.on('close', (code: number | null) => opts?.onExit?.(code ?? 1));
    return ok({ pid: child.pid ?? 0 });
  }

  /** 按进程组/进程树终止后台任务（task_stop 单点后端）：POSIX 杀 -pid 组，Windows 杀 /T 树 */
  killBackground(pid: number): void {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出，终态行由 close 回调落 */ } }
    }
  }

  /** 写入含父目录自动创建（维持现行 write 语义） */
  writeFile(absPath: string, content: string): void {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }

  listFiles(root: string, pattern: string): string[] {
    const re = new RegExp(globToRegex(pattern));
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else {
          // glob 语义统一 / 分隔：Windows 反斜杠产物先归一化再匹配（POSIX 上为 no-op），匹配与输出口径一致
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (re.test(rel)) out.push(rel);
        }
      }
    };
    walk(root);
    return out;
  }
}

/** 文件路径 glob 转正则：双星号斜杠匹配零个或多个目录段，单星号与问号不跨越斜杠 */
function globToRegex(pattern: string): string {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      let j = i;
      while (pattern[j] === '*') j++;
      if (pattern[j] === '/') {
        out += '(?:[^/]*/)*';
        i = j + 1;
      } else {
        out += '[^/]*';
        i = j;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else {
      out += escapeRegExp(c);
      i++;
    }
  }
  return out + '$';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 决议结果的来源标签（自检观测面用；同时是决议序的可断言契约） */
export type ShellSource = 'override' | 'posix' | 'git-bash' | 'powershell' | 'comspec';

/** shell 决议产物：`args` 为脚本标志前缀，`source` 标明由哪一级决议命中 */
export interface ResolvedShell {
  file: string;
  args: string[];
  source: ShellSource;
}

/**
 * 平台 shell 解析：sh 风格命令统一经 POSIX shell 执行。
 * 决议序：SUNSHINEX_SHELL 覆盖（须为 POSIX 兼容 shell）→ Windows 探测 Git Bash（bash 兼容 sh）→
 * Windows 无 Git Bash 时探测 PowerShell（pwsh 优先于 powershell.exe）→ 皆无则 ComSpec 末位兜底
 * （`/c`，仅保证不崩，sh 语义命令不保证可用）→ POSIX `/bin/sh`。
 *
 * PowerShell 一级对齐 Claude Code 官方口径（native Windows 无 Git for Windows 时以其作为 shell 工具，
 * 而非退回 cmd.exe）：cmd.exe 连 `echo` 重定向与引号语义都与 sh 相去更远，PowerShell 至少能承载
 * 文件/进程类命令，可比 cmd 多保住一部分真实可用面。`-NoProfile` 抑制用户 profile 输出污染 observation。
 * 平台分支只允许出现在本文件（CLAUDE.md §14）；导出供测试与自检观测实际决议结果。
 */
export function resolveShell(): ResolvedShell {
  return resolveShellFor(process.platform, process.env);
}

/**
 * 决议序的纯函数形态（平台、环境、存在性判定皆可注入）：平台分支的判别力由此可跨平台断言——
 * 在 POSIX 上也能回归 Windows 决议序（bash → pwsh → powershell → ComSpec），无需 Windows 宿主。
 */
export function resolveShellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): ResolvedShell {
  const override = env.SUNSHINEX_SHELL;
  if (override && override.trim().length > 0) return { file: override, args: ['-c'], source: 'override' };
  if (platform === 'win32') {
    const bash = findWindowsBash(env, exists);
    if (bash !== undefined) return { file: bash, args: ['-c'], source: 'git-bash' };
    const ps = findWindowsPowerShell(env, exists);
    if (ps !== undefined) return { file: ps, args: ['-NoProfile', '-Command'], source: 'powershell' };
    return { file: env.ComSpec ?? 'cmd.exe', args: ['/c'], source: 'comspec' };
  }
  return { file: '/bin/sh', args: ['-c'], source: 'posix' };
}

/**
 * Windows Git Bash 候选路径（纯逻辑，环境与存在性判定可注入，便于跨平台回归断言）。
 * 候选根两来源：①安装环境变量（覆盖非 C 盘与自定义安装目录）；②PATH 上挂着 `git.exe` 的目录反推
 * （Git for Windows 把 `<root>\cmd`、`<root>\mingw64\bin` 或 `<root>\bin` 置于 PATH）。
 * bash.exe 位于 `<root>\bin\` 或 `<root>\usr\bin\`（两种安装布局皆列）。
 */
/**
 * WSL 启动器目录判定：`bash.exe` 这个名字**不是 MSYS 家族专有**——Windows 自带一个同名的 WSL 启动器，
 * 它同样匹配「PATH 上直接暴露 bash.exe」的形态，却不是 Git Bash。误选的代价是三处同时错：
 *   ① PATH 不继承：宿主 Windows 侧装的 node/npm 在发行版里一律 not found（`node --version` 直接失败）；
 *   ② 路径变 `/mnt/<盘>/...`，工作目录与 Windows 视角不一致（调用方按 Windows 路径判断会落空）；
 *   ③ 首次调用要等发行版 VM 冷启动（实测 24–32 秒），且发行版持有 Windows 目录句柄致测试清理 EBUSY。
 * 采用**负向排除**而非「探测 MSYS 标记」：正向标记随发行版布局漂移（Git / msys2 / cygwin 各不相同），
 * 误拒合法 Git Bash 的代价高于这一处窄排除；新落点即在 KNOWN 列表登记一行。
 */
const WSL_BASH_LAUNCHER_DIRS = ['system32', 'syswow64', 'sysnative'] as const;

export function isWslBashLauncherDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = path.normalize(dir.replace(/[/\\]+$/, '')).toLowerCase();
  if (norm.length === 0) return false;
  // 主判据锚定 SystemRoot：系统目录的位置由环境事实给出，不靠名字猜——否则用户自建的 <任意路径>\system32 会被误拒
  const systemRoot = env.SystemRoot ?? env.windir;
  if (systemRoot !== undefined && systemRoot.length > 0) {
    const root = path.normalize(systemRoot.replace(/[/\\]+$/, '')).toLowerCase();
    for (const leaf of WSL_BASH_LAUNCHER_DIRS) if (norm === path.join(root, leaf).toLowerCase()) return true;
  } else if ((WSL_BASH_LAUNCHER_DIRS as readonly string[]).includes(path.basename(norm))) {
    // SystemRoot 不可得时的保守兜底：仅凭末段目录名判定（覆盖缺环境变量的残缺宿主）
    return true;
  }
  // 应用执行别名目录（Store 版 WSL 的 bash.exe 落此）：整段落点匹配，避免误伤用户自建的同名子目录
  const locals = [env.LOCALAPPDATA, env.USERPROFILE === undefined ? undefined : path.join(env.USERPROFILE, 'AppData', 'Local')].filter(
    (p): p is string => p !== undefined && p.length > 0,
  );
  return locals.some((base) => norm === path.join(base.replace(/[/\\]+$/, ''), 'Microsoft', 'WindowsApps').toLowerCase());
}

export function windowsBashCandidates(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string[] {
  const installRoots = [
    env.ProgramFiles,
    env.ProgramW6432,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA === undefined ? undefined : path.join(env.LOCALAPPDATA, 'Programs'),
  ];
  const roots: string[] = [];
  for (const r of installRoots) if (r) roots.push(path.join(r, 'Git'));
  // PATH 上直接暴露 bash.exe 的宿主（msys2 / cygwin 形态）：其所在目录即 shell 位置
  const direct: string[] = [];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    // WSL 启动器与 WindowsApps 别名目录排除在外：同名但不同壳，误选即 PATH 不继承 + /mnt 路径 + VM 冷启动
    if (!isWslBashLauncherDir(dir, env) && exists(path.join(dir, 'bash.exe'))) direct.push(path.join(dir, 'bash.exe'));
    if (!exists(path.join(dir, 'git.exe'))) continue;
    // git.exe 所在目录本身（<root>\cmd）及其两级祖先（<root>\mingw64\bin、<root>）都可能就是 Git 安装根
    roots.push(dir, path.dirname(dir), path.dirname(path.dirname(dir)));
  }
  const fromRoots = roots.flatMap((r) => [path.join(r, 'bin', 'bash.exe'), path.join(r, 'usr', 'bin', 'bash.exe')]);
  return [...direct, ...fromRoots];
}

/**
 * Windows Git Bash 发现：只认 bash.exe（POSIX 兼容）。硬编码单一安装路径会让非缺省安装静默回落
 * cmd.exe——命令引号语义与 sh 命令集随之改变（`node -e "…"` 被当字符串字面量求值、`ls`/`cat` 不可用），
 * 属本文件要消除的隐式平台差异；探测不到即诚实回落下一级（PowerShell，再下 ComSpec，见 §14 决议序）。
 */
export function findWindowsBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return windowsBashCandidates(env, exists).find((c) => exists(c));
}

/**
 * Windows PowerShell 候选路径（纯逻辑，环境与存在性判定可注入，便于跨平台回归断言）。
 * 两形态一序：**pwsh.exe 整体先于 powershell.exe**——PowerShell 7+ 支持 `&&` 链式与跨平台安装布局，
 * 承载命令的能力面明显强于 5.1。来源：①PATH 逐目录（winget/store 与手动安装常态挂 PATH）；
 * ②pwsh 缺省安装根 `<ProgramFiles>\PowerShell\7` 与 `%LOCALAPPDATA%\Microsoft\WindowsApps`（未挂 PATH 亦可见）；
 * ③Windows PowerShell 同 PATH 逐目录与其 in-box 固定位置 `%SystemRoot%\System32\WindowsPowerShell\v1.0`。
 */
export function windowsPowerShellCandidates(env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const pwsh: string[] = dirs.map((d) => path.join(d, 'pwsh.exe'));
  for (const root of [env.ProgramFiles, env.ProgramW6432]) if (root) pwsh.push(path.join(root, 'PowerShell', '7', 'pwsh.exe'));
  if (env.LOCALAPPDATA) pwsh.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  const legacy: string[] = dirs.map((d) => path.join(d, 'powershell.exe'));
  const sysRoot = env.SystemRoot ?? (env.SystemDrive ? path.join(env.SystemDrive, 'Windows') : undefined);
  if (sysRoot) legacy.push(path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  // 候选序即优先序：pwsh 各来源在前、powershell 各来源在后
  return [...pwsh, ...legacy];
}

/** Windows PowerShell 发现：与 Git Bash 同形（候选序 + 存在性复核），命中即返回可执行文件路径 */
export function findWindowsPowerShell(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return windowsPowerShellCandidates(env).find((c) => exists(c));
}
