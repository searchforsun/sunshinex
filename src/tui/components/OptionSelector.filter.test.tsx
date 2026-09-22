import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { filterOptions, OptionSelector } from './OptionSelector';

const opts = [
  { label: 'code-review', description: 'Review changes since a fixed point' },
  { label: 'brainstorming', description: 'Turn ideas into designs' },
  { label: 'retro', description: 'Conduct a retrospective' },
];

test('filterOptions：空词恒等（视图=全量、map=[0..n)）', () => {
  const r = filterOptions(opts, '');
  assert.deepEqual(r.view, opts);
  assert.deepEqual(r.map, [0, 1, 2]);
});

test('filterOptions：label 命中、大小写不敏感', () => {
  const r = filterOptions(opts, 'CODE');
  assert.deepEqual(r.map, [0]);
  assert.equal(r.view[0]?.label, 'code-review');
});

test('filterOptions：description 命中', () => {
  const r = filterOptions(opts, 'retrospective');
  assert.deepEqual(r.map, [2]);
});

test('filterOptions：无命中返回空视图（map 空）', () => {
  const r = filterOptions(opts, 'zzz');
  assert.equal(r.view.length, 0);
  assert.deepEqual(r.map, []);
});

test('OptionSelector：filter 渲染筛选行 + 过滤视图 + 勾选按原下标换算 + 编号隐藏', () => {
  const { lastFrame, unmount } = render(
    <OptionSelector question="Load which skill?" options={opts} cursor={0} picked={[2]} multiple filter="re" indexMap={[0, 2]} />,
  );
  const f = lastFrame() ?? '';
  assert.ok(f.includes('/ re▊'), '筛选行显示当前词');
  assert.ok(f.includes('code-review') && f.includes('retro'), '两个命中项渲染');
  assert.ok(!f.includes('brainstorming'), '未命中项不渲染');
  assert.ok(!f.includes('1. code-review') && !f.includes('3. retro'), '筛选态隐藏数字编号前缀');
  assert.ok(f.includes('◉'), '勾选标记按原下标换算（retro 原下标 2 在 picked）');
  unmount();
});

test('OptionSelector：空筛选词渲染筛选行但列表全量（恒等）', () => {
  const { lastFrame, unmount } = render(
    <OptionSelector question="q" options={opts} cursor={0} picked={[]} filter="" />,
  );
  const f = lastFrame() ?? '';
  assert.ok(f.includes('/ ▊'), '空词筛选行');
  assert.ok(f.includes('brainstorming'), '全量渲染');
  unmount();
});

test('OptionSelector：无 filter 渲染与旧形态一致（回归钉：编号照旧、无筛选行）', () => {
  const { lastFrame, unmount } = render(<OptionSelector question="q" options={opts} cursor={1} picked={[1]} />);
  const f = lastFrame() ?? '';
  assert.ok(f.includes('2. brainstorming'), '编号前缀照旧');
  assert.ok(!f.includes('/ ▊'), '无筛选行');
  unmount();
});
