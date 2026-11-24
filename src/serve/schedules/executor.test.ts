import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScheduleStore } from './store';
import { ScheduleExecutor } from './executor';
import { defaultScratchRoot } from '../session-lifecycle';
import type { CreateSessionOpts } from '../session-lifecycle';
import type { ScheduleJob } from './model';
import type { RunEndInfo } from '../session';

type FakeSubmit = { ok: true } | { ok: false; status: 409; error: string };

class FakeSession {
  attachedJournalId = 'jid1';
  dataDir: string;
  effort = '';
  effortCalls: string[] = [];
  /** false=该档位被拒（非 medium）——模拟 setEffort 的非法/不可用返回 */
  rejectEffort = false;
  submitted: string[] = [];
  submitResult: FakeSubmit = { ok: true };
  mintError: Error | undefined;
  private cb?: (info: RunEndInfo) => void;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }
  setEffort(e: string): boolean {
    this.effortCalls.push(e);
    if (this.rejectEffort && e !== 'medium') return false;
    this.effort = e;
    return true;
  }
  ensureJournalMinted(): void {
    if (this.mintError !== undefined) throw this.mintError;
  }
  submit(prompt: string): FakeSubmit {
    if (!this.submitResult.ok) return this.submitResult;
    this.submitted.push(prompt);
    return { ok: true };
  }
  onRunEnd(cb: (info: RunEndInfo) => void): () => void {
    this.cb = cb;
    return () => {
      this.cb = undefined;
    };
  }
  finish(stopReason?: string): void {
    this.cb?.({ stopReason, endedAt: 123, seconds: 2 });
  }
}

function tmpData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-exec-'));
}

function job(over: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: 'j',
    name: '巡检',
    prompt: '检查',
    root: 'default',
    effort: 'high',
    mode: 'full-access',
    recurrence: { unit: 'day', every: 1, at: '09:00' },
    startAt: 1,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runs: [],
    ...over,
  };
}

function jidFiles(dir: string): string[] {
  try {
    return fs.readdirSync(path.join(dir, 'sessions')).filter((f) => f.startsWith('jid1.'));
  } catch {
    return [];
  }
}

test('run：job.model 透传 createSession（per-session 固定模型，不切全局）', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job({ model: 'glm-4.7' });
  store.upsert(j);
  const session = new FakeSession(dir);
  const calls: Array<{ root: string; opts?: CreateSessionOpts }> = [];
  const ex = new ScheduleExecutor(
    {
      createSession: (root, opts) => {
        calls.push({ root, opts });
        return { ok: true, value: { sessionId: 's1' } };
      },
      getSession: () => session as never,
      releaseSession: () => undefined,
      activeSessionId: () => undefined,
    },
    store,
  );
  ex.run(j, 'schedule');
  assert.deepEqual(calls[0]!.opts, { mode: 'full-access', activate: false, model: 'glm-4.7' });
});

test('run：建会话/设强度/标题/提交/记录成功（done→succeeded）', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const session = new FakeSession(dir);
  const released: string[] = [];
  const ex = new ScheduleExecutor({ createSession: () => ({ ok: true, value: { sessionId: 's1' } }), getSession: () => session as never, releaseSession: (id) => released.push(id), activeSessionId: () => undefined }, store);
  const runId = ex.run(j, 'schedule', 5)!;
  assert.ok(runId.startsWith('run-'));
  assert.equal(session.effort, 'high');
  assert.deepEqual(session.submitted, ['检查']);
  const run = store.get('j')!.runs[0]!;
  assert.equal(run.id, runId);
  assert.equal(run.status, 'running');
  assert.equal(run.sessionId, 's1');
  assert.equal(run.journalId, 'jid1');
  assert.equal(run.root, defaultScratchRoot());
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.scheduledAt, 5);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'jid1.meta.json'), 'utf8')) as { title?: string; scheduled?: boolean };
  assert.match(meta.title ?? '', /^巡检 · \d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(meta.scheduled, true, '定时执行会话要打 scheduled 标（侧栏行图标数据源）');
  session.finish('done');
  assert.equal(store.get('j')!.runs[0]!.status, 'succeeded');
  assert.deepEqual(released, []);
});

