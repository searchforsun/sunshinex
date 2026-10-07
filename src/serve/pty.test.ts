import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PtyManager, RING_LIMIT } from './pty.js';

const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pty-t-'));

/** 跨平台定向:spawn 宿主 node 直跑 -e,零 shell 依赖(win32 conpty 真进程) */
const ECHO = (s: string): { file: string; args: string[] } => ({ file: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(s)})`] });

/**
 * win32 偏差(仅 T3 首个 spawn 使用):CreateProcessW lpCommandLine 上限 32767 字符,
 * RING_LIMIT+4096 的 payload 内联进 -e 脚本会 error 206(Cannot create process)——改为子进程内
 * `'x'.repeat(n)` 生成同等输出,断言语义不变(总量>RING_LIMIT 即可,尾部仍为 x)。
 */
const ECHO_BIG = (n: number): { file: string; args: string[] } => ({ file: process.execPath, args: ['-e', `process.stdout.write('x'.repeat(${n}))`] });

test('spawn→data→exit 链与幂等 kill', async () => {
  const m = new PtyManager();
  const s = m.spawn('p1', { ...ECHO('hello-pty'), cwd: cwd(), cols: 80, rows: 24, owner: 's1' });
  assert.equal(m.has('p1'), true);
  const got = new Promise<string>((r) => { let acc = ''; s.onData((d) => { acc += d; }); s.onExit(() => r(acc)); });
  const code = new Promise<number>((r) => s.onExit((c) => r(c)));
  assert.equal((await got).includes('hello-pty'), true);
  assert.equal(await code, 0);
  assert.equal(m.has('p1'), false);            // exit 自动注销
  m.kill('p1');                                 // 幂等:不抛
  m.kill('ghost');                              // 无此 id 静默
});

test('kill 中止活进程并触发 exit 注销', async () => {
  const m = new PtyManager();
  const s = m.spawn('p2', { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: cwd(), cols: 80, rows: 24, owner: 's1' });
  const exited = new Promise<number>((r) => s.onExit((c) => r(c)));
  s.kill();
  const c = await exited;
  assert.notEqual(c, 0);                        // 被 kill,非零退出
  assert.equal(m.has('p2'), false);
});

test('环形缓冲:超限输出仅保尾部 RING_LIMIT;未超限全量', async () => {
  const m = new PtyManager();
  const big = 'x'.repeat(RING_LIMIT + 4096);
  const s = m.spawn('p3', { ...ECHO_BIG(big.length), cwd: cwd(), cols: 80, rows: 24, owner: 's1' });
  await new Promise<void>((r) => s.onExit(() => r()));
  assert.equal(s.replay().length, RING_LIMIT);  // 恰尾部
  assert.equal(s.replay().endsWith('x'), true);
  const s2 = m.spawn('p4', { ...ECHO('tiny'), cwd: cwd(), cols: 80, rows: 24, owner: 's2' });
  await new Promise<void>((r) => s2.onExit(() => r()));
  assert.ok(s2.replay().includes('tiny'));      // 未超限全量(含可能的环境回显,故 includes)
});

test('killAllFor 按 owner 批量清杀;size 归零', async () => {
  const m = new PtyManager();
  const mk = (id: string, owner: string) => m.spawn(id, { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: cwd(), cols: 80, rows: 24, owner });
  const a1 = mk('a1', 's1'); const a2 = mk('a2', 's1'); mk('b1', 's2');
  assert.equal(m.size, 3);
  const gone = Promise.all([new Promise<void>((r) => a1.onExit(() => r())), new Promise<void>((r) => a2.onExit(() => r()))]);
  m.killAllFor('s1');
  await gone;
  assert.equal(m.has('a1'), false); assert.equal(m.has('a2'), false);
  assert.equal(m.size, 1);                      // s2 的 b1 存活
  m.killAllFor('s2');
  assert.equal(m.size, 0);
});

test('id 撞名 throw', () => {
  const m = new PtyManager();
  const o = { ...ECHO('a'), cwd: cwd(), cols: 80, rows: 24, owner: 's1' };
  m.spawn('dup', o);
  assert.throws(() => m.spawn('dup', o), /pty id exists/);
  m.killAllFor('s1');
});
