import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { SessionJournal, listSessions, sessionsDir, parseJournalFile, type JournalEvent, type SessionMeta } from '../tui/session-journal';
import { resolveDataDir, projectsRoot } from '../config/data-dir';

/** T2 工作区注册表 + attach 恢复 + dirpicker：/workspaces 扫描（workspace.json 反解 root）、
 *  /sessions?root= 列档、/dirpicker 目录选择、/session/:id/attach 播种链与转录并续写 journal */

/** 轮询等待（同 daemon.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;

interface Ctx {
  daemon: GuiDaemon;
  base: string;
  tmp: string;
  /** POST /session/new：root 必填，回 sessionId（s<n>） */
  newSession: (root: string) => Promise<string>;
}

/** 环境隔离样板（T2 工作区形态）：钉 SUNSHINEX_PROJECTS_DIR 到本用例 tmp——resolveDataDir 走
 *  <projectsRoot>/<slug>/data 按工作区分档（SUNSHINEX_DATA_DIR 显式覆盖会让全部 root 共用一个
 *  dataDir，工作区语义不成立，故一并摘除）；focused 直跑不经 scripts/run-tests.js 预载，须自隔离 */
async function withDaemon(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ws-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    const daemon = new GuiDaemon({ model });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    const base = `http://127.0.0.1:${s.port}`;
    const newSession = async (root: string): Promise<string> => {
      const r = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
      assert.equal(r.status, 200, 'session/new 应 200');
      const body = (await r.json()) as { sessionId: string };
      return body.sessionId;
    };
    try {
      await fn({ daemon, base, tmp, newSession });
    } finally {
      await s.close();
    }
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData !== undefined) process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 手工 journal 造档（SessionJournal 既有导出）：header 建档 + 给定事件逐条落盘，回档 id 与文件路径 */
function makeJournal(root: string, events: JournalEvent[]): { id: string; file: string } {
  const dataDir = resolveDataDir(root);
  const j = new SessionJournal(dataDir);
  j.start();
  const id = j.currentId!;
  for (const e of events) j.log(e);
  return { id, file: path.join(sessionsDir(dataDir), id + '.jsonl') };
}

interface WorkspaceRow {
  root?: string;
  slug: string;
  mtime: number;
  sessionCount: number;
}

test('① GET /workspaces：createSession 落 workspace.json（root 反解）；历史工作区无档 slug-only；sessionCount=sessions jsonl 数；无 token 401', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base, tmp } = ctx;
    const rootA = path.join(tmp, 'root-a');
    const rootB = path.join(tmp, 'root-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    await ctx.newSession(rootA);
    await ctx.newSession(rootB);
    // root-a 造一份 journal（SessionJournal 既有导出）→ sessionCount=1
    makeJournal(rootA, [{ t: 'user', text: '问一句' }]);

    // 历史工作区（TUI 时代产物）：slug 目录 + data + sessions 档，无 workspace.json → slug-only 行
    const legacySlug = 'legacy-project-deadbeef';
    const legacySess = path.join(projectsRoot(), legacySlug, 'data', 'sessions');
    fs.mkdirSync(legacySess, { recursive: true });
    fs.writeFileSync(path.join(legacySess, 'old.jsonl'), JSON.stringify({ t: 'header', v: 1, id: 'old', createdAt: new Date().toISOString() }) + '\n', 'utf8');

    // 鉴权面：无 token 401
    const noTok = await fetch(`${base}/workspaces`);
    assert.equal(noTok.status, 401, '/workspaces 恒鉴权');

    const r = await fetch(`${base}/workspaces`, { headers: AUTH });
    assert.equal(r.status, 200);
    const rows = (await r.json()) as WorkspaceRow[];

    const aRow = rows.find((x) => x.root === path.resolve(rootA));
    assert.ok(aRow, 'root-a 行的 root 经 workspace.json 反解正确');
    assert.ok(aRow.slug.length > 0, 'slug 非空');
    assert.equal(aRow.sessionCount, 1, 'root-a sessions jsonl 计数');
    assert.ok(typeof aRow.mtime === 'number' && aRow.mtime > 0, 'mtime=dataDir mtime');

    const bRow = rows.find((x) => x.root === path.resolve(rootB));
    assert.ok(bRow, 'root-b 行同样反解');
    assert.equal(bRow.sessionCount, 0, '无 sessions 目录 = 0');

    const legacy = rows.find((x) => x.slug === legacySlug);
    assert.ok(legacy, '历史工作区行在场（slug 目录 + data 存在即列）');
    assert.equal(legacy.root, undefined, '无 workspace.json → root undefined（前端不可 attach）');
    assert.equal(legacy.sessionCount, 1, '历史档计数照常');
  });
});