test('run：create 失败记录 failed，不建会话', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const ex = new ScheduleExecutor({ createSession: () => ({ ok: false, error: { code: 'INVALID_ARG', message: 'root missing' } } as never), getSession: () => undefined, releaseSession: () => undefined, activeSessionId: () => undefined }, store);
  const runId = ex.run(j, 'manual')!;
  const run = store.get('j')!.runs[0]!;
  assert.equal(run.id, runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /root missing/);
  assert.equal(run.sessionId, undefined);
});

test('run：建会话后取不到运行时——释放并记录 failed', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const released: string[] = [];
  const ex = new ScheduleExecutor({ createSession: () => ({ ok: true, value: { sessionId: 's1' } }), getSession: () => undefined, releaseSession: (id) => released.push(id), activeSessionId: () => undefined }, store);
  const runId = ex.run(j, 'manual')!;
  assert.deepEqual(released, ['s1']);
  const run = store.get('j')!.runs[0]!;
  assert.equal(run.id, runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /session not found/);
});

test('run：submit 失败释放会话、清出生档/meta 并记录 failed', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', 'jid1.jsonl'), '{"t":"header"}\n', 'utf8');
  const session = new FakeSession(dir);
  session.submitResult = { ok: false, status: 409, error: 'run in progress' };
  const released: string[] = [];
  const ex = new ScheduleExecutor({ createSession: () => ({ ok: true, value: { sessionId: 's1' } }), getSession: () => session as never, releaseSession: (id) => released.push(id), activeSessionId: () => undefined }, store);
  const runId = ex.run(j, 'manual')!;
  assert.ok(runId.startsWith('run-'));
  assert.deepEqual(released, ['s1']);
  assert.deepEqual(jidFiles(dir), [], '出生 journal/meta 应被清除');
  const run = store.get('j')!.runs[0]!;
  assert.equal(run.id, runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'run in progress');
});

test('run：root default 解析 + mode/activate 透传 + setEffort', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const session = new FakeSession(dir);
  const calls: Array<{ root: string; opts?: CreateSessionOpts }> = [];
  const ex = new ScheduleExecutor({
    createSession: (root, opts) => {
      calls.push({ root, ...(opts !== undefined ? { opts } : {}) });
      return { ok: true, value: { sessionId: 's1' } };
    },
    getSession: () => session as never,
    releaseSession: () => undefined,
    activeSessionId: () => undefined,
  }, store);
  const runId = ex.run(j, 'manual')!;
  assert.ok(runId.startsWith('run-'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.root, defaultScratchRoot());
  assert.deepEqual(calls[0]!.opts, { mode: 'full-access', activate: false });
  assert.equal(session.effort, 'high');
  const j2 = job({ id: 'j2', root: dir });
  store.upsert(j2);
  ex.run(j2, 'manual');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.root, dir, '非 default 字面 root 原样透传');
  assert.deepEqual(calls[1]!.opts, { mode: 'full-access', activate: false });
});

test('run：setEffort 拒收 → 回落 medium（spec §6.6 防御）', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const session = new FakeSession(dir);
  session.rejectEffort = true;
  const ex = new ScheduleExecutor({ createSession: () => ({ ok: true, value: { sessionId: 's1' } }), getSession: () => session as never, releaseSession: () => undefined, activeSessionId: () => undefined }, store);
  ex.run(j, 'manual');
  assert.deepEqual(session.effortCalls, ['high', 'medium']);
  assert.equal(session.effort, 'medium');
  assert.deepEqual(session.submitted, ['检查'], '强度回落不挡提交');
});

