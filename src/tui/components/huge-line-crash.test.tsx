import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ChildInspector } from './ChildInspector';
import { ToolRow } from './ToolRow';
import { ChatItem } from '../session';

/** 2026-09-30 真机崩溃回归：无空格超长行（minified/base64）裸出 ink/yoga 不可软折——
 *  Output.get 的 String.repeat 即 RangeError: Invalid string length，整个 CLI 崩溃退出。
 *  全部渲染路径须按列宽硬折，帧高有界、进程存活。
 *  md 段落/围栏面的两个 MarkdownText 用例随 D29 并轨退役（2026-10-04：回看链整体下线，
 *  渲染统一走 renderMd 烘焙直嵌）——同量级护栏由 MessageList.test 的
 *  「D29 并轨：超长无空格行……硬折不崩、剥码行宽有界」接班钉承接（并加行宽有界断言）。 */

const HUGE = 'a'.repeat(200_000) + ' end'; // ~200k 列无空格 token
const HUGE_CJK = '超'.repeat(100_000);

test('ToolRow expanded detail 与折叠摘要：超长结果行硬折/省略不崩', () => {
  const callItem = { role: 'tool', kind: 'call', text: 'READ big.json', ts: 1, seq: 1, detail: `${HUGE}\nsecond line`, callId: 'c1' } as unknown as ChatItem;
  const expanded = render(<ToolRow item={callItem} columns={80} collapsed={false} />, 80);
  assert.ok(expanded.allOutput().includes('second line'), '展开态全文可回看');
  expanded.unmount();
  const resultItem = { role: 'tool', kind: 'result', text: HUGE, ts: 2, seq: 2, detail: HUGE, ok: false, callId: 'c1' } as unknown as ChatItem;
  const collapsed = render(<ToolRow item={resultItem} columns={80} collapsed={true} />, 80);
  assert.match(collapsed.lastFrame() ?? '', /…/, '折叠态省略收尾');
  collapsed.unmount();
});

test('ChildInspector expanded：超长思考 detail 与结果行硬折不崩', () => {
  const one = render(
    <ChildInspector
      child={{
        label: 'w', startedAt: Date.now(), steps: 2, tokens: 100,
        transcript: [
          { kind: 'thinking', text: 'Thought for 3s', detail: HUGE_CJK },
          { kind: 'result', text: HUGE, ok: false },
        ],
      }}
      columns={80}
      rows={24}
      expanded
    />,
  );
  assert.ok(one.allOutput().includes('    aaaa'), '结果全文折行呈现（带缩进）');
  one.unmount();
});
