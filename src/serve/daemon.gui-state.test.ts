import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

/** 挂起适配器(同 daemon.workspace.test.ts 惯例):模型调用永挂直至 signal 中止——运行中刷新
 *  场景的在飞 run 模拟 */
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
import { listSessions } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';
import { validSessionId } from './session-handlers';

/** G14.2xx 面私有态/选择面持久化钉测（CLAUDE.md §13 持久化分层）：
 *  ① /session/:id/gui-state 存取——PUT 落 <slug>/gui/sessions/<id>.json（原子写）,GET 回读;
 *     坏 id 400/非对象 state 400/缺档 {state:null};
 *  ② attach 选择面回放——运行中 setMode/setEffort 即刻落 meta 旁车,新 daemon 重建会话后
 *     attach 按档归位（重启/重开不再回落装配缺省——此前三面只驻内存的审计缺口）。 */

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 环境隔离样板（同 daemon.workspace.test.ts）：钉 PROJECTS_DIR、摘 DATA_DIR（工作区语义成立） */
async function withDaemon(model: ModelAdapter, fn: (ctx: { base: string; tmp: string; daemon: GuiDaemon }) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-gs-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  const daemon = new GuiDaemon({ model });
  const handle = await daemon.start({ port: 0, token: 'test-token' });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    await fn({ base, tmp, daemon });
  } finally {
    await handle.close();
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
  }
}

test('gui-state:档键=journalId(跨重启稳定);未附 journal 写透 no-op;附后落 <slug>/gui/sessions/<journalId>.json', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, daemon, tmp }) => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const r = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
    const { sessionId } = (await r.json()) as { sessionId: string };

    // 未附 journal(纯新会话):PUT no-op 不落盘(防孤儿档按发号 id 堆积),GET {state:null}
    const state = { v: 1, tabs: [{ uid: 'file:a.ts', type: 'file', params: { path: 'a.ts' }, createdAt: 1 }], activeUid: 'file:a.ts', collapsed: false, width: 520, recentClosed: [] };
    let resp = await fetch(`${base}/session/${sessionId}/gui-state`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ state }) });
    assert.deepEqual(await resp.json(), { ok: true, persisted: false }, '未附 journal 写透 no-op');
    resp = await fetch(`${base}/session/${sessionId}/gui-state`, { headers: { authorization: 'Bearer test-token' } });
    assert.deepEqual(await resp.json(), { state: null });

    // 跑一轮 → journal 附上:档键切 journalId(重启后新会话 id attach 同档即取回)
    resp = await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: 'run' }) });
    assert.equal(resp.status, 202);
    await waitFor(() => daemon.get(sessionId)!.status() === 'idle', 20_000);
    const journalId = daemon.get(sessionId)!.attachedJournalId!;
    resp = await fetch(`${base}/session/${sessionId}/gui-state`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ state }) });
    assert.equal(resp.status, 200);
    const dataDir = resolveDataDir(root);
    const file = path.join(path.dirname(dataDir), 'gui', 'sessions', `${journalId}.json`);
    assert.ok(fs.existsSync(file), 'gui/sessions/<journalId>.json 在档(键=journalId)');
    resp = await fetch(`${base}/session/${sessionId}/gui-state`, { headers: { authorization: 'Bearer test-token' } });
    assert.deepEqual((await resp.json()).state, state, 'GET 原样回读');

    // id 形收紧:路径逃逸形在面单测(validSessionId 单点;fetch 会先行归一 .. 故走直测)
    assert.equal(validSessionId('../evil'), false, '路径逃逸拒');
    assert.equal(validSessionId('a/b'), false, '分隔符拒');
    // 非对象 state → 400
    resp = await fetch(`${base}/session/${sessionId}/gui-state`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ state: [1, 2] }) });
    assert.equal(resp.status, 400, '数组 state 拒');
  });
});

