import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeRunArtifacts, scanArtifactsJsonl } from './artifacts-handlers';
import type { Artifact } from '../types';

/** 产物并入面(2026-11-20 收敛):唯一来源=report_artifacts 声明;三条自动网(write/edit 写盘钩/
 *  轮末 git 差集/mtime 扫描)按用户裁定退役。mergeRunArtifacts=声明去重(artifactKey 保序)+64 帽 */

test('mergeRunArtifacts:声明按 artifactKey 去重保序,64 帽截断', () => {
  const declared: Artifact[] = [
    { kind: 'file', path: 'docs/a.md', source: 'tool', title: 'v1' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
    { kind: 'file', path: 'docs/a.md', source: 'tool', title: 'v2' }, // 同键 → 弃
  ];
  assert.deepEqual(mergeRunArtifacts(declared), [
    { kind: 'file', path: 'docs/a.md', source: 'tool', title: 'v1' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
  ]);
  const flood: Artifact[] = Array.from({ length: 65 }, (_, i) => ({ kind: 'file' as const, path: `f${String(i).padStart(2, '0')}.md`, source: 'tool' as const }));
  assert.equal(mergeRunArtifacts(flood).length, 64);
  assert.deepEqual(mergeRunArtifacts([]), []);
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
    { kind: 'file', path: 'a.md', source: 'edit', callId: 'c2', runSeq: 2, endedTs: 200 },
    { kind: 'file', path: 'b.png', source: 'bash', runSeq: 2, endedTs: 200 },
  ]);
});

test('scanArtifactsJsonl:空文本/无 run-open 前缀的 runmeta 不认', () => {
  assert.deepEqual(scanArtifactsJsonl(''), []);
  assert.deepEqual(scanArtifactsJsonl(JSON.stringify({ t: 'runmeta', artifacts: [{ path: 'x.md', source: 'write' }] })), []);
});

test('全链(2026-11-20 收敛):write 落盘不再自动登记产物,仅 report_artifacts 声明入卡', async () => {
  const { builtinTools } = await import('../harness/tools/builtin');
  const { SafetyChain } = await import('../harness/security/chain');
  const { SecurityGuard } = await import('../harness/security/guard');
  const { PolicyEngine } = await import('../harness/security/policy');
  const { ProcessSandbox } = await import('../harness/security/sandbox');
  const { ArtifactCollector } = await import('../harness/tools/artifact-collector');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-archain-'));
  const collector = new ArtifactCollector();
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
  const tools = builtinTools(safety, root, { artifacts: collector });
  const write = tools.find((t) => t.name === 'write')!;
  const report = tools.find((t) => t.name === 'report_artifacts')!;
  await write.executor({ path: 'a.md', content: '# hi\n' });
  await write.executor({ path: 'b.xml', content: '<x/>\n' });
  assert.deepEqual(collector.drain(), [], '写盘不再自动产生产物(自动网退役)');
  await report.executor({ artifacts: [{ kind: 'file', path: 'a.md', title: '分析报告', desc: '只读分析报告。' }] });
  const merged = mergeRunArtifacts(collector.drain());
  assert.deepEqual(merged, [{ kind: 'file', path: 'a.md', source: 'tool', title: '分析报告', desc: '只读分析报告。' }]);
  fs.rmSync(root, { recursive: true, force: true });
});
