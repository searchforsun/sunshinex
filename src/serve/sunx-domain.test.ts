import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { parseJournalFile, readSessionMeta, sessionsDir } from '../tui/session-journal';
import { resolveDataDir, sunxDomainDir } from '../config/data-dir';
import { memoryStats } from './config-helpers';
import { Harness } from '../harness';

/**
 * sunx 持久化域（2026-11-15 sunx P3 Task 2）daemon 合同：
 * ①出生即铸档——创建 kind='sunx' 即铸 journalId 并在 `~/.sunshinex/sunx/<jid>/data` 建域
 *   （journal header+ctx-snap+出生 meta 随档）；projects/ 区零条目、/workspaces 零污染；
 *   同 root 双 sunx 两个独立域目录（验收核心场景的目录面）。
 * ②重开链——新 daemon POST /sunx/attach(journalId)：壳出生即 sunx 形态、链回放/品性层在、
 *   定时调度随域重布防（R7 补发）、续写落域内档。
 * ③standard 路径回归锚——workspace.json 注册/惰性建档/路径推导/旧 attach 链全部与今日逐字节同。
 * ④清偿项三断言——memoryStats 域缝/memory_write 接缝注入键置尾/sunx 装配 learnSkills:false。
 * ⑤隔离验收（2026-11-15 sunx P3 Task 4 核心）——同 root 1 standard + 2 sunx：三域目录互不相同
 *   互不包含；sunx A 真实工具面写工作区记忆 → B 域/standard 域文件系统层不存在、读面 0 笔
 *   （记忆随域隔离）；standard 路径/注册/枚举零变化。
 */

/** 轮询等待：20ms 片轮询直至 pred 为真，超时抛错（daemon.contract.test 同形） */
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

/** 环境钉位（config/data-dir.test 首测同纪律）：HOME 重定向临时目录（sunx 域容器 ~/.sunshinex/sunx/
 *  随 HOME）、SUNSHINEX_PROJECTS_DIR 钉 tmp（standard 缺省推导可断言）、解除 DATA_DIR——缺省推导链
 *  真实行走。返回恢复函数 */
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

/** daemon 装配（daemon.contract.test withRestartedDaemon 同形）：staticRoot 指向不存在目录保静态面不挂载 */
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

/** 域内 journal 行读面（测试寻址单点）：parseJournalFile 域档 */
function domainJournalRows(jid: string): Array<Record<string, unknown>> {
  const file = path.join(sessionsDir(sunxDomainDir(jid)), `${jid}.jsonl`);
  return parseJournalFile(file).events as unknown as Array<Record<string, unknown>>;
}

// ═══════════════ ①出生即铸档 + 域目录 + 零污染 + 同 root 多实体 ═══════════════

