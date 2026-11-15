import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { readSessionMeta, sessionsDir } from '../tui/session-journal';
import { resolveDataDir, sunxDomainDir } from '../config/data-dir';

/**
 * sunx 数据源改向（2026-11-15 sunx P3 Task 3）daemon 合同：
 * ①GET /sunx/sessions——扫 sunx 域容器（~/.sunshinex/sunx/<jid>/data）全域 meta 出行
 *   （id=journalId/title/kind 恒 'sunx'/updatedAt，行携出生 meta root；daemon 注册表匹配补
 *   liveSessionId/awaiting/status）；空容器空列；standard 会话不入列、/sessions?root= 不受扰。
 * ②端点收口——rename/title GET/anchors/restore-plan/fork/btw/sides/rewind 对 sunx 会话寻址走
 *   session.dataDir 域外窥（projects 区零落档）；standard 同端点锚字节不变（projects 区落档）。
 * ③memory-stats 域接线（Task 2 移交清偿）——root 命中在座 sunx 会话 → 统计随域。
 */

/** 轮询等待：20ms 片轮询直至 pred 为真，超时抛错（sunx-domain.test 同形） */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 环境钉位（sunx-domain.test 同纪律）：HOME 重定向临时目录（sunx 域容器随 HOME）、
 *  SUNSHINEX_PROJECTS_DIR 钉 tmp、解除 DATA_DIR——缺省推导链真实行走。返回恢复函数 */
function pinSunxEnv(base: string): () => void {
  const home = path.join(base, 'home');
  const projects = path.join(base, 'projects');
  fs.mkdirSync(home, { recursive: true });
  const keys = ['HOME', 'USERPROFILE', 'SUNSHINEX_DATA_DIR', 'SUNSHINEX_PROJECTS_DIR', 'SUNSHINEX_AUTO_MEMORY', 'SUNSHINEX_LEARNED_SKILLS'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = projects;
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** daemon 装配（sunx-domain.test 同形）：staticRoot 指向不存在目录保静态面不挂载 */
async function startDaemon(model: ModelAdapter, base: string): Promise<{ daemon: GuiDaemon; http: string; close: () => Promise<void> }> {
  const daemon = new GuiDaemon({ model, staticRoot: path.join(base, 'dist-gui-absent') });
  const s = await daemon.start({ port: 0, token: 'test-token' });
  return { daemon, http: `http://127.0.0.1:${s.port}`, close: () => s.close() };
}

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

async function newSession(http: string, body: Record<string, unknown>): Promise<{ sessionId: string }> {
  const r = await fetch(`${http}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
  const text = await r.text();
  assert.equal(r.status, 200, `session/new 应 200：${text}`);
  return JSON.parse(text) as { sessionId: string };
}

async function runRound(http: string, daemon: GuiDaemon, sid: string, goal: string): Promise<void> {
  const r = await fetch(`${http}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal }) });
  assert.equal(r.status, 202, 'submit 应 202');
  await waitFor(() => daemon.get(sid)!.status() === 'idle', 15_000);
}

const DONE = (reply: string): string => `{"done":true,"reply":"${reply}"}`;

/** ask_question 卡（session.pending.test 同款 builtin schema 四必填）：运行悬挂在待确认=awaiting 标注源 */
function askCard(question: string, labels: string[]): string {
  return JSON.stringify({
    tool: 'ask_question',
    input: { question, options: labels.map((l) => ({ label: l, description: null })), multiple: null, allowCustom: null },
  });
}

/** GET /sunx/sessions 行族 */
interface SunxRow {
  id: string;
  updatedAt: number;
  title?: string;
  kind: string;
  root?: string;
  liveSessionId?: string;
  awaiting?: boolean;
  status?: string;
}

async function sunxRows(http: string): Promise<SunxRow[]> {
  const r = await fetch(`${http}/sunx/sessions`, { headers: AUTH });
  assert.equal(r.status, 200, '/sunx/sessions 应 200');
  return (await r.json()) as SunxRow[];
}

// ═══════════════ ①域枚举端点：空容器/多域/standard 隔离 ═══════════════

