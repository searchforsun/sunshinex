import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { CodedToolError } from './tools';

/** 后台任务记录（后台任务线规格 D2/D3）：账本进程内承载，不落盘不跨会话；输出流式追加 <dataDir>/tasks/<id>.log */
export interface BackgroundTask {
  id: string;
  kind: 'exec' | 'subagent';
  label: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  outputFilePath: string;
  startedAt: number;
  exitCode?: number;
  ownerRun?: string;
  /** 停止执行单点（exec=进程 kill、subagent=中断线 abort）；提交方挂载，账本透传——kill 与 abort 两类差异收敛在提交方闭包，账本零 kind 分派 */
  stop?: () => void;
}

/** owner 作用域（后台任务线规格 D9）：AsyncLocalStorage 承载 fork 归属，并发 fork 互不串号 */
const ownerStorage = new AsyncLocalStorage<string>();

/** 统一任务账本单点（后台任务线规格 D1/D10）：ID 空间/生命周期/状态统一承载；进程内 Map 不落盘不跨会话；ID=会话内递增确定性序号，零随机源 */
export class TaskRegistry {
  private seq = 0;
  private readonly tasks = new Map<string, BackgroundTask>();
  constructor(private readonly tasksDir: string) {}

  /** owner 作用域：fn 执行期内 submit 缺省归属 owner（fork 收割记账，规格 D9） */
  runInOwnerScope<T>(owner: string, fn: () => T): T {
    return ownerStorage.run(owner, fn);
  }

  currentOwner(): string {
    return ownerStorage.getStore() ?? 'main';
  }

  submit(input: { kind: 'exec' | 'subagent'; label: string; ownerRun?: string }): BackgroundTask {
    this.seq += 1;
    const id = `b${this.seq}`;
    const outputFilePath = path.join(this.tasksDir, 'tasks', `${id}.log`);
    try {
      fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
      fs.writeFileSync(outputFilePath, '', 'utf8');
    } catch (e) {
      // 日志文件创建失败=启动失败显式报错（后台任务线规格 §9），不静默吞
      throw new CodedToolError('EXEC_FAILED', `background task log unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const task: BackgroundTask = {
      id,
      kind: input.kind,
      label: input.label,
      status: 'running',
      outputFilePath,
      startedAt: Date.now(),
      ownerRun: input.ownerRun ?? this.currentOwner(),
    };
    this.tasks.set(id, task);
    return task;
  }

  append(taskId: string, chunk: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    fs.appendFileSync(t.outputFilePath, chunk, 'utf8');
  }

  /** 终态（规格 D3）：带 exitCode 落 [exit N]；带 marker 落 marker 行（subagent 结论/失败补丁行）；否则 [status]；重复终止幂等 */
  finish(taskId: string, status: 'done' | 'failed' | 'stopped', opts?: { exitCode?: number; marker?: string }): BackgroundTask | undefined {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'running') return t;
    const line = opts?.marker ?? (opts?.exitCode !== undefined ? `[exit ${opts.exitCode}]` : `[${status}]`);
    fs.appendFileSync(t.outputFilePath, `${line}\n`, 'utf8');
    t.status = status;
    if (opts?.exitCode !== undefined) t.exitCode = opts.exitCode;
    return t;
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /** ownerRun 收割（规格 D9）：终结该 owner 名下全部 running——触发 stop 句柄并落 [stopped] 终态行 */
  reap(ownerRun: string): BackgroundTask[] {
    const out: BackgroundTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === 'running' && t.ownerRun === ownerRun) {
        t.stop?.();
        this.finish(t.id, 'stopped', { marker: '[stopped: owner finished]' });
        out.push(t);
      }
    }
    return out;
  }

  /** 全量收口（宿主退出/CLI run 终态，规格 D9 任务属进程） */
  stopAll(): BackgroundTask[] {
    const out = this.list().filter((t) => t.status === 'running');
    for (const t of out) {
      t.stop?.();
      this.finish(t.id, 'stopped', { marker: '[stopped: process exit]' });
    }
    return out;
  }

  /** 等待单点（task_wait 底座）：全部目标到终态即 resolve；超时 resolve settled=false 不抛错——
   *  轮询 100ms 与既有 appendFileSync 落盘口径同源，零事件依赖零新依赖；不存在的 id 直接过滤 */
  waitUntilSettled(taskIds: string[], timeoutMs: number): Promise<{ settled: boolean; tasks: BackgroundTask[] }> {
    const deadline = Date.now() + timeoutMs;
    const snapshot = () =>
      taskIds.map((id) => this.tasks.get(id)).filter((t): t is BackgroundTask => t !== undefined);
    return new Promise((resolve) => {
      const poll = (): void => {
        const ts = snapshot();
        // 空目标（含未知 id 过滤后为空）零等待即回：无等待对象即无事可等，幂等空回执
        if (ts.length === 0 || ts.every((t) => t.status !== 'running')) {
          resolve({ settled: true, tasks: ts });
          return;
        }
        if (Date.now() >= deadline) {
          resolve({ settled: false, tasks: ts });
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }
}
