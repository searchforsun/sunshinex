import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { ContextItem } from '../../types';
import { ContextChunk, ContextWindow } from './window';
import { CompactionCoordinator } from './compaction';

/** CompactionCoordinator 单元钉（D25/H3 拆件）：触发水位（checksum 门禁三态：first 计数回投 / replay 幂等不计数不回投 /
 *  new 递增且水位取注入面实时值）、压缩块会话恢复与清空口径（计数跨 /new 保留）。依赖全注入伪造，零磁盘读写。 */

interface Rig {
  coord: CompactionCoordinator;
  events: Array<{ chainFrom: number; compacted: ContextItem[] }>;
  setWatermark(n: number): void;
}

function rig(): Rig {
  const events: Array<{ chainFrom: number; compacted: ContextItem[] }> = [];
  let watermark = 0;
  const coord = new CompactionCoordinator({
    window: new ContextWindow(),
    root: path.join(os.tmpdir(), 'sunshinex-coordinator-root'), // recentFiles 恒空：无重读 IO，路径仅 resolve 用
    recentFiles: () => [],
    compactInstructions: () => null,
    chainFrom: () => watermark,
    onCompact: (chainFrom, compacted) => events.push({ chainFrom, compacted }),
  });
  return { coord, events, setWatermark: (n: number) => { watermark = n; } };
}

const chunkOf = (id: string): ContextChunk => ({ id, summary: `旧上下文要点-${id}`.repeat(10), type: 'history', priority: 1 });

test('触发水位：first 计数并回投 compact；同 chunks replay 幂等（不计数不回投）；new 递增且 chainFrom 取注入面实时值', async () => {
  const { coord, events, setWatermark } = rig();
  const c1 = [chunkOf('a')];
  assert.equal(await coord.apply(c1), 'deterministic', '无模型走确定性回退');
  assert.equal(coord.compactionCount(), 1, 'first 记 1');
  assert.equal(events.length, 1, '首次压缩回投恰好一条 compact');
  assert.equal(events[0].chainFrom, 0, '水位取注入回调实时值');
  assert.ok(coord.compactedView().length >= 1, '压缩块已落地');

  assert.equal(await coord.apply(c1), 'replay', '同一压缩事件幂等重放');
  assert.equal(coord.compactionCount(), 1, 'replay 不计数');
  assert.equal(events.length, 1, 'replay 不回投');

  setWatermark(3); // 折链后水位推进（模拟 trimChainFront 已执行）
  assert.equal(await coord.apply([chunkOf('b')]), 'deterministic', '新 chunks 判 new 走完整重注入');
  assert.equal(coord.compactionCount(), 2, 'new 递增');
  assert.equal(events.length, 2);
  assert.equal(events[1].chainFrom, 3, '回投水位读的是发射时刻的注入面值');
  assert.equal(coord.compactedUpToCount(), coord.compactedView().length, '块计数与块视图同源');
});

test('压缩块恢复与清空：restoreCompacted 浅拷贝隔离替换；clearCompacted 清空且压缩事件计数跨 /new 保留', async () => {
  const { coord } = rig();
  await coord.apply([chunkOf('a')]);
  assert.ok(coord.compactedView().length >= 1);

  const payload: ContextItem[] = [{ kind: 'system', content: '恢复摘要' }];
  coord.restoreCompacted(payload);
  payload.push({ kind: 'system', content: '事后追加' }); // 载荷再变更不得泄漏进协调器（拷贝隔离）
  assert.deepEqual(coord.compactedView(), [{ kind: 'system', content: '恢复摘要' }], '恢复直注入整体替换');
  assert.equal(coord.compactedUpToCount(), 1);

  const countBefore = coord.compactionCount();
  coord.clearCompacted();
  assert.equal(coord.compactedView().length, 0, '/new 清空压缩块');
  assert.equal(coord.compactedUpToCount(), 0);
  assert.equal(coord.compactionCount(), countBefore, '事件计数跨会话保留（与原 resetSession 口径逐字一致）');
});
