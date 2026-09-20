import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ToolRow } from './ToolRow';
import { ChatItem } from '../session';

const spawnCall: ChatItem = {
  role: 'tool', text: 'SPAWN reviewer', ts: 0, seq: 1, kind: 'call',
  detail: 'READ a.ts\n4 matches\n结论行',
  subagentMeta: { steps: 3, durationMs: 42_000 },
};

test('SPAWN 折叠态：● 头行带 meta 尾注，不重放转录', () => {
  const f = render(<ToolRow item={spawnCall} columns={80} collapsed={true} />).lastFrame() ?? '';
  assert.match(f, /● \[SPAWN\] reviewer（3 steps · 42s）/);
  assert.doesNotMatch(f, /结论行/);
});

test('SPAWN 展开态（spawnExpanded）：▾ 头行 + 转录缩进重放', () => {
  const f = render(<ToolRow item={spawnCall} columns={80} collapsed={true} spawnExpanded={true} />).lastFrame() ?? '';
  assert.match(f, /▾ \[SPAWN\] reviewer/);
  assert.match(f, /结论行/);
});

test('meta 缺省：折叠态无尾注；Tab 全场展开（collapsed=false）行为不变', () => {
  const bare: ChatItem = { ...spawnCall, subagentMeta: undefined };
  const f1 = render(<ToolRow item={bare} columns={80} collapsed={true} />).lastFrame() ?? '';
  assert.match(f1, /● \[SPAWN\] reviewer/);
  assert.doesNotMatch(f1, /steps/);
  const f2 = render(<ToolRow item={spawnCall} columns={80} collapsed={false} />).lastFrame() ?? '';
  assert.match(f2, /结论行/, 'Tab 全展开重放保持既有行为');
});

test('非 SPAWN 调用行形态零变化：无尾注、头标恒 ●', () => {
  const write: ChatItem = { role: 'tool', text: 'WRITE a.ts', ts: 0, seq: 2, kind: 'call' };
  const f = render(<ToolRow item={write} columns={80} collapsed={true} spawnExpanded={true} />).lastFrame() ?? '';
  assert.match(f, /● \[WRITE\] a\.ts/);
  assert.doesNotMatch(f, /steps/);
});
