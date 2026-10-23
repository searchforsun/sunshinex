import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { CodedToolError } from './tools';
import { slugify } from '../slug';
import { utcCompactStamp } from '../idstamp';

/** 后台任务记录（后台任务线规格 D2/D3）：账本进程内承载，不落盘不跨会话；输出流式追加 <dataDir>/tasks/<id>.log */
export interface BackgroundTask {
  id: string;
  kind: 'exec' | 'subagent';
  label: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  outputFilePath: string;
  startedAt: number;
  /** 终态时刻（finish 落定；running 无——GUI 运行时长=now-startedAt / 终态=endedAt-startedAt） */
  endedAt?: number;
  exitCode?: number;
  ownerRun?: string;
  /** 停止执行单点（exec=进程 kill、subagent=中断线 abort）；提交方挂载，账本透传——kill 与 abort 两类差异收敛在提交方闭包，账本零 kind 分派 */
  stop?: () => void;
}

/** owner 作用域（后台任务线规格 D9）：AsyncLocalStorage 承载 fork 归属，并发 fork 互不串号 */
const ownerStorage = new AsyncLocalStorage<string>();

/** 账本持久化行（2026-10-24 回溯裁定「后台任务与会话绑定,打开可回溯」）：submit 全量行 + finish
 *  增量行,重放重建账本——文件与 **journalId** 绑定（稳定身份;daemon 会话 sun-id 每次打开都新铸,
 *  磁盘绑定不得用它）。submit 行带 pid:重放时 running 行按 pid 判孤儿（异进程=已死→stopped;
 *  同进程=别处活账→保持 running）。stop 句柄不入档（函数不可序列化,JSON.stringify 自然剥离） */
type TaskLedgerRow =
  | { op: 'submit'; pid: number; task: BackgroundTask }
  | { op: 'finish'; id: string; status: 'done' | 'failed' | 'stopped'; endedAt: number; exitCode?: number };

// id 业务段方言：label ASCII 化 slug ≤16 字符（正则链单点 src/slug.ts）；CJK 等非拉丁标签全折叠
// 回退 kind（业务全称由 /tasks label 列与任务日志承载，id 段只做可读助记）

/** 统一任务账本单点（后台任务线规格 D1/D10）：ID 空间/生命周期/状态统一承载；进程内 Map 不落盘不跨会话。
 *  ID=「业务段-时间段-随机段」（2026-10-03 用户裁决「b1 b2 没有业务和时间含义，容易重复」）：旧 b1
 *  进程计数器每会话归零，跨会话同 id 建档即 writeFileSync 截断覆盖旧任务日志=真数据损失；新方言对标
 *  newSessionId（UTC 紧凑时间戳+4 位随机尾），跨会话唯一且一眼可读「何时启动了什么」，撞 id 再生成兜底 */
export class TaskRegistry {
  private readonly tasks = new Map<string, BackgroundTask>();

  constructor(
    private readonly tasksDir: string,
    /** 账本路径(可选):构造即装载——稳定身份由调用方保证(journalId 推导;daemon 走 adoptLedger
     *  收养,因 sun-id 每次打开新铸不可作磁盘身份)。缺省 undefined = 纯内存既有形态 */
    private ledgerPath?: string,
  ) {
    if (ledgerPath !== undefined) this.replayLedger(ledgerPath);
  }

