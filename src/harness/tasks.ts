import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { CodedToolError } from './tools';
import { slugify } from '../slug';
import { utcCompactStamp } from '../idstamp';

/** 后台任务记录（后台任务线规格 D2/D3）：账本可选持久化（会话绑定 <dataDir>/tasks/ledger-<journalId>.jsonl，
 *  submit 全量/finish 增量行、装载重放，见 TaskLedgerRow）；缺省纯内存。输出流式追加 <dataDir>/tasks/<id>.log */
export interface BackgroundTask {
  id: string;
  kind: 'exec' | 'subagent';
  label: string;
  /** 任务名(2026-11-07 用户裁定):exec 的 purpose——后台任务页签/等待行显它而非命令原文;缺省回落 label */
  title?: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  outputFilePath: string;
  startedAt: number;
  /** 终态时刻（finish 落定；running 无——GUI 运行时长=(endedAt ?? now)-startedAt） */
  endedAt?: number;
  exitCode?: number;
  /** 取消类型(2026-11-16 用户裁定):仅 stopped 态可能携带;重放自 finish 行 reason/孤儿标定恢复 */
  stopReason?: TaskStopReason;
  ownerRun?: string;
  /** 停止执行单点（exec=进程 kill、subagent=中断线 abort）；提交方挂载，账本透传——kill 与 abort 两类差异收敛在提交方闭包，账本零 kind 分派 */
  stop?: () => void;
  /** 板任务派发登记（2026-11-03 用户裁定「等待团队任务不进后台任务面」）：teammate 执行板任务时
   *  向账本登记 dispatchTag 条目，仅供 task_wait/agent_team_task_wait 等待面与台账回执消费——
   *  GUI 后台任务面（/tasks 端点 + bg-task 直播事件）按此标过滤，团队任务的呈现归任务板。
   *  落在 task 对象随 submit 行持久化，账本重放后仍携带 */
  boardDispatch?: boolean;
  /** 已被 task_wait/agent_team_task_wait 终态回执消费（bg-wake spec §3.1）：只在内存 live 对象置位，
   *  不入账本——重启后 running 行孤儿标 stopped 本就不唤醒 */
  receipted?: boolean;
  /** 继承记录标（2026-11-25 用户裁定「复制任务记录,不复制后台任务板」）：/new 把旧座终态记录并入
   *  新座账本时逐行打标——task_status 等记录面照常可见（历史可溯），GUI 后台任务页签查询面
   *  （handleSessionTasks）按此标过滤：面板只列本会话自己的任务，不整屏继承旧任务 */
  inherited?: boolean;
}

/** 本进程提交的活任务对象(进程级):同一 daemon 内会话 runtime 重建(换模式等)会新建 TaskRegistry
 *  并重放账本——重放若复制出新对象,stop 句柄(进程 kill 闭包)丢失,停止只改账不杀进程(实测 python
 *  服务停后仍监听端口)。同进程 running 行改为复用此处的同一对象:stop/终态在新旧账本间共享 */
const liveTasks = new Map<string, BackgroundTask>();

/** owner 作用域（后台任务线规格 D9）：AsyncLocalStorage 承载 fork 归属，并发 fork 互不串号 */
const ownerStorage = new AsyncLocalStorage<string>();

/** 账本持久化行（2026-10-24 回溯裁定「后台任务与会话绑定,打开可回溯」）：submit 全量行 + finish
 *  增量行,重放重建账本——文件与 **journalId** 绑定（稳定身份;daemon 会话 sun-id 每次打开都新铸,
 *  磁盘绑定不得用它）。submit 行带 pid:重放时 running 行按 pid 判孤儿（异进程=已死→stopped;
 *  同进程=别处活账→保持 running）。stop 句柄不入档（函数不可序列化,JSON.stringify 自然剥离） */
/** 取消类型(2026-11-16 用户裁定「任务取消时记录取消类型」):manual=人为取消(后台任务页签
 *  停止钮,HTTP 直停)/agent=agent 自主取消(task_stop 工具)/cascade=连带停止(owner 收割)/
 *  interrupt=异常中断(重启孤儿自愈标定,中断唤醒唯一推导源) */
export type TaskStopReason = 'manual' | 'agent' | 'cascade' | 'interrupt';

type TaskLedgerRow =
  | { op: 'submit'; pid: number; task: BackgroundTask }
  | { op: 'finish'; id: string; status: 'done' | 'failed' | 'stopped'; endedAt: number; exitCode?: number; reason?: TaskStopReason }
  | { op: 'ack-interrupt'; ids: string[] };

// id 业务段方言：label ASCII 化 slug ≤16 字符（正则链单点 src/slug.ts）；CJK 等非拉丁标签全折叠
// 回退 kind（业务全称由 /tasks label 列与任务日志承载，id 段只做可读助记）

