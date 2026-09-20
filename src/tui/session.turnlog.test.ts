import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { parseJournalFile, readActivePointer, sessionsDir, type JournalEvent } from './session-journal';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** env 钉私有数据目录（须在 SessionController 构造前——writeSnapshot sink 的 blobsDir 构造期固定）；返回恢复函数 */
function pinDataDir(dataDir: string): () => void {
  const saved = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return () => {
    if (saved === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = saved;
  };
}

test('任务收口：write 的影子快照随该轮 user 事件落盘，blob 为 pre-image', async () => {
  const tmp = tmpdir('rewind-t3-');
  const restore = pinDataDir(path.join(tmp, 'data'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'old');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([
      '{"phase":"act","tool":"write","input":{"path":"a.txt","content":"new"}}',
      '{"done":true,"reply":"done"}',
    ]) });
    await ctrl.submit('改 a.txt');
    await ctrl.waitIdle();
    const dataDir = resolveDataDir(tmp);
    const id = readActivePointer(dataDir);
    assert.ok(id, '活动指针应指向已落盘会话');
    const parsed = parseJournalFile(path.join(sessionsDir(dataDir), id + '.jsonl'));
    const userEv = parsed.events.find((e): e is Extract<JournalEvent, { t: 'user' }> => e.t === 'user');
    assert.ok(userEv, 'journal 应含 user 事件');
    assert.equal(userEv.files?.length, 1, 'user 事件应带影子快照清单');
    assert.equal(userEv.files[0].path, 'a.txt');
    assert.equal(userEv.files[0].deleted, undefined);
    assert.equal(fs.readFileSync(path.join(dataDir, 'sessions', '_blobs', userEv.files[0].hash)).toString(), 'old');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('任务收口：无 write 的任务 user 事件无 files 字段（v1 形态一致）', async () => {
  const tmp = tmpdir('rewind-t3b-');
  const restore = pinDataDir(path.join(tmp, 'data'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('纯对话');
    await ctrl.waitIdle();
    const dataDir = resolveDataDir(tmp);
    const id = readActivePointer(dataDir)!;
    const parsed = parseJournalFile(path.join(sessionsDir(dataDir), id + '.jsonl'));
    const userEv = parsed.events.find((e): e is Extract<JournalEvent, { t: 'user' }> => e.t === 'user');
    assert.ok(userEv, 'journal 应含 user 事件');
    assert.equal(userEv.files, undefined, '无 write 时不应写 files 字段');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
