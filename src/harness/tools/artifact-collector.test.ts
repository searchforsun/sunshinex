import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactCollector } from './artifact-collector';

/** 产物收集器(2026-11-20 收敛):唯一写入口=declare(report_artifacts 模型显式声明);
 *  自动网(write/edit 落盘钩/git 差集/mtime 扫描)按用户裁定全部退役。drain 按 artifactKey 保末次 */

test('declare 任意 kind 入列;drain 按 artifactKey 去重保末次并清空', () => {
  const c = new ArtifactCollector();
  c.declare([
    { kind: 'file', path: 'docs/a.md', source: 'tool', title: '主文档', desc: '本轮主交付物' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
  ]);
  c.declare([{ kind: 'file', path: 'docs/a.md', source: 'tool', title: '主文档 v2' }]);
  assert.deepEqual(c.drain(), [
    { kind: 'file', path: 'docs/a.md', source: 'tool', title: '主文档 v2' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
  ]);
  assert.deepEqual(c.drain(), []); // drain 清空
});

test('无声明=drain 空;反斜杠/正斜杠路径视同键', () => {
  const c = new ArtifactCollector();
  assert.deepEqual(c.drain(), []);
  c.declare([{ kind: 'file', path: 'docs\\a.md', source: 'tool' }]);
  c.declare([{ kind: 'file', path: 'docs/a.md', source: 'tool', title: '归一' }]);
  assert.deepEqual(c.drain(), [{ kind: 'file', path: 'docs/a.md', source: 'tool', title: '归一' }]);
});
