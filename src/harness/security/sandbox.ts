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
    return new Promise((resolve) => {
      execFile('/bin/sh', ['-c', cmd], { cwd: opts?.cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed) {
            resolve(fail('EXEC_TIMEOUT', `命令超时：${cmd}`));
          } else {
            resolve(fail('EXEC_FAILED', stderr || err.message || '命令执行失败'));
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
          const rel = path.relative(root, full);
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
