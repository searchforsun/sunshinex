import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWorker, WorkerError, type WorkerProc } from '../src/worker';

/** fake 子进程工厂（spawn 注入面）：手工驱动回执/退出，记录 stdin 请求行与 kill 调用——协议面黑盒对拍。
 *  不伪造整个 ChildProcess，只给 createWorker 依赖的 WorkerProc 最小结构面。 */
function makeFakeProc() {
  const ee = new EventEmitter();
  const stdin = new PassThrough();
  const kills: string[] = [];
  const received: string[] = [];
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) received.push(line.replace(/\r$/, ''));
    }
  });
  const proc: WorkerProc = {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once(event, listener) {
      ee.once(event, listener);
      return proc;
    },
    on(event, listener) {
      ee.on(event, listener);
      return proc;
    },
    kill(signal) {
      kills.push(String(signal));
      return true;
    },
  };
  // 仿真：宿主 end stdin（EOF）→ PS 主循环 ReadLine 得 null → 脚本收尾退出——对齐真 worker close 的体面路径
  let exitEmitted = false;
  const emitExitOnce = (code: number | null, signal: string | null): void => {
    if (exitEmitted) return;
    exitEmitted = true;
    ee.emit('exit', code, signal);
  };
  stdin.on('finish', () => emitExitOnce(0, null));
  return {
    proc,
    received,
    kills,
    /** 按协议回放一行回执（对象 → 单行 JSON 写入 stdout）。 */
    emitLine(msg: unknown): void {
      (proc.stdout as PassThrough).write(JSON.stringify(msg) + '\n');
    },
    /** 回放一段非 JSON 坏行（协议健壮性对拍）。 */
    emitRaw(line: string): void {
      (proc.stdout as PassThrough).write(line + '\n');
    },
    /** 模拟进程退出（exit 事件；幂等——与 stdin EOF 仿真路径互不重复触发）。 */
    exit(code: number | null, signal: string | null = null): void {
      emitExitOnce(code, signal);
    },
    /** 模拟 stderr 输出。 */
    emitStderr(text: string): void {
      (proc.stderr as PassThrough).write(text);
    },
  };
}

/** 等 IO 微任务/宏任务落定（请求行写入、串行队列推进）。 */
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('op 按 id 配对回执；并发调用串行排队；乱序回执不错配', async () => {
  const h = makeFakeProc();
  const w = createWorker('powershell.exe', () => h.proc);
  const p1 = w.op<string>('echo', { v: 'first' });
  const p2 = w.op<string>('echo', { v: 'second' });
  await tick();
  // 串行队列：同一时刻一个在途——第二请求尚未下发
  assert.equal(h.received.length, 1);
  assert.deepEqual(JSON.parse(h.received[0]), { id: 1, op: 'echo', params: { v: 'first' } });
  // 乱序回放：id2 的回执先到（其请求甚至还没发出）——不得错配、不得崩溃
  h.emitLine({ id: 2, ok: true, result: 'second-early' });
  h.emitLine({ id: 1, ok: true, result: 'first' });
  assert.equal(await p1, 'first');
  await tick();
  // p1 收口后第二请求才下发，id 续排
  assert.equal(h.received.length, 2);
  assert.deepEqual(JSON.parse(h.received[1]), { id: 2, op: 'echo', params: { v: 'second' } });
  h.emitLine({ id: 2, ok: true, result: 'second' });
  assert.equal(await p2, 'second');
  await w.close();
});

test('worker ok:false 回执 → 抛 WorkerError（code=worker_op_failed，消息透传）', async () => {
  const h = makeFakeProc();
  const w = createWorker('powershell.exe', () => h.proc);
  const p = w.op('uia_snapshot', { scope: 'window' });
  await tick();
  h.emitLine({ id: 1, ok: false, error: 'UIA timeout' });
  await assert.rejects(p, (err: unknown) => err instanceof WorkerError && err.code === 'worker_op_failed' && /UIA timeout/.test(err.message));
  await w.close();
});

test('close()：SIGTERM 收口+等待退出；幂等；close 后 op 立即 reject', async () => {
  const h = makeFakeProc();
  const w = createWorker('powershell.exe', () => h.proc);
  const closing = w.close();
  await tick();
  // 收口即发 SIGTERM（Windows 下即终止等价），等待 exit 事件收口
  assert.deepEqual(h.kills, ['SIGTERM']);
  h.exit(0, null);
  await closing;
  await closing; // 幂等：二次 close 正常返回
  await assert.rejects(w.op('screenshot', {}), (err: unknown) => err instanceof WorkerError && err.code === 'worker_closed');
});

test('进程退出：未决请求全部 reject（消息附 stderr 尾部）；退出后 op 拒绝', async () => {
  const h = makeFakeProc();
  const w = createWorker('powershell.exe', () => h.proc);
  const p = w.op('screenshot', {});
  await tick();
  h.emitStderr('boom from ps\n');
  h.exit(1, null);
  await assert.rejects(p, (err: unknown) => err instanceof WorkerError && err.code === 'worker_exit' && /code=1/.test(err.message) && /boom from ps/.test(err.message));
  await assert.rejects(w.op('screenshot', {}), /exited/); // 退出后调用 → 立即拒绝
  await w.close(); // 已退出后 close 正常收口
});

test('坏行与未配对回执不崩溃（进 stderr 环形缓冲）', async () => {
  const h = makeFakeProc();
  const w = createWorker('powershell.exe', () => h.proc);
  const p = w.op('ping', {});
  await tick();
  h.emitRaw('not-json');
  h.emitLine({ id: 99, ok: true, result: 'ghost' });
  h.emitLine({ id: 1, ok: true, result: 'pong' });
  assert.equal(await p, 'pong');
  const ring = w.stderrTail();
  assert.ok(ring.some((l) => l.includes('not-json')));
  assert.ok(ring.some((l) => l.includes('99')));
  await w.close();
});
