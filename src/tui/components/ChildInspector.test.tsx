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

test('Inspector 头部不呈委派 prompt（2026-09-28 用户裁决：去掉「委派提示词」段）', () => {
  const one = render(<ChildInspector child={live({ prompt: '调研单体链路' })} columns={80} rows={20} />);
  const f = one.lastFrame() ?? '';
  assert.doesNotMatch(f, /委派提示词/, '头部无委派提示词标签行');
  assert.doesNotMatch(f, /调研单体链路/, '委派词内容不再上屏（数据链保留在 subagentMeta.prompt）');
  one.unmount();
});

test('Inspector 视口有界：长行折行预算下帧高不超 rows（源行数预算失准即溢出残影/重复观感回归）', () => {
  // 真机病根：预算按源行数计，MarkdownText 按 columns 折行——长 CJK 行 1 源行折数显示行，帧超高溢出动态区
  const longLine = '长'.repeat(200);
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'text' as const, text: `${longLine}-${i}` }));
  const one = render(
    <ChildInspector child={live({ transcript: many })} columns={80} rows={12} />,
  );
  const f = one.lastFrame() ?? '';
  const n = f.replace(/\n$/, '').split('\n').length;
  assert.ok(n <= 12, `帧高 ${n} 行应不超视口 rows=12（折行预算 + 视口余量护栏）`);
  one.unmount();
});

test('Inspector Tab 两态：缺省折叠对标主 agent（非末段只留正文+首个工具对），Tab 展开全量（2026-09-28 用户裁决反转）', () => {
  const multi: ChildLiveState = {
    ...live(),
    transcript: [
      { kind: 'text', text: '第一段思考' },
      { kind: 'call', text: 'READ src/a.ts' },
      { kind: 'result', text: '84 lines', ok: true },
      { kind: 'text', text: '第二段思考' },
      { kind: 'call', text: 'GREP pattern' },
      { kind: 'result', text: '3 files', ok: true },
      { kind: 'call', text: 'READ src/b.ts' },
      { kind: 'result', text: '9 lines', ok: true },
      { kind: 'text', text: '结论段正文' },
    ],
  };
  // 缺省（折叠）：末段全显；非末段只留正文 + 首个工具对，第二段的后续工具对收敛
  const def = render(<ChildInspector child={multi} columns={80} rows={40} />).lastFrame() ?? '';
  assert.match(def, /第一段思考/, '非末段正文保留');
  assert.match(def, /● \[READ\] src\/a\.ts/, '非末段首个工具对保留（锚点）');
  assert.match(def, /第二段思考/, '末段（结论段）全显');
  assert.doesNotMatch(def, /src\/b\.ts/, '非末段第二工具对折叠隐藏——缺省即主 agent 折叠形态');
  const full = render(<ChildInspector child={multi} columns={80} rows={40} expanded />).lastFrame() ?? '';
  assert.match(full, /src\/b\.ts/, 'Tab 展开全量：后续工具对可见');
});

test('Inspector 折叠态思考段收敛 ▶ 摘要行（时间线对齐主 agent，2026-09-28 用户裁决）：多行思考墙不再全文直出、末段结论全显', () => {
  const multi: ChildLiveState = {
    ...live(),
    transcript: [
      { kind: 'text', text: '思考第一行\n思考第二行\n思考第三行' },
      { kind: 'call', text: 'READ src/a.ts' },
      { kind: 'result', text: '84 lines', ok: true },
      { kind: 'text', text: '中间叙述' },
      { kind: 'call', text: 'GREP pattern' },
      { kind: 'result', text: '3 files', ok: true },
      { kind: 'text', text: '结论正文行一\n结论正文行二' },
    ],
  };
  // 缺省（折叠）：思考段收敛为 ▶ 首行摘要（多行段带 … 标记），后续行全文直出即思考墙；末段结论链全显
  const def = render(<ChildInspector child={multi} columns={80} rows={40} />).lastFrame() ?? '';
  assert.match(def, /▶ 思考第一行 …/, '非末段思考段收敛为 ▶ 首行摘要');
  assert.doesNotMatch(def, /思考第二行/, '思考段后续行折叠隐藏');
  assert.match(def, /▶ 中间叙述/, '中间叙述段同样收敛（单行段无 … 标记）');
  assert.match(def, /结论正文行一/, '末段结论链全显');
  assert.match(def, /结论正文行二/, '末段结论链逐行全显');
  const full = render(<ChildInspector child={multi} columns={80} rows={40} expanded />).lastFrame() ?? '';
  assert.match(full, /思考第二行/, 'Tab 展开全量：思考正文可见');
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
