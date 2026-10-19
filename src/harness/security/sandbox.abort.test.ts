import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessSandbox } from './sandbox';

/** G14.2xx 立即停止语义:前台 exec 挂 run 信号——信号中止即收割在途子进程,命令落 EXEC_ABORTED
 *  (非 ok/超时,转录如实显「已中止」);无信号路径行为不变(sleep 真睡、正常命令 ok)。
 *  平台:win32 taskkill /T /F 树杀,POSIX SIGKILL——两平台断言同一契约(快速失败+EXEC_ABORTED)。 */

test('setRunSignal 后中止:在途 exec 秒级收割并落 EXEC_ABORTED(不再睡满全程)', async () => {
  const sb = new ProcessSandbox();
  const ac = new AbortController();
  sb.setRunSignal(ac.signal);
  const t0 = Date.now();
  const p = sb.exec('sleep 8');
  setTimeout(() => ac.abort(), 400);
  const r = await p;
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false, '被中止的命令不得报 ok');
  assert.equal((r as { error: { code: string } }).error.code, 'EXEC_ABORTED');
  assert.ok(elapsed < 5000, `中止应秒级生效(实际 ${elapsed}ms)`);
});

test('无信号正控:sleep 真睡(≥1s)后 ok——基线行为不回归', async () => {
  const sb = new ProcessSandbox();
  const t0 = Date.now();
  const r = await sb.exec('sleep 1');
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed >= 900, `sleep 1 应真睡(实际 ${elapsed}ms)`);
});

test('信号先于 exec:命令不启动直接 EXEC_ABORTED', async () => {
  const sb = new ProcessSandbox();
  const ac = new AbortController();
  sb.setRunSignal(ac.signal);
  ac.abort();
  const t0 = Date.now();
  const r = await sb.exec('sleep 5');
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal((r as { error: { code: string } }).error.code, 'EXEC_ABORTED');
  assert.ok(elapsed < 2000, `已中止信号下不应启动命令(实际 ${elapsed}ms)`);
});

test('clear 信号后恢复基线:exec 正常 ok', async () => {
  const sb = new ProcessSandbox();
  const ac = new AbortController();
  sb.setRunSignal(ac.signal);
  ac.abort(); // 先中止过一轮
  sb.setRunSignal(undefined); // 轮收束摘信号
  const r = await sb.exec('echo cleared');
  assert.equal(r.ok, true, '摘信号后 exec 恢复正常');
});

test('转后台前的同步窗口:信号中止即 EXEC_ABORTED(不等转换、不后台存活)', async () => {
  const sb = new ProcessSandbox();
  const ac = new AbortController();
  sb.setRunSignal(ac.signal);
  const t0 = Date.now();
  const p = sb.exec('sleep 5', { timeoutToBackground: true, timeoutMs: 4000 });
  setTimeout(() => ac.abort(), 300); // 转后台(4s)之前的同步窗口内中止
  const r = await p;
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false, '同步窗口内中止不得落「转后台 ok」');
  assert.equal((r as { error: { code: string } }).error.code, 'EXEC_ABORTED');
  assert.ok(elapsed < 2000, `同步窗口内应立即收割(实际 ${elapsed}ms)`);
});

test('已转后台不追杀:转换完成后信号中止,后台任务照常存活到自然结束', async () => {
  const sb = new ProcessSandbox();
  const ac = new AbortController();
  sb.setRunSignal(ac.signal);
  const p = sb.exec('sleep 2', { timeoutToBackground: true, timeoutMs: 400 });
  setTimeout(() => ac.abort(), 1200); // 400ms 已转后台,1.2s 才中止——不追杀
  const r = await p; // 转换回执(500ms 时已 ok)
  assert.equal(r.ok, true, '转后台回执不受后到信号影响');
  assert.equal((r as { value: { timedOut?: boolean } }).value.timedOut, true);
  // 后台子进程存活到自然结束(~2s):此处仅断言回执语义;进程存活由 killBackground/teardown 面覆盖
});
