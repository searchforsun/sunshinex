import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { TodoList } from './TodoList';

const todos = [
  { text: '阅读 prd.md', done: true },
  { text: '梳理技术栈版本', done: true },
  { text: '遍历微服务目录并汇总各服务职责', done: false },
  { text: '输出架构总览', done: false },
];

const countLines = (fr: string | undefined) => (fr ?? '').split('\n').filter((l) => l.trim().length > 0).length;

test('TodoList：运行中紧凑形态——单行计数+当前进行项，不铺全量清单', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos} expanded={false} columns={80} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('待办 2/4'), '计数显示');
  assert.ok(f.includes('▸ 遍历微服务目录'), '当前进行项显示');
  assert.ok(!f.includes('阅读 prd.md') && !f.includes('输出架构总览'), '其余项不显示');
  assert.equal(countLines(f), 1, '恰好单行');
  unmount();
});

test('TodoList：展开形态（Tab 展开模式/收束后）全量清单逐行', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos} expanded columns={80} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('待办 2/4'), '标题行');
  assert.ok(f.includes('✓ 阅读 prd.md'), '已完成项勾选展示');
  assert.ok(f.includes('▸ 遍历微服务目录并汇总各服务职责'), '进行中项箭头展示');
  assert.ok(f.includes('▸ 输出架构总览'), '未开始项全量展示');
  unmount();
});

test('TodoList：两种形态行数均恒定（勾选推进不增减行数，不构成高度波动源）', () => {
  const a = render(<TodoList todos={todos} expanded={false} columns={80} />);
  const b = render(<TodoList todos={todos.map((t, i) => ({ ...t, done: i < 3 }))} expanded={false} columns={80} />);
  assert.ok((b.lastFrame() ?? '').includes('待办 3/4'), '紧凑计数推进如实显示');
  assert.equal(countLines(b.lastFrame()), countLines(a.lastFrame()), '紧凑形态勾选推进帧高一致');
  a.unmount();
  b.unmount();

  const full = todos.map((t, i) => ({ ...t, done: i < 3 }));
  const c = render(<TodoList todos={todos} expanded columns={80} />);
  const d = render(<TodoList todos={full} expanded columns={80} />);
  assert.equal(countLines(d.lastFrame()), countLines(c.lastFrame()), '展开形态勾选推进帧高一致');
  c.unmount();
  d.unmount();
});
