import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import './warning-filter';

test('过滤：node:sqlite 实验横幅被吞（TUI 渲染面净化）', () => {
  const before = process.listenerCount('warning');
  process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
  assert.equal(process.listenerCount('warning'), before, '被过滤的警告不应触达 process warning 事件');
});

test('透出：其余 ExperimentalWarning 与普通警告原样通过', async () => {
  const seen: string[] = [];
  const onWarn = (w: Error): void => { seen.push(w.message); };
  process.on('warning', onWarn);
  try {
    process.emitWarning('some other experimental thing', 'ExperimentalWarning');
    process.emitWarning('custom notice', 'CustomNotice');
  }
  await new Promise<void>((r) => setImmediate(r)); // emitWarning 经 nextTick 异步派发，先等一拍再断言/摘监听
  process.removeListener('warning', onWarn);
  assert.ok(seen.some((m) => m.includes('some other experimental thing')));
  assert.ok(seen.some((m) => m.includes('custom notice')));
});
