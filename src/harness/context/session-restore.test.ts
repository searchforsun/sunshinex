import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextChange, ContextManager } from './index';
import { FileStore } from '../../storage/adapter';

const setup = (): ContextManager => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-csr-'));
  return new ContextManager(tmp, new FileStore(tmp));
};

test('订阅：appendChain 发出 append 事件（携带实际推入的行与绝对步号），空追加不发', () => {
  const cm = setup();
  const seen: ContextChange[] = [];
  cm.onContextChange((c) => seen.push(c));
  cm.appendChain([{ action: 'task', observation: '指令行' }, { observation: '结论行' }]);
  cm.appendChain([]);
  assert.deepEqual(seen, [
    { kind: 'append', steps: [{ step: 1, action: 'task', observation: '指令行' }, { step: 2, observation: '结论行' }] },
  ]);
});

test('订阅：applyCompaction 与 trimChainFront 各发一条 compact（后态快照，重放末值覆盖）', async () => {
  const cm = setup();
  const seen: ContextChange[] = [];
  cm.onContextChange((c) => seen.push(c));
  cm.appendChain([{ observation: '旧步骤' }]);
  const chunks = await cm.window.compact([{ kind: 'history', content: '较长的旧上下文内容 '.repeat(30) }]);
  await cm.applyCompaction(chunks);
  cm.trimChainFront(1);
  const compacts = seen.filter((c): c is Extract<ContextChange, { kind: 'compact' }> => c.kind === 'compact');
  assert.equal(compacts.length, 2, '压缩配对产生两条 compact 事件');
  assert.equal(compacts[0].chainFrom, 0, 'applyCompaction 先发（水位未折）');
  assert.equal(compacts[1].chainFrom, 1, 'trimChainFront 后发（水位已折）');
  assert.ok(compacts[1].compacted.length > 0, '压缩块非空');
});

test('restoreSession：直注入不触发订阅；chainSeq 按链内最大步号续排', () => {
  const cm = setup();
  let fired = 0;
  cm.onContextChange(() => fired++);
  cm.restoreSession({ chain: [{ step: 3, observation: '历史步骤' }], chainFrom: 0, compacted: [{ kind: 'system', content: '摘要' }] });
  assert.equal(fired, 0, '恢复注入不经过订阅');
  assert.deepEqual(cm.chainView(), [{ step: 3, observation: '历史步骤' }]);
  cm.appendChain([{ observation: '恢复后新步骤' }]);
  const view = cm.chainView();
  assert.deepEqual(view.map((s) => s.step), [3, 4], '步号从最大值续排不回绕');
  assert.equal(cm.exportSessionState().chainFrom, 0);
});

test('export → restore 往返：链视图与压缩块与原实例逐字段一致', async () => {
  const a = setup();
  const events: ContextChange[] = [];
  a.onContextChange((c) => events.push(c));
  a.appendChain([{ observation: 's1' }, { observation: 's2' }]);
  const chunks = await a.window.compact([{ kind: 'history', content: '旧上下文内容 '.repeat(30) }]);
  await a.applyCompaction(chunks);
  a.trimChainFront(1);
  a.appendChain([{ observation: 's3' }]);
  // 用事件流重放（journal 归约的同构语义：链累积 + compact 末值覆盖）
  const steps = events.filter((e) => e.kind === 'append').flatMap((e) => e.steps);
  const lastCompact = [...events].reverse().find((e): e is Extract<ContextChange, { kind: 'compact' }> => e.kind === 'compact');
  assert.ok(lastCompact);
  const b = setup();
  b.restoreSession({ chain: steps, chainFrom: lastCompact.chainFrom, compacted: lastCompact.compacted });
  assert.deepEqual(b.chainView(), a.chainView(), '链视图（水位折后）一致');
  assert.deepEqual(b.exportSessionState().chain, a.exportSessionState().chain, '全量链一致');
  assert.deepEqual(b.exportSessionState().compacted, a.exportSessionState().compacted, '压缩块一致');
});

test('exportSessionState 深拷贝：改动返回值不回渗内部数组', () => {
  const cm = setup();
  cm.appendChain([{ observation: 's1' }]);
  const snap = cm.exportSessionState();
  snap.chain.push({ step: 99, observation: '外部注入' });
  snap.chainFrom = 10;
  assert.equal(cm.chainView().length, 1);
  assert.equal(cm.exportSessionState().chainFrom, 0);
});
