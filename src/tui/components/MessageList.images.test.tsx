import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { MessageList } from './MessageList';
import type { ChatItem } from '../session';
import type { BannerInfo } from '../banner-info';

/** TUI 转录图片标记渲染（2026-10-26 图片功能，Claude Code 对标）：user 行随行 images →
 *  [Image 1] [Image 2] 占位标记（灰底带内、文本上方）；纯图行只显标记；无图形态零变化 */

const banner: BannerInfo = { version: '1.0', model: 'm', root: 'r' } as BannerInfo;
const mk = (over: Partial<ChatItem>): ChatItem => ({ role: 'assistant', text: '', ts: 1, seq: 1, ...over });

test('MessageList：user 行带图 → [Image N] 标记行在文本上方（灰底带内）', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 1, role: 'user', text: '看这张图', images: ['data:image/png;base64,QQ==', 'data:image/jpeg;base64,Qg=='] })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  const out = one.allOutput();
  assert.ok(out.includes('[Image 1] [Image 2]'), '标记行按序渲染');
  assert.ok(out.includes('看这张图'), '正文随行');
  const labelIdx = out.indexOf('[Image 1]');
  const textIdx = out.indexOf('看这张图');
  assert.ok(labelIdx >= 0 && labelIdx < textIdx, '标记在文本上方');
  assert.ok(!out.includes('data:image'), 'dataURL 本体不入终端');
  one.unmount();
});

test('MessageList：纯图无文本 → 仅 [Image 1] 标记行；无图行形态零变化（回归）', () => {
  const one = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 1, role: 'user', text: '', images: ['data:image/png;base64,QQ=='] })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  const out = one.allOutput();
  assert.ok(out.includes('[Image 1]'), '纯图行显标记');
  one.unmount();

  const plain = render(
    <MessageList
      banner={banner}
      messages={[mk({ seq: 2, role: 'user', text: '普通一条' })]}
      columns={80}
      expandAll={false}
      latestFull={false}
    />,
  );
  const out2 = plain.allOutput();
  assert.ok(out2.includes('普通一条'));
  assert.ok(!out2.includes('[Image'), '无图行无标记');
  plain.unmount();
});
