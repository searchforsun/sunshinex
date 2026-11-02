import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionIn } from './session-lifecycle';
import type { SessionLifecycleIo } from './session-lifecycle';
import { SessionRuntime } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { parseJournalFile, sessionsDir } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';

/** setMode 换铸快照内存直传（2026-10-31 session-snapshot-freeze spec §4,Task 6）：同会话中途换运行时
 *  （setMode 运行时换铸 / planFlow 批准续段）前缀字节稳定——旧运行时快照内存直传新运行时,不经 journal
 *  回程、不重读磁盘（离场磁盘变更留给追尾,不烘进快照）。io 装配形态照抄 daemon.ctx-snap.test.ts */

/** 轮询等待（daemon.ctx-snap.test.ts 同款）：20ms 片轮询直至 pred 为真，超时抛错 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** lifecycle io 装配（daemon.ctx-snap.test.ts 同款直驱形态）：注册表本地 Map，广播/激活/监听全 no-op */
function makeIo(model: ModelAdapter): SessionLifecycleIo {
  const sessions = new Map<string, SessionRuntime>();
  let seq = 0;
  let pid = 0;
  return {
    sessions,
    model,
    nextSeq: () => ++seq,
    mintPid: () => `p${++pid}`,
    broadcast: () => {},
    setActive: () => {},
    watchProject: () => {},
    unwatchProject: () => {},
  };
}

/** 环境隔离样板（daemon.ctx-snap.test.ts 同款）：钉 SUNSHINEX_PROJECTS_DIR 到本用例 tmp 并摘除
 *  SUNSHINEX_DATA_DIR（显式覆盖会让全部 root 共用一个 dataDir，工作区语义不成立） */
async function withIsoEnv(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ctx-snap-setmode-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    await fn(tmp);
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData !== undefined) process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 工作区播种（SUNSHINE.md + 技能目录）：出生快照的磁盘形态 */
function seedWorkspace(root: string, sunshine: string, skillId: string, skillDesc: string): void {
  fs.mkdirSync(path.join(root, '.sunshinex', 'skills', skillId), { recursive: true });
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), sunshine, 'utf8');
  fs.writeFileSync(
    path.join(root, '.sunshinex', 'skills', skillId, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: ${skillDesc}\n---\nbody\n`,
    'utf8',
  );
}

test('setMode 换铸：快照内存直传字节稳定,不重读磁盘', { timeout: 60_000 }, async () => {
  await withIsoEnv(async (tmp) => {
    const root = path.join(tmp, 'ws');
    fs.mkdirSync(root, { recursive: true });
    seedWorkspace(root, 'v1 line\n', 'old-skill', 'old skill at birth');
    const io = makeIo(new ScriptedAdapter(['{"done":true,"reply":"ok"}']));

    // 1) 建会话：出生快照含旧技能（磁盘 v1 拍）
    const c = createSessionIn(io, root);
    assert.ok(c.ok, 'createSessionIn 受理');
    const s = io.sessions.get(c.value.sessionId)!;
    const preSnap = s.runtime.harness.context.snapshotExport();
    assert.ok(preSnap.items.some((it) => it.content.includes('old skill at birth')), '出生快照含旧技能（前置确认）');

    // 2) 改磁盘：SUNSHINE.md 追加 + 新技能目录（离场变更——换铸不得重读磁盘烘进快照）
    fs.appendFileSync(path.join(root, 'SUNSHINE.md'), 'v2 line\n', 'utf8');
    seedWorkspace(root, '', 'new-skill', 'brand new skill');

    // 3) setMode 换铸（缺省 full-access → acceptEdits,真切换触发 assemble 换新运行时）
    assert.equal(await s.setMode('acceptEdits'), 'ok', 'setMode 受理');
    assert.equal(s.isAcceptEdits(), true, '档位确实切走（换铸确实发生）');

    // 4) 换铸后导出面与换铸前逐位相等（内存直传：不经 journal 回程、不重读磁盘）
    const postSnap = s.runtime.harness.context.snapshotExport();
    assert.deepEqual(postSnap, preSnap, '换铸后快照与换铸前逐位相等（items+sig 同源同拍）');
    assert.ok(!postSnap.items.some((it) => it.content.includes('v2 line')), '磁盘 SUNSHINE.md 新内容未烘进快照');
    assert.ok(!postSnap.items.some((it) => it.content.includes('brand new skill')), '磁盘新技能未烘进快照');

    // 5) 后续 run 照常在换铸后运行时上跑（换铸不破坏会话活性）
    assert.equal(s.submit('跑一轮').ok, true, '换铸后提交受理');
    await waitFor(() => s.status() === 'idle', 30_000);

    // 6) 零 snap 事件落档：restoreSnapshot 直注入不触发订阅,档内 ctx-snap 行数不变（出生写唯一）。
    //    出生档自 52edb56 幽灵会话根修起改惰性铸造——首条实质事件才建档,故读档须在首 run 之后
    const jid = s.attachedJournalId!;
    const events = parseJournalFile(path.join(sessionsDir(resolveDataDir(root)), `${jid}.jsonl`)).events;
    assert.equal(events.filter((e) => e.t === 'ctx-snap').length, 1, '换铸零 snap 落档（出生写唯一）');
  });
});
