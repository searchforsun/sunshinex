import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ChildPanel } from './ChildPanel';
import { ChildLiveState } from '../session';

const child = (over: Partial<ChildLiveState> = {}): ChildLiveState => ({
  label: 'w',
  startedAt: Date.now(),
  steps: 2,
  tokens: 1200,
  transcript: ['READ a.ts', '4 matches', '分析结论'],
  tail: ['READ a.ts', '4 matches', '分析结论'],
  ...over,
});

test('ChildPanel：空 children 零占位；单面板恒 4 行；tail 轮转帧高不变', () => {
  const empty = render(<ChildPanel childrenState={[]} columns={80} />);
  assert.equal((empty.lastFrame() ?? '').trim(), '', '空面板态不占任何行（规格 §5 零占位）');
  empty.unmount();

  const one = render(<ChildPanel childrenState={[child()]} columns={80} />);
  const f1 = one.lastFrame() ?? '';
  assert.match(f1, /\[w\]/, '头部应含 [label] 标识（Spinner label 前缀）');
  assert.match(f1, /READ a\.ts/, '尾流应含最近行');
  const lines1 = f1.replace(/\n$/, '').split('\n').length;
  one.unmount();

  const rotated = render(
    <ChildPanel childrenState={[child({ tail: ['行二', '行三', '行四最新'] })]} columns={80} />,
  );
  const f2 = rotated.lastFrame() ?? '';
  const lines2 = f2.replace(/\n$/, '').split('\n').length;
  assert.equal(lines1, lines2, 'tail 轮转前后帧高恒定（恒 4 行面板，规格 D5）');
  assert.ok(f2.includes('行四最新'), '应显示最新尾行');
  rotated.unmount();
});

test('ChildPanel：并发 4 面板同屏、总高 = 4×单面板恒定（护栏）', () => {
  const one = render(<ChildPanel childrenState={[child()]} columns={80} />);
  const base = (one.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  one.unmount();

  const four = render(
    <ChildPanel childrenState={[1, 2, 3, 4].map((i) => child({ label: `w${i}` }))} columns={80} />,
  );
  const f = four.lastFrame() ?? '';
  for (const i of [1, 2, 3, 4]) assert.ok(f.includes(`[w${i}]`), `面板 ${i} 应同屏`);
  assert.equal(f.replace(/\n$/, '').split('\n').length, base * 4, '4 面板总高 = 4×单面板恒定（规格 D5 护栏）');
  four.unmount();
});

test('ChildPanel：尾流超宽折行取尾（最新片段可见、帧高恒 4 行）', () => {
  const wide = render(
    <ChildPanel childrenState={[child({ tail: [`${'x'.repeat(200)}流式尾部END`] })]} columns={40} />,
  );
  const f = wide.lastFrame() ?? '';
  const lines = f.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 4, '折行取尾后帧高仍恒 4 行（空位以空格补足，ink 空串行会塌行）');
  assert.ok(f.includes('END'), '超宽流式行应显示最新尾部内容（规格 G2）');
  wide.unmount();
});
