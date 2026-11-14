import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactCollector } from './artifact-collector';

/** 产物声明收集器(2026-11-12 spec §3.3;仿 WriteSnapshotCollector 注入模式):白名单过滤/
 *  tool-result 回标挂末尾未标条目/drain 按 path 保末次并清空 */

test('record:白名单过滤;同路径多刀 drain 保末次(含末个 source 与末次回标)', () => {
  const c = new ArtifactCollector();
  c.record('docs/a.md', 'write');
  c.record('src/index.ts', 'write'); // 代码不收
  c.tagCall('docs/a.md', 'c1');
  c.record('docs/a.md', 'edit'); // 第二刀
  c.tagCall('docs/a.md', 'c2');
  assert.deepEqual(c.drain(), [{ path: 'docs/a.md', source: 'edit', callId: 'c2' }]);
  assert.deepEqual(c.drain(), []); // drain 清空
});

test('tagCall:回标路径反斜杠归一比对;无匹配静默', () => {
  const c = new ArtifactCollector();
  c.record('docs/a.md', 'write');
  c.tagCall('docs\\a.md', 'c1');
  assert.deepEqual(c.drain(), [{ path: 'docs/a.md', source: 'write', callId: 'c1' }]);
  const c2 = new ArtifactCollector();
  c2.tagCall('ghost.md', 'c0'); // 无匹配不抛不记
  assert.deepEqual(c2.drain(), []);
});