test('run：onRunEnd 映射 done→succeeded / interrupted→stopped / 其它→failed', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const sessions = new Map<string, FakeSession>();
  let seq = 0;
  const ex = new ScheduleExecutor({
    createSession: () => {
      const id = `s${++seq}`;
      sessions.set(id, new FakeSession(dir));
      return { ok: true, value: { sessionId: id } };
    },
    getSession: (id) => sessions.get(id) as never,
    releaseSession: () => undefined,
    activeSessionId: () => undefined,
  }, store);
  const rec = (id: string) => store.get('j')!.runs.find((r) => r.id === id)!;
  const done = ex.run(j, 'manual')!;
  sessions.get('s1')!.finish('done');
  assert.equal(rec(done).status, 'succeeded');
  assert.equal(rec(done).endedAt, 123);
  assert.equal(rec(done).seconds, 2);
  assert.equal(rec(done).error, undefined);
  const stopped = ex.run(j, 'manual')!;
  sessions.get('s2')!.finish('interrupted');
  assert.equal(rec(stopped).status, 'stopped');
  assert.equal(rec(stopped).error, undefined);
  const modelError = ex.run(j, 'manual')!;
  sessions.get('s3')!.finish('model-error');
  assert.equal(rec(modelError).status, 'failed');
  assert.equal(rec(modelError).error, 'model-error');
  const noReason = ex.run(j, 'manual')!;
  sessions.get('s4')!.finish(undefined);
  assert.equal(rec(noReason).status, 'failed');
  assert.equal(rec(noReason).error, 'run failed');
});

test('LRU：>10 个已结束运行时释放最旧且跳过 active', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const released: string[] = [];
  let active: string | undefined = 's-active';
  const sessions = new Map<string, FakeSession>();
  let seq = 0;
  const ex = new ScheduleExecutor({
    createSession: () => { const id = `s${++seq}`; sessions.set(id, new FakeSession(dir)); return { ok: true, value: { sessionId: id } }; },
    getSession: (id) => sessions.get(id) as never,
    releaseSession: (id) => released.push(id),
    activeSessionId: () => active,
  }, store);
  for (let i = 0; i < 11; i++) { ex.run(j, 'manual'); sessions.get(`s${i + 1}`)!.finish('done'); }
  assert.equal(released.length, 1);
  assert.notEqual(released[0], active);
});

test('LRU：active 正是最旧保留运行时时，释放次旧（active 永不释放）', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  const released: string[] = [];
  let active: string | undefined;
  const sessions = new Map<string, FakeSession>();
  let seq = 0;
  const ex = new ScheduleExecutor({
    createSession: () => { const id = `s${++seq}`; sessions.set(id, new FakeSession(dir)); return { ok: true, value: { sessionId: id } }; },
    getSession: (id) => sessions.get(id) as never,
    releaseSession: (id) => released.push(id),
    activeSessionId: () => active,
  }, store);
  for (let i = 0; i < 10; i++) { ex.run(j, 'manual'); sessions.get(`s${i + 1}`)!.finish('done'); }
  assert.deepEqual(released, []);
  active = 's1'; // 最旧保留运行时即 daemon active
  ex.run(j, 'manual');
  sessions.get('s11')!.finish('done');
  assert.deepEqual(released, ['s2'], '跳过 active s1，释放次旧 s2');
});

test('run：ensureJournalMinted/meta 写失败也不抛，释放并记录 failed', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  // a) ensureJournalMinted 抛错
  const mintSession = new FakeSession(dir);
  mintSession.mintError = new Error('mint failed');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', 'jid1.jsonl'), '{"t":"header"}\n', 'utf8');
  const releasedA: string[] = [];
  const exA = new ScheduleExecutor({ createSession: () => ({ ok: true, value: { sessionId: 's1' } }), getSession: () => mintSession as never, releaseSession: (id) => releasedA.push(id), activeSessionId: () => undefined }, store);
  let runId: string | undefined;
  assert.doesNotThrow(() => { runId = exA.run(j, 'manual'); });
  assert.ok(runId !== undefined && runId.startsWith('run-'));
  assert.deepEqual(releasedA, ['s1']);
  assert.deepEqual(jidFiles(dir), []);
  const runA = store.get('j')!.runs[0]!;
  assert.equal(runA.id, runId);
  assert.equal(runA.status, 'failed');
  assert.match(runA.error ?? '', /mint failed/);

  // b) session meta 写失败（dataDir 是文件）
  const notADir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(notADir, 'x', 'utf8');
  const metaSession = new FakeSession(notADir);
  const releasedB: string[] = [];
  const exB = new ScheduleExecutor({ createSession: () => ({ ok: true, value: { sessionId: 's2' } }), getSession: () => metaSession as never, releaseSession: (id) => releasedB.push(id), activeSessionId: () => undefined }, store);
  let runIdB: string | undefined;
  assert.doesNotThrow(() => { runIdB = exB.run(j, 'manual'); });
  assert.ok(runIdB !== undefined && runIdB.startsWith('run-'));
  assert.deepEqual(releasedB, ['s2']);
  const runB = store.get('j')!.runs.find((r) => r.id === runIdB)!;
  assert.equal(runB.status, 'failed');
  assert.notEqual(runB.error, undefined);
});

