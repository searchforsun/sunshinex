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

test('Inspector 运行中：无外框整页平铺，状态行（label/step/tokens/Esc 提示）与结构行混排（2026-09-29 用户裁决去边框）', () => {
  const one = render(<ChildInspector child={live()} columns={80} rows={12} />);
  const f = one.lastFrame() ?? '';
  const all = one.allOutput();
  assert.doesNotMatch(all, /╭/, '无外层边框（视作独立主 agent session 平铺）');
  assert.match(f, /\[w\]/, '状态行携带 label');
  assert.match(f, /step 14/, '状态行携带步数');
  assert.match(f, /Esc/, '状态行携带退出提示');
  assert.match(all, /● \[READ\] src\/a\.ts/, 'call 行与主 agent ToolRow 同构（● [VERB] target）');
  assert.match(all, /⎿ ✓ 84 lines/, 'result 行 ⎿ + ok 标记');
  assert.match(all, /分析中…/, 'text 行经 Markdown 渲染原样呈现');
  one.unmount();
});

test('Inspector 委派 prompt 作用户输入带呈现（2026-09-29 用户裁决：视作独立主 agent session，只是有输入）', () => {
  const one = render(<ChildInspector child={live({ prompt: '调研单体链路' })} columns={80} rows={20} />);
  const all = one.allOutput();
  assert.match(all, /调研单体链路/, '委派词作为用户输入上屏（灰底输入带）');
  one.unmount();
});

test('Inspector 思考流式：运行中 6 行滚动窗实时预览，收束后 ✻ 摘要行入时间线（对标主 agent ThinkingRow）', () => {
  // 运行中 bufThink 流式尾段 → 动态区 6 行滚动窗（✻ 前缀斜体）
  const streaming = render(<ChildInspector child={live({ bufThink: '思考第一行\n思考第二行\n思考第三行' })} columns={80} rows={16} />);
  const sf = streaming.lastFrame() ?? '';
  assert.match(sf, /✻ 思考第三行/, '思考流尾行实时呈现（流式预览窗）');
  streaming.unmount();
  // 收束后 thinking 摘要行进 Static 时间线；缺省折叠 detail 不可见，Tab 展开全文
  const closed = live({
    transcript: [
      { kind: 'thinking', text: 'Thought for 3s', detail: '思考全文第一行\n思考全文第二行' },
      { kind: 'text', text: '结论正文' },
    ],
  });
  const def = render(<ChildInspector child={closed} columns={80} rows={16} />);
  assert.match(def.allOutput(), /✻ Thought for 3s/, '✻ 摘要行入时间线（与主 agent 同构）');
  assert.ok(!(def.lastFrame() ?? '').includes('思考全文第一行'), '缺省折叠：思考全文不直出');
  def.unmount();
  const exp = render(<ChildInspector child={closed} columns={80} rows={16} expanded />);
  assert.match(exp.allOutput(), /思考全文第一行/, 'Tab 展开：思考全文可见');
  assert.match(exp.allOutput(), /思考全文第二行/, 'Tab 展开：思考全文逐行可见');
  exp.unmount();
});

test('Inspector 不压缩：完成态完整时间线入滚动缓冲（Static 打印一次，不再取尾截断）', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'text' as const, text: `line-${i}` }));
  const one = render(<ChildInspector child={live({ transcript: many, done: true, doneAt: Date.now() })} columns={80} rows={10} />);
  const all = one.allOutput();
  assert.ok(all.includes('line-0'), '最早行完整呈现（不取尾压缩）');
  assert.ok(all.includes('line-25'), '中段行完整呈现');
  assert.ok(all.includes('line-49'), '最新行完整呈现');
  // 动态帧有界（预览窗 + 状态行），不超视口
  const n = (one.lastFrame() ?? '').replace(/\n$/, '').split('\n').length;
  assert.ok(n <= 10, `动态帧高 ${n} 行不超视口 rows=10`);
  one.unmount();
});

test('Inspector 流式增量入档：空行段落边界后的闭合段进 Static，未闭合尾段留动态预览（对标主 agent flushReply/LiveArea）', () => {
  const one = render(
    <ChildInspector
      child={live({
        transcript: [
          { kind: 'text', text: '第一段结论' },
          { kind: 'text', text: '' },
          { kind: 'text', text: '第二段进行中' },
        ],
        bufText: '尚未成行的半行',
      })}
      columns={80}
      rows={16}
    />,
  );
  const f = one.lastFrame() ?? '';
  // Static/动态分界判据：闭合段打印一次进滚动缓冲（不在动态帧内），未闭合尾段逐帧重绘（在动态帧内）
  assert.match(one.allOutput(), /第一段结论/, '空行闭合段进 Static（打印一次入滚动缓冲）');
  assert.ok(!f.includes('第一段结论'), '闭合段不占动态帧（Static 打印一次后不再重绘）');
  assert.match(f, /第二段进行中/, '未闭合尾段动态区实时预览');
  assert.match(f, /尚未成行的半行/, '流式半行随尾段预览');
  one.unmount();
});

test('Inspector 完成态回看：detail 行解析回看（动词行还原 call 形态、⎿ 前缀→result 形态、✻→思考摘要）', () => {
  const one = render(
    <ChildInspector
      archived={{
        label: 'w',
        lines: ['READ src/a.ts', '⎿ ✓ 84 lines', '⎿ ✗ boom', '✻ Thought for 3s', '    思考全文行'],
        steps: 5,
        durationMs: 61_000,
      }}
      columns={80}
      rows={12}
    />,
  );
  const all = one.allOutput();
  assert.match(all, /● \[READ\] src\/a\.ts/, '动词行还原 call 形态（与主 agent ToolRow 同构）');
  assert.match(all, /⎿ ✓ 84 lines/, 'result 行呈现');
  assert.match(all, /⎿ ✗ boom/, '失败结果行呈现');
  assert.match(all, /✻ Thought for 3s/, '思考摘要行还原（✻ 前缀）');
  assert.ok(!all.includes('思考全文行'), '归档缺省折叠：思考 detail 不直出');
  one.unmount();
  const exp = render(
    <ChildInspector
      archived={{
        label: 'w',
        lines: ['✻ Thought for 3s', '    思考全文行'],
        steps: 5,
        durationMs: 61_000,
      }}
      columns={80}
      rows={12}
      expanded
    />,
  );
  assert.match(exp.allOutput(), /思考全文行/, 'Tab 展开：归档思考 detail 可见');
  exp.unmount();
});

test('Inspector 折叠结果行单行省略、Tab 展开全文（对标主 agent ToolRow 两态）', () => {
  const multi = live({
    transcript: [
      { kind: 'call', text: 'BASH npm test' },
      { kind: 'result', text: 'ok 1 - passes\nok 2 - passes\n# fail 2', ok: false },
    ],
  });
  const def = render(<ChildInspector child={multi} columns={80} rows={12} />);
  const defAll = def.allOutput();
  assert.match(defAll, /⎿ ✗ ok 1 - passes/, '折叠态：结果首行单行呈现');
  assert.ok(!defAll.includes('# fail 2'), '折叠态：多行结果后续行省略');
  def.unmount();
  const exp = render(<ChildInspector child={multi} columns={80} rows={12} expanded />);
  assert.match(exp.allOutput(), /# fail 2/, 'Tab 展开：结果全文逐行呈现');
  exp.unmount();
});
