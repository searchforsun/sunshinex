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

test('LiveArea：思考流长行按显示宽度折行取尾（无空格长串不撑破宽度）', () => {
  const longLine = '深度思考'.repeat(60);
  const { lastFrame, unmount } = render(<LiveArea live={{ kind: 'thinking', text: longLine, startedAt: 0 }} columns={40} />);
  const frame = lastFrame() ?? '';
  const rows = frame.replace(/\n$/, '').split('\n');
  assert.equal(rows.length, 6, '折行后仍收敛为 6 行滚动窗');
  rows.forEach((r) => assert.ok(r.length <= 40, `每行不超列宽（实际 ${r.length}）`));
  unmount();
});
