import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, type TestRenderResult } from '../test-ink';
import { ChildInspector } from './ChildInspector';
import { ToolRow } from './ToolRow';
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

test('Inspector 运行中：无外框整页平铺，状态行（label/step/tokens 元数据）与结构行混排（2026-09-29 去边框；2026-10-02 Tab/Esc 提示移恒驻键提示条）', () => {
  const one = render(<ChildInspector child={live()} columns={80} rows={12} />);
  const f = one.lastFrame() ?? '';
  const all = one.allOutput();
  assert.doesNotMatch(all, /╭/, '无外层边框（视作独立主 agent session 平铺）');
  assert.match(f, /\[w\]/, '状态行携带 label');
  assert.match(f, /step 14/, '状态行携带步数');
  assert.doesNotMatch(f, /Esc 退出|Esc exit/, '键提示不再内嵌 head（由 App 层键提示条承载）');
  assert.match(all, /● \[READ\] src\/a\.ts/, 'call 行与主 agent ToolRow 同构（● [VERB] target）');
  assert.match(all, /⎿ ✓/, 'result 行 ⎿ + ok 标记（标记行）');
  assert.match(all, /84 lines/, 'result 内容行（全形对标主 agent）');
  assert.match(all, /分析中…/, 'text 段经 renderMd 渲染原样呈现（markdansi 出口）');
  one.unmount();
});