test('② GET /dirpicker：缺省家目录；自定义路径只列目录且排序；文件/不存在 400；parent 链', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base, tmp } = ctx;
    // 缺省 = 家目录
    const home = (await (await fetch(`${base}/dirpicker`, { headers: AUTH })).json()) as { path: string; parent: string; dirs: string[] };
    assert.equal(home.path, path.resolve(os.homedir()), '缺省 path=家目录');
    assert.equal(home.parent, path.resolve(os.homedir(), '..'), '家目录的 parent');
    for (const d of home.dirs) {
      assert.ok(fs.statSync(path.join(home.path, d)).isDirectory(), `dirs 只含目录：${d}`);
    }
    // 自定义：两子目录 + 一文件 → 只目录、排序
    const p = path.join(tmp, 'dp');
    fs.mkdirSync(path.join(p, 'beta'), { recursive: true });
    fs.mkdirSync(path.join(p, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(p, 'file.txt'), 'x', 'utf8');
    const r = await fetch(`${base}/dirpicker?path=${encodeURIComponent(p)}`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { path: string; parent: string; dirs: string[] };
    assert.equal(body.path, path.resolve(p));
    assert.deepEqual(body.dirs, ['alpha', 'beta'], '只目录 + 排序（文件不进 dirs）');
    assert.equal(body.parent, path.resolve(p, '..'), 'parent=上一级');
    // 非目录 / 不存在 → 400
    const notDir = await fetch(`${base}/dirpicker?path=${encodeURIComponent(path.join(p, 'file.txt'))}`, { headers: AUTH });
    assert.equal(notDir.status, 400, '文件路径 → 400');
    const missing = await fetch(`${base}/dirpicker?path=${encodeURIComponent(path.join(tmp, 'no-such'))}`, { headers: AUTH });
    assert.equal(missing.status, 400, '不存在路径 → 400');
  });
});

test('③ GET /sessions?root=：列 journal（id/updatedAt/firstUser 摘要）；无 root 400', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base, tmp } = ctx;
    const root = path.join(tmp, 'root-c');
    fs.mkdirSync(root, { recursive: true });
    const { id } = makeJournal(root, [{ t: 'user', text: '第一条输入' }]);

    const noRoot = await fetch(`${base}/sessions`, { headers: AUTH });
    assert.equal(noRoot.status, 400, '缺 root → 400');

    const r = await fetch(`${base}/sessions?root=${encodeURIComponent(root)}`, { headers: AUTH });
    assert.equal(r.status, 200);
    const list = (await r.json()) as SessionMeta[];
    const hit = list.find((m) => m.id === id);
    assert.ok(hit, '列表含手工档 id');
    assert.equal(hit.firstUser, '第一条输入', 'firstUser=首条用户输入摘要');
    assert.ok(typeof hit.updatedAt === 'number' && hit.updatedAt > 0, 'updatedAt 在场');
    assert.deepEqual(listSessions(resolveDataDir(root)).map((m) => m.id), list.map((m) => m.id), '与 listSessions 同源同序');
  });
});

