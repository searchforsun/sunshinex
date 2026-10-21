import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';

/** 挂起适配器(同 daemon.gui-state.test.ts 惯例):模型调用永挂直至 signal 中止——running 409
 *  门禁的在飞 run 模拟 */
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

/** 2026-10-21 归档面钉测:/session/:id/archive 双寻址(daemon 会话 id / journalId)——running 409、
 *  未知 404、archived:false 撤销;/sessions 与 /sessions/recent 滤除 archived===true;
 *  GET /sessions/archived 跨工作区聚合(slug 来源标注)。样板(AUTH/withDaemon/HangingAdapter)
 *  逐字自 daemon.gui-state.test.ts;状态轮询同其惯用法(GET snapshot status===want,HTTP 面)。 */

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' } as Record<string, string>;

/** 会话状态轮询(GET /session/:id/snapshot status===want) */
async function waitStatus(base: string, sessionId: string, want: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${base}/session/${sessionId}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
    if (((await r.json()) as { status: string }).status === want) return;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 环境隔离样板(同 daemon.workspace.test.ts):钉 PROJECTS_DIR、摘 DATA_DIR(工作区语义成立) */
async function withDaemon(model: ModelAdapter, fn: (ctx: { base: string; tmp: string; daemon: GuiDaemon }) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-arch-'));
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

test('archive:daemon 会话 id 与 journalId 双寻址均可打标;撤销回 false;未知 404', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, tmp }) => {
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    await waitStatus(base, sessionId, 'idle');
    const jid = fs.readdirSync(path.join(resolveDataDir(tmp), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');

    // daemon 会话 id 寻址
    const r1 = await fetch(`${base}/session/${sessionId}/archive`, { method: 'POST', headers: AUTH, body: JSON.stringify({}) });
    assert.equal(r1.status, 200);
    assert.deepEqual((await r1.json()) as { archived: boolean }, { ok: true, archived: true });

    // journalId 寻址(撤销)
    const r2 = await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: JSON.stringify({ archived: false }) });
    assert.equal(r2.status, 200);
    assert.deepEqual((await r2.json()) as { archived: boolean }, { ok: true, archived: false });

    // 未知 id
    const r3 = await fetch(`${base}/session/20261021T000000Z-none/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(r3.status, 404);
  });
});

test('archive:running 会话 409(先停再归档,与 delete 同门禁);journalId 寻址同拒', async () => {
  await withDaemon(new HangingAdapter(), async ({ base, tmp }) => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: 'hang' }) });
    await waitStatus(base, sessionId, 'running');

    const r1 = await fetch(`${base}/session/${sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(r1.status, 409, 'running 会话 id 归档拒');
    const jid = fs.readdirSync(path.join(resolveDataDir(root), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');
    const r2 = await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(r2.status, 409, 'running journalId 归档拒');
  });
});

test('列表滤除:archived 会话退出 /sessions 与 /sessions/recent;GET /sessions/archived 跨工作区聚合', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, tmp }) => {
    // 默认锚点工作区(RECENTS 只收默认锚点命名——root 取 sunshinex-default,滤除断言才非空转)
    const root = path.join(tmp, 'sunshinex-default');
    fs.mkdirSync(root, { recursive: true });
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    await waitStatus(base, sessionId, 'idle');
    const jid = fs.readdirSync(path.join(resolveDataDir(root), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');
    // 前置:归档前两列表都在(滤除断言非空转——行缺席只能归档滤除所致)
    const before = (await (await fetch(`${base}/sessions?root=${encodeURIComponent(root)}`, { headers: AUTH })).json()) as Array<{ id: string }>;
    assert.equal(before.some((r) => r.id === jid), true, '归档前主列表在');
    const recentBefore = (await (await fetch(`${base}/sessions/recent`, { headers: AUTH })).json()) as Array<{ id: string }>;
    assert.equal(recentBefore.some((r) => r.id === jid), true, '归档前 RECENTS 在');
    await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: '{}' });

    const sessions = (await (await fetch(`${base}/sessions?root=${encodeURIComponent(root)}`, { headers: AUTH })).json()) as Array<{ id: string }>;
    assert.equal(sessions.some((r) => r.id === jid), false, '主列表滤除归档');
    const recent = (await (await fetch(`${base}/sessions/recent`, { headers: AUTH })).json()) as Array<{ id: string }>;
    assert.equal(recent.some((r) => r.id === jid), false, 'RECENTS 滤除归档');
    const archived = (await (await fetch(`${base}/sessions/archived`, { headers: AUTH })).json()) as Array<{ id: string; slug: string; archivedAt: number }>;
    assert.equal(archived.some((r) => r.id === jid), true, '归档列表在');
    assert.equal(archived[0]!.slug.length > 0, true, '来源 slug 标注');
  });
});
