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

test('OptionSelector 超窗滑窗（2026-09-30 翻页口径统一）：窗口随光标平移 + 页脚指示 + 窗口局部序号，零 More…/Back…', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `opt-${i}` }));
  // 首窗：0-7 可见、页脚 1/2 页；序号窗口局部（1.-8.）
  const r1 = render(<OptionSelector question="q" options={many} cursor={0} picked={[]} />);
  const f1 = r1.lastFrame() ?? '';
  assert.ok(f1.includes('opt-0') && f1.includes('opt-7'), '首窗 8 行');
  assert.ok(!f1.includes('opt-8'), '窗口外行不渲染');
  assert.ok(f1.includes('1/2'), '页脚页码指示');
  assert.ok(f1.includes('1. opt-0') && f1.includes('8. opt-7'), '序号=窗口内局部编号');
  assert.ok(!f1.includes('More…') && !f1.includes('Back…') && !f1.includes('更多…') && !f1.includes('上一页'), '零导航行');
  r1.unmount();
  // 光标越过窗口边缘：窗口平移到第二窗、序号重新从 1 起
  const r2 = render(<OptionSelector question="q" options={many} cursor={9} picked={[]} />);
  const f2 = r2.lastFrame() ?? '';
  assert.ok(f2.includes('opt-8') && f2.includes('opt-11'), '第二窗 4 行（8-11）');
  assert.ok(!f2.includes('opt-0') && !f2.includes('opt-7'), '首窗行滑出');
  assert.ok(f2.includes('2. opt-9'), '序号随窗口重排（光标行=窗口第 2 行）');
  assert.ok(f2.includes('2/2') && f2.includes('10/12'), '页脚页码与位置指示');
  r2.unmount();
  // ≤8 项：无滑窗无页脚（与既有形态零漂移——序号局部=全局）
  const few = many.slice(0, 3);
  const r3 = render(<OptionSelector question="q" options={few} cursor={0} picked={[]} />);
  const f3 = r3.lastFrame() ?? '';
  assert.ok(!f3.includes('/1'), '单窗无页脚指示');
  assert.ok(f3.includes('1. opt-0') && f3.includes('3. opt-2'), '序号照常');
  r3.unmount();
});