test('④ POST /session/:id/attach：播种链与转录；submit 续落 chain 行（不落 msg）；teardown seal snapshots；未知 journalId 400 / 双挂 409', { timeout: 30_000 }, async () => {
  await withDaemon(
    new ScriptedAdapter(['{"phase":"act","tool":"write","input":{"path":"a.txt","content":"new"}}', '{"done":true,"reply":"第二轮完成"}']),
    async (ctx) => {
      const { base, tmp, daemon } = ctx;
      const root = path.join(tmp, 'root-att');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'a.txt'), 'old', 'utf8');
      // 手工 journal：header + user + chain + msg（user/assistant 两行）
      const { id: jid, file } = makeJournal(root, [
        { t: 'user', text: '先前的任务' },
        { t: 'chain', steps: [{ step: 1, action: 'task', observation: '先前的任务' }] },
        { t: 'msg', item: { role: 'user', text: '先前的任务', ts: 1, seq: 1 } },
        { t: 'msg', item: { role: 'assistant', text: '先前的答复', ts: 2, seq: 2 } },
      ]);
      const linesBefore = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).length;

      const sid = await ctx.newSession(root);
      // journalId 未知 → 400
      const nf = await fetch(`${base}/session/${sid}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: 'no-such' }) });
      assert.equal(nf.status, 400, '未知 journalId → 400');
      // journalId 缺省/非法 → 400
      const bad = await fetch(`${base}/session/${sid}/attach`, { method: 'POST', headers: AUTH, body: '{}' });
      assert.equal(bad.status, 400, '缺 journalId → 400');

      const att = await fetch(`${base}/session/${sid}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: jid }) });
      assert.equal(att.status, 200);
      assert.deepEqual(await att.json(), { ok: true, sessionId: sid });
      assert.equal(daemon.activeId(), sid, 'attach 置激活');

      // 双挂 → 409
      const again = await fetch(`${base}/session/${sid}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: jid }) });
      assert.equal(again.status, 409, '同会话二次 attach → 409');

      // 转录播种：snapshot 的 messages 含播种条（user `> ` 引用块 + assistant 原文）
      const snap = (await (await fetch(`${base}/session/${sid}/snapshot`, { headers: AUTH })).json()) as { messages: Array<{ kind: string; md: string }> };
      const mds = snap.messages.map((m) => m.md);
      assert.ok(mds.includes('> 先前的任务'), 'user 播种条（引用块形态）');
      assert.ok(mds.includes('先前的答复'), 'assistant 播种条');
      // 链播种：主链含既有 task 行
      const chainObs = daemon.get(sid)!.runtime.harness.context.chainView().map((s) => s.observation);
      assert.ok(chainObs.includes('先前的任务'), '主链播种（restoreSession 直注入）');

      // submit 一轮 → journal 续落 chain 行（文件尾新增）
      const r = await fetch(`${base}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '再跑一轮' }) });
      assert.equal(r.status, 202);
      await waitFor(() => daemon.get(sid)!.status() === 'idle', 20_000);
      const linesAfter = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).length;
      assert.ok(linesAfter > linesBefore, `journal 文件尾新增行（${linesBefore} → ${linesAfter}）`);
      const events = parseJournalFile(file).events;
      const newSteps = events.flatMap((e): Array<{ step: number; action?: string; observation: string }> => (e.t === 'chain' ? e.steps.filter((s) => s.observation !== '先前的任务') : []));
      assert.ok(newSteps.length > 0, '新 run 的链行续落同 journal');
      assert.equal(newSteps[0].step, 2, '步号续排（restoreSession 按链内最大步号续号，播种行 step=1）');
      assert.ok(newSteps.some((s) => s.observation.includes('write')), 'write 调用行在档');
      assert.ok(newSteps.some((s) => s.action === 'reply' && s.observation === '第二轮完成'), 'reply 行在档');
      assert.equal(events.filter((e) => e.t === 'msg').length, 2, 'daemon 侧只落 chain——msg 行不续写');

      // teardown → journal seal（write 影子快照清单以 snapshots 事件尾追；现场形态=drain 非空才落）
      await daemon.get(sid)!.teardown();
      const sealed = parseJournalFile(file).events;
      const snapEv = sealed.find((e): e is Extract<JournalEvent, { t: 'snapshots' }> => e.t === 'snapshots');
      assert.ok(snapEv, 'teardown seal 落 snapshots 事件');
      assert.equal(snapEv.files.length, 1);
      assert.equal(snapEv.files[0].path, 'a.txt');
    },
  );
});