test('① GET /sunx/sessions：空容器空列；多域枚举（id/title/kind 恒 sunx/root 随出生 meta）；standard 会话不入列且 /sessions?root= 不受扰', async () => {
  const base = tmpdir('sunshinex-serve-sunxsrc-a-');
  const restore = pinSunxEnv(base);
  let close: (() => Promise<void>) | undefined;
  try {
    const rootA = path.join(base, 'ws-a');
    const rootB = path.join(base, 'ws-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    const d = await startDaemon(new ScriptedAdapter([DONE('r1'), DONE('r2')]), base);
    close = d.close;
    // 空容器（零域创建）：空列（容器目录不存在=读失败回空，不炸）
    assert.deepEqual(await sunxRows(d.http), [], '空容器返回空列');
    // 多域：两 sunx 各自域 + 一 standard 同 root（对照隔离）
    const { sessionId: sidA } = await newSession(d.http, { root: rootA, kind: 'sunx', name: '域主甲' });
    const jidA = d.daemon.get(sidA)!.attachedJournalId!;
    await runRound(d.http, d.daemon, sidA, '跑一轮');
    const { sessionId: sidB } = await newSession(d.http, { root: rootB, kind: 'sunx', name: '域主乙' });
    const jidB = d.daemon.get(sidB)!.attachedJournalId!;
    const { sessionId: sidStd } = await newSession(d.http, { root: rootA });
    await runRound(d.http, d.daemon, sidStd, '标准一轮');
    const jidStd = d.daemon.get(sidStd)!.attachedJournalId!; // standard 惰性建档：首轮后才铸 id
    // 枚举：恰两行（standard 不入列）；行形同 /sessions 族（kind 恒 sunx、title/root 随出生 meta）
    const rows = await sunxRows(d.http);
    assert.equal(rows.length, 2, `恰两 sunx 行（standard 不入列）：${JSON.stringify(rows.map((r) => r.id))}`);
    const rowA = rows.find((r) => r.id === jidA);
    const rowB = rows.find((r) => r.id === jidB);
    assert.ok(rowA !== undefined && rowB !== undefined, '两域各一行');
    assert.equal(rowA.kind, 'sunx', 'kind 恒 sunx');
    assert.equal(rowB.kind, 'sunx', 'kind 恒 sunx');
    assert.equal(rowA.title, '域主甲', '标题随出生 meta');
    assert.equal(rowB.title, '域主乙', '标题随出生 meta');
    assert.equal(rowA.root, path.resolve(rootA), '行携出生 meta root');
    assert.equal(rowB.root, path.resolve(rootB), '行携出生 meta root');
    assert.equal(typeof rowA.updatedAt, 'number', 'updatedAt 数值（排序键）');
    assert.equal(rowA.status, 'idle', '在座注册表 status 标注');
    assert.equal(rowA.liveSessionId, undefined, '非运行中无 liveSessionId');
    assert.equal(rows.some((r) => r.id === jidStd), false, 'standard journalId 不入列');
    // standard 锚：/sessions?root= 不受扰（projects 区既有一族——sunx 域不混入）
    const std = await (await fetch(`${d.http}/sessions?root=${encodeURIComponent(rootA)}`, { headers: AUTH })).json() as Array<{ id: string }>;
    assert.deepEqual(std.map((r) => r.id), [jidStd], '/sessions?root= 只含 standard 行（字节不变锚）');
    // 收口：teardown 防悬挂 timer
    await d.daemon.get(sidA)!.teardown();
    await d.daemon.get(sidB)!.teardown();
    await d.daemon.get(sidStd)!.teardown();
  } finally {
    await close?.();
    restore();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});

// ═══════════════ ②域枚举端点：live/awaiting/status 标注 ═══════════════

test('② GET /sunx/sessions 标注：运行中行附 liveSessionId+status running+awaiting（ask 挂起）；收束后标注消退', async () => {
  const base = tmpdir('sunshinex-serve-sunxsrc-b-');
  const restore = pinSunxEnv(base);
  let close: (() => Promise<void>) | undefined;
  try {
    const root = path.join(base, 'ws-live');
    fs.mkdirSync(root, { recursive: true });
    const d = await startDaemon(new ScriptedAdapter([askCard('继续前确认', ['a', 'b']), DONE('续')]), base);
    close = d.close;
    const { sessionId: sid } = await newSession(d.http, { root, kind: 'sunx', name: '活体' });
    const jid = d.daemon.get(sid)!.attachedJournalId!;
    await fetch(`${d.http}/session/${sid}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑' }) });
    await waitFor(() => d.daemon.get(sid)!.status() === 'running', 15_000);
    await waitFor(() => (d.daemon.get(sid)!.pendingSnapshot().length > 0), 15_000);
    // 运行中+挂起：liveSessionId/status/awaiting 三标注齐
    const live = (await sunxRows(d.http)).find((r) => r.id === jid);
    assert.ok(live !== undefined, '行在场');
    assert.equal(live.liveSessionId, sid, 'liveSessionId=在座会话 id（运行圆点直比）');
    assert.equal(live.status, 'running', 'status 标注');
    assert.equal(live.awaiting, true, 'awaiting 标注（挂起表非空）');
    // interrupt（挂起回填+停跑）→ idle：标注消退
    const ir = await fetch(`${d.http}/session/${sid}/interrupt`, { method: 'POST', headers: AUTH });
    assert.equal(ir.status, 200);
    await waitFor(() => d.daemon.get(sid)!.status() === 'idle', 15_000);
    const after = (await sunxRows(d.http)).find((r) => r.id === jid);
    assert.equal(after!.liveSessionId, undefined, '收束后 liveSessionId 消退');
    assert.equal(after!.awaiting, undefined, '收束后 awaiting 消退');
    assert.equal(after!.status, 'idle', 'status 跟随');
    await d.daemon.get(sid)!.teardown();
  } finally {
    await close?.();
    restore();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});

// ═══════════════ ③端点收口：sunx 寻址走域，standard 锚不变 ═══════════════

test('③ 端点收口：rename/title GET/anchors/restore-plan/fork/btw/sides/rewind 对 sunx 全走域外窥（projects 区零落档）；standard 同端点照旧落 projects 区', async () => {
  const base = tmpdir('sunshinex-serve-sunxsrc-c-');
  const restore = pinSunxEnv(base);
  let close: (() => Promise<void>) | undefined;
  try {
    const root = path.join(base, 'ws-c');
    fs.mkdirSync(root, { recursive: true });
    const d = await startDaemon(new ScriptedAdapter([DONE('r1'), DONE('btw 回答')]), base);
    close = d.close;
    const { sessionId: sid } = await newSession(d.http, { root, kind: 'sunx', name: '收口体' });
    const ctl = d.daemon.get(sid)!;
    const jid = ctl.attachedJournalId!;
    const domain = sunxDomainDir(jid);
    await runRound(d.http, d.daemon, sid, '先跑一轮');
    const post = async (p: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
      const r = await fetch(`${d.http}${p}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    // rename：落域 meta（旧实现落 resolveDataDir(root)——projects 区零落档即红检）
    const ren = await post(`/session/${sid}/rename`, { title: '改的名' });
    assert.equal(ren.status, 200);
    assert.equal(readSessionMeta(domain, jid).title, '改的名', 'rename 落域 meta');
    // title GET：读域 meta
    const tg = await (await fetch(`${d.http}/session/${sid}/title/get`, { headers: AUTH })).json() as { title?: string; kind?: string };
    assert.equal(tg.title, '改的名', 'title GET 读域 meta');
    assert.equal(tg.kind, 'sunx', 'kind 透出');
    // anchors：读域 journal（先跑一轮→链 task 行即锚）
    const an = await (await fetch(`${d.http}/session/${sid}/anchors`, { headers: AUTH })).json() as { anchors: unknown[] };
    assert.ok(an.anchors.length >= 1, 'anchors 读域 journal 非空');
    // restore-plan：读域 journal（turn=1 之后回退清单，只读面 200 即寻址对）
    const rp = await fetch(`${d.http}/session/${sid}/restore-plan?turn=1`, { headers: AUTH });
    assert.equal(rp.status, 200, 'restore-plan 读域 journal');
    // fork：子档落域（响应 sessionId=换座壳 id；子 journal id=壳 attachedJournalId）
    const fk = await post(`/session/${sid}/fork`, { turn: 1 });
    assert.equal(fk.status, 200, `fork 200：${JSON.stringify(fk.json)}`);
    const forkShell = fk.json.sessionId as string;
    const forkJid = d.daemon.get(forkShell)!.attachedJournalId!;
    assert.ok(forkJid !== undefined && forkJid !== jid, 'fork 子档独立 journalId');
    assert.equal(d.daemon.get(forkShell)!.sessionKind, 'sunx', 'fork kind 继承（子壳出生即 sunx）');
    assert.ok(fs.existsSync(path.join(sessionsDir(domain), `${forkJid}.jsonl`)), 'fork 子档落域');
    // btw：side 旁档落域（branchFrom 落域内新档 + meta.side 标记；btw 走独立回执面不进 /sides 清单）
    const bw = await post(`/session/${sid}/btw`, { question: '顺便问下' });
    assert.equal(bw.status, 200, `btw 200：${JSON.stringify(bw.json)}`);
    const btwId = bw.json.sessionId as string;
    assert.equal(readSessionMeta(domain, btwId).side, true, 'btw side 标记落域 meta');
    assert.ok(fs.existsSync(path.join(sessionsDir(domain), `${btwId}.jsonl`)), 'btw 旁档落域');
    // side fork（/sides 清单数据源）：sideOf/sideSeq 回指落域
    const sf = await post(`/session/${sid}/fork`, { turn: 1, side: true });
    assert.equal(sf.status, 200, `side fork 200：${JSON.stringify(sf.json)}`);
    const sideShell = sf.json.sessionId as string;
    const sideJid = d.daemon.get(sideShell)!.attachedJournalId!;
    assert.equal(readSessionMeta(domain, sideJid).sideOf, jid, 'side fork sideOf 回指落域');
    // sides：清单读域旁档
    const sd = await (await fetch(`${d.http}/session/${sid}/sides`, { headers: AUTH })).json() as Array<{ journalId: string }>;
    assert.ok(sd.some((r) => r.journalId === sideJid), 'sides 清单读域旁档');
    // rewind：替代档落域（回退到轮 1——换座回新 id；响应双 id：sessionId=壳/journalId=替代档）
    const rw = await post(`/session/${sid}/rewind`, { turn: 1 });
    assert.equal(rw.status, 200, `rewind 200：${JSON.stringify(rw.json)}`);
    const rwId = rw.json.journalId as string;
    assert.ok(rwId !== undefined && rwId !== jid, 'rewind 替代档独立 journalId');
    assert.ok(fs.existsSync(path.join(sessionsDir(domain), `${rwId}.jsonl`)), 'rewind 替代档落域');
    assert.equal(readSessionMeta(domain, jid).rewoundTo, rwId, '旧档 rewoundTo 回指（meta 标记落域）');
    // projects 区零落档（收口红检核心）：sunx 全部端点产物无一进 resolveDataDir(root)
    const projData = resolveDataDir(root);
    assert.equal(fs.existsSync(sessionsDir(projData)), false, `projects 区零落档（${sessionsDir(projData)} 不存在）`);
    // standard 锚：同端点族对 standard 会话照旧落 projects 区（字节不变）
    const { sessionId: sidStd } = await newSession(d.http, { root });
    await runRound(d.http, d.daemon, sidStd, '标准一轮');
    const jidStd = d.daemon.get(sidStd)!.attachedJournalId!;
    const renStd = await post(`/session/${sidStd}/rename`, { title: '标准改名' });
    assert.equal(renStd.status, 200);
    assert.equal(readSessionMeta(projData, jidStd).title, '标准改名', 'standard rename 落 projects 区（字节不变）');
    const anStd = await (await fetch(`${d.http}/session/${sidStd}/anchors`, { headers: AUTH })).json() as { anchors: unknown[] };
    assert.ok(anStd.anchors.length >= 1, 'standard anchors 读 projects 区照旧');
    // 收口：teardown 防悬挂 timer
    await d.daemon.get(sidStd)!.teardown();
  } finally {
    await close?.();
    restore();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});

// ═══════════════ ④memory-stats 域接线（Task 2 移交清偿） ═══════════════

test('④ memory-stats 接线：root 命中在座 sunx 会话 → 统计随域（域记忆文件计数出列）；未命中 root 走 projects 区既有推导', async () => {
  const base = tmpdir('sunshinex-serve-sunxsrc-d-');
  const restore = pinSunxEnv(base);
  let close: (() => Promise<void>) | undefined;
  try {
    const rootM = path.join(base, 'ws-m');
    const rootN = path.join(base, 'ws-n');
    fs.mkdirSync(rootM, { recursive: true });
    fs.mkdirSync(rootN, { recursive: true });
    const d = await startDaemon(new ScriptedAdapter([DONE('ok')]), base);
    close = d.close;
    const { sessionId: sid } = await newSession(d.http, { root: rootM, kind: 'sunx', name: '记忆体' });
    const domain = sunxDomainDir(d.daemon.get(sid)!.attachedJournalId!);
    // 域记忆两笔（memoryStats 口径：主目录直属非 MEMORY.md 的 .md 文件数）
    const memDir = path.join(domain, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'a.md'), '---\ntitle: a\n---\nA');
    fs.writeFileSync(path.join(memDir, 'b.md'), '---\ntitle: b\n---\nB');
    // 命中：root 寻址走在座 sunx 会话域（旧实现单参读 projects 区=0 → 本断言红检接线）
    const hit = await (await fetch(`${d.http}/settings/memory-stats?root=${encodeURIComponent(rootM)}`, { headers: AUTH })).json() as { entries: number; lastWriteAt: number | null };
    assert.equal(hit.entries, 2, 'root 命中 sunx 会话 → 统计随域（2 笔域记忆）');
    assert.ok(hit.lastWriteAt !== null, '最近写入随域可读');
    // 未命中：无 sunx 在座的 root → projects 区既有推导（零记忆=零值，字节不变面）
    const miss = await (await fetch(`${d.http}/settings/memory-stats?root=${encodeURIComponent(rootN)}`, { headers: AUTH })).json() as { entries: number; lastWriteAt: number | null };
    assert.deepEqual(miss, { entries: 0, lastWriteAt: null }, '未命中 root 走既有推导');
    await d.daemon.get(sid)!.teardown();
  } finally {
    await close?.();
    restore();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});
