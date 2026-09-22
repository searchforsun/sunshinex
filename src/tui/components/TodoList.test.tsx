import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { TodoList } from './TodoList';

const todos = [
  { text: '阅读 prd.md', status: 'completed' as const },
  { text: '梳理技术栈版本', status: 'completed' as const },
  { text: '遍历微服务目录并汇总各服务职责', status: 'pending' as const },
  { text: '输出架构总览', status: 'pending' as const },
];

const countLines = (fr: string | undefined) => (fr ?? '').split('\n').filter((l) => l.trim().length > 0).length;

test('TodoList：运行中紧凑形态——单行计数+当前进行项，不铺全量清单', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos} expanded={false} columns={80} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('todo 2/4'), '计数显示（英文口径）');
  assert.ok(f.includes('▸ 遍历微服务目录'), '当前进行项显示');
  assert.ok(!f.includes('阅读 prd.md') && !f.includes('输出架构总览'), '其余项不显示');
  assert.equal(countLines(f), 1, '恰好单行');
  unmount();
});

test('TodoList：展开形态（Tab 展开模式/收束后）全量清单逐行', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos} expanded columns={80} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('todo 2/4'), '标题行（英文口径）');
  assert.ok(f.includes('✓ 阅读 prd.md'), '已完成项勾选展示');
  assert.ok(f.includes('✓ 梳理技术栈版本'), '已完成项第二项勾选展示（夹具无 in_progress，原 ▸ 断言随三态实现校正）');
  assert.ok(f.includes('○ 遍历微服务目录并汇总各服务职责'), '未开始项圆圈展示');
  assert.ok(f.includes('○ 输出架构总览'), '未开始项全量展示');
  unmount();
});

test('TodoList：两种形态行数均恒定（勾选推进不增减行数，不构成高度波动源）', () => {
  const a = render(<TodoList todos={todos} expanded={false} columns={80} />);
  const b = render(<TodoList todos={todos.map((t, i) => ({ ...t, status: i < 3 ? ('completed' as const) : t.status }))} expanded={false} columns={80} />);
  assert.ok((b.lastFrame() ?? '').includes('todo 3/4'), '紧凑计数推进如实显示（英文口径）');
  assert.equal(countLines(b.lastFrame()), countLines(a.lastFrame()), '紧凑形态勾选推进帧高一致');
  a.unmount();
  b.unmount();

  const full = todos.map((t, i) => ({ ...t, status: i < 3 ? ('completed' as const) : t.status }));
  const c = render(<TodoList todos={todos} expanded columns={80} />);
  const d = render(<TodoList todos={full} expanded columns={80} />);
  assert.equal(countLines(d.lastFrame()), countLines(c.lastFrame()), '展开形态勾选推进帧高一致');
  c.unmount();
  d.unmount();
});

const todos3 = [
  { text: '阅读 prd.md', status: 'completed' as const },
  { text: '梳理技术栈版本', status: 'in_progress' as const },
  { text: '输出架构总览', status: 'pending' as const },
];

test('TodoList 三态展开：✓ 已完成 / ▸ 进行中 / ○ 未开始（todo_write 规格 §8）', () => {
  const { lastFrame, unmount } = render(<TodoList todos={todos3} expanded columns={80} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('✓ 阅读 prd.md'), 'completed 勾选展示');
  assert.ok(f.includes('▸ 梳理技术栈版本'), 'in_progress 箭头展示');
  assert.ok(f.includes('○ 输出架构总览'), 'pending 圆圈展示');
  unmount();
});

test('TodoList 紧凑当前项：取首个 in_progress，无则回退首个 pending', () => {
  const a = render(<TodoList todos={todos3} expanded={false} columns={80} />);
  assert.ok((a.lastFrame() ?? '').includes('▸ 梳理技术栈版本'), 'in_progress 优先于 pending');
  a.unmount();
  const b = render(<TodoList todos={[todos3[0], todos3[2]]} expanded={false} columns={80} />);
  assert.ok((b.lastFrame() ?? '').includes('▸ 输出架构总览'), '无 in_progress 回退首个 pending');
  b.unmount();
});
