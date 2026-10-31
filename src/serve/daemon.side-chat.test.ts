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
import { branchFrom, listSessions, readSessionMeta, sessionsDir, writeSessionMeta } from '../tui/session-journal';
import { resolveDataDir } from '../config/data-dir';

/** 辅助对话持久化可见（2026-10-31 用户裁定「独立会话档+每主会话独立编号」）：side fork 整档继承
 *  （当前最新上下文）→ 编号标题（辅助对话 N,父档 sideCount 持久化）→ 列表可见可点回。
 *  handleBranch side 分支=3 行薄壳（branchFrom+两次 writeSessionMeta）,数据面钉在此层;
 *  io 装配照抄 daemon.ctx-snap.test.ts（daemon 六面直驱） */

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

async function withIsoEnv(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-side-chat-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  try {
    await fn(tmp);
  } finally {
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
  }
}

test('辅助对话编号+持久化可见:side fork 两次→辅助对话 1/2,父档 sideCount=2,列表可见可点回', async () => {
  await withIsoEnv(async (tmp) => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'line\n', 'utf8');
    const io = makeIo(new ScriptedAdapter(['{"done":true,"reply":"ok"}']));
    const c = createSessionIn(io, root);
    if (!c.ok) throw new Error(c.error.message);
    const s = io.sessions.get(c.value.sessionId)!;
    s.submit('主任务');
    for (let i = 0; i < 150 && (s.status() !== 'idle' || s.attachedJournalId === undefined); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const jid = s.attachedJournalId!;
    // side fork ×2(与 handleBranch side 分支同构:branchFrom 整档继承+编号标题+父档计数)
    const dataDir = resolveDataDir(root);
    for (let n = 1; n <= 2; n++) {
      const lines = fs.readFileSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`), 'utf8').split('\n').filter((l) => l !== '').length;
      const newId = branchFrom(dataDir, jid, lines, 'fork');
      const parentMeta = readSessionMeta(dataDir, jid);
      const seq = (parentMeta.sideCount ?? 0) + 1;
      writeSessionMeta(dataDir, jid, { sideCount: seq });
      writeSessionMeta(dataDir, newId, { side: true, title: `辅助对话 ${seq}`, sideOf: jid });
    }
    // 编号与计数持久化
    assert.equal(readSessionMeta(dataDir, jid).sideCount, 2);
    const rows = listSessions(dataDir);
    const titled = rows.filter((r) => r.title?.startsWith('辅助对话'));
    assert.equal(titled.length, 2, '带编号标题的辅助档入列(可见可点回)');
    assert.deepEqual(titled.map((r) => r.title).sort(), ['辅助对话 1', '辅助对话 2']);
    // fork 整档继承:辅助档链含主任务行(重开播种即含当前上下文)
    for (const r of titled) {
      const chainLine = fs.readFileSync(r.file, 'utf8').split('\n').find((l) => l.includes('"action":"task"'))!;
      const fork = JSON.parse(chainLine) as { steps: Array<{ observation?: string }> };
      assert.ok(fork.steps.some((st) => st.observation === '主任务'), 'fork 整档继承(当前最新上下文)');
    }
  });
});