/** 统一任务账本单点（后台任务线规格 D1/D10）：ID 空间/生命周期/状态统一承载；进程内 Map 为运行时真相，
 *  可选账本持久化（构造装载/adoptLedger 收养，见 TaskLedgerRow）。
 *  ID=「业务段-时间段-随机段」（2026-10-03 用户裁决「b1 b2 没有业务和时间含义，容易重复」）：旧 b1
 *  进程计数器每会话归零，跨会话同 id 建档即 writeFileSync 截断覆盖旧任务日志=真数据损失；新方言对标
 *  newSessionId（UTC 紧凑时间戳+4 位随机尾），跨会话唯一且一眼可读「何时启动了什么」，撞 id 再生成兜底 */
export class TaskRegistry {
  private readonly tasks = new Map<string, BackgroundTask>();
  /** 重启孤儿 stopped 行 id 集（2026-11-15 sunx P2 Task 5,R9 恢复轮触发清单推导源）：账本重放时
   *  「异进程且仍 running」被标 stopped 的行——崩溃遗留的派发任务（优雅停机 stopAll 落 finish 行者
   *  不在此列）。读面推导缓存非生产状态：仅内存、随实例生灭、重放逐次并集（已终态行零副作用），
   *  零盘面写入 */
  private readonly restartStoppedIds = new Set<string>();
  /** 已消费的异常中断 id(ack-interrupt 行重放恢复+内存即时):restartOrphans 读面排除 */
  private readonly restartAckedIds = new Set<string>();
  /** 运行态变更旁路(submit/finish 后触发;装载/adopt 重放零回调——避免开会话刷屏) */
  private onChange?: (task: BackgroundTask) => void;
  /** 停止通知缝（2026-11-21 用户需求「任务在待答期间被停止/重启时,主对话留一行审计」）：
   *  finish(stopped) 时回调——宿主据此取消该任务的待答提问并留痕；与 onChange 分立不抢占 */
  private stopNotifier?: (task: BackgroundTask) => void;

  constructor(
    private readonly tasksDir: string,
    /** 账本路径(可选):构造即装载——稳定身份由调用方保证(journalId 推导;daemon 走 adoptLedger
     *  收养,因 sun-id 每次打开新铸不可作磁盘身份)。缺省 undefined = 纯内存既有形态 */
    private ledgerPath?: string,
  ) {
    if (ledgerPath !== undefined) this.replayLedger(ledgerPath);
  }

  /** 装配期挂 live 旁路(须在 adoptLedger 之后——重放不经此口) */
  setStopNotifier(cb: ((task: BackgroundTask) => void) | undefined): void {
    this.stopNotifier = cb;
  }

  setOnChange(cb: ((task: BackgroundTask) => void) | undefined): void {
    this.onChange = cb;
  }

  /** 唤醒提示装配开关（bg-wake spec §4.2 宿主闸①）：daemon/TUI 注入 true，CLI 缺省 false */
  wakeHint?: boolean;

