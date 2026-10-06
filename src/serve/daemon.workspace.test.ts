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
 *  /sessions?root= 列档、/dirpicker 目录选择、/session/:id/attach 播种链与转录并续写 journal；
 *  T2 扩：createSession 出生 journal（惰性建档→首 run 链持久）、chain 派生转录播种（msg 缺席兜底，
 *  Ruling 5 零重复）、POST /session/:id/delete 会话回收（running 409/journal 保留） */

/** 挂起适配器（同 session.test.ts 惯例）：模型调用永挂直至 signal 中止——delete「running 409」面的
 *  运行中锁中正模拟 */
class HangingAdapter implements ModelAdapter {
  readonly provider = 'hanging';
  async chat(req: { signal?: AbortSignal }): Promise<never> {
    return new Promise((_, reject) => {
      const signal = req.signal;
      if (signal?.aborted) return reject(new Error('Task interrupted'));
      signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
    });
  }
}

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

test('⑤ createSession 出生 journal（T2）：惰性建档（未 run 零文件）→ submit 一轮 sessions/ 出新档（chain 行、零 msg）；/sessions?root= 列出；第二会话不同 id；attach 重开 → 转录 chain 派生（user `> <goal>` + assistant reply）', { timeout: 30_000 }, async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"首轮完成"}']), async (ctx) => {
    const { base, tmp, daemon } = ctx;
    const root = path.join(tmp, 'root-birth');
    fs.mkdirSync(root, { recursive: true });

    const s1 = await ctx.newSession(root);
    // 惰性建档：未 run 前零文件（空会话不产档案，TUI 惰性先例同构）
    assert.equal(daemon.get(s1)!.attachedJournalId, undefined, '出生 journal 惰性——未 run 无档 id');
    assert.equal(listSessions(resolveDataDir(root)).length, 0, 'sessions 目录零档');

    const r = await fetch(`${base}/session/${s1}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    assert.equal(r.status, 202);
    await waitFor(() => daemon.get(s1)!.status() === 'idle', 20_000);

    const jid = daemon.get(s1)!.attachedJournalId;
    assert.ok(jid, '首 run 后出生 journal 已建档');
    const file = path.join(sessionsDir(resolveDataDir(root)), `${jid}.jsonl`);
    assert.ok(fs.existsSync(file), 'sessions/ 出现新档 jsonl');
    const events = parseJournalFile(file).events;
    assert.equal(events[0]?.t, 'header', '档首 header');
    const chainSteps = events.flatMap((e) => (e.t === 'chain' ? e.steps : []));
    assert.ok(chainSteps.some((s) => s.action === 'task' && s.observation === '跑一轮'), 'task 行在档（observation=goal）');
    assert.ok(chainSteps.some((s) => s.action === 'reply' && s.observation === '首轮完成'), 'reply 行在档');
    assert.equal(events.filter((e) => e.t === 'msg').length, 0, 'daemon 档零 msg 行');

    // Home 侧列档面：/sessions?root= 含新档
    const list = (await (await fetch(`${base}/sessions?root=${encodeURIComponent(root)}`, { headers: AUTH })).json()) as SessionMeta[];
    assert.ok(list.some((m) => m.id === jid), '/sessions?root= 列出新档');

    // 第二会话（同 root 再开）不同 id
    const s2 = await ctx.newSession(root);
    assert.notEqual(s2, s1, '第二会话 id 不同');

    // attach 重开：s2 挂 s1 的档 → 转录 chain 派生（daemon 档无 msg——Ruling 5 兜底路径）
    const att = await fetch(`${base}/session/${s2}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: jid }) });
    assert.equal(att.status, 200, 'attach 重开 200（s2 出生 journal 惰性未建档——守卫不拦）');
    const snap = (await (await fetch(`${base}/session/${s2}/snapshot`, { headers: AUTH })).json()) as { messages: Array<{ kind: string; md: string }> };
    const mds = snap.messages.map((m) => m.md);
    assert.ok(mds.includes('> 跑一轮'), 'chain 派生 user 条（`> <goal>` 引用块，task 行派生）');
    assert.ok(mds.includes('首轮完成'), 'chain 派生 assistant 条（reply 行派生）');
  });
});

