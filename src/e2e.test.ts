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
  h.context.memory.record('compaction', '种子事件：e2e 记忆保留验证');

  const perceived = h.perception.scan();
  assert.ok(perceived.files.includes('a.txt'));

  const r = await h.reactor.run({ goal: '读取 a.txt' });
  assert.equal(r.done, true);
  assert.ok(r.steps.length >= 1);
  assert.ok(h.context.memory.index().length >= 1);
});

test('缺省 root 时以 process.cwd() 为基准（当前目录模式）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cwd-'));
  fs.writeFileSync(path.join(dir, 'b.txt'), 'world');
  const model = new ScriptedAdapter([
    '{"tool":"read","input":{"path":"b.txt"},"done":false}',
    '{"done":true}',
  ]);

  const prev = process.cwd();
  try {
    process.chdir(dir);
    const h = new Harness({ model }); // 不传 root，走缺省基准
    const perceived = h.perception.scan();
    assert.ok(perceived.files.includes('b.txt'));

    const r = await h.reactor.run({ goal: '读取 b.txt' });
    assert.equal(r.done, true);
    assert.ok(r.steps.length >= 1);
  } finally {
    process.chdir(prev);
  }
});
