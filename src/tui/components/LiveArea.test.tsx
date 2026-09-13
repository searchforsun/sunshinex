import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { LiveArea } from './LiveArea';

test('LiveArea：思考流滚动显示末 6 行，块高恒定不跳动', () => {
  // 短文本：不足 6 行补空行，块高恒为 6
  const short = render(<LiveArea live={{ kind: 'thinking', text: '先想一步', startedAt: 0 }} columns={80} />);
  const f1 = short.lastFrame() ?? '';
  assert.match(f1, /✻ 先想一步/, '末条增量应显示');
  short.unmount();

  // 长文本：只显示尾部窗口，头部行不出现
  const long = render(
    <LiveArea
      live={{ kind: 'thinking', text: ['一', '二', '三', '四', '五', '六', '七', '八'].join('\n'), startedAt: 0 }}
      columns={80}
    />,
  );
  const f2 = long.lastFrame() ?? '';
  assert.ok(f2.includes('✻ 三') && f2.includes('✻ 八'), '应显示末 6 行中的首尾');
  assert.ok(!f2.includes('✻ 一'), '头部行不应显示');
  assert.equal(
    (short.lastFrame() ?? '').split('\n').length,
    f2.split('\n').length,
    '块高恒定：不足 6 行补空行，短/长文本帧高一致',
  );
  long.unmount();
});

test('LiveArea：答复预览只呈现未入档尾段（committedLen 水位排除前缀）', () => {
  const { lastFrame, unmount } = render(
    <LiveArea
      live={{ kind: 'reply', text: '第一行\n第二行\n第三行', committedLen: 8, startedAt: 0 }}
      columns={80}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('第三行'), '未入档尾行应显示');
  assert.ok(!frame.includes('第一行') && !frame.includes('第二行'), '已入档行不应重复显示');
  unmount();
});

test('LiveArea：答复未入档超长时显示溢出提示且帧高有界', () => {
  const text = Array.from({ length: 12 }, (_, i) => `行${i + 1}`).join('\n');
  const { lastFrame, unmount } = render(
    <LiveArea live={{ kind: 'reply', text, committedLen: 0, startedAt: 0 }} columns={80} />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /上文已入档/, '应显示溢出提示');
  assert.ok(frame.includes('行12'), '应显示末行');
  assert.ok(!frame.includes('行1\n'), '头部行不应显示');
  unmount();
});

test('LiveArea：表格行进入预览区即实时渲染（框线成形，非源码滚动）', () => {
  const table = ['| 模块 | 结论 |', '| --- | --- |', '| 渲染层 | 实时成形 |', '| 切块层 | 整表放行 |'].join('\n');
  const { lastFrame, unmount } = render(
    <LiveArea live={{ kind: 'reply', text: table, committedLen: 0, startedAt: 0 }} columns={80} />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /[─╭╰]/, '表格应以框线形态实时渲染');
  assert.ok(!frame.includes('| 模块 |'), '不应以源码竖线形态滚动');
  unmount();
});

test('LiveArea：预览统一 Markdown 渲染——粗体/列表生成期间即成形（无源码星号与短横）', () => {
  const md = '结论如下：\n**可改进项:**\n- Checkstyle 纳入 CI 门禁\n- 逻辑删除依赖人工遵守';
  const { lastFrame, unmount } = render(
    <LiveArea live={{ kind: 'reply', text: md, committedLen: 0, startedAt: 0 }} columns={80} />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('可改进项') && frame.includes('Checkstyle'), '粗体与列表内容应显示');
  assert.ok(!frame.includes('**'), '粗体标记不得以源码星号形态出现');
  unmount();
});
