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
  transcript: [{ kind: 'call', text: 'READ a.ts' }, { kind: 'result', text: '4 matches', ok: true }, { kind: 'text', text: '分析结论' }],
  ...over,
});

test('ChildPanel：运行中头行携带 step N 计数（子代理执行进度可见）', () => {
  const one = render(<ChildPanel childrenState={[child({ steps: 7 })]} columns={80} />);
  const f = one.lastFrame() ?? '';
  assert.match(f, /step 7/, '运行中面板头行应含 step 计数（ChildLiveState.steps 已采集，呈现零成本）');
  one.unmount();
});

test('ChildPanel：工具活动行对齐主链——当前调用名替代轮换动词 + 调用耗时', () => {
  const started = Date.now() - 5000;
  const one = render(
    <ChildPanel
      childrenState={[child({ calls: [{ callId: 's1:0', verb: 'grep', startedAt: started }] })]}
      columns={80}
    />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /\[grep\]/, '工具挂起时头行应显示当前调用名而非轮换动词');
  assert.ok(!/Brewing|Pondering|Weaving|Distilling/.test(f), '活动行不得退回动词轮换（与主链口径对齐）');
  one.unmount();

  const idle = render(<ChildPanel childrenState={[child()]} columns={80} />);
  assert.match((idle.lastFrame() ?? ''), /(Brewing|Pondering|Weaving|Distilling)/, '无活跃调用时维持动词轮换');
  idle.unmount();
});
