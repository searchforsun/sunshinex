import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactCollector } from './artifact-collector';

/** 产物收集器(2026-11-12 spec §3.3;2026-11-14 kind 化):record 白名单过滤/file 回标挂末尾
 *  未标条目/declare 任意 kind 入列且 drain 时遮蔽同键推导条/drain 按键保末次并清空 */

test('record:白名单过滤;同路径多刀 drain 保末次(含末个 source 与末次回标)', () => {
  const c = new ArtifactCollector();
  c.record('docs/a.md', 'write');
  c.record('src/index.ts', 'write'); // 代码不收
  c.tagCall('docs/a.md', 'c1');
  c.record('docs/a.md', 'edit'); // 第二刀
  c.tagCall('docs/a.md', 'c2');
  assert.deepEqual(c.drain(), [{ kind: 'file', path: 'docs/a.md', source: 'edit', callId: 'c2' }]);
  assert.deepEqual(c.drain(), []); // drain 清空
});

test('tagCall:回标路径反斜杠归一比对;无匹配静默', () => {
  const c = new ArtifactCollector();
  c.record('docs/a.md', 'write');
  c.tagCall('docs\\a.md', 'c1');
  assert.deepEqual(c.drain(), [{ kind: 'file', path: 'docs/a.md', source: 'write', callId: 'c1' }]);
  const c2 = new ArtifactCollector();
  c2.tagCall('ghost.md', 'c0'); // 无匹配不抛不记
  assert.deepEqual(c2.drain(), []);
});

test('declare:任意 kind 入列;drain 时声明遮蔽同键推导条并在先', () => {
  const c = new ArtifactCollector();
  c.record('docs/a.md', 'write'); // 自动网推导条(同键)
  c.declare([
    { kind: 'file', path: 'docs/a.md', source: 'tool', title: '主文档', desc: '本轮主交付物' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
    { kind: 'command', command: 'python gomoku.py', source: 'tool' },
  ]);
  const out = c.drain();
  assert.deepEqual(out, [
    { kind: 'file', path: 'docs/a.md', source: 'tool', title: '主文档', desc: '本轮主交付物' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
    { kind: 'command', command: 'python gomoku.py', source: 'tool' },
  ]);
});

test('declare 后同键不再收推导重复;不同键推导照收', () => {
  const c = new ArtifactCollector();
  c.declare([{ kind: 'file', path: 'a.md', source: 'tool' }]);
  c.record('a.md', 'edit'); // 同键推导 → 被 declare 遮蔽
  c.record('b.md', 'write'); // 不同键 → 照收
  assert.deepEqual(c.drain(), [
    { kind: 'file', path: 'a.md', source: 'tool' },
    { kind: 'file', path: 'b.md', source: 'write' },
  ]);
});
