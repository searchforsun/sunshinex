import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunArtifacts } from './artifacts-handlers';
import type { ArtifactFile, ChangeFile } from '../types';

/** 产物并入面(2026-11-12 spec §3.4-3.5):声明∪bash 兜底(差集中白名单新建),声明优先去重,64 帽 */

test('mergeRunArtifacts:声明∪bash 新建,声明优先去重,64 帽声明集在先', () => {
  const declared: ArtifactFile[] = [
    { path: 'docs/a.md', source: 'write', callId: 'c1' },
    { path: 'shot.png', source: 'edit' },
  ];
  const gitExtra: ChangeFile[] = [
    { path: 'docs/a.md', status: 'untracked', added: 1, deleted: null }, // 声明已有 → 覆弃
    { path: 'out\\csv\\data.csv', status: 'added', added: 9, deleted: null }, // bash 兜底收(反斜杠归一)
    { path: 'src/gen.ts', status: 'untracked', added: 2, deleted: null }, // 白名单外不收
    { path: 'docs/b.md', status: 'modified', added: 1, deleted: 1 }, // 修改类不经兜底(spec §3.4)
  ];
  assert.deepEqual(mergeRunArtifacts(declared, gitExtra), [
    { path: 'docs/a.md', source: 'write', callId: 'c1' },
    { path: 'shot.png', source: 'edit' },
    { path: 'out/csv/data.csv', source: 'bash' },
  ]);
  const flood: ArtifactFile[] = Array.from({ length: 64 }, (_, i) => ({ path: `f${String(i).padStart(2, '0')}.md`, source: 'write' as const }));
  const merged = mergeRunArtifacts(flood, [{ path: 'extra.md', status: 'added', added: 1, deleted: null }]);
  assert.equal(merged.length, 64); // 帽截断:声明集在先,兜底被挤出
  assert.equal(merged.some((a) => a.path === 'extra.md'), false);
});

test('mergeRunArtifacts:双空面=空', () => {
  assert.deepEqual(mergeRunArtifacts([], []), []);
});
