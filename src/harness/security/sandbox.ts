import { execFile } from 'child_process';
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
      execFile(shell.file, [shell.scriptFlag, cmd], { cwd: opts?.cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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

/**
 * 平台 shell 解析：sh 风格命令统一经 POSIX shell 执行。
 * 决议序：SUNSHINEX_SHELL 覆盖（须为 POSIX 兼容 shell）→ Windows 探测 Git Bash（bash 兼容 sh）→
 * Windows 无 Git 时 ComSpec 兜底（`/c`，仅保证不崩，sh 语义命令不保证可用）→ POSIX `/bin/sh`。
 * 平台分支只允许出现在本文件（CLAUDE.md §14）；导出供测试与自检观测实际决议结果。
 */
export function resolveShell(): { file: string; scriptFlag: string } {
  const override = process.env.SUNSHINEX_SHELL;
  if (override && override.trim().length > 0) return { file: override, scriptFlag: '-c' };
  if (process.platform === 'win32') {
    const bash = findWindowsBash();
    if (bash !== undefined) return { file: bash, scriptFlag: '-c' };
    return { file: process.env.ComSpec ?? 'cmd.exe', scriptFlag: '/c' };
  }
  return { file: '/bin/sh', scriptFlag: '-c' };
}

/**
 * Windows Git Bash 候选路径（纯逻辑，环境与存在性判定可注入，便于跨平台回归断言）。
 * 候选根两来源：①安装环境变量（覆盖非 C 盘与自定义安装目录）；②PATH 上挂着 `git.exe` 的目录反推
 * （Git for Windows 把 `<root>\cmd`、`<root>\mingw64\bin` 或 `<root>\bin` 置于 PATH）。
 * bash.exe 位于 `<root>\bin\` 或 `<root>\usr\bin\`（两种安装布局皆列）。
 */
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
    if (exists(path.join(dir, 'bash.exe'))) direct.push(path.join(dir, 'bash.exe'));
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
 * 属本文件要消除的隐式平台差异；探测不到即诚实回落 ComSpec（§14 登记的兜底口径）。
 */
export function findWindowsBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return windowsBashCandidates(env, exists).find((c) => exists(c));
}
