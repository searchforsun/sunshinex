import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { TodoList } from './TodoList';

const todos = [
  { text: '阅读 prd.md', done: true },
  { text: '梳理技术栈版本', done: true },
  { text: '遍历微服务目录', done: false },
  { text: '输出架构总览', done: false },
];

test('TodoList：运行中折叠为单行进度（帧高恒定，不随勾选增减行数）', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos} running />);
  const f1 = lastFrame() ?? '';
  assert.ok(f1.includes('待办 2/4'), '单行进度应显示已完成/总数');
  assert.ok(f1.includes('遍历微服务目录'), '单行进度应含当前进行项');
  assert.ok(!f1.includes('输出架构总览'), '运行中不展开未开始项（帧高有界）');
  assert.equal(f1.split('\n').length, 1, '运行中恰好单行');
  unmount();
});

test('TodoList：收束后展开全量清单（✓/▸ 逐行）', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('✓ 阅读 prd.md'), '已完成项勾选展示');
  assert.ok(f.includes('▸ 输出架构总览'), '未完成项箭头展示');
  unmount();
});
