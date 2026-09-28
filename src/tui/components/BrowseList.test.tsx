import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { BrowseList, BROWSE_PAGE_ROWS } from './BrowseList';

const row = (id: string, label: string, extra?: { running?: boolean }) => ({
  id,
  label,
  ...(extra ?? {}),
  meta: { steps: 2, durationMs: 42_000, tokens: 800 },
});

test('BrowseList：行序由调用方单点口径给定（运行中在前 + 已完成委派时间升序），组件按传入序渲染', () => {
  const f = render(
    <BrowseList
      rows={[row('live:w', 'w', { running: true }), row('archived:10', 'early'), row('archived:11', 'late')]}
      cursor={0}
    />,
  ).lastFrame() ?? '';
  const w = f.indexOf('[w]');
  const early = f.indexOf('[early]');
  const late = f.indexOf('[late]');
  assert.ok(w >= 0 && early > w && late > early, '运行中在前、已完成按传入序（委派时间升序在 App 单点口径落定）');
  assert.match(f, /running|运行中/, '运行中行带运行态标记（i18n 双语形态）');
});

test('BrowseList：光标行反色标记 ❯、非光标行无前缀', () => {
  const f = render(<BrowseList rows={[row('a:1', 'a'), row('a:2', 'b')]} cursor={1} />).lastFrame() ?? '';
  const a = f.indexOf('[a]');
  const b = f.indexOf('[b]');
  assert.ok(b > a, '两行同屏');
  assert.match(f, /❯ \[b\]/, '光标行 ❯ 前缀');
  assert.doesNotMatch(f, /❯ \[a\]/, '非光标行无 ❯ 前缀');
});

test(`BrowseList：每页 ${BROWSE_PAGE_ROWS} 行窗口、页脚页码，翻页窗口平移`, () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`a:${i + 1}`, `t${i + 1}`));
  const page1 = render(<BrowseList rows={rows} cursor={0} />).lastFrame() ?? '';
  assert.doesNotMatch(page1, /\[t9\]/, '第 1 页不含第 9 行（每页 8 个窗口）');
  assert.doesNotMatch(page1, /\[t10\]/, '第 1 页不含第 10 行');
  assert.match(page1, /page 1\/2/, '超出单页显示页脚页码');
  const page2 = render(<BrowseList rows={rows} cursor={8} />).lastFrame() ?? '';
  assert.match(page2, /\[t9\]/, '第 2 页窗口平移后含第 9 行');
  assert.match(page2, /\[t10\]/, '第 2 页含第 10 行');
  assert.doesNotMatch(page2, /\[t1\]/, '第 2 页不含第 1 行');
});

test('BrowseList：空态零占位；归档行带 steps/耗时元信息', () => {
  const empty = render(<BrowseList rows={[]} cursor={0} />);
  assert.equal((empty.lastFrame() ?? '').trim(), '', '空态零占位');
  empty.unmount();
  const f = render(<BrowseList rows={[row('a:1', 'w1')]} cursor={0} />).lastFrame() ?? '';
  assert.match(f, /2 steps · 42s/, '归档行统计元信息在位');
});