test('① sunx 出生即铸档：创建即铸 journalId，域目录 sunx/<jid>/data 在（header+ctx-snap+出生 meta 随档）；projects 区零条目、/workspaces 零污染；同 root 双 sunx 独立域', async () => {
  const base = tmpdir('sunshinex-serve-sunxdom-a-');
  const restore = pinSunxEnv(base);
  let close: (() => Promise<void>) | undefined;
  try {
    const root = path.join(base, 'ws-a');
    fs.mkdirSync(root, { recursive: true });
    const d = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), base);
    close = d.close;
    // 创建即铸档（持久化实体语义：出生即存在——零 run 零实质事件也建档；standard 惰性建档不变）
    const { sessionId: sid1 } = await newSession(d.http, { root, kind: 'sunx', name: '域主甲', charter: 'DOMAIN-BIRTH-1' });
    const s1 = d.daemon.get(sid1)!;
    const jid1 = s1.attachedJournalId;
    assert.ok(jid1 !== undefined, '创建即铸 journalId（非惰性）');
    // 域目录 ~/.sunshinex/sunx/<jid>/data 在
    const domain1 = sunxDomainDir(jid1!);
    const home = path.join(base, 'home');
    assert.equal(domain1, path.join(home, '.sunshinex', 'sunx', jid1!, 'data'), '域目录=HOME/.sunshinex/sunx/<jid>/data（单点推导）');
    assert.ok(fs.existsSync(domain1), '域目录出生即在');
    // journal 随档：header（v3/id）+ ctx-snap 出生行（快照冻结起点含品性层）
    const file1 = path.join(sessionsDir(domain1), `${jid1}.jsonl`);
    assert.ok(fs.existsSync(file1), '域内 journal 建档即存在');
    const events = parseJournalFile(file1).events;
    const header = events[0];
    assert.ok(header !== undefined && header.t === 'header' && header.v === 3 && header.id === jid1, '首行=header v3 id=jid');
    const snap = events.find((e) => e.t === 'ctx-snap') as { t: 'ctx-snap'; sig?: { charter?: string } } | undefined;
    assert.ok(snap !== undefined, 'ctx-snap 出生行随档');
    assert.equal(snap!.sig?.charter, 'DOMAIN-BIRTH-1', '出生快照含品性层');
    // 出生 meta 随档（域内旁车）：kind/title/charterRev:1/root（重开寻址源）
    const meta1 = readSessionMeta(domain1, jid1!);
    assert.equal(meta1.kind, 'sunx', '出生 meta kind');
    assert.equal(meta1.title, '域主甲', '出生 meta title');
    assert.equal(meta1.charterRev, 1, '出生 meta charterRev=1');
    assert.equal(meta1.root, path.resolve(root), '出生 meta root=工作区根（重开壳根源）');
    // projects 区零条目（无 workspace.json、无 slug 数据域——sunx 域不进 /workspaces）
    const projects = path.join(base, 'projects');
    const projectEntries = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
    assert.equal(projectEntries.length, 0, 'projects 区零条目（sunx 不注册工作区）');
    const wsRows = (await (await fetch(`${d.http}/workspaces`, { headers: AUTH })).json()) as Array<{ root?: string }>;
    assert.equal(wsRows.some((r) => r.root === path.resolve(root)), false, '/workspaces 无该 sunx 工作区行');
    // 同 root 第二个 sunx：独立域目录（验收核心场景的目录面——零共享由 Task 4 全链 e2e 验）
    const { sessionId: sid2 } = await newSession(d.http, { root, kind: 'sunx', name: '域主乙' });
    const jid2 = d.daemon.get(sid2)!.attachedJournalId;
    assert.ok(jid2 !== undefined && jid2 !== jid1, '第二个 sunx 独立 journalId');
    const domain2 = sunxDomainDir(jid2!);
    assert.notEqual(domain2, domain1, '两个 sunx 两个独立域目录');
    assert.ok(fs.existsSync(path.join(sessionsDir(domain2), `${jid2}.jsonl`)), '第二域 journal 在');
    assert.equal(readSessionMeta(domain2, jid2!).title, '域主乙', '第二域出生 meta 独立');
    // 收口：两域 teardown（防悬挂 timer 拖事件循环）
    await s1.teardown();
    await d.daemon.get(sid2)!.teardown();
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

// ═══════════════ ②重开链 attachSunx ═══════════════

test('② 重开链：新 daemon POST /sunx/attach(journalId)——壳出生即 sunx/链回放/品性层跟编辑文/调度随域补发/续写落域内档；未知 journalId 400', async () => {
  const base = tmpdir('sunshinex-serve-sunxdom-b-');
  const restore = pinSunxEnv(base);
  let close1: (() => Promise<void>) | undefined;
  let close2: (() => Promise<void>) | undefined;
  try {
    const root = path.join(base, 'ws-b');
    fs.mkdirSync(root, { recursive: true });
    // 进程 A：出生铸档 → 实质一轮（链回放素材）→ 品性编辑（编辑文跨重启）→ 台账随档
    const d1 = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']), base);
    close1 = d1.close;
    const { sessionId: sid } = await newSession(d1.http, { root, kind: 'sunx', name: '域主丙', charter: 'REOPEN-CHARTER-1' });
    await runRound(d1.http, d1.daemon, sid, 'probe round one');
    const jid = d1.daemon.get(sid)!.attachedJournalId!;
    const domain = sunxDomainDir(jid);
    const e1 = await fetch(`${d1.http}/session/${sid}/charter`, { method: 'POST', headers: AUTH, body: JSON.stringify({ text: 'REOPEN-CHARTER-2' }) });
    assert.deepEqual(await e1.json(), { ok: true, charterRev: 2 }, '品性编辑 rev2（编辑文落域 meta.charterText）');
    // 台账随档：手落异进程 running 孤儿行（崩溃遗留形态）——重开后由域内账本收养重放（标 stopped）
    const tasksDir = path.join(domain, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, `ledger-${jid}.jsonl`),
      `${JSON.stringify({ op: 'submit', pid: 999_999, task: { id: 'exec-old-0001', kind: 'exec', label: 'old-fork', title: 'old fork', status: 'running', outputFilePath: path.join(tasksDir, 'exec-old-0001.log'), startedAt: Date.now(), ownerRun: 'main' } })}\n`,
      'utf8',
    );
    const rowsBefore = domainJournalRows(jid).length;
    // 手落一枚未触发 wake-schedule 机制行（fireAt 已过=daemon 停机跨越形态——重开后 R7 补发一次）
    fs.appendFileSync(path.join(sessionsDir(domain), `${jid}.jsonl`), `${JSON.stringify({ t: 'wake-schedule', id: 'sched-1', fireAt: Date.now() - 5_000, note: 'domain rearm probe' })}\n`, 'utf8');
    await d1.daemon.get(sid)!.teardown();
    await close1();
    close1 = undefined;

    // 进程 B（真重启）：POST /sunx/attach ——容器按 journalId 定位域 → 壳出生即 sunx → attachSessionIn 全链
    const d2 = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"late reply"}']), base);
    close2 = d2.close;
        const ar = await fetch(`${d2.http}/sunx/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: jid }) });
        const arText = await ar.text();
        assert.equal(ar.status, 200, `attachSunx 应 200：${arText}`);
        const adopted = JSON.parse(arText) as { ok: true; sessionId: string; root: string };
    assert.equal(adopted.root, path.resolve(root), '回执 root=工作区根');
    const b = d2.daemon.get(adopted.sessionId)!;
    assert.equal(b.sessionKind, 'sunx', '重开壳出生即 sunx 形态');
    assert.equal(b.sunxName, '域主丙', '重开姓名随域 meta.title');
    assert.ok(b.transcriptCount() > 0, 'journal 链回放落在重开后运行时');
    // 品性两面（P1 ⑨c 同口径）：读面（charterCurrent）=编辑文跨重启；冻结层=快照回种出生文（编辑
    // 以链上替代行为权威——restoreSnapshot 随签名回种 charterLayer,与 reCast 链逐字节同形）
    assert.equal(b.runtime.harness.context.snapshotExport().sig.charter, 'REOPEN-CHARTER-1', '冻结层=快照出生文（P1 回种语义）');
    assert.ok(b.runtime.harness.tasks.list().some((t) => t.id === 'exec-old-0001'), '域内台账随档收养（孤儿行重放标 stopped）');
    const g = await fetch(`${d2.http}/session/${adopted.sessionId}/charter`, { headers: AUTH });
    assert.deepEqual(await g.json(), { text: 'REOPEN-CHARTER-2', charterRev: 2 }, 'charter 读面跟编辑文+rev 一致');
    // 唤醒调度随域：未触发行重布防 → fireAt 已过=R7 即刻补发一轮（firedAt 终态行落域档）
    await waitFor(() => domainJournalRows(jid).some((r) => r.t === 'wake-schedule' && (r as { id?: string }).id === 'sched-1' && (r as { firedAt?: number }).firedAt !== undefined), 10_000);
    await waitFor(() => b.status() === 'idle', 15_000);
    // 续写落域内档：补发轮行进域档；projects 区仍零条目（工作 root 的缺省推导区无该档）
    assert.ok(domainJournalRows(jid).length > rowsBefore + 1, '重开后续写行落域内档');
    assert.ok(!fs.existsSync(path.join(sessionsDir(resolveDataDir(root)), `${jid}.jsonl`)), 'projects 区无该 sunx 档（域绑定不走 root 推导）');
    // 幂等：同 journal 再 attach → 收编在座（同 sessionId）
    const ar2 = await fetch(`${d2.http}/sunx/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: jid }) });
    assert.equal(ar2.status, 200);
    assert.equal(((await ar2.json()) as { sessionId: string }).sessionId, adopted.sessionId, '二次 attachSunx 收编在座');
    // 未知 journalId 400
    const ar404 = await fetch(`${d2.http}/sunx/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: '20990101T000000Z-none' }) });
    assert.equal(ar404.status, 400, '容器无此域=unknown sunx session 400');
    await b.teardown();
  } finally {
    await close1?.();
    await close2?.();
    restore();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});

// ═══════════════ ③standard 路径回归锚 ═══════════════

test('③ standard 回归锚：惰性建档（出生零档）/workspace.json 注册//workspaces 在列/路径=resolveDataDir 推导/旧 attach 链原样', async () => {
  const base = tmpdir('sunshinex-serve-sunxdom-c-');
  const restore = pinSunxEnv(base);
  let close1: (() => Promise<void>) | undefined;
  let close2: (() => Promise<void>) | undefined;
  try {
    const root = path.join(base, 'ws-std');
    fs.mkdirSync(root, { recursive: true });
    const d1 = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), base);
    close1 = d1.close;
    const { sessionId: sid } = await newSession(d1.http, { root });
    const s = d1.daemon.get(sid)!;
    // 惰性建档不变式：standard 出生零档（幽灵会话语义原样）
    assert.equal(s.attachedJournalId, undefined, 'standard 出生零档（惰性建档）');
    // workspace.json 注册照旧：projects/<slug>/data/workspace.json 落 {root}
    const defDataDir = resolveDataDir(root);
    assert.ok(defDataDir.startsWith(path.join(base, 'projects') + path.sep) && defDataDir.endsWith('data'), '缺省推导仍按 projects 根（钉槽锚）');
    const wsFile = path.join(defDataDir, 'workspace.json');
    assert.ok(fs.existsSync(wsFile), 'workspace.json 注册在');
    assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, 'utf8')), { root: path.resolve(root) }, '注册档内容照旧');
    const wsRows = (await (await fetch(`${d1.http}/workspaces`, { headers: AUTH })).json()) as Array<{ root?: string }>;
    assert.equal(wsRows.some((r) => r.root === path.resolve(root)), true, '/workspaces 在列');
    // 首轮触发惰性建档：档落 resolveDataDir(root) 既有推导（非域）
    await runRound(d1.http, d1.daemon, sid, '标准一轮');
    const jid = s.attachedJournalId!;
    assert.ok(jid !== undefined, '首轮建档');
    assert.ok(fs.existsSync(path.join(sessionsDir(defDataDir), `${jid}.jsonl`)), 'standard 档落 projects 缺省推导');
    assert.equal(s.dataDir, defDataDir, 'standard dataDir 外窥=resolveDataDir(root)（字节不变）');
    await s.teardown();
    await close1();
    close1 = undefined;
    // 旧 attach 链原样：壳 newSession（无 kind）+ POST /session/:id/attach
    const d2 = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), base);
    close2 = d2.close;
    const shell = await newSession(d2.http, { root });
    const ar = await fetch(`${d2.http}/session/${shell.sessionId}/attach`, { method: 'POST', headers: AUTH, body: JSON.stringify({ journalId: jid }) });
    assert.equal(ar.status, 200, 'standard attach 链原样受理');
    const b = d2.daemon.get(shell.sessionId)!;
    assert.equal(b.sessionKind, undefined, 'standard 不重铸');
    assert.ok(b.transcriptCount() > 0, '链回放照常');
    await b.teardown();
  } finally {
    await close1?.();
    await close2?.();
    restore();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});

// ═══════════════ ④清偿项三断言（Task 1 移交义务） ═══════════════

test('④ 清偿项：memoryStats 域缝随注入/memory_write 落盘随域（注入键置尾）/sunx 装配 learnSkills=false（编排轮零 learned 沉淀，standard 照旧）', async () => {
  const base = tmpdir('sunshinex-serve-sunxdom-d-');
  const restore = pinSunxEnv(base);
  let close: (() => Promise<void>) | undefined;
  let h: Harness | undefined;
  try {
    // ① memoryStats 域缝：serve 面漏网清偿——可选 dataDir 参数随域（缺省推导基线对照）
    const statRoot = path.join(base, 'ws-stat');
    fs.mkdirSync(statRoot, { recursive: true });
    const statDomain = path.join(base, 'stat-domain');
    fs.mkdirSync(path.join(statDomain, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(statDomain, 'memory', 'note.md'), '---\ntype: project\n---\nbody', 'utf8');
    assert.equal(memoryStats(statRoot, statDomain).entries, 1, '注入域：记忆统计随域（serve 面漏网清偿——可选 dataDir 缝）');
    assert.equal(memoryStats(statRoot).entries, 0, '缺席：统计落既有缺省推导（基线不变）');
    // ② memory_write 落盘随域（harness 接缝注入键置尾——注入域恒胜）
    const memRoot = path.join(base, 'ws-mem');
    fs.mkdirSync(memRoot, { recursive: true });
    const memDomain = path.join(base, 'mem-domain');
    h = new Harness({ root: memRoot, dataDir: memDomain, learnSkills: false, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const w = await h.tools.execute('memory_write', { action: 'save', slug: 'probe-fact', type: 'project', content: 'domain binding probe', description: 'probe' }, h.safety);
    assert.ok(w.ok, `memory_write 应成功：${w.ok ? '' : w.error.message}`);
    // 落点断言（slug 由落盘单点归一——记录文件=域 memory/ 内非索引 .md 任一在档即随域）
    const memFiles = fs.existsSync(path.join(memDomain, 'memory')) ? fs.readdirSync(path.join(memDomain, 'memory')).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md') : [];
    assert.ok(memFiles.length >= 1, `记忆记录落注入域（实际 ${JSON.stringify(memFiles)}）`);
    assert.ok(!fs.existsSync(path.join(resolveDataDir(memRoot), 'memory')), '缺省推导区零记忆落盘（域绑定面）');
    h.tasks.stopAll();
    h = undefined;
    // ③ learnSkills=false（sunx 装配）：编排轮零 learned 沉淀；standard 控制组照旧沉淀。
    // 模型面用无 capabilities.chat 的裸适配器——isModelSummarizer 门禁关外=沉淀走确定性写盘路径
    // （ScriptedAdapter 恒带 chat:true,提取轮进模型队列卡解析必败,观察不到开关差异）
    const doneAdapter: ModelAdapter = {
      provider: 'done-bare',
      chat: async () => ({ finish: 'stop', content: 'ok', toolCalls: [] }),
    };
    const d = await startDaemon(doneAdapter, base);
    close = d.close;
    const stdRoot = path.join(base, 'ws-std-learn');
    const sunxRoot = path.join(base, 'ws-sunx-learn');
    fs.mkdirSync(stdRoot, { recursive: true });
    fs.mkdirSync(sunxRoot, { recursive: true });
    const std = await newSession(d.http, { root: stdRoot });
    await runRound(d.http, d.daemon, std.sessionId, 'settle a learned skill probe');
    const stdSid = d.daemon.get(std.sessionId)!;
    assert.ok(fs.readdirSync(path.join(resolveDataDir(stdRoot), 'skills')).includes('settle-a-learned-skill-probe'), 'standard 控制组：learned 沉淀照旧（slug 目录）');
    const sunx = await newSession(d.http, { root: sunxRoot, kind: 'sunx' });
    const sunxSid = d.daemon.get(sunx.sessionId)!;
    const jid = sunxSid.attachedJournalId!;
    await runRound(d.http, d.daemon, sunx.sessionId, 'settle a learned skill probe');
    assert.ok(!fs.existsSync(path.join(sunxDomainDir(jid), 'skills')), 'sunx 域零 learned 沉淀（learnSkills=false）');
    assert.ok(!fs.existsSync(path.join(resolveDataDir(sunxRoot), 'skills')), 'sunx 装配在缺省推导区也零 learned 沉淀');
    await stdSid.teardown();
    await sunxSid.teardown();
  } finally {
    h?.tasks.stopAll();
    await close?.();
    restore();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});

// ═══════════════ ⑤隔离验收（Task 4 核心场景）：同 root 1 standard + 2 sunx 三域互斥 ═══════════════

test('⑤ 隔离验收：同 root 建 1 standard + 2 sunx——三域目录互不相同互不包含；sunx A 真实工具面写工作区记忆 → B 域/standard 域文件系统层不存在、读面 0 笔；standard 路径/注册/枚举零变化', async () => {
  const base = tmpdir('sunshinex-serve-sunxdom-e-');
  const restore = pinSunxEnv(base);
  let close: (() => Promise<void>) | undefined;
  try {
    const root = path.join(base, 'ws-shared');
    fs.mkdirSync(root, { recursive: true });
    const d = await startDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), base);
    close = d.close;
    // 同 root 三会话：1 standard（普通路径零变化锚）+ 2 sunx（同名工作区不同实例——journalId 即域键）
    const { sessionId: stdSid } = await newSession(d.http, { root });
    const { sessionId: sidA } = await newSession(d.http, { root, kind: 'sunx', name: '域主甲' });
    const { sessionId: sidB } = await newSession(d.http, { root, kind: 'sunx', name: '域主乙' });
    const std = d.daemon.get(stdSid)!;
    const sA = d.daemon.get(sidA)!;
    const sB = d.daemon.get(sidB)!;
    const jidA = sA.attachedJournalId!;
    const jidB = sB.attachedJournalId!;
    const domA = sunxDomainDir(jidA);
    const domB = sunxDomainDir(jidB);
    const domStd = std.dataDir; // standard 外窥=resolveDataDir(root) 既有推导（③ 同口径）
    assert.equal(domStd, resolveDataDir(root), 'standard 域=projects 缺省推导（字节不变）');
    // 出生即在：两 sunx 域出生即铸档；standard 出生 workspace.json 注册已建目录
    assert.ok(fs.existsSync(domA), 'sunx A 域目录在场');
    assert.ok(fs.existsSync(domB), 'sunx B 域目录在场');
    assert.ok(fs.existsSync(domStd), 'standard 域目录在场（注册面）');
    // 三域互不相同且互不包含（路径层互斥——验收剧本「三域目录互不相同」断言到文件系统层）
    assert.notEqual(domA, domB, 'sunx A/B 域不同目录');
    assert.notEqual(domA, domStd, 'sunx A/standard 域不同目录');
    assert.notEqual(domB, domStd, 'sunx B/standard 域不同目录');
    for (const x of [domA, domB, domStd]) {
      for (const y of [domA, domB, domStd]) {
        if (x !== y) assert.ok(!x.startsWith(y + path.sep) && !y.startsWith(x + path.sep), `域目录互不包含：${x} 与 ${y}`);
      }
    }
    // sunx A 真实工具面写工作区记忆（既有形态 ④：harness.tools.execute + safety——域绑定注入键置尾恒胜）
    const w = await sA.runtime.harness.tools.execute(
      'memory_write',
      { action: 'save', slug: 'isolation-probe', type: 'project', content: 'domain A only fact', description: 'isolation probe' },
      sA.runtime.harness.safety,
    );
    assert.ok(w.ok, `sunx A memory_write 应成功：${w.ok ? '' : w.error.message}`);
    // 文件系统层：记录落 A 域 memory/（slug 由落盘单点归一——非索引 .md 任一在档即随域）；B 域与
    // standard 域读不存在（记忆随域隔离——「避免互相影响记忆」验收）
    const memFilesA = fs.readdirSync(path.join(domA, 'memory')).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md');
    assert.ok(memFilesA.length >= 1, `记忆记录落 A 域（实际 ${JSON.stringify(memFilesA)}）`);
    assert.ok(fs.existsSync(path.join(domA, 'memory', 'MEMORY.md')), 'A 域索引随写重建');
    assert.ok(!fs.existsSync(path.join(domB, 'memory')), 'B 域无 memory 目录（文件系统层不存在）');
    assert.ok(!fs.existsSync(path.join(domStd, 'memory')), 'standard 域无 memory 目录（读不到 A 的记忆）');
    // 读面（memoryStats 域缝三对照）：A 1 笔、B/standard 0 笔
    assert.equal(memoryStats(root, domA).entries, 1, 'A 域读面 1 笔');
    assert.equal(memoryStats(root, domB).entries, 0, 'B 域读面 0 笔（隔离）');
    assert.equal(memoryStats(root, domStd).entries, 0, 'standard 域读面 0 笔（隔离）');
    // standard 路径/行为零变化：workspace.json 注册照旧；/workspaces 仅 standard（sunx 域零污染）；
    // /sunx/sessions 恰两域且 standard 不入列（项目组数据源单点）
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(domStd, 'workspace.json'), 'utf8')), { root: path.resolve(root) }, 'standard workspace.json 注册照旧');
    const wsRows = (await (await fetch(`${d.http}/workspaces`, { headers: AUTH })).json()) as Array<{ root?: string }>;
    assert.deepEqual(wsRows.map((r) => r.root), [path.resolve(root)], '/workspaces 仅 standard 行（sunx 域不入列）');
    const sunxRows = (await (await fetch(`${d.http}/sunx/sessions`, { headers: AUTH })).json()) as Array<{ id: string; kind: string }>;
    assert.deepEqual([...sunxRows.map((r) => r.id)].sort(), [jidA, jidB].sort(), '/sunx/sessions 恰两域行');
    assert.ok(sunxRows.every((r) => r.kind === 'sunx'), 'sunx 行 kind 恒 sunx');
    await std.teardown();
    await sA.teardown();
    await sB.teardown();
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