test('Inspector：text 段 markdansi 渲染——表格全网格（alignTable 圆角 + 行分隔线，与主链同出口 renderMd）', () => {
  // 表格走 renderMd 网格路径（alignTable：╭ 圆角 + 每行 ├┼┤ 分隔）；2026-09-30 用户裁决「不只是表头有横线」
  const one = render(
    <ChildInspector
      child={{
        label: 'w', startedAt: Date.now(), steps: 1, tokens: 10,
        transcript: [{ kind: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |' }],
      }}
      columns={80}
      rows={20}
    />,
  );
  const all = one.allOutput();
  assert.ok(all.includes('│'), '表格框线');
  assert.ok(all.includes('╭'), 'alignTable 圆角顶边');
  assert.ok(all.includes('├'), '数据行分隔线（全网格，非仅表头）');
  one.unmount();
});

test('Inspector 委派 prompt 作用户输入带呈现（2026-09-29 用户裁决：视作独立主 agent session，只是有输入）', () => {
  const one = render(<ChildInspector child={live({ prompt: '调研单体链路' })} columns={80} rows={20} />);
  const all = one.allOutput();
  assert.match(all, /调研单体链路/, '委派词作为用户输入上屏（灰底输入带）');
  one.unmount();
});

test('Inspector 归档态委派词单点承载：detail ⏺ 行不再二次呈现（2026-09-30 真机重复项修复）', () => {
  // archiveInto 同一委派词写两份（subagentMeta.prompt + detail ⏺ 行）——⏺ 行恒过滤，只留输入带
  const one = render(
    <ChildInspector
      archived={{ label: 'w', lines: ['⏺ 委派提示词：调研单体链路', '结论正文'], prompt: '调研单体链路', steps: 2, durationMs: 5000 }}
      columns={80}
      rows={12}
    />,
  );
  const all = one.allOutput();
  assert.equal(all.split('调研单体链路').length - 1, 1, '委派词恰呈现一次（输入带单点承载）');
  assert.ok(!all.includes('⏺'), '⏺ meta 行不再渲染');
  one.unmount();
});

test('Inspector 并行结果归位：结果行渲染在对应调用行下（真机「并行结果堆叠」病根，2026-09-30）', () => {
  // 真实并行时序：3 call 先入档、结果按完成序 c2→c1→c3 到达
  const one = render(
    <ChildInspector
      child={live({
        transcript: [
          { kind: 'call', text: 'GLOB a', callId: 'c1' },
          { kind: 'call', text: 'GLOB b', callId: 'c2' },
          { kind: 'call', text: 'READ f', callId: 'c3' },
          { kind: 'result', text: 'hits b', ok: true, callId: 'c2' },
          { kind: 'result', text: 'hits a', ok: true, callId: 'c1' },
          { kind: 'result', text: 'boom', ok: false, callId: 'c3' },
        ],
      })}
      columns={80}
      rows={20}
    />,
  );
  const all = one.allOutput();
  const idx = (s: string): number => all.indexOf(s);
  assert.ok(idx('● [GLOB] a') < idx('hits a') && idx('hits a') < idx('● [GLOB] b'), 'c1 结果行紧跟 c1 调用行（c2 之前）');
  assert.ok(idx('● [GLOB] b') < idx('hits b') && idx('hits b') < idx('● [READ] f'), 'c2 结果行紧跟 c2 调用行');
  assert.ok(idx('● [READ] f') < idx('⎿ ✗') && all.includes('boom'), 'c3 失败结果行紧跟 c3 调用行（✗ 标记）');
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

test('Inspector 思考期帧高实账：正文尾窗+思考尾窗+状态行 ≤ rows-1（恰触 rows 即每帧 clearTerminal 整屏重写洪流，WT 视觉冻结病根）', () => {
  // 长 bufText 撑满正文预览预算 + bufThink 在场：正是真机子代理「思考+正文双流式」的帧形态
  const longTail = Array.from({ length: 60 }, (_, i) => `正文第 ${i} 行，补足宽度让 renderMd 折行收敛到列宽以内再折出多行来。`).join('\n');
  const one = render(<ChildInspector child={live({ bufText: longTail, bufThink: '思考流第一行\n思考流第二行' })} columns={80} rows={16} />);
  const f = one.lastFrame() ?? '';
  assert.ok(f.includes('✻ 思考流'), '思考尾窗在场（双流式帧形态）');
  const n = f.replace(/\n$/, '').split('\n').length;
  assert.ok(n <= 15, `思考期动态帧高 ${n} 行必须 ≤ rows-1=15（恰触 16 行即 ink clearTerminal 每帧整屏重写）`);
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
  assert.match(all, /⎿ ✓/, 'result 标记行呈现');
  assert.match(all, /84 lines/, 'result 内容行呈现');
  assert.match(all, /⎿ ✗/, '失败结果标记行呈现');
  assert.match(all, /boom/, '失败结果内容呈现');
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
  assert.match(defAll, /⎿ ✗/, '结果标记行（✗ 着色）');
  assert.match(defAll, /ok 1 - passes/, '结果首行呈现（全形对标主 agent，2026-09-30 用户裁决）');
  def.unmount();
  const exp = render(<ChildInspector child={multi} columns={80} rows={12} expanded />);
  assert.match(exp.allOutput(), /# fail 2/, 'Tab 展开：结果全文逐行呈现');
  exp.unmount();
});

test('Inspector 结果行折叠三行同形：⎿ ✓ 首行带块 + … 独立省略号行（与主链 ToolRow 共用 ResultCollapsed 单点——真机「子代理少省略号一行」病根）+ CR 剥除', () => {
  // render 第二参=终端宽度实参：… 行来自终端宽（80）下的 yoga 折行，缺省宽更宽即不折行（unmount 全入 finally——
  // 断言失败跳过卸载即自持 interval 吊死整个测试批次）
  let one: TestRenderResult | undefined;
  let lines: string[] = [];
  let ri = -1;
  try {
    one = render(
      <ChildInspector
        child={live({
          transcript: [
            { kind: 'call', text: 'READ src/a.ts' },
            { kind: 'result', text: 'package com.yupi;\r\nsecond line', ok: true },
          ],
        })}
        columns={80}
        rows={12}
      />,
      80,
    );
    lines = one
      .allOutput()
      .split('\n')
      .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trimEnd())
      .filter((l) => l.trim().length > 0);
    ri = lines.findIndex((l) => l.includes('⎿ ✓'));
    assert.ok(ri >= 0, '结果行呈现');
    assert.match(lines[ri]!, /⎿ ✓ {2}package com\.yupi;/, '首行内容在结果行（前缀空格+带块前导空格双空格同主链，CR 剥除后无回卷残留）');
    assert.ok(!lines[ri]!.includes('\r'), 'CR 已剥除');
    assert.equal(lines[ri + 1], '…', '省略号行独立呈现（带块恒吃满预算宽，… 溢出折到下一行行首——主链三行工具组第三行）');
    assert.ok(!lines.slice(ri, ri + 3).some((l) => l.includes('second line')), '多行结果折叠态只呈现首行（全文 Tab 展开可见）');
  } finally {
    one?.unmount();
  }
  // 同形铁钉：同一结果内容经主链 ToolRow 与子代理视图渲染逐行一致（共用单点的漂移保险）
  let two: TestRenderResult | undefined;
  try {
    two = render(
      <ToolRow
        item={{ role: 'tool', text: 'package com.yupi;\nsecond line', ts: 0, seq: 1, kind: 'result', ok: true, detail: 'package com.yupi;\r\nsecond line' } as never}
        columns={80}
        collapsed
      />,
      80,
    );
    const main = two!
      .allOutput()
      .split('\n')
      .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trimEnd())
      .filter((l) => l.trim().length > 0);
    const mi = main.findIndex((l) => l.includes('⎿ ✓'));
    assert.ok(mi >= 0, '主链结果行呈现');
    assert.equal(main[mi], lines[ri], '主/子结果行逐字节同形（共用 ResultCollapsed）');
    assert.equal(main[mi + 1], lines[ri + 1], '省略号行逐字节同形');
  } finally {
    two?.unmount();
  }
});

test('Inspector 调用行行宽护栏：长动词（TASK_WAIT）下 target 预算按前缀实账扣减，行宽不超终端列数（2026-09-30 真机 ink repeat(负数) RangeError 崩溃实锤）', () => {
  const displayWidth = (t: string): number => t.length; // ASCII 夹具宽度即长度
  const one = render(
    <ChildInspector
      child={live({
        transcript: [
          { kind: 'call', text: 'TASK_WAIT ' + 'x'.repeat(300) },
          { kind: 'call', text: 'WEBSEARCH ' + 'y'.repeat(300) },
        ],
      })}
      columns={80}
      rows={12}
    />,
    80,
  );
  const lines = one
    .allOutput()
    .split('\n')
    .filter((l) => l.includes('[TASK_WAIT]') || l.includes('[WEBSEARCH]'));
  assert.ok(lines.length >= 2, '两行调用行都在');
  for (const l of lines) {
    const w = displayWidth(l.trimEnd());
    assert.ok(w <= 80, `调用行宽 ${w} ≤ 终端列数 80（超宽即 ink repeat(负数) 崩溃）`);
  }
  one.unmount();
});

test('Inspector 归档多行内容：委派词/结果续行折回本行不漏成正文（真机「多余输入内容/多余工具行」病根）', () => {
  const one = render(
    <ChildInspector
      archived={{
        label: 'w',
        lines: [
          '⏺ 委派提示词：项目背景首行',
          '    项目背景续行甲',
          '    项目背景续行乙',
          'EXEC wc -l',
          '⎿ ✓ ===TOOLS===',
          '    40 BaseTool.java',
          '    91 Factory.java',
          'READ src/a.ts',
          '⎿ ✓ 84 lines',
        ],
        steps: 3,
        durationMs: 12_000,
      }}
      columns={80}
      rows={40}
    />,
  );
  const all = one.allOutput();
  assert.match(all, /项目背景首行/, '委派词首行进输入带（灰底作用户带）');
  assert.equal((all.match(/项目背景续行甲/g) ?? []).length, 1, '委派词续行恰呈现一次（吸收进输入带，不漏成独立正文段）');
  assert.match(all, /===TOOLS===/, '结果首行内联呈现');
  assert.ok(!all.includes('40 BaseTool.java'), '结果续行折叠态不直出（并回 result text，Tab 展开可见）');
  one.unmount();
  const exp = render(
    <ChildInspector
      archived={{
        label: 'w',
        lines: ['EXEC wc -l', '⎿ ✓ ===TOOLS===', '    40 BaseTool.java', '    91 Factory.java'],
        steps: 3,
        durationMs: 12_000,
      }}
      columns={80}
      rows={40}
      expanded
    />,
  );
  assert.match(exp.allOutput(), /40 BaseTool\.java/, '展开态结果续行随 result 全文呈现');
  assert.match(exp.allOutput(), /91 Factory\.java/, '展开态结果续行完整');
  exp.unmount();
});

test('Inspector 归档 meta 带委派词全文：⏺ 行及其续行整块丢弃（同一委派词不重播——输入带单点承载）', () => {
  const one = render(
    <ChildInspector
      archived={{
        label: 'w',
        prompt: '项目背景首行\n项目背景续行甲',
        lines: [
          '⏺ 委派提示词：项目背景首行',
          '    项目背景续行甲',
          'EXEC wc -l',
          '⎿ ✓ done',
        ],
        steps: 2,
        durationMs: 9_000,
      }}
      columns={80}
      rows={40}
    />,
  );
  const all = one.allOutput();
  assert.equal((all.match(/项目背景首行/g) ?? []).length, 1, '委派词首行恰呈现一次（meta 输入带，detail ⏺ 行丢弃）');
  assert.equal((all.match(/项目背景续行甲/g) ?? []).length, 1, '委派词续行恰呈现一次（随 ⏺ 行丢弃，不漏成正文）');
  one.unmount();
});
