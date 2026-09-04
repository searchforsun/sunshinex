import { execFile } from 'child_process';
import { ExecResult } from '../../types';
import { Result, ok, fail } from '../../result';

export interface Sandbox {
  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>>;
}

/** process 子进程隔离沙箱（零依赖近似 OS 级强制，Docker 预留） */
export class ProcessSandbox implements Sandbox {
  async run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<Result<ExecResult>> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    return new Promise((resolve) => {
      execFile('/bin/sh', ['-c', cmd], { cwd: opts?.cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
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
}
