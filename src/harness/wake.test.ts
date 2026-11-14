// bg-wake 批C：harness 侧三接缝测试——opts.wake 终态分流汇（stopped 不分流、boardDispatch 过滤前）、
// wakeHint 宿主闸① 装配开关、receipted 消费标记（markReceipted 直置 / markBoardReceipted 板 id →
// dispatchTag 标签匹配台账行）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildHarness } from '../runtime';
import { wakeHintSuffix, WAKE_HINT } from './tasks';

test('harness wake 接缝：终态分流 onFinished；stopped 不分流；wakeHint 装配', () => {
  const seen: Array<{ id: string; status: string }> = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgwake-'));
  const h = buildHarness(root, { wake: { onFinished: (t) => seen.push({ id: t.id, status: t.status }), hint: true } });
  const t1 = h.tasks.submit({ kind: 'exec', label: 'cmd', title: '构建', ownerRun: 'main' });
  h.tasks.finish(t1.id, 'done');
  const t2 = h.tasks.submit({ kind: 'exec', label: 'cmd2', ownerRun: 'main' });
  h.tasks.finish(t2.id, 'stopped', { marker: '[stopped: process exit]' });
  assert.deepEqual(seen, [{ id: t1.id, status: 'done' }]); // stopped 不分流
  assert.equal(h.tasks.wakeHint, true);
  assert.equal(wakeHintSuffix(h.tasks), WAKE_HINT); // currentOwner 缺省 main
});

test('未注入 wake（CLI 形态）：不分流、无提示', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgwake0-'));
  const h = buildHarness(root);
  const t = h.tasks.submit({ kind: 'exec', label: 'c', ownerRun: 'main' });
  h.tasks.finish(t.id, 'failed');
  assert.equal(h.tasks.wakeHint ?? false, false);
  assert.equal(wakeHintSuffix(h.tasks), '');
});

test('receipted：markReceipted/isReceipted/markBoardReceipted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgwake1-'));
  const h = buildHarness(root);
  const t = h.tasks.submit({ kind: 'subagent', label: 'task-t3', boardDispatch: true, ownerRun: 'fork:m1' });
  assert.equal(h.tasks.isReceipted(t.id), false);
  h.tasks.markBoardReceipted(['t3']); // 板 id → dispatchTag 标签匹配台账行
  assert.equal(h.tasks.isReceipted(t.id), true);
  const t2 = h.tasks.submit({ kind: 'exec', label: 'c', ownerRun: 'main' });
  h.tasks.markReceipted([t2.id]);
  assert.equal(h.tasks.isReceipted(t2.id), true);
});

test('wakeHintSuffix 闸②负半边：fork 名下（currentOwner≠main）返回空串——子面回执保持原文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgwake2-'));
  const h = buildHarness(root, { wake: { onFinished: () => {}, hint: true } });
  assert.equal(h.tasks.wakeHint, true);
  assert.equal(h.tasks.runInOwnerScope('fork:m1', () => wakeHintSuffix(h.tasks)), '');
  assert.equal(wakeHintSuffix(h.tasks), WAKE_HINT); // 主链缺省 owner 归 main：正半边对照
});
