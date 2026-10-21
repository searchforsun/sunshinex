import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { readSessionMeta, sessionsDir } from './session-journal';
import { resolveDataDir } from '../config/data-dir';

test('/archive:/delete 门禁与真清(TUI)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-archcmd-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const jid = ctrl.journal?.currentId as string;
    const dataDir = resolveDataDir(tmp);

    await ctrl.submit('/delete');
    assert.equal(readSessionMeta(dataDir, jid).archived, undefined, '未归档 /delete 拒绝且档还在');
    assert.ok(fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`)), '档未被清');

    await ctrl.submit('/archive');
    assert.equal(readSessionMeta(dataDir, jid).archived, true, '/archive 打标');

    await ctrl.submit('/delete');
    assert.equal(fs.existsSync(path.join(sessionsDir(dataDir), `${jid}.jsonl`)), false, '归档态 /delete 真清');
    assert.equal(ctrl.journal?.currentId !== undefined && ctrl.journal.currentId !== jid, true, '已软重置到新会话档');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
