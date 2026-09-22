// 后台任务线 T4a：fork 收割（规格 D9）——前台子代理名下发起的后台任务（ownerRun=子代理 run），在子代理收口时
// 由 runSubagent finally 段统一 reap：触发 stop 句柄、落 [stopped] 终态行。断言面：任务终态、零泄漏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskRegistry } from './tasks';

test('reap(ownerRun)：终结该 owner 名下全部 running、其余 owner 不误伤', () => {
  const tasks = new TaskRegistry('/tmp/sunshinex-reap-test-data');
  let stoppedA = false;
  let stoppedC = false;
  const a = tasks.submit({ kind: 'exec', label: 'a-owned', ownerRun: 'fork-1' });
  a.stop = () => {
    stoppedA = true;
  };
  const b = tasks.submit({ kind: 'exec', label: 'b-done', ownerRun: 'fork-1' });
  tasks.finish(b.id, 'done'); // 终态任务不重复收割
  const c = tasks.submit({ kind: 'exec', label: 'c-owned', ownerRun: 'fork-2' });
  c.stop = () => {
    stoppedC = true;
  };
  const reaped = tasks.reap('fork-1');
  assert.equal(reaped.length, 1, '恰好收割 fork-1 名下 1 条 running');
  assert.equal(reaped[0].id, a.id);
  assert.equal(stoppedA, true, 'stop 句柄已触发');
  assert.equal(tasks.get(a.id)?.status, 'stopped');
  assert.match(tasks.get(a.id)?.outputFilePath ? readLog(tasks.get(a.id)!) : '', /\[stopped: owner finished\]/, '终态行含 [stopped: owner finished]');
  assert.equal(tasks.get(b.id)?.status, 'done', '终态任务不受影响');
  assert.equal(stoppedC, false, '其他 owner 零误伤');
  assert.equal(tasks.get(c.id)?.status, 'running', '其他 owner 任务保持 running');
});

/** 读任务日志（收割断言用） */
function readLog(t: { outputFilePath: string }): string {
  // reap 落终态行走账本内存态；日志文件由 append 侧写盘——此处直接读，若文件未建则空串兜底
  try {
    return require('fs').readFileSync(t.outputFilePath, 'utf8');
  } catch {
    return '';
  }
}
