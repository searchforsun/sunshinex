import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { Spinner } from './Spinner';

test('Spinner 三态：thinking 保留思考动词帧；tool-pending 按调用数渲染状态行', () => {
  const thinking = render(
    <Spinner startedAt={Date.now() - 5000} tokens={1200} phase="thinking" calls={[]} />,
  );
  const ft = thinking.lastFrame() ?? '';
  assert.match(ft, /Pondering|Brewing|Weaving|Distilling/, 'thinking 保留既有动词轮换');
  thinking.unmount();

  const pending = render(
    <Spinner
      startedAt={Date.now() - 3000}
      tokens={0}
      phase="tool-pending"
      calls={[
        { callId: 'step:1-idx:0', verb: 'read', target: 'read src/a.ts', startedAt: Date.now() - 2000 },
        { callId: 'step:1-idx:1', verb: 'grep', target: 'grep pattern', startedAt: Date.now() - 1000 },
      ]}
    />,
  );
  const fp = pending.lastFrame() ?? '';
  assert.match(fp, /\[read src\/a\.ts\]/, '活跃调用行含调用行全形（target 携带任务语义）');
  assert.match(fp, /\[grep pattern\]/, '并行批逐调用一行');
  const lines = fp.replace(/\n$/, '').split('\n').filter((l) => l.trim().length > 0).length;
  assert.equal(lines, 2, '两活跃调用恒 2 行（帧高 = 活跃调用数）');
  pending.unmount();
});

test('Spinner 三态：tool-awaiting 标注等待审批', () => {
  const awaiting = render(
    <Spinner
      startedAt={Date.now() - 3000}
      tokens={0}
      phase="tool-awaiting"
      calls={[{ callId: 'step:2-idx:0', verb: 'write', target: 'write out.txt', startedAt: Date.now() - 1500 }]}
    />,
  );
  const f = awaiting.lastFrame() ?? '';
  assert.match(f, /\[write out\.txt\]/);
  assert.match(f, /awaiting approval/, '审批挂起态显式标注');
  awaiting.unmount();
});

test('活跃调用行超宽 verb：按列宽自然省略，宽列完整呈现', () => {
  const pending = render(
    <Spinner startedAt={Date.now()} tokens={0} phase="tool-pending" columns={40}
      calls={[{ callId: 'c1', verb: 'read', target: `read ${'p'.repeat(120)}`, startedAt: Date.now() }]} />,
  );
  const fn = pending.lastFrame() ?? '';
  assert.ok(fn.includes('…'), '窄列：省略号收尾');
  pending.unmount();
  const wide = render(
    <Spinner startedAt={Date.now()} tokens={0} phase="tool-pending" columns={200}
      calls={[{ callId: 'c1', verb: 'read', target: `read ${'p'.repeat(120)}`, startedAt: Date.now() }]} />,
    200,
  );
  const fw = wide.lastFrame() ?? '';
  assert.ok(fw.includes('p'.repeat(120)), '宽列：完整呈现');
  wide.unmount();
});

test('运行态单一化：spawn 类调用不出主链活动行（子代理运行态由 ChildPanel 边框单点承载）', () => {
  // 2026-09-27 真机症状：派发期同一子代理双份运行态（主链 [SPAWN …] 行 + 面板行）、计时不同步
  const one = render(
    <Spinner startedAt={Date.now()} tokens={0} phase="tool-pending" columns={80}
      calls={[
        { callId: 's1', verb: 'spawn', target: 'spawn AI层调研', startedAt: Date.now() - 1000 },
        { callId: 's2', verb: 'spawn', target: 'spawn 数据层调研', startedAt: Date.now() - 1000 },
      ]} />,
  );
  const f = one.lastFrame() ?? '';
  assert.ok(!f.includes('SPAWN') && !f.includes('AI层调研'), '纯 spawn 批：主链活动行零渲染');
  one.unmount();
  const mixed = render(
    <Spinner startedAt={Date.now()} tokens={0} phase="tool-pending" columns={80}
      calls={[
        { callId: 's1', verb: 'spawn', target: 'spawn AI层调研', startedAt: Date.now() - 1000 },
        { callId: 'g1', verb: 'grep', target: 'grep pattern', startedAt: Date.now() - 500 },
      ]} />,
  );
  const fm = mixed.lastFrame() ?? '';
  assert.ok(!fm.includes('AI层调研'), '混合批：spawn 行被过滤');
  assert.match(fm, /\[grep pattern\]/, '混合批：本链调用照常呈现');
  mixed.unmount();
});
