import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunArtifacts, scanArtifactsJsonl } from './artifacts-handlers';
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

test('mergeRunArtifacts:声明面 65 条溢出→64 帽截断,全为声明条', () => {
  const flood: ArtifactFile[] = Array.from({ length: 65 }, (_, i) => ({ path: `d${String(i).padStart(2, '0')}.md`, source: 'write' as const }));
  const merged = mergeRunArtifacts(flood, []);
  assert.equal(merged.length, 64); // 声明侧溢出同样截断至 64
  assert.ok(merged.every((a) => a.source === 'write' && a.path.startsWith('d')));
});

/** 产物库聚合扫描(2026-11-12 spec §6.2):run-open 开轮记 seq,runmeta 绑轮,跨 run 去重保最新;
 *  journal 全量扫 → 子智能体 run 的 runmeta 行同样入池(含子 run) */

test('scanArtifactsJsonl:跨 run 同路径保最新 run,坏行跳过,runSeq 倒序', () => {
  const jsonl = [
    JSON.stringify({ t: 'run-open', seq: 1 }),
    JSON.stringify({ t: 'runmeta', artifacts: [{ path: 'a.md', source: 'write', callId: 'c1' }], endedTs: 100 }),
    JSON.stringify({ t: 'run-open', seq: 2 }),
    JSON.stringify({ t: 'runmeta', artifacts: [{ path: 'a.md', source: 'edit', callId: 'c2' }, { path: 'b.png', source: 'bash' }], endedTs: 200 }),
    'junk-line',
    JSON.stringify({ t: 'runmeta', changes: [] }), // 无 artifacts 行忽略
  ].join('\n');
  assert.deepEqual(scanArtifactsJsonl(jsonl), [
    { path: 'a.md', source: 'edit', callId: 'c2', runSeq: 2, endedTs: 200 },
    { path: 'b.png', source: 'bash', runSeq: 2, endedTs: 200 },
  ]);
});

test('scanArtifactsJsonl:空文本/无 run-open 前缀的 runmeta 不认', () => {
  assert.deepEqual(scanArtifactsJsonl(''), []);
  assert.deepEqual(scanArtifactsJsonl(JSON.stringify({ t: 'runmeta', artifacts: [{ path: 'x.md', source: 'write' }] })), []);
});
