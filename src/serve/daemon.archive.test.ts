import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { resolveDataDir, sunxDomainDir } from '../config/data-dir';
import { parseJournalFile, readSessionMeta } from '../tui/session-journal';
import { reduceSegRows } from '../session/seglog';

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

/** 2026-10-21 归档面钉测:/session/:id/archive 双寻址(daemon 会话 id / journalId)——运行中照常归档、
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

test('archive:运行中照常归档(2026-11-07 用户裁定:归档=切换显示位置,不停运行);归档列表带运行标注', async () => {
  await withDaemon(new HangingAdapter(), async ({ base, tmp }) => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: 'hang' }) });
    await waitStatus(base, sessionId, 'running');

    const r1 = await fetch(`${base}/session/${sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(r1.status, 200, 'running 会话 id 归档受理');
    const jid = fs.readdirSync(path.join(resolveDataDir(root), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');
    const rows = (await (await fetch(`${base}/sessions/archived`, { headers: AUTH })).json()) as Array<{ id: string; liveSessionId?: string }>;
    assert.equal(rows.find((r) => r.id === jid)?.liveSessionId, sessionId, '归档行带运行标注(左槽转圈数据源)');
    const r2 = await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: JSON.stringify({ archived: false }) });
    assert.equal(r2.status, 200, 'running journalId 撤销归档受理');
    await waitStatus(base, sessionId, 'running'); // 归档/撤销不打断运行
  });
});

test('delete 门禁:未归档 409;归档态 200 且 journal/meta/gui 私有档全消', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, tmp }) => {
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    await waitStatus(base, sessionId, 'idle');
    const jid = fs.readdirSync(path.join(resolveDataDir(tmp), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');
    // gui 私有档 precondition 造场(PUT gui-state 落 <slug>/gui/sessions/<jid>.json)——使「清」断言非空转
    // (brief 原案按存在性分支;此处先造档,分支恒走真断言。路径实况:slugDir=dirname(resolveDataDir))
    const guiSession = path.join(resolveDataDir(tmp), '..', 'gui', 'sessions', `${jid}.json`);
    const put = await fetch(`${base}/session/${sessionId}/gui-state`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ state: { tabs: ['chat'] } }) });
    assert.equal(put.status, 200);
    assert.equal(fs.existsSync(guiSession), true, '前置:gui 私有档在场');

    const denied = await fetch(`${base}/session/${sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(denied.status, 409, '未归档拒删');

    await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    const ok = await fetch(`${base}/session/${sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(ok.status, 200);
    const sessionsDir = path.join(resolveDataDir(tmp), 'sessions');
    assert.equal(fs.readdirSync(sessionsDir).filter((f) => f.startsWith(`${jid}.`)).length, 0, '会话档全家清');
    assert.equal(fs.existsSync(guiSession), false, 'gui 私有档清');
    const gone = await fetch(`${base}/session/${sessionId}/snapshot`, { headers: AUTH });
    assert.equal(gone.status, 404, 'daemon 会话出注册表');
  });
});
test('delete 域语义(P3 修复轮归一裁定 2026-11-15):sunx 删=域目录整删且同 root standard 会话档零殃及;standard 多会话删一个=项目夹保留;登记缺席(悬挂工作区)末会话删=项目夹连带', async () => {
  // A. sunx 删=域目录整删(~/.sunshinex/sunx/<jid>/ 无条件——独占域模型)+同 root standard 会话档
  //    零殃及(域容器物理独立于 projects/)。sunx 域容器随 HOME——本子场景自钉 HOME 隔离(真实家目录
  //    域不可触;withDaemon 不钉 HOME,故不走它)
  const baseA = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-arch-sunxd-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  let closeA: (() => Promise<void>) | undefined;
  try {
    const home = path.join(baseA, 'home');
    const projects = path.join(baseA, 'projects');
    fs.mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.SUNSHINEX_PROJECTS_DIR = projects;
    delete process.env.SUNSHINEX_DATA_DIR;
    const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']), staticRoot: path.join(baseA, 'dist-gui-absent') });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    closeA = s.close;
    const base = `http://127.0.0.1:${s.port}`;
    const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const root = path.join(baseA, 'ws-a');
    fs.mkdirSync(root, { recursive: true });
    // 同 root 双实体:sunx(域内档)+standard(projects 区档)——删除隔离的对照场
    const sunxNew = await (await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root, kind: 'sunx', name: '域删体' }) })).json() as { sessionId: string };
    await fetch(`${base}/session/${sunxNew.sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    const stdNew = await (await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) })).json() as { sessionId: string };
    await fetch(`${base}/session/${stdNew.sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '标准一轮' }) });
    const waitIdle = async (sid: string): Promise<void> => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const r = await fetch(`${base}/session/${sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
        if (((await r.json()) as { status: string }).status === 'idle') return;
        if (Date.now() > deadline) throw new Error('waitFor 超时');
        await new Promise((rr) => setTimeout(rr, 20));
      }
    };
    await waitIdle(sunxNew.sessionId);
    await waitIdle(stdNew.sessionId);
    const jidSunx = daemon.get(sunxNew.sessionId)!.attachedJournalId!;
    const domainDir = path.dirname(sunxDomainDir(jidSunx));
    const stdJid = fs.readdirSync(path.join(resolveDataDir(root), 'sessions')).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''))[0]!;
    assert.equal(fs.existsSync(domainDir), true, '前置:sunx 域目录在场');
    await fetch(`${base}/session/${sunxNew.sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    const ok = await fetch(`${base}/session/${sunxNew.sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(ok.status, 200);
    assert.equal(fs.existsSync(domainDir), false, 'sunx 删=域目录整删(独占域,无条件)');
    assert.equal(fs.existsSync(path.join(resolveDataDir(root), 'sessions', `${stdJid}.jsonl`)), true, '同 root standard 会话档零殃及');
    await daemon.get(stdNew.sessionId)!.teardown();
  } finally {
    await closeA?.();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    try {
      fs.rmSync(baseA, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
  // B. standard 多会话同 root:删其一=项目夹保留(工作区登记在=项目仍在,删档不删项目)+兄弟档在。
  //    兄弟档寻址=journal id(runtime id 不在盘面,档名=journal id——旧断言以 sessionId 对档名
  //    startsWith,恒 false 的错配根修;此处经 daemon 注册表 attachedJournalId 精确取)
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']), async ({ base, tmp, daemon }) => {
    const s1 = await (await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) })).json() as { sessionId: string };
    const s2 = await (await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) })).json() as { sessionId: string };
    await fetch(`${base}/session/${s1.sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '一轮' }) });
    await fetch(`${base}/session/${s2.sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '两轮' }) });
    await waitStatus(base, s1.sessionId, 'idle');
    await waitStatus(base, s2.sessionId, 'idle');
    const s2Jid = daemon.get(s2.sessionId)!.attachedJournalId!;
    assert.equal(fs.existsSync(path.join(resolveDataDir(tmp), 'sessions', `${s2Jid}.jsonl`)), true, '前置:兄弟档在场');
    await fetch(`${base}/session/${s1.sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    const ok = await fetch(`${base}/session/${s1.sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(ok.status, 200);
    const slugDir = path.dirname(resolveDataDir(tmp));
    assert.equal(fs.existsSync(slugDir), true, 'standard 多会话删一=项目夹保留(登记工作区不随档摘)');
    assert.equal(fs.existsSync(path.join(resolveDataDir(tmp), 'sessions', `${s2Jid}.jsonl`)), true, '兄弟会话档未受殃及(journal id 寻址)');
  });
  // C. 登记缺席(悬挂工作区:workspace.json 摘除)+删后无其他 .jsonl 会话 → 项目夹连带整删
  //    (05adfb48 用户裁定「删除时同时删除项目持久化文件夹」的存活面——条件整删收窄至此)
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, tmp }) => {
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    await waitStatus(base, sessionId, 'idle');
    const slugDir = path.dirname(resolveDataDir(tmp));
    const wsJson = path.join(resolveDataDir(tmp), 'workspace.json');
    assert.equal(fs.existsSync(wsJson), true, '前置:工作区登记在场');
    await fetch(`${base}/session/${sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    fs.rmSync(wsJson, { force: true }); // 摘登记=悬挂工作区(登记面不再认领该项目夹)
    const ok = await fetch(`${base}/session/${sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(ok.status, 200);
    assert.equal(fs.existsSync(slugDir), false, '悬挂工作区末会话删=项目夹连带整删');
  });
});


test('delete 领养域守卫(终审 Fix 1):sunx 域内 fork 子档删=仅清子档,父档/记忆/台账/域目录全存活;独占域 sunx 删=域整删(既有语义)', async () => {
  // fork/rewind 换座壳经 CreateSessionOpts.dataDir 领养父域(同域多 journal:父+fork 子档共存于
  // ~/.sunshinex/sunx/<父jid>/data)——purge 守卫若按 dirname(dataDir) 整删即灭掉父档全家。
  // 收紧后按 journalId 推域属:仅当 dataDir===sunxDomainDir(本档 jid)(自己是域的唯一会话)才整删
  const baseA = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-arch-forkd-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  let closeA: (() => Promise<void>) | undefined;
  try {
    const home = path.join(baseA, 'home');
    const projects = path.join(baseA, 'projects');
    fs.mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.SUNSHINEX_PROJECTS_DIR = projects;
    delete process.env.SUNSHINEX_DATA_DIR;
    const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']), staticRoot: path.join(baseA, 'dist-gui-absent') });
    const s = await daemon.start({ port: 0, token: 'test-token' });
    closeA = s.close;
    const base = `http://127.0.0.1:${s.port}`;
    const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const root = path.join(baseA, 'ws-a');
    fs.mkdirSync(root, { recursive: true });
    const sunxNew = await (await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root, kind: 'sunx', name: '域主父' }) })).json() as { sessionId: string };
    await fetch(`${base}/session/${sunxNew.sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    const waitIdle = async (sid: string): Promise<void> => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const r = await fetch(`${base}/session/${sid}/snapshot`, { headers: { authorization: 'Bearer test-token' } });
        if (((await r.json()) as { status: string }).status === 'idle') return;
        if (Date.now() > deadline) throw new Error('waitFor 超时');
        await new Promise((rr) => setTimeout(rr, 20));
      }
    };
    await waitIdle(sunxNew.sessionId);
    const jidP = daemon.get(sunxNew.sessionId)!.attachedJournalId!;
    const domain = sunxDomainDir(jidP);
    const domainDir = path.dirname(domain);
    // 域级资产造场:记忆记录+台账(删除隔离断言非空转的存活标的)
    fs.mkdirSync(path.join(domain, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(domain, 'memory', 'note.md'), '---\ntype: project\n---\nparent domain fact', 'utf8');
    fs.mkdirSync(path.join(domain, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(domain, 'tasks', `ledger-${jidP}.jsonl`), `${JSON.stringify({ op: 'submit', pid: 1, task: { id: 't1', kind: 'exec', label: 'l', title: 't', status: 'stopped', outputFilePath: 'x', startedAt: 1, ownerRun: 'main' } })}\n`, 'utf8');
    // 域内 fork:子档落父域 sessions/<jidC>.jsonl(领养形态——子 journalId ≠ 域键)
    const forkRes = await fetch(`${base}/session/${sunxNew.sessionId}/fork`, { method: 'POST', headers: AUTH, body: JSON.stringify({ turn: 1 }) });
    const forkBody = (await forkRes.json()) as { ok: true; sessionId: string };
    assert.equal(forkRes.status, 200, `fork 应 200:${JSON.stringify(forkBody)}`);
    const jidC = daemon.get(forkBody.sessionId)!.attachedJournalId!;
    assert.ok(jidC !== undefined && jidC !== jidP, 'fork 子档独立 journalId');
    assert.equal(fs.existsSync(path.join(domain, 'sessions', `${jidC}.jsonl`)), true, '前置:fork 子档落父域(领养形态)');
    // 子档归档+删除(在座 sessionId 寻址——GUI fork 页签删除实况)
    await fetch(`${base}/session/${forkBody.sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    const ok = await fetch(`${base}/session/${forkBody.sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(ok.status, 200);
    // 子档清:子 journal 全家出域(领养域保留——per-session 清理口径)
    assert.equal(fs.existsSync(path.join(domain, 'sessions', `${jidC}.jsonl`)), false, '子档 journal 清');
    assert.equal(fs.existsSync(path.join(domain, 'sessions', `${jidC}.meta.json`)), false, '子档 meta 清');
    // 父域存活:域目录/父档/父 meta/记忆/台账全在(整删守卫收紧——dirname 领养域不手术)
    assert.equal(fs.existsSync(domainDir), true, '父域目录存活(领养域不整删)');
    assert.equal(fs.existsSync(path.join(domain, 'sessions', `${jidP}.jsonl`)), true, '父档存活');
    assert.equal(fs.existsSync(path.join(domain, 'sessions', `${jidP}.meta.json`)), true, '父 meta 存活');
    assert.equal(fs.existsSync(path.join(domain, 'memory', 'note.md')), true, '域记忆存活');
    assert.equal(fs.existsSync(path.join(domain, 'tasks', `ledger-${jidP}.jsonl`)), true, '域台账存活');
    await daemon.get(sunxNew.sessionId)!.teardown();
    // 对照:独占域 sunx 删=域整删(既有语义保持——自己是域的唯一会话才动手术)
    await fetch(`${base}/session/${sunxNew.sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    const okP = await fetch(`${base}/session/${sunxNew.sessionId}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(okP.status, 200);
    assert.equal(fs.existsSync(domainDir), false, '独占域删=域整删(既有语义不变)');
  } finally {
    await closeA?.();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    try {
      fs.rmSync(baseA, { recursive: true, force: true });
    } catch {
      // win32 目录锁迟滞不挡断言
    }
  }
});

test('delete journalId 寻址:在座 idle 会话升格运行时回收(终审 F1)——档真清+注册表移出,复活通道关闭', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, tmp }) => {
    // 现场=归档页删除实况:会话开着(idle 在座)→ 顶栏归档 → 归档页按 journalId 删
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    await waitStatus(base, sessionId, 'idle');
    const jid = fs.readdirSync(path.join(resolveDataDir(tmp), 'sessions')).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');
    const arch = await fetch(`${base}/session/${jid}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    assert.equal(arch.status, 200);

    // DELETE 打 journalId URL(归档页行寻址形态)
    const del = await fetch(`${base}/session/${jid}/delete`, { method: 'POST', headers: AUTH });
    assert.equal(del.status, 200);
    const sessionsDir = path.join(resolveDataDir(tmp), 'sessions');
    assert.equal(fs.readdirSync(sessionsDir).filter((f) => f.startsWith(`${jid}.`)).length, 0, '会话档全家清');
    // F1 核心:在座 idle 会话已同链回收(teardown→注册表移出),原 sessionId 快照 404——
    // 无残壳 runtime 即无 append 复活已清档的通道
    const gone = await fetch(`${base}/session/${sessionId}/snapshot`, { headers: AUTH });
    assert.equal(gone.status, 404, '在座会话出注册表(F1 回收)');
    const sessions = (await (await fetch(`${base}/sessions?root=${encodeURIComponent(tmp)}`, { headers: AUTH })).json()) as Array<{ id: string }>;
    assert.equal(sessions.some((r) => r.id === jid), false, '主列表无残留');
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
    const archived = (await (await fetch(`${base}/sessions/archived`, { headers: AUTH })).json()) as Array<{ id: string; slug: string; root: string; archivedAt: number }>;
    assert.equal(archived.some((r) => r.id === jid), true, '归档列表在');
    assert.equal(archived[0]!.slug.length > 0, true, '来源 slug 标注');
    assert.equal(archived.find((r) => r.id === jid)!.root, root, '归档行 root=来源工作区(归档页行打开寻址数据面)');
  });
});

test('archived 行 kind 透出（sunx P2 Task 7）：sunx 会话归档标记落域旁车（archived+kind:"sunx" 随域档——域容器枚举归 Task 3）；standard 归档行经 /sessions/archived 聚合零 kind 键', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, tmp, daemon }) => {
    const root = path.join(tmp, 'sunshinex-default');
    fs.mkdirSync(root, { recursive: true });
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root, kind: 'sunx' }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    await waitStatus(base, sessionId, 'idle');
    const jid = daemon.get(sessionId)!.attachedJournalId!;
    // 对照组 standard 会话（同 root）
    const std = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root }) });
    const stdId = ((await std.json()) as { sessionId: string }).sessionId;
    await fetch(`${base}/session/${stdId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '标准一轮' }) });
    await waitStatus(base, stdId, 'idle');
    const dir = path.join(resolveDataDir(root), 'sessions');
    const stdJid = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')).find((id) => id !== jid)!;

    // sunx：在座路径（sessionId 寻址→session.dataDir 域旁车；journalId 磁盘寻址扫 projects 区,
    // 域容器寻址语义=Task 3 范围）
    await fetch(`${base}/session/${sessionId}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    await fetch(`${base}/session/${stdJid}/archive`, { method: 'POST', headers: AUTH, body: '{}' });
    // sunx：归档标记落域旁车（archived+kind 同档存活——P3 Task 2 域绑定；跨域枚举/徽标行=Task 3）
    const sunxMeta = readSessionMeta(sunxDomainDir(jid), jid);
    assert.equal(sunxMeta.archived, true, 'sunx 归档标记落域旁车');
    assert.equal(sunxMeta.kind, 'sunx', 'sunx 归档后域旁车 kind 仍 sunx');
    // standard：跨工作区聚合行零 kind 键（projects 区清单行为不变）
    const archived = (await (await fetch(`${base}/sessions/archived`, { headers: AUTH })).json()) as Array<{ id: string; kind?: string }>;
    assert.equal(archived.find((r) => r.id === stdJid)?.kind, undefined, 'standard 归档行零 kind 键');
    assert.equal(archived.some((r) => r.id === jid), false, 'sunx 域不进 projects 区归档聚合（域容器枚举=Task 3）');
  });
});

test('command 气泡入档:POST /command 后 journal 有命令 user 行+结果 notice 行(刷新回放双向可见)', async () => {
  await withDaemon(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), async ({ base, tmp }) => {
    const created = await fetch(`${base}/session/new`, { method: 'POST', headers: AUTH, body: JSON.stringify({ root: tmp }) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    // 真跑一轮先建档(journal 随首 run 创建;/command 在无档会话上零落档为既有口径,不在本钉范围)
    await fetch(`${base}/session/${sessionId}/submit`, { method: 'POST', headers: AUTH, body: JSON.stringify({ goal: '跑一轮' }) });
    await waitStatus(base, sessionId, 'idle');
    const dir = path.join(resolveDataDir(tmp), 'sessions');
    const jid = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))[0]!.replace(/\.jsonl$/, '');

    // 前置阴性:unsupported 命令 400 且零命令行入档(证明 user 行确由执行路径写入)
    const bad = await fetch(`${base}/session/${sessionId}/command`, { method: 'POST', headers: AUTH, body: JSON.stringify({ line: '/nope' }) });
    assert.equal(bad.status, 400);
    const replayEntriesBefore = reduceSegRows(parseJournalFile(path.join(dir, `${jid}.jsonl`)).events);
    assert.equal(replayEntriesBefore.some((e) => e.kind === 'user' && e.md === '/nope'), false, '前置：未执行命令零命令行入档');

    const r = await fetch(`${base}/session/${sessionId}/command`, { method: 'POST', headers: AUTH, body: JSON.stringify({ line: '/status' }) });
    assert.equal(r.status, 200);

    // 回放可见面双行钉:命令气泡(user)+结果回执(tool 行三态——2026-10-31 裁定,notice 不再旁路落行)——刷新/回溯时「执行过什么命令」可见
    const replay = reduceSegRows(parseJournalFile(path.join(dir, `${jid}.jsonl`)).events);
    assert.ok(replay.some((e) => e.kind === 'user' && e.md === '/status'), '命令行 user 气泡入档(回放可见)');
    const cmdTool = replay.find((e) => e.kind === 'tool' && e.name === '/status');
    assert.ok(cmdTool, '命令 tool 行入档(三态回执面)');
    assert.equal(cmdTool!.status, undefined, '命令 tool 行终态(done)');
    assert.ok(cmdTool!.result !== undefined && cmdTool!.result!.ok && cmdTool!.result!.text.length > 0, '结果回执随 tool 行 result 载荷入档');
  });
});
