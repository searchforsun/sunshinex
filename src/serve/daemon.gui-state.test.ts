import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
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

test('/app/gui-state:应用级指针档往返(恢复现场入口),落 <projectsRoot>/gui/ui-state.json', async () => {
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
