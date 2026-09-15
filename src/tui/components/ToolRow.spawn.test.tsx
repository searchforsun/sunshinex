import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { ToolRow } from './ToolRow';
import { ChatItem } from '../session';

let seq = 0;
const call = (text: string, detail?: string): ChatItem =>
  ({ seq: seq++, role: 'tool', text, ts: 0, kind: 'call', ...(detail ? { detail } : {}) }) as ChatItem;

test('ToolRow：SPAWN 调用行 detail（子代理转录）展开态全文重放、折叠态单行', () => {
  const spawn = call('SPAWN reviewer', '子代理转录首行\n子代理转录尾行');

  const expanded = render(<ToolRow item={spawn} columns={80} collapsed={false} />);
  const fe = expanded.lastFrame() ?? '';
  assert.match(fe, /● \[SPAWN\] reviewer/, '调用行头部恒显（动词方括号高亮既有形态）');
  assert.ok(fe.includes('子代理转录首行') && fe.includes('子代理转录尾行'), '展开态 detail 全文逐行重放（规格 §6）');
  expanded.unmount();

  const collapsed = render(<ToolRow item={spawn} columns={80} collapsed={true} />);
  const fc = collapsed.lastFrame() ?? '';
  assert.match(fc, /● \[SPAWN\] reviewer/, '折叠态调用行头部恒显');
  assert.ok(!fc.includes('子代理转录首行'), '折叠态不展开 detail（单行头部形态）');
  collapsed.unmount();
});

test('ToolRow：普通调用行（无 detail）不受影响', () => {
  const plain = call('READ a.ts');
  const f = render(<ToolRow item={plain} columns={80} collapsed={false} />).lastFrame() ?? '';
  assert.match(f, /● \[READ\] a\.ts/, '调用行动词带方括号高亮的既有形态');
});
