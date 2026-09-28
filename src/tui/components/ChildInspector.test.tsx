import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ChildInspector } from './ChildInspector';
import { ChildLine, ChildLiveState } from '../session';

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
  assert.match(f, /● \[READ\] src\/a\.ts/, 'call 行与主 agent ToolRow 同构（● [VERB] target）');
  assert.match(f, /⎿ ✓ 84 lines/, 'result 行 ⎿ + ok 标记');
  assert.match(f, /分析中…/, 'text 行经 Markdown 渲染原样呈现');
  assert.match(f, /╭/, '外层特殊边框（整屏框定）');
  one.unmount();
});

test('Inspector 完成态：detail 行解析回看（动词行还原 call 形态、⎿ 前缀→result 形态）', () => {
  const one = render(
    <ChildInspector
      archived={{ label: 'w', lines: ['READ src/a.ts', '⎿ ✓ 84 lines', '⎿ ✗ boom'], steps: 5, durationMs: 61_000 }}
      columns={80}
      rows={12}
    />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /● \[READ\] src\/a\.ts/, '动词行还原 call 形态（与主 agent ToolRow 同构）');
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

test('Inspector 视口有界：长行折行预算下帧高不超 rows（源行数预算失准即溢出残影/重复观感回归）', () => {
  // 真机病根：预算按源行数计，MarkdownText 按 columns 折行——长 CJK 行 1 源行折数显示行，帧超高溢出动态区
  const longLine = '长'.repeat(200);
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'text' as const, text: `${longLine}-${i}` }));
  const one = render(
    <ChildInspector child={live({ transcript: many, prompt: `${'委'.repeat(600)}（截断）` })} columns={80} rows={12} />,
  );
  const f = one.lastFrame() ?? '';
  const n = f.replace(/\n$/, '').split('\n').length;
  assert.ok(n <= 12, `帧高 ${n} 行应不超视口 rows=12（折行预算 + prompt 上限裁剪双护栏）`);
  assert.match(f, /…/, '超限委派 prompt 取尾带 … 标记');
  one.unmount();
});

test('Inspector Tab 两态：缺省完整时间线（call/result 全显），收起态只留正文（2026-09-28 用户裁决）', () => {
  const full = render(<ChildInspector child={live()} columns={80} rows={20} />).lastFrame() ?? '';
  assert.match(full, /● \[READ\] src\/a\.ts/, '缺省（展开）态完整时间线：call 行在');
  assert.match(full, /⎿ ✓ 84 lines/, '缺省（展开）态完整时间线：result 行在');
  const collapsed = render(<ChildInspector child={live()} columns={80} rows={20} expanded={false} />).lastFrame() ?? '';
  assert.doesNotMatch(collapsed, /● \[READ\]/, '收起态工具调用行隐藏');
  assert.doesNotMatch(collapsed, /⎿/, '收起态结果行隐藏');
  assert.match(collapsed, /分析中…/, '收起态正文保留');
  assert.match(collapsed, /Tab/, '头部携带 Tab 切换提示');
});

test('Inspector 视口有界：真实 markdown 形态（标题/表格/围栏/长 CJK）下帧高不超 rows（估算与渲染不同源即溢出残影/两遍观感回归）', () => {
  // 真机病根（2026-09-28 全屏视图两遍）：segRows 只按裸折行计数，MarkdownText 真实渲染还有
  // 块间空行（marginTop 1）、表格 alignTable 框线行、ink 折行边界差三类行数——预算低估即帧超高溢出动态区
  const transcript: ChildLine[] = [];
  transcript.push({ kind: 'text', text: `${'这是一段非常长的中文正文行用于测试折行累计估算偏差的情况'.repeat(3)}` });
  transcript.push({ kind: 'call', text: 'READ package.json' });
  transcript.push({ kind: 'result', text: '42 lines', ok: true });
  transcript.push({ kind: 'text', text: '## 调研结论\n\n- src/tui 渲染层\n- src/harness 运行时' });
  transcript.push({ kind: 'call', text: 'grep src -l' });
  transcript.push({ kind: 'result', text: '8 files', ok: true });
  // 表格块收尾：alignTable 框线行数远多于源行折行口径，估算低估即帧超高溢出（探针实锤 7 例红的形态）
  transcript.push({ kind: 'text', text: '| 模块 | 职责 |\n|------|------|\n| session | 会话状态与 journal 持久化 |\n| reactor | 闭环引擎与并行闸门 |' });
  for (const columns of [60, 80, 100]) {
    for (const rows of [10, 12, 14]) {
      const one = render(
        <ChildInspector
          child={live({ transcript, prompt: '调研前端目录结构', steps: 8, tokens: 9000 })}
          columns={columns}
          rows={rows}
        />,
      );
      const f = one.lastFrame() ?? '';
      const n = f.replace(/\n$/, '').split('\n').length;
      one.unmount();
      assert.ok(n <= rows, `columns=${columns} rows=${rows}: 帧高 ${n} 行不超视口（估算同源护栏）`);
    }
  }
});
