import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ChildInspector } from './ChildInspector';
import { ChildLiveState } from '../session';

const live = (over: Partial<ChildLiveState> = {}): ChildLiveState => ({
  label: 'w', startedAt: Date.now() - 12_000, steps: 14, tokens: 13_000,
  transcript: [
    { kind: 'text', text: '分析中…' },
    { kind: 'call', text: 'READ src/a.ts' },
    { kind: 'result', text: '84 lines', ok: true },
  ],
  ...over,
});

test('Inspector 运行中：头部状态行（label/step/tokens/耗时/Esc 提示）与正文结构行混排', () => {
  const one = render(<ChildInspector child={live()} columns={80} rows={12} />);
  const f = one.lastFrame() ?? '';
  assert.match(f, /\[w\]/, '头部携带 label');
  assert.match(f, /step 14/, '头部携带步数');
  assert.match(f, /Esc/, '头部携带退出提示');
  assert.match(f, /READ src\/a\.ts/, 'call 行原样呈现');
  assert.match(f, /⎿ ✓ 84 lines/, 'result 行 ⎿ + ok 标记');
  assert.match(f, /分析中…/, 'text 行原样混排');
  one.unmount();
});

test('Inspector 完成态：detail 行解析回看（⎿ 前缀→result 形态，其余原样）', () => {
  const one = render(
    <ChildInspector
      archived={{ label: 'w', lines: ['READ src/a.ts', '⎿ ✓ 84 lines', '⎿ ✗ boom'], steps: 5, durationMs: 61_000 }}
      columns={80}
      rows={12}
    />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /READ src\/a\.ts/, 'call/text 行呈现');
  assert.match(f, /⎿ ✓ 84 lines/, 'result 行呈现');
  assert.match(f, /⎿ ✗ boom/, '失败结果行呈现');
  one.unmount();
});

test('Inspector 取尾适配视口：超出 rows 的更早行不渲染（动态区有界约束）', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'text' as const, text: `line-${i}` }));
  const one = render(<ChildInspector child={live({ transcript: many })} columns={80} rows={10} />);
  const f = one.lastFrame() ?? '';
  assert.ok(!f.includes('line-0'), '视口外的更早行不渲染');
  assert.ok(!f.includes('line-10'), '视口外的更早行不渲染');
  assert.match(f, /line-49/, '最新行在视口内');
  one.unmount();
});

test('Inspector 头部呈委派 prompt', () => {
  const one = render(<ChildInspector child={live({ prompt: '调研单体链路' })} columns={80} rows={12} />);
  assert.match(one.lastFrame() ?? '', /调研单体链路/, '头部呈委派提示词');
  one.unmount();
});
