import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPlugins } from './loader';

test('loadPlugins：扫描 plugins/{id}/plugin.json，id 以目录名为准', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  try {
    assert.deepEqual(loadPlugins(dir), []);
    fs.mkdirSync(path.join(dir, 'plugins', 'p1'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugins', 'p1', 'plugin.json'),
      JSON.stringify({ id: '被目录名覆盖', name: 'P1', version: '1.0.0', entry: 'index.js' }),
    );
    const list = loadPlugins(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'p1');
    assert.equal(list[0].name, 'P1');
    assert.equal(list[0].entry, 'index.js');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPlugins：无 plugin.json 的目录滤除；非法 JSON 降级跳过不阻断合法插件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-bad-'));
  try {
    fs.mkdirSync(path.join(dir, 'plugins', 'p2'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'plugins', 'p3'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'p3', 'plugin.json'), '{不是 JSON');
    fs.mkdirSync(path.join(dir, 'plugins', 'p4'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'p4', 'plugin.json'), JSON.stringify({ name: 'P4', version: '0.2.0' }));
    const list = loadPlugins(dir);
    assert.equal(list.length, 1, '仅 p4 入列：p2 无清单被滤、p3 损坏被降级跳过');
    assert.equal(list[0].id, 'p4');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
