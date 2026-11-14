import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeliverablePath, type ArtifactFile } from './types';
import { kernelEventRows, reduceSegRows } from './session/seglog';
import { sanitizeArtifacts } from './session/entry';
import type { RunMeta } from './session/entry';

/** 轮次产物面(2026-11-12 spec):白名单单点 + sanitize + 落档/重放往返(Task 2 追加) */

test('isDeliverablePath:白名单命中(大小写不敏感/反斜杠/嵌套目录),代码与点开头顶格不认', () => {
  assert.equal(isDeliverablePath('docs/TECH-DEBT-LOG.md'), true);
  assert.equal(isDeliverablePath('报告.MD'), true);
  assert.equal(isDeliverablePath('mocks\\ui\\logo.svg'), true);
  assert.equal(isDeliverablePath('docs/data.Export.JSON'), true);
  assert.equal(isDeliverablePath('src/index.ts'), false);
  assert.equal(isDeliverablePath('src/app.py'), false);
  assert.equal(isDeliverablePath('README'), false);
  assert.equal(isDeliverablePath('dir/.hidden'), false);
});

test('sanitizeArtifacts:坏行弃/source 枚举收敛/path 去重保首现', () => {
  assert.deepEqual(
    sanitizeArtifacts([
      { path: 'a.md', source: 'write' },
      { path: '', source: 'write' },
      'junk',
      { path: 'b.png', source: 'hax' },
      { path: 'a.md', source: 'edit', callId: 'c9' },
    ]),
    [{ path: 'a.md', source: 'write' }],
  );
  assert.equal(sanitizeArtifacts(undefined), undefined);
  assert.equal(sanitizeArtifacts('x'), undefined);
  assert.equal(sanitizeArtifacts([]), undefined);
});

test('runmeta.artifacts 落档/重放往返:kernelEventRows 带出 → runMetaOf 绑回末个 run 条', () => {
  const artifacts = [
    { path: 'docs/report.md', source: 'write', callId: 'c1' },
    { path: 'shot.png', source: 'bash' },
  ] satisfies ArtifactFile[];
  const meta: RunMeta = { seconds: 3, steps: 5, artifacts };
  const rows = kernelEventRows({ t: 'runmeta', entry: { seq: 7, ts: 1, kind: 'run', md: '', meta } });
  const replayed = reduceSegRows([{ t: 'run-open', ts: 1, seq: 7 }, ...rows]);
  const runEntry = replayed.find((e) => e.kind === 'run');
  assert.ok(runEntry);
  assert.deepEqual(runEntry.meta?.artifacts, artifacts);
  assert.equal(runEntry.meta?.steps, 5);
});
