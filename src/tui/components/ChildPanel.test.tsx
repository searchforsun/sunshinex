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
  assert.match(f1, /╭/, '外层特殊边框（2026-09-27 用户裁决对标 CC，运行态视觉分域）');
  const lines1 = f1.replace(/\n$/, '').split('\n').length;
  assert.equal(lines1, 3, '单代理 = 1 内容行 + 2 边框行（每代理一行内容语义不变；动态区只显运行中、无概览计数行）');
  one.unmount();
});

test('ChildPanel：工具活动行单行保证——多调用长命令下每代理行不换行（2026-09-28 用户裁决：工具不要超过一行自动省略）', () => {
  // exec 全量命令修复后调用 target 变长（cf8d73e），旧按调用数均分预算漏算 [label] 前缀/耗时/tokens 尾巴
  // → 宽度超预算换行，面板「每代理一行」护栏被击穿
  const calls = Array.from({ length: 3 }, (_, i) => ({
    callId: `c${i}`,
    target: `EXEC cd src/main/java/com/liepin/aries/web && grep -rn "sortKey" --include="*.java" . | grep -i task-item-${i}`,
    startedAt: Date.now() - 3000,
  }));
  const one = render(
    <ChildPanel childrenState={[child({ label: 'web模块架构分析', calls })]} columns={120} />, 120,
  );  const f = one.lastFrame() ?? '';
  const lines = f.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 3, '单代理 = 1 内容行 + 2 边框行：工具调用再多、命令再长都不得换行');
  assert.ok(f.includes('↑1.2k tokens'), '耗时/tokens 尾巴仍应可见');
  one.unmount();
});

test('ChildPanel：长耗时段 + 大 tokens 尾巴实账预算——行尾不再折行（2026-09-28 真机截图：10m 35s 耗时段与 ↑184k tokens 尾巴击穿估算常数，行尾 tokens 折到第二行）', () => {
  const calls = Array.from({ length: 3 }, (_, i) => ({
    callId: `c${i}`,
    target: `EXEC grep -rn "class TaskResultBizImpl" src/main/java --include="*.java" | head -50-${i}`,
    startedAt: Date.now() - 635_000, // 10m 35s 耗时段
  }));
  const one = render(
    <ChildPanel childrenState={[child({ label: '执行链与中间件能', calls, tokens: 184_000 })]} columns={120} />, 120,
  );
  const lines = (one.lastFrame() ?? '').replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 3, '耗时段/tokens 尾巴按实际宽度计入预算：单代理仍 1 内容行 + 2 边框行');
  assert.ok(lines.join('\n').includes('↑184k tokens'), 'tokens 尾巴仍可见');
  one.unmount();
});

test('ChildPanel：并发 4 面板同屏、总高 = 4 内容行 + 2 边框行（每代理一行护栏）', () => {
  const one = render(<ChildPanel childrenState={[child()]} columns={80} />);
  const base = (one.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  one.unmount();

  const four = render(
    <ChildPanel childrenState={[1, 2, 3, 4].map((i) => child({ label: `w${i}` }))} columns={80} />,
  );
  const f = four.lastFrame() ?? '';
  for (const i of [1, 2, 3, 4]) assert.ok(f.includes(`[w${i}]`), `面板 ${i} 应同屏`);
  assert.equal(f.replace(/\n$/, '').split('\n').length, (base - 2) * 4 + 2, 'N 面板总高 = N 内容行 + 2 边框行（每代理一行护栏；base 含边框故减 2）');
  four.unmount();
});

test('ChildPanel：完成行不进动态区（2026-09-28 用户裁决——动态区只显运行中）', () => {
  const mixed = render(
    <ChildPanel childrenState={[child({ label: 'done1', done: true }), child({ label: 'run1' })]} columns={80} />,
  );
  const f = mixed.lastFrame() ?? '';
  assert.ok(!f.includes('done1'), '完成行不再渲染（归档即离场，Ctrl+B 浏览器承载回看）');
  assert.match(f, /\[run1\]/, '运行中显单行状态');
  mixed.unmount();

  const allDone = render(<ChildPanel childrenState={[child({ done: true })]} columns={80} />);
  assert.equal((allDone.lastFrame() ?? '').trim(), '', '全部完成即面板整体消失（零占位）');
  allDone.unmount();
});

// 结构行类型在面板层不可见（呈现只消费 calls/done/tokens），此处锁定夹具类型契约
test('ChildPanel 夹具：transcript 为 ChildLine 结构行', () => {
  const lines: ChildLine[] = child().transcript;
  assert.equal(lines[0]!.kind, 'call');
});