  /** 账本重放（构造装载与 adoptLedger 共用）：逐行 submit/finish;崩溃截断行/坏行跳过不炸（TeamStore
   *  同教训）。孤儿判定按行内 pid:异进程的 running 行=进程已死 → stopped（endedAt=重放时刻）;同进程
   *  running=同一 daemon 里别处活账（attach 收养场景）保持 running。已有同 id 活条目（本实例先建的）
   *  活条目胜出不回填——live 永远是新真相 */
  private replayLedger(file: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return; // 缺文件(新会话)/读失败:空账本起步,尽力回溯不炸装配
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let row: TaskLedgerRow | undefined;
      try {
        const parsed = JSON.parse(line) as TaskLedgerRow;
        if (parsed.op === 'submit' && typeof parsed.task?.id === 'string') row = parsed;
        else if (parsed.op === 'finish' && typeof parsed.id === 'string') row = parsed;
      } catch {
        row = undefined;
      }
      if (row === undefined) continue;
      if (row.op === 'submit') {
        if (this.tasks.has(row.task.id)) continue; // live 胜出:本实例已在账的条目不被账本回填覆盖
        const orphan = row.task.status === 'running' && row.pid !== process.pid;
        const t: BackgroundTask = orphan
          ? { ...row.task, status: 'stopped', endedAt: Date.now() }
          : { ...row.task };
        this.tasks.set(t.id, t);
      } else {
        const t = this.tasks.get(row.id);
        if (t !== undefined && t.status === 'running') {
          t.status = row.status;
          t.endedAt = row.endedAt;
          if (row.exitCode !== undefined) t.exitCode = row.exitCode;
        }
      }
    }
  }

  /** 会话身份收养（2026-10-24 严重 bug 修复）：daemon 会话 sun-id 每次打开都新铸（journalId 才是
   *  稳定身份）——账本路径由 attachJournal 以 journalId 推导后此处收养（装载回放+后续追加切到该
   *  文件）。幂等：重复收养同文件,重放对已在账条目零副作用（live 胜出+终态守卫） */
  adoptLedger(file: string): void {
    this.ledgerPath = file;
    this.replayLedger(file);
  }

  /** 账本追加（尽力落档）：写失败不影响任务运行面（journal 同口径） */
  private appendLedger(row: TaskLedgerRow): void {
    if (this.ledgerPath === undefined) return;
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      fs.appendFileSync(this.ledgerPath, JSON.stringify(row) + '\n', 'utf8');
    } catch {
      // 尽力落档:账本写失败不回滚任务提交/终态
    }
  }

  /** owner 作用域：fn 执行期内 submit 缺省归属 owner（fork 收割记账，规格 D9） */
  runInOwnerScope<T>(owner: string, fn: () => T): T {
    return ownerStorage.run(owner, fn);
  }

  currentOwner(): string {
    return ownerStorage.getStore() ?? 'main';
  }

  submit(input: { kind: 'exec' | 'subagent'; label: string; ownerRun?: string }): BackgroundTask {
    const gen = (): string =>
      `${slugify(input.label, { max: 16, fallback: input.kind })}-${utcCompactStamp()}-${Math.random().toString(36).slice(2, 6)}`;
    let id = gen();
    while (this.tasks.has(id) || fs.existsSync(path.join(this.tasksDir, 'tasks', `${id}.log`))) id = gen();
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
    this.appendLedger({ op: 'submit', pid: process.pid, task });
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
    t.endedAt = Date.now();
    if (opts?.exitCode !== undefined) t.exitCode = opts.exitCode;
    this.appendLedger({
      op: 'finish',
      id: taskId,
      status,
      endedAt: t.endedAt,
      ...(opts?.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    });
    return t;
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }



  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * id 归一单点(task_wait/task_stop 共用):模型按板 id/委派 id 调等待与停止是高频调用形态(真机
   * t5,t6,t7,t8 全量报错)。台账 id=slug(label)+ts+rand,板任务 label=dispatchTag(板 id):
   * - 旧 tN 恢复档:标签 task-tN → 台账 id 形如 task-tN-<ts>-<rand>,按 task-tN- 前缀命中;
   * - 新方言(2026-10-19「t1/t2 无意义」裁决)task-<业务段>-<随机码>:标签=板 id,台账 id 再带
   *   时间戳随机尾,且台账业务段截 16(slug 方言)——板 id 超长时按其 slug16 前缀唯一命中;
   *   多命中取最近提交(重派发后旧条目让位);
   * 直接命中优先;无前缀命中原样透传由调用面报 INVALID_ARG
   */
  resolveId(id: string): string {
    if (this.tasks.has(id)) return id;
    const legacy = /^(?:task-)?(t\d+)$/.exec(id);
    const modern = /^task-[a-z0-9][a-z0-9-]*-[a-z0-9]{4}$/.exec(id);
    let prefix: string | null = null;
    if (legacy !== null) prefix = `task-${legacy[1]}-`;
    else if (modern !== null) {
      // 台账业务段截 16(slug 方言):板 id 超 16 时台账 id 以其 slug16 形态存在,前缀照 slug16 取
      const short = slugify(id, { max: 16, fallback: '' });
      prefix = `${short.length > 0 ? short : id}-`;
    }
    if (prefix !== null) {
      const hits = this.list().filter((t) => t.id.startsWith(prefix));
      if (hits.length > 0) return hits.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)).id;
    }
    return id;
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
