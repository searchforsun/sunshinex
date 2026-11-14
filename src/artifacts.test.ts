import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeliverablePath, type Artifact } from './types';
import { kernelEventRows, reduceSegRows } from './session/seglog';
import { sanitizeArtifacts } from './session/entry';
import type { RunMeta } from './session/entry';

/** 轮次产物面(2026-11-12 spec;2026-11-14 kind 化改宗):白名单单点 + sanitize 判别联合
 *  (含旧档 {path,source} 行读取侧迁移) + 落档/重放往返 */

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

test('sanitizeArtifacts:kind 判别校验/旧档 path 行升级 file/url 形态/command/坏行弃/去重保首现', () => {
  assert.deepEqual(
    sanitizeArtifacts([
      { path: 'a.md', source: 'write' }, // 旧档行(无 kind)→ 升级 kind:file
      { path: '', source: 'write' },
      'junk',
      { path: 'b.png', source: 'hax' },
      { kind: 'file', path: 'a.md', source: 'edit', callId: 'c9' }, // 同 key → 保首现
      { kind: 'url', url: 'https://localhost:7788', title: '在线试玩', desc: '浏览器直接玩' },
      { kind: 'url', url: 'ftp://bad' }, // 非 http(s) → 弃
      { kind: 'command', command: 'python gomoku.py' },
      { kind: 'command', command: '' }, // 空 command → 弃
      { kind: 'url', title: '无 url 字段' }, // 缺 url → 弃
    ]),
    [
      { kind: 'file', path: 'a.md', source: 'write' },
      { kind: 'url', url: 'https://localhost:7788', source: 'tool', title: '在线试玩', desc: '浏览器直接玩' },
      { kind: 'command', command: 'python gomoku.py', source: 'tool' },
    ],
  );
  assert.equal(sanitizeArtifacts(undefined), undefined);
  assert.equal(sanitizeArtifacts('x'), undefined);
  assert.equal(sanitizeArtifacts([]), undefined);
});

test('runmeta.artifacts 落档/重放往返:kernelEventRows 带出 → runMetaOf 绑回末个 run 条', () => {
  const artifacts = [
    { kind: 'file', path: 'docs/report.md', source: 'write', callId: 'c1' },
    { kind: 'file', path: 'shot.png', source: 'bash' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
  ] satisfies Artifact[];
  const meta: RunMeta = { seconds: 3, steps: 5, artifacts };
  const rows = kernelEventRows({ t: 'runmeta', entry: { seq: 7, ts: 1, kind: 'run', md: '', meta } });
  const replayed = reduceSegRows([{ t: 'run-open', ts: 1, seq: 7 }, ...rows]);
  const runEntry = replayed.find((e) => e.kind === 'run');
  assert.ok(runEntry);
  assert.deepEqual(runEntry.meta?.artifacts, artifacts);
  assert.equal(runEntry.meta?.steps, 5);
});
