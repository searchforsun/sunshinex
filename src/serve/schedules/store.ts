import * as fs from 'node:fs';
import { writeJsonAtomic } from '../../catalog/io';
import * as path from 'node:path';
import { userConfigDir } from '../../config/env';
import { SCHEDULE_RUN_LIMIT } from './model';
import type { RunRecord, ScheduleJob, StoreFile } from './model';

export function schedulesFile(): string {
  const override = process.env.SUNSHINEX_DATA_DIR;
  return path.join(override !== undefined && override !== '' ? path.resolve(override) : userConfigDir(), 'schedules.json');
}

export class ScheduleStore {
  private data: StoreFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  /** 坏档改名落点：`schedules.json` → `schedules.corrupt-<ts>.json`（spec §4.2；同目录，尽力而为） */
  private corruptFile(): string {
    const base = path.basename(this.file);
    const stem = base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
    return path.join(path.dirname(this.file), `${stem}.corrupt-${Date.now()}.json`);
  }

  private load(): StoreFile {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      /* 缺失是常态（首启空库）；其余读失败（权限/类型等）按坏档隔离，绝不阻塞启动 */
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, jobs: [] };
      console.warn('[schedules] unreadable store, starting empty:', e instanceof Error ? e.message : String(e));
      this.quarantine();
      return { version: 1, jobs: [] };
    }
    try {
      const raw = JSON.parse(text) as unknown;
      if (raw === null || typeof raw !== 'object' || (raw as StoreFile).version !== 1 || !Array.isArray((raw as StoreFile).jobs)) {
        throw new Error('unsupported schedules file');
      }
      const jobs = (raw as StoreFile).jobs
        .filter((j) => j !== null && typeof j === 'object' && !Array.isArray(j))
        .map((j) => ({
          ...j,
          runs: (Array.isArray(j.runs) ? j.runs : [])
            .filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && typeof (r as RunRecord).status === 'string')
            .slice(0, SCHEDULE_RUN_LIMIT),
        }));
      return { version: 1, jobs };
    } catch (e) {
      console.warn('[schedules] corrupt store, starting empty:', e instanceof Error ? e.message : String(e));
      this.quarantine();
      return { version: 1, jobs: [] };
    }
  }

  /** 坏档隔离：尽力改名到 `schedules.corrupt-<ts>.json`；失败也按空库启动 */
  private quarantine(): void {
    try {
      fs.renameSync(this.file, this.corruptFile());
    } catch {
      /* 改名失败也按空库启动 */
    }
  }

  list(): ScheduleJob[] {
    return this.data.jobs;
  }

  get(id: string): ScheduleJob | undefined {
    return this.data.jobs.find((j) => j.id === id);
  }

  upsert(job: ScheduleJob): void {
    const i = this.data.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) this.data.jobs[i] = job;
    else this.data.jobs.push(job);
    this.persist();
  }

  patch(id: string, patch: Partial<ScheduleJob>): void {
    const job = this.get(id);
    if (job === undefined) return;
    Object.assign(job, patch);
    this.persist();
  }

  remove(id: string): boolean {
    const i = this.data.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.data.jobs.splice(i, 1);
    this.persist();
    return true;
  }

  addRun(id: string, run: RunRecord): void {
    const job = this.get(id);
    if (job === undefined) return;
    job.runs = [run, ...job.runs].slice(0, SCHEDULE_RUN_LIMIT);
    this.persist();
  }

  patchRun(id: string, runId: string, patch: Partial<RunRecord>): void {
    const job = this.get(id);
    const run = job?.runs.find((r) => r.id === runId);
    if (run === undefined) return;
    Object.assign(run, patch);
    this.persist();
  }

  markInterrupted(now: number): void {
    let changed = false;
    for (const job of this.data.jobs) {
      for (const run of job.runs) {
        if (run.status !== 'running') continue;
        run.status = 'interrupted';
        run.endedAt = now;
        run.error = 'daemon restarted before completion';
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, JSON.stringify(this.data));
    } catch (e) {
      console.error('[schedules] persist failed:', e instanceof Error ? e.message : String(e));
    }
  }
}