  /** 终态回执消费标记：置 live 对象 receipted（账本零写入） */
  markReceipted(ids: readonly string[]): void {
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (t !== undefined) t.receipted = true;
    }
  }

  /** 板任务终态回执标记：板 id → dispatchTag 标签匹配 boardDispatch 台账行（teammate execute 登记口径） */
  markBoardReceipted(boardIds: readonly string[]): void {
    const tags = new Set(boardIds.flatMap((id) => [id, /^t\d+$/.test(id) ? `task-${id}` : id]));
    for (const t of this.tasks.values()) {
      if (t.boardDispatch === true && tags.has(t.label)) t.receipted = true;
    }
  }

  isReceipted(id: string): boolean {
    return this.tasks.get(id)?.receipted === true;
  }

  /** 账本重放（构造装载与 adoptLedger 共用）：逐行 submit/finish;崩溃截断行/坏行跳过不炸（TeamStore
   *  同教训）。孤儿收口两段：submit 先原样入账、finish 行权威翻转终态；整档回放后再把「异进程且仍
   *  running」标 stopped——若 submit 时先标孤儿 stopped，后续 finish done 会被 running 守卫吞掉
   *  （重启后台任务蓝点变灰、时长漂到墙钟的病根）。同进程 running=同一 daemon 别处活账保持。
   *  已有同 id 活条目（本实例先建的）活条目胜出不回填——live 永远是新真相 */
  private replayLedger(file: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return; // 缺文件(新会话)/读失败:空账本起步,尽力回溯不炸装配
    }
    const foreignRunning = new Set<string>();
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let row: TaskLedgerRow | undefined;
      try {
        const parsed = JSON.parse(line) as TaskLedgerRow;
        if (parsed.op === 'submit' && typeof parsed.task?.id === 'string') row = parsed;
        else if (parsed.op === 'finish' && typeof parsed.id === 'string') row = parsed;
        else if (parsed.op === 'ack-interrupt' && Array.isArray(parsed.ids)) row = parsed;
      } catch {
        row = undefined; // 坏行(崩溃截断/半写)跳过:回放尽力而为,单行不炸装配
      }
      if (row === undefined) continue;
      if (row.op === 'ack-interrupt') {
        for (const id of row.ids) this.restartAckedIds.add(id); // 一次性消化(2026-11-16 用户实测重复拍醒根修):已消费的异常中断不再进恢复素材
        continue;
      }
      if (row.op === 'submit') {
        if (this.tasks.has(row.task.id)) continue; // live 胜出:本实例已在账的条目不被账本回填覆盖
        const live = row.pid === process.pid ? liveTasks.get(row.task.id) : undefined;
        this.tasks.set(row.task.id, live ?? { ...row.task });
        if (row.task.status === 'running' && row.pid !== process.pid) foreignRunning.add(row.task.id);
        else foreignRunning.delete(row.task.id);
      } else {
        const t = this.tasks.get(row.id);
        if (t !== undefined && t.status === 'running') {
          t.status = row.status;
          t.endedAt = row.endedAt;
          if (row.exitCode !== undefined) t.exitCode = row.exitCode;
          if (row.reason !== undefined) t.stopReason = row.reason;
          foreignRunning.delete(row.id); // finish 已权威收口,不再孤儿标
        }
      }
    }
    const now = Date.now();
    for (const id of foreignRunning) {
      const t = this.tasks.get(id);
      if (t !== undefined && t.status === 'running') {
        t.status = 'stopped';
        t.endedAt = now;
        t.stopReason = 'interrupt'; // 取消类型(2026-11-16 用户裁定):重启自愈=异常中断——中断唤醒唯一推导源
        this.restartStoppedIds.add(id); // R9 恢复轮推导源（2026-11-15 sunx P2 Task 5）：自愈产物可观测
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

  submit(input: { kind: 'exec' | 'subagent'; label: string; title?: string; ownerRun?: string; boardDispatch?: boolean }): BackgroundTask {
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
      ...(input.title !== undefined && input.title !== '' ? { title: input.title } : {}),
      status: 'running',
      outputFilePath,
      startedAt: Date.now(),
      ownerRun: input.ownerRun ?? this.currentOwner(),
      ...(input.boardDispatch === true ? { boardDispatch: true } : {}),
    };
    this.tasks.set(id, task);
    liveTasks.set(id, task);
    this.appendLedger({ op: 'submit', pid: process.pid, task });
    this.onChange?.(task);
    return task;
  }

  append(taskId: string, chunk: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    fs.appendFileSync(t.outputFilePath, chunk, 'utf8');
  }

  /** 终态（规格 D3）：带 exitCode 落 [exit N]；带 marker 落 marker 行（subagent 结论/失败补丁行）；否则 [status]；重复终止幂等 */
  finish(taskId: string, status: 'done' | 'failed' | 'stopped', opts?: { exitCode?: number; marker?: string; reason?: TaskStopReason }): BackgroundTask | undefined {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'running') return t;
    const line = opts?.marker ?? (opts?.exitCode !== undefined ? `[exit ${opts.exitCode}]` : `[${status}]`);
    fs.appendFileSync(t.outputFilePath, `${line}\n`, 'utf8');
    t.status = status;
    t.endedAt = Date.now();
    if (opts?.exitCode !== undefined) t.exitCode = opts.exitCode;
    if (opts?.reason !== undefined) t.stopReason = opts.reason; // 取消类型(2026-11-16 用户裁定)
    liveTasks.delete(taskId);
    this.appendLedger({
      op: 'finish',
      id: taskId,
      status,
      endedAt: t.endedAt,
      ...(opts?.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
    });
    if (status === 'stopped') this.stopNotifier?.(t); // 审计缝:宿主取消该任务的待答提问
    this.onChange?.(t);
    return t;
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  /** 重启孤儿 stopped 行读面（2026-11-15 sunx P2 Task 5,R9 恢复轮「打断任务清单」推导源之二）：
   *  账本重放时标 stopped 的异进程 running 孤儿（P1 语义「重启后台任务不唤醒」的产物在此转为
   *  恢复轮可观测清单——attach 序已有信息的读面投影,零新增生产状态） */
  restartOrphans(): BackgroundTask[] {
    return this.list().filter((t) => t.status === 'stopped' && this.restartStoppedIds.has(t.id) && !this.restartAckedIds.has(t.id));
  }

  /** 异常中断一次性消化(2026-11-16 用户实测重复拍醒根修):恢复轮起跑成功后由调用方回执——
   *  ack 行落账本(重放即知)+内存集排除,后续 attach 不再对同批孤儿重复拍醒 */
  ackInterruptOrphans(ids: readonly string[]): void {
    const fresh = ids.filter((id) => this.restartStoppedIds.has(id) && !this.restartAckedIds.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) this.restartAckedIds.add(id);
    this.appendLedger({ op: 'ack-interrupt', ids: fresh });
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
    // 「task <id>」前缀容错(2026-11-17 用户实测「taskid 不对,停止报错重试两次」):exec 转后台/
    //   提交回执原文是「task <id> started / moved to background: task <id>」,模型照抄带前缀形态
    //   传 task_stop/task_wait 的 taskId——剥前缀归一本名,首调即中,免 INVALID_ARG 重试。
    //   台账 id 恒无空格(slug/tN),「task 」带空格前缀不可能 legit,剥离零误伤
    const bare = /^task\s+(.+)$/.exec(id.trim());
    if (bare !== null) id = bare[1]!;
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

  /** ownerRun 收割（规格 D9）：终结该 owner 名下全部未终态（running）——触发 stop 句柄并落
   *  [stopped] 终态行 */
  reap(ownerRun: string): BackgroundTask[] {
    const out: BackgroundTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === 'running' && t.ownerRun === ownerRun) {
        t.stop?.();
        this.finish(t.id, 'stopped', { marker: '[stopped: owner finished]', reason: 'cascade' });
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
   *  轮询 100ms 与既有 appendFileSync 落盘口径同源，零事件依赖零新依赖；不存在的 id 直接过滤。
   *  signal（2026-10-26 立即暂停）：run 中止信号在场即挂监听——用户中断不再等终态/超时，即刻回
   *  settled=false（回执如实显「已中止」面），task_wait 阻塞期(默认 1800s)从不可中断变即时穿透。
   *  收口卫生（2026-10-27 技术债轮）：单一 finish 出口统一摘 abort 监听+清在途 poll timer——
   *  原 settle/timeout 后监听靠 {once:true}+对已 settled promise resolve 空转兜住、中止路径残留
   *  ≤100ms stray timer，行为正确但每次 wait 皆遗挂靠面 */
  waitUntilSettled(taskIds: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ settled: boolean; tasks: BackgroundTask[] }> {
    const deadline = Date.now() + timeoutMs;
    const snapshot = () =>
      taskIds.map((id) => this.tasks.get(id)).filter((t): t is BackgroundTask => t !== undefined);
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = (): void => finish({ settled: false, tasks: snapshot() });
      const finish = (r: { settled: boolean; tasks: BackgroundTask[] }): void => {
        if (done) return;
        done = true;
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        if (timer !== null) clearTimeout(timer);
        resolve(r);
      };
      if (signal !== undefined) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
      }
      const poll = (): void => {
        if (done) return; // 中止路径由 onAbort finish,poll 不再出手
        const ts = snapshot();
        // 空目标（含未知 id 过滤后为空）零等待即回：无等待对象即无事可等，幂等空回执
        if (ts.length === 0 || ts.every((t) => t.status !== 'running')) {
          finish({ settled: true, tasks: ts });
          return;
        }
        if (Date.now() >= deadline) {
          finish({ settled: false, tasks: ts });
          return;
        }
        timer = setTimeout(poll, 100);
      };
      poll();
    });
  }
}

/** 分派回执唤醒提示（bg-wake spec §4.2，已裁定）：可选出路非指令——不否定 task_wait，只告知「提前收轮等唤醒」 */
export const WAKE_HINT =
  ' You need not wait for it within this turn: if nothing else depends on it right now, finish your current work, reply, and end the turn — you will be woken automatically when it completes.';

/** task_wait 回执再引工具名（宿主起轮处 receiptBody 调用复用，避免裸串漂移） */
export const WAKE_HINT_RECEIPT_TOOL = 'task_wait';

/** 回执提示挂载闸（闸① wakeHint 装配 × 闸② 主链归属；板任务分派点恒主链天然满足）：
 *  spawn 回执条件挂载（subagent.ts）与 wakeHintSuffix 共用本单点 */
export function wakeHintGate(tasks: TaskRegistry): boolean {
  return tasks.wakeHint === true && tasks.currentOwner() === 'main';
}

/** 回执提示后缀（三道挂载闸合成点）：宿主闸① wakeHint 装配 × 闸② 主链归属；板任务分派点恒主链天然满足 */
export function wakeHintSuffix(tasks: TaskRegistry): string {
  return wakeHintGate(tasks) ? WAKE_HINT : '';
}
