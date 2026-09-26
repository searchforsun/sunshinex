import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ChildPanel } from './ChildPanel';
import { ChildLine, ChildLiveState } from '../session';

const child = (over: Partial<ChildLiveState> = {}): ChildLiveState => ({
  label: 'w',
  startedAt: Date.now(),
  steps: 2,
  tokens: 1200,
  transcript: [{ kind: 'call', text: 'READ a.ts' }, { kind: 'result', text: '4 matches', ok: true }, { kind: 'text', text: '分析结论' }],
  ...over,
});

test('ChildPanel：空 children 零占位；CC 式每代理一行（规格 §3.1）', () => {
  const empty = render(<ChildPanel childrenState={[]} columns={80} />);
  assert.equal((empty.lastFrame() ?? '').trim(), '', '空面板态不占任何行（规格 §5 零占位）');
  empty.unmount();

  const one = render(<ChildPanel childrenState={[child()]} columns={80} />);
  const f1 = one.lastFrame() ?? '';
  assert.match(f1, /\[w\]/, '头部应含 [label] 标识（Spinner label 前缀）');
  const lines1 = f1.replace(/\n$/, '').split('\n').length;
  assert.equal(lines1, 1, '单代理恰一行（CC 式收敛，尾流展示取消）');
  one.unmount();
});

test('ChildPanel：并发 4 面板同屏、总高 = 4 行（每代理一行护栏）', () => {
  const one = render(<ChildPanel childrenState={[child()]} columns={80} />);
  const base = (one.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  one.unmount();

  const four = render(
    <ChildPanel childrenState={[1, 2, 3, 4].map((i) => child({ label: `w${i}` }))} columns={80} />,
  );
  const f = four.lastFrame() ?? '';
  for (const i of [1, 2, 3, 4]) assert.ok(f.includes(`[w${i}]`), `面板 ${i} 应同屏`);
  assert.equal(f.replace(/\n$/, '').split('\n').length, base * 4, 'N 面板总高 = N 行（每代理一行护栏，规格 §3.1）');
  four.unmount();
});

test('ChildPanel：完成态终标行即时定格（done 优先于活动行/Spinner）', () => {
  const mixed = render(
    <ChildPanel childrenState={[child({ label: 'done1', done: true }), child({ label: 'run1' })]} columns={80} />,
  );
  const f = mixed.lastFrame() ?? '';
  assert.match(f, /✓ \[done1\] done/, '完成态显终标行');
  assert.match(f, /\[run1\]/, '运行中显单行状态');
  mixed.unmount();
});

// 结构行类型在面板层不可见（呈现只消费 calls/done/tokens），此处锁定夹具类型契约
test('ChildPanel 夹具：transcript 为 ChildLine 结构行', () => {
  const lines: ChildLine[] = child().transcript;
  assert.equal(lines[0]!.kind, 'call');
});

test('ChildPanel：done 行含步数/冻结耗时/tokens（doneAt 冻结，不随帧跳动）', () => {
  const start = Date.now() - 5000;
  const one = render(
    <ChildPanel childrenState={[child({ done: true, doneAt: start + 4000, startedAt: start, steps: 14, tokens: 1300 })]} columns={80} />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /✓ \[w\] done \(14 steps · 4s · ↑1\.3k tokens\)/, 'done 行 = steps · 冻结耗时 · tokens');
  one.unmount();
});
