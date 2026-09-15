import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './tools';
import type { ToolCategory } from '../types';
import type { RegisteredTool } from './tools';

function mockTool(name: string, category: ToolCategory = 'read'): RegisteredTool {
  return {
    name,
    description: `desc ${name}`,
    category,
    executor: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
  };
}

test('derive：exclude 剔除、only 收窄、原 registry 零突变、executor 引用共享', () => {
  const parent = new ToolRegistry();
  parent.register(mockTool('read'));
  parent.register(mockTool('glob'));
  parent.register(mockTool('spawn', 'subagent'));

  const child = parent.derive({ exclude: ['spawn'] });
  assert.ok(!child.has('spawn'), '子面剔除 spawn');
  assert.ok(child.has('read') && child.has('glob'));

  const narrowed = parent.derive({ only: ['read'] });
  assert.deepEqual(narrowed.list().map((t) => t.name), ['read']);

  assert.ok(parent.has('spawn'), '原 registry 不被派生突变');

  assert.equal(parent.get('read')!.executor, child.get('read')!.executor, 'executor 引用共享：工具无状态、安全链执行期注入');
});

test('derive：only 含未知名静默取交集（未知名校验属 spawn 输入面职责，derive 保持纯函数）', () => {
  const parent = new ToolRegistry();
  parent.register(mockTool('read'));
  const child = parent.derive({ only: ['read', 'ghost'] });
  assert.deepEqual(child.list().map((t) => t.name), ['read']);
});

test('derive：无参克隆全量面（等价空 exclude，供既有 fork 装配点统一收口复用）', () => {
  const parent = new ToolRegistry();
  parent.register(mockTool('read'));
  const clone = parent.derive();
  assert.deepEqual(clone.list().map((t) => t.name), ['read']);
  clone.register(mockTool('extra'));
  assert.ok(!parent.has('extra'), '克隆面写入不回渗');
});
