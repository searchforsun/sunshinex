import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { parseJournalFile, readSessionMeta, sessionsDir } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';
import type { ScheduleStore } from './schedules/store';

const AUTH = { authorization: 'Bearer t', 'content-type': 'application/json' };

interface Ctx {
  base: string;
  tmp: string;
  daemon: GuiDaemon;
}

/** 装配样板（同 brief；seed 在 GuiDaemon 构造前调用——store 构造期即读 schedules.json，boot 补跑靠此播种）。
 *  schedulesFile 显式注入临时档（终审 finding 7）：裸跑不依赖 SUNSHINEX_DATA_DIR 回落的真实用户档 */
async function withSchedulesDaemon(
  fn: (ctx: Ctx) => Promise<void>,
  seed?: (dataDir: string, tmp: string) => void,
  model?: ModelAdapter,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-daemon-'));
  const dataDir = path.join(tmp, 'data');
  const prevHome = process.env.HOME;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.HOME = tmp;
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  seed?.(dataDir, tmp);
  try {
    const daemon = new GuiDaemon({
      model: model ?? new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
      staticRoot: path.join(tmp, 'dist-gui-absent'),
      schedulesFile: path.join(tmp, 'schedules.json'),
    });
    const s = await daemon.start({ port: 0, token: 't' });
    try {
      await fn({ base: `http://127.0.0.1:${s.port}`, tmp, daemon });
    } finally {
      await s.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* win32 收口后偶发目录锁：不挡断言 */
    }
  }
}

interface RunRow {
  id: string;
  trigger: string;
  status: string;
  sessionId?: string;
  journalId?: string;
  root: string;
  error?: string;
}

interface JobView {
  id: string;
  name: string;
  prompt: string;
  root: string;
  enabled: boolean;
  ended?: boolean;
  nextRunAt: number | null;
  recurrence: { unit: string; every: number; at?: string };
  runCount: number;
  lastRun?: RunRow;
}

