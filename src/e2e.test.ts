import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Harness } from './harness';
import { ScriptedAdapter } from './model/adapter';

test('端到端：感知 → Reactor → 工具执行 → 记忆记录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-e2e-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const model = new ScriptedAdapter([
    '{"tool":"read","input":{"path":"a.txt"},"done":false}',
    '{"done":true}',
  ]);
  const h = new Harness({ root, model });

  const perceived = h.perception.scan();
  assert.ok(perceived.files.includes('a.txt'));

  const r = await h.reactor.run({ goal: '读取 a.txt' });
  assert.equal(r.done, true);
  assert.ok(r.steps.length >= 1);
  assert.ok(h.context.memory.index().length >= 1);
});