test('run：通道绑定会话复用（2026-11-25 用户裁定②「定时/唤醒落最新会话」）——提交进复用座(submitExternal),忙=steer,零建席,finish 不释放', () => {
  const dir = tmpData();
  const store = new ScheduleStore(path.join(dir, 'schedules.json'));
  const j = job();
  store.upsert(j);
  // 复用座:通道绑定(带 channelMeta/root)闲态——submitExternal 直提
  const session = new FakeSession(dir);
  (session as unknown as { id: string }).id = 's1'; // 复用座 id(run 记录寻址)
  (session as unknown as { root: string }).root = '/chat/root';
  (session as unknown as { channelMeta: { platform: string; chatId: string } }).channelMeta = { platform: 'feishu', chatId: 'oc-x' };
  const extSubmitted: string[] = [];
  (session as unknown as { submitExternal: (goal: string) => { ok: boolean; status?: number; error?: string } }).submitExternal = (goal) => {
    extSubmitted.push(goal);
    return { ok: true };
  };
  (session as unknown as { steer: (goal: string) => void }).steer = (goal) => {
    session.submitted.push(`steer:${goal}`);
  };
  const created: Array<string | null> = [];
  const released: string[] = [];
  const ex = new ScheduleExecutor({
    createSession: (root) => {
      created.push(root);
      return { ok: true, value: { sessionId: 'fresh' } };
    },
    getSession: () => session as never,
    releaseSession: (id) => released.push(id),
    activeSessionId: () => undefined,
    reuseChannelSession: () => session as never,
  }, store);
  const runId = ex.run(j, 'schedule', 5)!;
  assert.ok(runId.startsWith('run-'));
  assert.equal(extSubmitted.length, 1, 'submitExternal 直提');
  assert.equal(session.submitted.length, 0, '非 steer');
  assert.equal(created.length, 0, '零建席(复用座)');
  const run = store.get('j')!.runs[0]!;
  assert.equal(run.sessionId, 's1');
  assert.equal(run.status, 'running');
  // finish:不进 retained(复用座不释放)
  session.finish('done');
  assert.equal(store.get('j')!.runs[0]!.status, 'succeeded');
  assert.deepEqual(released, [], '复用座永不释放');
  // 忙(409)=steer 排队不丢
  const session2 = new FakeSession(dir);
  (session2 as unknown as { id: string }).id = 's2';
  (session2 as unknown as { root: string }).root = '/chat/root';
  (session2 as unknown as { channelMeta: { platform: string; chatId: string } }).channelMeta = { platform: 'feishu', chatId: 'oc-x' };
  const steered: string[] = [];
  (session2 as unknown as { submitExternal: (goal: string) => { ok: boolean; status?: number; error?: string } }).submitExternal = () => ({ ok: false, status: 409, error: 'run in progress' });
  (session2 as unknown as { steer: (goal: string) => void }).steer = (goal) => steered.push(goal);
  const ex2 = new ScheduleExecutor({
    createSession: () => {
      created.push('should-not-create' as string | null);
      return { ok: true, value: { sessionId: 'fresh2' } };
    },
    getSession: () => session2 as never,
    releaseSession: () => undefined,
    activeSessionId: () => undefined,
    reuseChannelSession: () => session2 as never,
  }, store);
  const id2 = ex2.run(j, 'schedule')!;
  assert.ok(id2.startsWith('run-'));
  assert.deepEqual(steered, ['检查'], '忙=steer 排队不丢');
  assert.equal(created.length, 0, '忙路径同样零建席');
});
