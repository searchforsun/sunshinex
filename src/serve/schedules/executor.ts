import { randomBytes } from 'node:crypto';
import { defaultScratchRoot } from '../session-lifecycle';
import type { CreateSessionOpts } from '../session-lifecycle';
import type { Result } from '../../result';
import type { RunEndInfo, SessionRuntime } from '../session';
import { purgeSession, writeSessionMeta } from '../../session/journal';
import type { RunRecord, RunStatus, RunTrigger, ScheduleJob } from './model';
import type { ScheduleStore } from './store';

const RETAIN_MAX = 10;

/** 执行器对 daemon 的触点面（Task 6 装配注入）：建/取/释放运行时 + 当前 active 会话 + 时钟 */
interface ScheduleExecutorIo {
  createSession(root: string, opts?: CreateSessionOpts): Result<{ sessionId: string }>;
  getSession(id: string): SessionRuntime | undefined;
  releaseSession(id: string): void;
  activeSessionId(): string | undefined;
  now?: () => number;
}

function newRunId(): string {
  return `run-${randomBytes(4).toString('hex')}`;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
/** 标题时间戳（本地墙钟）：`MM-DD HH:mm` */
function stamp(now: number): string {
  const d = new Date(now);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 定时任务执行器（spec §6）：到点建普通会话 → 提交任务 → 记 running 记录 → onRunEnd 回填终态。
 * `run` 是 ScheduleEngine 的 execute 回调；契约要求**绝不抛**（引擎 timer 面不设防，一次异常不得
 * 打断 daemon 调度）：任何失败都落 failed 记录并返回 runId，运行态尽力释放/清理。
 * LRU（spec §6.10）：已结束的运行时最多保留 10 个，超出释放最旧且非 daemon active 的。
 */
export class ScheduleExecutor {
  private readonly now: () => number;
  private readonly retained: Array<{ id: string; endedAt: number }> = [];

  constructor(private readonly io: ScheduleExecutorIo, private readonly store: ScheduleStore) {
    this.now = io.now ?? (() => Date.now());
  }

  run(job: ScheduleJob, trigger: RunTrigger, plannedAt?: number): string | undefined {
    let id: string;
    try {
      id = newRunId();
    } catch {
      return undefined; // 随机源不可用：无可记录标识，宁缺记录不抛
    }
    let startedAt = 0;
    let root = '';
    let sessionId: string | undefined;
    let session: SessionRuntime | undefined;
    let journalId: string | undefined;
    try {
      startedAt = this.now();
      root = job.root === 'default' ? defaultScratchRoot() : job.root;
      const created = this.io.createSession(root, { mode: job.mode, activate: false, ...(job.model !== undefined ? { model: job.model } : {}) });
      if (!created.ok) {
        this.addFailed(id, job, trigger, plannedAt, startedAt, root, created.error.message);
        return id;
      }
      sessionId = created.value.sessionId;
      session = this.io.getSession(sessionId);
      if (session === undefined) {
        this.release(sessionId);
        this.addFailed(id, job, trigger, plannedAt, startedAt, root, 'session not found after create');
        return id;
      }
      // 强度边界（spec §6.6 防御）：非法/不可用档位 setEffort 返回 false——回落 medium，仍失败则
      // 保持会话缺省（提交链不因强度设置失败中断）
      if (!session.setEffort(job.effort)) session.setEffort('medium');
      session.ensureJournalMinted();
      journalId = session.attachedJournalId;
      if (journalId !== undefined) {
        // scheduled=定时任务执行会话标记（2026-11-21）：侧栏会话行在相对时间左侧挂钟面图标
        writeSessionMeta(session.dataDir, journalId, { title: `${job.name} · ${stamp(startedAt)}`, scheduled: true });
      }
      const submitted = session.submit(job.prompt);
      if (!submitted.ok) {
        // 拒收（如 409 运行中）：运行时释放 + 出生档/meta 清除——不留空会话痕迹
        this.release(sessionId);
        this.purge(session.dataDir, journalId);
        this.addFailed(id, job, trigger, plannedAt, startedAt, root, submitted.error);
        return id;
      }
      const run: RunRecord = {
        id,
        trigger,
        ...(plannedAt !== undefined ? { scheduledAt: plannedAt } : {}),
        startedAt,
        status: 'running',
        sessionId,
        ...(journalId !== undefined ? { journalId } : {}),
        root,
      };
      this.store.addRun(job.id, run);
      const sid = sessionId;
      try {
        session.onRunEnd((info) => this.finish(job.id, id, sid, info));
      } catch {
        /* 观测面注册失败不改已受理事实：记录停在 running，daemon 重启对账兜底 */
      }
      return id;
    } catch (e) {
      // 建会话后的任一环节抛错（ensureJournalMinted/meta 写/submit 内部异常等）：尽力收尸再记 failed
      const message = e instanceof Error ? e.message : String(e);
      const jid = journalId ?? session?.attachedJournalId;
      if (sessionId !== undefined) this.release(sessionId);
      if (session !== undefined && jid !== undefined) this.purge(session.dataDir, jid);
      this.addFailed(id, job, trigger, plannedAt, startedAt, root, message);
      return id;
    }
  }

  /** run 收尾回填（spec §6.9）：done→succeeded，interrupted→stopped，其它/异常→failed。
   *  seconds 可为 0（边界拒收）——信息性字段，无正值不变量 */
  private finish(jobId: string, runIdValue: string, sessionId: string, info: RunEndInfo): void {
    const status: RunStatus = info.stopReason === 'done' ? 'succeeded' : info.stopReason === 'interrupted' ? 'stopped' : 'failed';
    try {
      this.store.patchRun(jobId, runIdValue, {
        status,
        endedAt: info.endedAt,
        seconds: info.seconds,
        ...(status === 'failed' ? { error: info.stopReason ?? 'run failed' } : {}),
      });
    } catch {
      /* 落盘已在 store 内兜底；此处再兜 callback 面不向 run teardown 抛 */
    }
    this.retain(sessionId, info.endedAt);
  }

  /** LRU（spec §6.10）：保留至多 RETAIN_MAX 个已结束运行时，释放最旧的非 active；active 永不释放
   *  （全为 active 的极端下宁超留断循环——内存卫生不得牺牲在座会话） */
  private retain(sessionId: string, endedAt: number): void {
    this.retained.push({ id: sessionId, endedAt });
    while (this.retained.length > RETAIN_MAX) {
      let active: string | undefined;
      try {
        active = this.io.activeSessionId();
      } catch {
        active = undefined;
      }
      const idx = this.retained.findIndex((r) => r.id !== active);
      if (idx < 0) return;
      const [old] = this.retained.splice(idx, 1);
      if (old === undefined) return;
      this.release(old.id);
    }
  }

  private release(sessionId: string): void {
    try {
      this.io.releaseSession(sessionId);
    } catch {
      /* 尽力释放：注册表触点异常不得击穿 run 契约 */
    }
  }

  private purge(dataDir: string, journalId: string | undefined): void {
    if (journalId === undefined) return;
    try {
      purgeSession(dataDir, journalId);
    } catch {
      /* 尽力清理出生空档（purge 自身已逐档容错） */
    }
  }

  private addFailed(id: string, job: ScheduleJob, trigger: RunTrigger, plannedAt: number | undefined, at: number, root: string, error: string): void {
    const run: RunRecord = {
      id,
      trigger,
      ...(plannedAt !== undefined ? { scheduledAt: plannedAt } : {}),
      startedAt: at,
      endedAt: at,
      status: 'failed',
      root,
      error,
    };
    try {
      this.store.addRun(job.id, run);
    } catch {
      /* 记录失败不改控制流：run 契约绝不抛 */
    }
  }
}