test('⑥ attach 播种去重（Ruling 5）：TUI journal msg 行在场 → 转录只含 msg 派生（chain 行不重复派生，长度断言）', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base, tmp } = ctx;
    const root = path.join(tmp, 'root-dedup');
    fs.mkdirSync(root, { recursive: true });
    // 手工 TUI journal：msg 行在场（user/assistant）+ chain 行（task/reply）——msg 优先，chain 派生跳过
    const { id: jid } = makeJournal(root, [
      { t: 'user', text: '旧任务' },
      { t: 'chain', steps: [
        { step: 1, action: 'task', observation: '旧任务' },
        { step: 2, action: 'reply', observation: '链内答复（不应派生）' },
      ] },
      { t: 'msg', item: { role: 'user', text: '旧任务', ts: 1, seq: 1 } },
      { t: 'msg', item: { role: 'assistant', text: '旧答复', ts: 2, seq: 2 } },
    ]);
    const sid = await ctx.newSession(root);
    const att = await fetch(`${base}/session/${sid}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: jid }) });
    assert.equal(att.status, 200);
    const snap = (await (await fetch(`${base}/session/${sid}/snapshot`, { headers: AUTH })).json()) as { messages: Array<{ kind: string; md: string }> };
    assert.equal(snap.messages.length, 2, 'msg 行在场 → 播种恰 msg 派生条数（chain 派生零追加）');
    const mds = snap.messages.map((m) => m.md);
    assert.ok(mds.includes('> 旧任务') && mds.includes('旧答复'), 'msg 派生条在场');
    assert.ok(!mds.includes('链内答复（不应派生）'), 'chain reply 不重复派生');
  });
});

test('⑦ POST /session/:id/delete：idle 删 → 200 + 注册表移出 + active 清 + 再访 404 + journal 文件保留；running 409；未知 :id 404', { timeout: 30_000 }, async () => {
  await withDaemon(new HangingAdapter(), async (ctx) => {
    const { base, tmp, daemon } = ctx;
    const root = path.join(tmp, 'root-del');
    fs.mkdirSync(root, { recursive: true });

    // 未知 :id → 404
    const unknown = await fetch(`${base}/session/s999/delete`, { method: 'POST', headers: AUTH });
    assert.equal(unknown.status, 404, '未知 :id → 404');

    // idle 会话删除（该会话为 active → 删后清 undefined）
    const s1 = await ctx.newSession(root);
    assert.equal(daemon.activeId(), s1, '新建即激活');
    const d1 = await fetch(`${base}/session/${s1}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(d1.status, 200);
    assert.deepEqual(await d1.json(), { ok: true });
    assert.equal(daemon.get(s1), undefined, '注册表已移出');
    assert.equal(daemon.activeId(), undefined, 'active 指向被删会话 → 清 undefined');
    const gone = await fetch(`${base}/session/${s1}/snapshot`, { headers: AUTH });
    assert.equal(gone.status, 404, '删后 :id 访问 404');

    // running 会话删除 → 409；收 run 后删 → 200 且 journal 文件保留
    const s2 = await ctx.newSession(root);
    assert.equal(daemon.activeId(), s2);
    const r = await fetch(`${base}/session/${s2}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '长任务' }) });
    assert.equal(r.status, 202);
    await waitFor(() => daemon.get(s2)!.status() === 'running', 3000);
    const busy = await fetch(`${base}/session/${s2}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(busy.status, 409, '运行中删除 → 409');
    // 收 run：interrupt → idle（出生 journal 已随首条 chain append 建档）
    const it = await fetch(`${base}/session/${s2}/interrupt`, { method: 'POST', headers: AUTH });
    assert.equal(it.status, 200);
    await waitFor(() => daemon.get(s2)!.status() === 'idle', 5000);
    const jid = daemon.get(s2)!.attachedJournalId;
    assert.ok(jid, '出生 journal 已建档（可断言文件保留）');
    const jfile = path.join(sessionsDir(resolveDataDir(root)), `${jid}.jsonl`);
    const d2 = await fetch(`${base}/session/${s2}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(d2.status, 200);
    assert.equal(daemon.get(s2), undefined, 's2 移出注册表');
    assert.equal(daemon.activeId(), undefined, 'active 同步清');
    assert.ok(fs.existsSync(jfile), 'journal 文件保留（磁盘档案非 daemon 生命周期资产）');
    const list = (await (await fetch(`${base}/sessions?root=${encodeURIComponent(root)}`, { headers: AUTH })).json()) as SessionMeta[];
    assert.ok(list.some((m) => m.id === jid), '保留的 journal 仍可被 /sessions 列出（后续 attach 重开可消费）');
  });
});

test('⑧ /session/new mode 白名单：白名单外值 400 {error:"invalid mode"}；manual/dontAsk/缺省 200', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async (ctx) => {
    const { base, tmp } = ctx;
    const root = path.join(tmp, 'root-mode');
    fs.mkdirSync(root, { recursive: true });
    // 白名单外（undefined|dontAsk|manual 之外）→ 400 恒定文案
    for (const mode of ['xxxx', 'auto', '', 42, null]) {
      const r = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root, mode }) });
      assert.equal(r.status, 400, `mode=${JSON.stringify(mode)} 白名单外应 400`);
      assert.deepEqual(await r.json(), { error: 'invalid mode' }, `mode=${JSON.stringify(mode)} 恒定文案`);
    }
    // 白名单内三形态照常 200（manual 透传 / dontAsk 显式 / 缺省）
    for (const mode of ['manual', 'dontAsk', undefined]) {
      const r = await fetch(`${base}/session/new`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ root, ...(mode !== undefined ? { mode } : {}) }),
      });
      assert.equal(r.status, 200, `mode=${String(mode)} 白名单内应 200`);
    }
  });
});
