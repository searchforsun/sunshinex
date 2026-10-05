import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileInbox } from './file-inbox';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('FileInbox:send/poll 往返(to 隔离/位点严格大于/id 互异/ts 严格单调)', async () => {
  const tmp = tmpdir('sunshinex-tb-fileinbox-');
  try {
    const inbox = new FileInbox(path.join(tmp, 'inbox'));
    const m1 = await inbox.send('worker', { from: 'lead', text: 'hello' });
    const m2 = await inbox.send('worker', { from: 'lead', text: 'second' });
    assert.notEqual(m1.id, m2.id, 'id 互异');
    assert.ok(m1.ts < m2.ts, 'ts 严格单调');
    assert.deepEqual(inbox.poll('worker', 0).map((m) => m.text), ['hello', 'second']);
    assert.deepEqual(inbox.poll('worker', m1.ts).map((m) => m.text), ['second'], '位点严格大于:等于 since 的上一条不回');
    assert.deepEqual(inbox.poll('other', 0), [], '按收件人隔离');
    assert.ok(fs.existsSync(path.join(tmp, 'inbox', 'worker.jsonl')), '消息已落盘到 <agent>.jsonl');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FileInbox:损坏行跳过(截断行不卡收件箱,poll 只回完好消息)', () => {
  const tmp = tmpdir('sunshinex-tb-fileinbox2-');
  try {
    const dir = path.join(tmp, 'inbox');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'worker.jsonl'), [
      JSON.stringify({ id: 'm1', from: 'lead', to: 'worker', text: 'a', ts: 1 }),
      '{ "id": "mX", "fr', // 崩溃截断行(无换行)
      JSON.stringify({ id: 'm2', from: 'lead', to: 'worker', text: 'b', ts: 2 }),
    ].join('\n'), 'utf8');
    const inbox = new FileInbox(dir);
    assert.deepEqual(inbox.poll('worker', 0).map((m) => m.text), ['a', 'b'], '两条完好消息全量返回');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FileInbox:跨重启 id 不撞、clock 恢复(新实例重放现有最大 id 序号/ts)', async () => {
  const tmp = tmpdir('sunshinex-tb-fileinbox3-');
  try {
    const dir = path.join(tmp, 'inbox');
    const a = new FileInbox(dir);
    await a.send('worker', { from: 'lead', text: '1' });
    await a.send('worker', { from: 'lead', text: '2' });
    const last = await a.send('worker', { from: 'lead', text: '3' });
    const b = new FileInbox(dir); // 重启:同目录新实例,状态仅存在于文件里
    const m4 = await b.send('worker', { from: 'lead', text: '4' });
    assert.equal(m4.id, 'm4', 'id 序号接续旧最大(m3 → m4),不跨重启相撞');
    assert.ok(m4.ts > last.ts, 'clock 经重放恢复,B 首条 ts > A 末条 ts');
    assert.equal(b.poll('worker', 0).length, 4, '重放可见全部 4 条');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FileInbox:缺文件 poll 回 [](惰性纪律:poll 不建目录)', () => {
  const tmp = tmpdir('sunshinex-tb-fileinbox4-');
  try {
    const dir = path.join(tmp, 'inbox');
    const inbox = new FileInbox(dir);
    assert.deepEqual(inbox.poll('ghost', 0), []);
    assert.ok(!fs.existsSync(dir), '未 send 不建目录');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
