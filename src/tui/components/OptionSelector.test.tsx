import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { moveCursor, OptionSelector, togglePick } from './OptionSelector';

const opts = [
  { label: 'Approve once' },
  { label: 'Allow for session' },
  { label: 'Deny', description: 'reject this action' },
];

test('moveCursor：↑（-1）/↓（1）首尾循环滚动', () => {
  assert.equal(moveCursor(0, 3, -1), 2, '首行 ↑ 回环到末行');
  assert.equal(moveCursor(2, 3, 1), 0, '末行 ↓ 回环到首行');
  assert.equal(moveCursor(1, 3, -1), 0, '中间行 ↑ 上移');
  assert.equal(moveCursor(1, 3, 1), 2, '中间行 ↓ 下移');
});

test('togglePick：单选覆盖为当前项；多选增删并保持升序', () => {
  assert.deepEqual(togglePick([0], 2, false), [2], '单选覆盖');
  assert.deepEqual(togglePick([], 1, true), [1], '多选勾选');
  assert.deepEqual(togglePick([0, 1], 1, true), [0], '多选取消勾选');
  assert.deepEqual(togglePick([0, 2], 1, true), [0, 1, 2], '多选追加保持升序（answers 按序拼接不漂移）');
});

test('OptionSelector：题头 + ❯ 高亮行 + 行号 + 描述 + 缺省提示行', () => {
  const { lastFrame, unmount } = render(
    <OptionSelector question="How should this proceed?" options={opts} cursor={2} picked={[]} />,
  );
  const f = lastFrame() ?? '';
  assert.ok(f.includes('How should this proceed?'), '题头透传');
  assert.ok(f.includes('❯ 3. Deny'), 'cursor 行 ❯ 高亮 + 序号');
  assert.ok(f.includes('reject this action'), 'description 展示');
  assert.ok(f.includes('enter submit'), '缺省提示行（英文口径）');
  unmount();
});

test('OptionSelector：多选形态 ◉/○ 勾选标记 + 自定义提示行', () => {
  const { lastFrame, unmount } = render(
    <OptionSelector question="Pick tests to run" options={opts} cursor={1} picked={[0, 1]} multiple hint="space toggles" />,
  );
  const f = lastFrame() ?? '';
  assert.ok(f.includes('◉') && f.includes('○'), '勾选/未勾选标记并存');
  assert.ok(f.includes('❯ ◉'), 'cursor 行同时带勾选标记与高亮');
  assert.ok(f.includes('space toggles'), '自定义提示行透传');
  unmount();
});

test('OptionSelector：单选形态不渲染勾选圈', () => {
  const { lastFrame, unmount } = render(<OptionSelector question="q" options={opts} cursor={0} picked={[0]} />);
  const f = lastFrame() ?? '';
  assert.ok(!f.includes('◉') && !f.includes('○'), '单选无勾选圈');
  unmount();
});