test('attach 收编:同 journal 在座(含运行中)→ 返回原会话 id 并丢弃空壳——运行中刷新不再假「已停止」', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-gs3-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const daemon = new GuiDaemon({ model: new HangingAdapter() });
    const handle = await daemon.start({ port: 0, token: 'test-token' });
    const base = `http://127.0.0.1:${handle.port}`;
    try {
      // 会话 s1 跑挂起 run(journal 在档且 attached,运行中)
      let resp = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
      const { sessionId } = (await resp.json()) as { sessionId: string };
      resp = await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: 'hang' }) });
      assert.equal(resp.status, 202);
      await waitFor(() => daemon.get(sessionId)!.status() === 'running', 20_000);
      const journalId = daemon.get(sessionId)!.attachedJournalId!;

      // 运行中刷新:浏览器链 newSession 造空壳 s2 → attach(s2, journal) → **收编**回 s1
      resp = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
      const { sessionId: shellId } = (await resp.json()) as { sessionId: string };
      assert.notEqual(shellId, sessionId, '前置:壳是新 id');
      resp = await fetch(`${base}/session/${shellId}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId }) });
      assert.equal(resp.status, 200);
      assert.equal(((await resp.json()) as { sessionId: string }).sessionId, sessionId, '返回收编后的原会话 id');
      assert.equal(daemon.get(shellId), undefined, '空壳已丢弃');
      assert.equal(daemon.get(sessionId)!.status(), 'running', '在飞 run 原对象未受扰');
      assert.equal(daemon.activeId(), sessionId, '激活切回收编会话');
    } finally {
      await handle.close();
    }
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/app/gui-state:应用级指针档往返(恢复现场入口),落 <userConfigDir>/gui/ui-state.json', async () => {
  // userConfigDir 钉定(隔离):指针档落 <userConfigDir>/gui/ui-state.json——断言「首启无现场」打在
  // 真实盘上,本机 GUI 在跑即恒有指针档,环境敏感假失败;HOME 重定向即整目录隔离
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-gs-pointer-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base }) => {
    const auth = { authorization: 'Bearer test-token' };
    let resp = await fetch(`${base}/app/gui-state`, { headers: auth });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { state: null }, '首启无现场');
    const state = { v: 1, lastRoot: 'D:/ws/demo', lastJournalId: '20261020T055439Z-yhn1' };
    resp = await fetch(`${base}/app/gui-state`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
    assert.equal(resp.status, 200);
    resp = await fetch(`${base}/app/gui-state`, { headers: auth });
    assert.deepEqual(await resp.json(), { state }, '指针档原样回读');
    resp = await fetch(`${base}/app/gui-state`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'nope' }) });
    assert.equal(resp.status, 400, '非对象 state 拒');
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/app/seen:已读档往返(已读/未读态落底层),落 <userConfigDir>/gui/seen.json;坏条目消毒', async () => {
  // userConfigDir 钉定同 /app/gui-state 测试:HOME 重定向即整目录隔离(本机 GUI 在跑不环境敏感)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-gs-seen-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base }) => {
      const auth = { authorization: 'Bearer test-token' };
      let resp = await fetch(`${base}/app/seen`, { headers: auth });
      assert.equal(resp.status, 200);
      assert.deepEqual(await resp.json(), { seen: {} }, '首启无档');
      const seen = { '20261022T115634Z-sy8d': 1700000000000, j2: 1700000001000 };
      resp = await fetch(`${base}/app/seen`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ seen }) });
      assert.equal(resp.status, 200);
      resp = await fetch(`${base}/app/seen`, { headers: auth });
      assert.deepEqual(await resp.json(), { seen }, '原样回读(跨端权威)');
      resp = await fetch(`${base}/app/seen`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ seen: { good: 5, bad: 'x', '': 6, neg: Number.NaN } }) });
      assert.equal(resp.status, 200);
      resp = await fetch(`${base}/app/seen`, { headers: auth });
      assert.deepEqual(await resp.json(), { seen: { good: 5 } }, '坏条目弃置不拒整单(容错口径同 pins)');
      resp = await fetch(`${base}/app/seen`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ seen: 'nope' }) });
      assert.equal(resp.status, 400, '非对象 seen 拒');
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('attach 回放选择面:运行中 setMode/setEffort 落 meta,新 daemon 重建会话 attach 归位', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-gs2-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    // —— daemon A:建会话跑一轮(journal 在档),切 mode=manual + effort=high(即刻落 meta) ——
    const daemonA = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"r1"}']) });
    let handle = await daemonA.start({ port: 0, token: 'test-token' });
    let base = `http://127.0.0.1:${handle.port}`;
    let resp = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
    const { sessionId } = (await resp.json()) as { sessionId: string };
    resp = await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: 'run' }) });
    assert.equal(resp.status, 202);
    await waitFor(() => daemonA.get(sessionId)!.status() === 'idle', 20_000);
    resp = await fetch(`${base}/session/${sessionId}/mode`, { method: 'POST', headers: AUTH, body: JSON.stringify({ mode: 'manual' }) });
    assert.equal(resp.status, 200);
    resp = await fetch(`${base}/session/${sessionId}/effort`, { method: 'POST', headers: AUTH, body: JSON.stringify({ effort: 'high' }) });
    assert.equal(resp.status, 200);
    const journalId = daemonA.get(sessionId)!.attachedJournalId!;
    await handle.close();

    // —— daemon B:同 root 重建会话(新 daemon sessionSeq 复位同 id),attach 按档归位 ——
    const daemonB = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"r2"}']) });
    handle = await daemonB.start({ port: 0, token: 'test-token' });
    base = `http://127.0.0.1:${handle.port}`;
    resp = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
    const { sessionId: sid2 } = (await resp.json()) as { sessionId: string };
    const journals = listSessions(resolveDataDir(root)).filter((j) => j.id === journalId);
    assert.equal(journals.length, 1, '源 journal 在档');
    resp = await fetch(`${base}/session/${sid2}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId }) });
    assert.equal(resp.status, 200, 'attach 应 200');
    // 选择面归位:snapshot.mode=manual + effort=high——重启不再回落缺省(审计缺口闭合)
    resp = await fetch(`${base}/session/${sid2}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
    const snap = (await resp.json()) as { mode?: string; effort?: string };
    assert.equal(snap.mode, 'manual', 'mode 回放');
    assert.equal(snap.effort, 'high', 'effort 回放');
    await handle.close();
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