function createDraft(tmp: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '巡检',
    prompt: '检查仓库',
    root: tmp,
    effort: 'high',
    mode: 'full-access',
    recurrence: { unit: 'day', every: 1, at: '09:00' },
    startAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

async function createJob(base: string, body: Record<string, unknown>): Promise<JobView> {
  const res = await fetch(`${base}/schedules`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as JobView;
}

/** 轮询 runs 直到 pred 成立（同 daemon 测试 20-30ms 片惯例）；超时抛错带完整 runs 现场 */
async function waitRuns(base: string, id: string, pred: (runs: RunRow[]) => boolean, timeoutMs = 10_000): Promise<RunRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/schedules/${id}/runs`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runs: RunRow[] };
    if (pred(body.runs)) return body.runs;
    if (Date.now() > deadline) throw new Error(`GET runs 超时: ${JSON.stringify(body.runs)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** POST /run 后等首条 run 落终态；失败即带 run.error 断言（会话栈问题现场可见） */
async function runToCompletion(base: string, id: string): Promise<RunRow> {
  const res = await fetch(`${base}/schedules/${id}/run`, { method: 'POST', headers: AUTH });
  assert.equal(res.status, 200);
  const runs = await waitRuns(base, id, (rs) => rs.length > 0 && rs[0]!.status !== 'running');
  const run = runs[0]!;
  assert.equal(run.status, 'succeeded', run.error);
  return run;
}

function journalPath(tmp: string, journalId: string): string {
  return path.join(sessionsDir(resolveDataDir(tmp)), `${journalId}.jsonl`);
}

test('schedules CRUD / enabled / run / records：触发建普通会话并落标题', async () => {
  await withSchedulesDaemon(async ({ base, tmp }) => {
    const list0 = (await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: unknown[]; defaultModel: string; now: number };
    assert.deepEqual(list0.jobs, []);
    assert.ok(typeof list0.defaultModel === 'string');
    assert.ok(typeof list0.now === 'number');

    const startAt = Date.now() + 3_600_000;
    const created = await fetch(`${base}/schedules`, { method: 'POST', headers: AUTH, body: JSON.stringify({
      name: '巡检', prompt: '检查仓库', root: tmp, effort: 'high', mode: 'full-access',
      recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt,
    }) });
    assert.equal(created.status, 200);
    const job = (await created.json()) as JobView;
    assert.equal(job.enabled, true);
    assert.ok(job.nextRunAt !== null && job.nextRunAt > Date.now());

    const off = (await (await fetch(`${base}/schedules/${job.id}/enabled`, { method: 'POST', headers: AUTH, body: JSON.stringify({ enabled: false }) })).json()) as JobView;
    assert.equal(off.enabled, false);
    assert.equal(off.nextRunAt, null);
    const on = (await (await fetch(`${base}/schedules/${job.id}/enabled`, { method: 'POST', headers: AUTH, body: JSON.stringify({ enabled: true }) })).json()) as JobView;
    assert.equal(on.enabled, true);

    const run = (await (await fetch(`${base}/schedules/${job.id}/run`, { method: 'POST', headers: AUTH })).json()) as { runId: string };
    assert.ok(run.runId.startsWith('run-'));

    const runRows = await waitRuns(base, job.id, (rs) => rs.length > 0 && rs[0]!.status !== 'running');
    const runRow = runRows[0]!;
    assert.equal(runRow.status, 'succeeded', runRow.error);
    assert.ok(runRow.journalId !== undefined);
    const meta = readSessionMeta(resolveDataDir(tmp), runRow.journalId!);
    assert.match(meta.title ?? '', /^巡检 · \d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(meta.effort, 'high');
    assert.ok(fs.existsSync(journalPath(tmp, runRow.journalId!)));

    const del = await fetch(`${base}/schedules/${job.id}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    const list1 = (await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: unknown[] };
    assert.deepEqual(list1.jobs, []);
  });
});

test('preview 与非法 draft 400', async () => {
  await withSchedulesDaemon(async ({ base }) => {
    const ok = await fetch(`${base}/schedules/preview`, { method: 'POST', headers: AUTH, body: JSON.stringify({ recurrence: { unit: 'day', every: 1, at: '09:00' }, startAt: Date.now() + 60_000 }) });
    assert.equal(ok.status, 200);
    const next = (await ok.json()) as { next: number[] };
    assert.equal(next.next.length, 3);
    const bad = await fetch(`${base}/schedules/preview`, { method: 'POST', headers: AUTH, body: JSON.stringify({ recurrence: { unit: 'day', every: 1, at: '99:99' }, startAt: 1 }) });
    assert.equal(bad.status, 400);
  });
});

test('boot catch-up：start 补跑一次逾期任务并落会话/标题', async () => {
  const seed = (dataDir: string, tmp: string): void => {
    fs.mkdirSync(dataDir, { recursive: true });
    const now = Date.now();
    const startAt = now - 2 * 3_600_000;
    const job = {
      id: 'sch-catchup',
      name: '补跑',
      prompt: '补跑任务',
      root: tmp,
      effort: 'medium',
      mode: 'full-access',
      recurrence: { unit: 'hour', every: 1 },
      startAt,
      enabled: true,
      createdAt: startAt,
      updatedAt: startAt,
      nextRunAt: now - 3_600_000,
      runs: [],
    };
    fs.writeFileSync(path.join(tmp, 'schedules.json'), JSON.stringify({ version: 1, jobs: [job] }), 'utf8');
  };
  await withSchedulesDaemon(async ({ base, tmp, daemon }) => {
    const runs = await waitRuns(base, 'sch-catchup', (rs) => rs.length > 0 && rs[0]!.status !== 'running');
    assert.equal(runs.length, 1, '补跑应恰好一条记录');
    const run = runs[0]!;
    assert.equal(run.trigger, 'catch-up');
    assert.equal(run.status, 'succeeded', run.error);
    assert.ok(run.sessionId !== undefined);
    assert.ok(run.journalId !== undefined);
    assert.ok(daemon.get(run.sessionId!) !== undefined);
    assert.equal(daemon.activeId(), undefined, '补跑建会话不抢 active');
    const meta = readSessionMeta(resolveDataDir(tmp), run.journalId!);
    assert.match(meta.title ?? '', /^补跑 · \d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(fs.existsSync(journalPath(tmp, run.journalId!)));
    // 补跑后引擎继续布防：任务仍启用且 nextRunAt 已前推到未来
    const list = (await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: JobView[] };
    const view = list.jobs.find((j) => j.id === 'sch-catchup')!;
    assert.equal(view.enabled, true);
    assert.ok(view.nextRunAt !== null && view.nextRunAt > Date.now());
  }, seed);
});

test('PUT /schedules/:id 更新名字与作息并重算 nextRunAt', async () => {
  await withSchedulesDaemon(async ({ base, tmp }) => {
    const created = await createJob(base, createDraft(tmp));
    const nextStart = Date.now() + 7_200_000;
    const res = await fetch(`${base}/schedules/${created.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify(createDraft(tmp, {
        name: '改名后的巡检',
        recurrence: { unit: 'minute', every: 30 },
        startAt: nextStart,
      })),
    });
    assert.equal(res.status, 200);
    const updated = (await res.json()) as JobView;
    assert.equal(updated.name, '改名后的巡检');
    assert.equal(updated.recurrence.unit, 'minute');
    assert.equal(updated.recurrence.every, 30);
    assert.equal(updated.nextRunAt, nextStart, 'nextRunAt 按新作息重算');
    assert.ok(updated.nextRunAt !== null && updated.nextRunAt > Date.now());
    const list = (await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: JobView[] };
    assert.equal(list.jobs.find((j) => j.id === created.id)?.name, '改名后的巡检');
  });
});

test('GET /sessions?root 列表含定时会话标题', async () => {
  await withSchedulesDaemon(async ({ base, tmp }) => {
    const job = await createJob(base, createDraft(tmp));
    const run = await runToCompletion(base, job.id);
    assert.ok(run.journalId !== undefined);
    const qs = new URLSearchParams({ root: tmp });
    const res = await fetch(`${base}/sessions?${qs.toString()}`, { headers: AUTH });
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{ id: string; title?: string; root?: string }>;
    const row = rows.find((r) => r.id === run.journalId);
    assert.ok(row !== undefined, '定时会话应出现在 /sessions 列表');
    assert.match(row!.title ?? '', /^巡检 · \d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

test('DELETE /schedules/:id 回收最近 run 的会话运行时，journal/meta 留盘', async () => {
  await withSchedulesDaemon(async ({ base, tmp, daemon }) => {
    const job = await createJob(base, createDraft(tmp));
    const run = await runToCompletion(base, job.id);
    const sessionId = run.sessionId!;
    const journalId = run.journalId!;
    assert.ok(daemon.get(sessionId) !== undefined, '运行后会话运行时应在册');

    const del = await fetch(`${base}/schedules/${job.id}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    const deadline = Date.now() + 10_000;
    while (daemon.get(sessionId) !== undefined) {
      if (Date.now() > deadline) throw new Error('删除任务后会话运行时未回收');
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(fs.existsSync(journalPath(tmp, journalId)), 'journal 留盘');
    assert.ok(fs.existsSync(path.join(sessionsDir(resolveDataDir(tmp)), `${journalId}.meta.json`)), 'meta 留盘');
    const jobs = (await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: unknown[] };
    assert.deepEqual(jobs.jobs, []);
  });
});

test('GET /schedules 对逾期 nextRunAt 只读重算到未来（不落盘）', async () => {
  await withSchedulesDaemon(async ({ base, tmp, daemon }) => {
    const job = await createJob(base, createDraft(tmp, { startAt: Date.now() + 3_600_000 }));
    // 模拟引擎停摆/定时器在途窗:存量 nextRunAt 落到过去（store 是引擎唯一写者,此处直改内存）
    const store = (daemon as unknown as { scheduleStore: ScheduleStore }).scheduleStore;
    const stale = Date.now() - 60_000;
    store.patch(job.id, { nextRunAt: stale });

    const list = (await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: JobView[]; now: number };
    const view = list.jobs.find((j) => j.id === job.id)!;
    assert.ok(view.nextRunAt !== null, '重算后仍有下一次');
    assert.ok(view.nextRunAt! > Date.now(), `读面应展示未来时刻,实际 ${view.nextRunAt}`);
    assert.equal(store.get(job.id)!.nextRunAt, stale, 'GET 不得改写存储（引擎单写者）');
    // 盘面同证:GET 后档内仍是 stale
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'schedules.json'), 'utf8')) as { jobs: Array<{ id: string; nextRunAt: number }> };
    assert.equal(onDisk.jobs.find((j) => j.id === job.id)!.nextRunAt, stale, 'GET 不落盘');
  });
});

test('DELETE /schedules/:id 回收最新一条带 sessionId 的 run（更新的失败记录无会话不挡回收）', async () => {
  await withSchedulesDaemon(async ({ base, tmp, daemon }) => {
    const job = await createJob(base, createDraft(tmp));
    const first = await runToCompletion(base, job.id);
    const sid = first.sessionId!;
    assert.ok(daemon.get(sid) !== undefined);

    // 更新 root 到不存在目录 → 下一次 run 建席失败,落一条无 sessionId 的 failed 记录成为 runs[0]
    const missing = path.join(tmp, 'missing-root');
    const upd = await fetch(`${base}/schedules/${job.id}`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify(createDraft(missing)),
    });
    assert.equal(upd.status, 200);
    const run = await fetch(`${base}/schedules/${job.id}/run`, { method: 'POST', headers: AUTH });
    assert.equal(run.status, 200);
    const runs = await waitRuns(base, job.id, (rs) => rs.length >= 2 && rs[0]!.status === 'failed');
    assert.equal(runs[0]!.sessionId, undefined, '建席失败记录无会话');

    const del = await fetch(`${base}/schedules/${job.id}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    const deadline = Date.now() + 10_000;
    while (daemon.get(sid) !== undefined) {
      if (Date.now() > deadline) throw new Error('应回收最新一条带会话的 run,旧 run 运行时仍在册');
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(fs.existsSync(journalPath(tmp, first.journalId!)), 'journal 留盘');
  });
});

test('DELETE /schedules/:id 跳过 active 会话（用户正在看的运行时不得被拆）', async () => {
  await withSchedulesDaemon(async ({ base, tmp, daemon }) => {
    const job = await createJob(base, createDraft(tmp));
    const run = await runToCompletion(base, job.id);
    const sid = run.sessionId!;
    // 真流程置 active:新建壳 + attach 同 journal → daemon 收编 run 运行时并置激活
    const shell = daemon.createSession(tmp);
    assert.ok(shell.ok, '壳会话创建成功');
    const attached = daemon.attach(shell.value.sessionId, run.journalId!);
    assert.ok(attached.ok, 'attach 成功');
    assert.equal(daemon.activeId(), sid, 'run 会话已激活');

    const del = await fetch(`${base}/schedules/${job.id}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(daemon.get(sid) !== undefined, 'active 运行时不得被回收');
    assert.equal(daemon.activeId(), sid);
    assert.ok(fs.existsSync(journalPath(tmp, run.journalId!)), 'journal 留盘');
  });
});

test('DELETE /schedules/:id 回收前 deny 未决挂起（pending-resolve denied 落档）', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-pending-out-'));
  try {
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'write', input: { path: path.join(out, 'pending.txt'), content: 'x' } }),
      '{"done":true,"reply":"ok"}',
    ]);
    await withSchedulesDaemon(async ({ base, tmp, daemon }) => {
      const job = await createJob(base, createDraft(tmp, { mode: 'acceptEdits' }));
      const runRes = await fetch(`${base}/schedules/${job.id}/run`, { method: 'POST', headers: AUTH });
      assert.equal(runRes.status, 200);
      const runs = await waitRuns(base, job.id, (rs) => rs.length > 0 && rs[0]!.sessionId !== undefined);
      const run = runs[0]!;
      const sid = run.sessionId!;
      const deadline = Date.now() + 15_000;
      while ((daemon.get(sid)?.pendingSnapshot().length ?? 0) === 0) {
        if (Date.now() > deadline) throw new Error('审批挂起未出现（scripted write 未触发 ask）');
        await new Promise((r) => setTimeout(r, 25));
      }
      const del = await fetch(`${base}/schedules/${job.id}`, { method: 'DELETE', headers: AUTH });
      assert.equal(del.status, 200);
      const gone = Date.now() + 10_000;
      while (daemon.get(sid) !== undefined) {
        if (Date.now() > gone) throw new Error('删除任务后会话运行时未回收');
        await new Promise((r) => setTimeout(r, 25));
      }
      const rows = parseJournalFile(journalPath(tmp, run.journalId!)).events as Array<Record<string, unknown>>;
      assert.ok(
        rows.some((r) => r.t === 'pending-resolve' && r.outcome === 'denied'),
        '回收前应 deny 未决挂起并落 pending-resolve 行',
      );
    }, undefined, model);
  } finally {
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('POST /schedules 非法 draft 400', async () => {
  await withSchedulesDaemon(async ({ base, tmp }) => {
    const res = await fetch(`${base}/schedules`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(createDraft(tmp, { recurrence: { unit: 'day', every: 1, at: '99:99' } })),
    });
    assert.equal(res.status, 400);
    const list = (await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: unknown[] };
    assert.deepEqual(list.jobs, []);
  });
});

test('create_scheduled_task 工具：模型自然语言创建走同一 engine；effort/mode 继承当前会话输入框', async () => {
  const model = new ScriptedAdapter([
    {
      toolCalls: [
        {
          name: 'create_scheduled_task',
          args: {
            name: '晨间巡检',
            prompt: '总结昨天以来的提交并给出风险提示',
            recurrence: { unit: 'day', every: 1, at: '09:00', weekdays: null, day_of_month: null, month: null, day: null },
            start_at: null,
            until: null,
            root: null,
            effort: null,
            mode: null,
          },
        },
      ],
    },
    '{"done":true,"reply":"已创建"}',
  ]);
  await withSchedulesDaemon(async ({ base, tmp }) => {
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    assert.equal(created.status, 200);
    const { sessionId } = (await created.json()) as { sessionId: string };
    // 会话输入框当前选择：高强度 + 只读——工具省参时必须落这两个值（guard 对配置面三档放行，不挂审批）
    assert.equal((await fetch(`${base}/session/${sessionId}/effort`, { method: 'POST', headers: AUTH, body: JSON.stringify({ effort: 'high' }) })).status, 200);
    assert.equal((await fetch(`${base}/session/${sessionId}/mode`, { method: 'POST', headers: AUTH, body: JSON.stringify({ mode: 'read-only' }) })).status, 200);
    const sub = await fetch(`${base}/session/${sessionId}/submit`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ goal: '帮我创建一个每天 9 点的巡检定时任务' }),
    });
    assert.equal(sub.status, 202);

    type Job = { name: string; root: string; prompt: string; effort: string; mode: string; recurrence: Record<string, unknown> };
    let jobs: Job[] = [];
    const deadline = Date.now() + 10_000;
    while (jobs.length === 0) {
      jobs = ((await (await fetch(`${base}/schedules`, { headers: AUTH })).json()) as { jobs: Job[] }).jobs;
      if (jobs.length === 0 && Date.now() > deadline) throw new Error('工具未在 10s 内创建定时任务');
      if (jobs.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.name, '晨间巡检');
    assert.equal(jobs[0]!.prompt, '总结昨天以来的提交并给出风险提示');
    assert.equal(jobs[0]!.root, tmp, 'root 缺省=当前会话工作区');
    assert.deepEqual(jobs[0]!.recurrence, { unit: 'day', every: 1, at: '09:00' });
    assert.equal(jobs[0]!.effort, 'high', 'effort 缺省继承当前输入框');
    assert.equal(jobs[0]!.mode, 'read-only', 'mode 缺省继承当前输入框');
  }, undefined, model);
});
