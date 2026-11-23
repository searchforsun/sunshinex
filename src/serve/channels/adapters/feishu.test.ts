/** 飞书适配器单测(纯函数锚点):feishuEventToInbound 的形状归一/字段映射/过滤语义;
 *  受理 ack(OnIt 表情)与群聊 @(at 标签)的请求/前缀纯形状(2026-11-22 用户裁定双条)。
 *  SDK 外连面(WS/HTTP)不进单测——适配器经 engine dry-run 链路覆盖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feishuEventToInbound, feishuAckReactionPayload, feishuMentionPrefix, feishuCardContent, feishuCardMentionPrefix } from './feishu';

const p2pText = {
  sender: { sender_id: { open_id: 'ou_1', user_id: 'uid_1' }, sender_type: 'user' },
  message: {
    message_id: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '你好' }),
  },
};

test('p2p text:direct/atBot 恒真/open_id 优先/正文解析', () => {
  const m = feishuEventToInbound('fs1', p2pText);
  assert.ok(m !== undefined);
  assert.equal(m.channel, 'fs1');
  assert.equal(m.chatId, 'oc_1');
  assert.equal(m.chatKind, 'direct');
  assert.equal(m.userId, 'ou_1');
  assert.equal(m.msgId, 'om_1');
  assert.equal(m.text, '你好');
  assert.equal(m.atBot, true);
});

test('group + mentions:group/atBot=true(双保险)', () => {
  const data = {
    ...p2pText,
    message: { ...p2pText.message, chat_type: 'group', chat_id: 'oc_g', mentions: [{ key: '@_user_1' }] },
  };
  const m = feishuEventToInbound('fs1', data);
  assert.ok(m !== undefined);
  assert.equal(m.chatKind, 'group');
  assert.equal(m.atBot, true);
});

test('group 无 mentions:atBot=false', () => {
  const data = {
    ...p2pText,
    message: { ...p2pText.message, chat_type: 'group', chat_id: 'oc_g2', content: JSON.stringify({ text: '没@机器人' }) },
  };
  const m = feishuEventToInbound('fs1', data);
  assert.ok(m !== undefined);
  assert.equal(m.atBot, false);
});

test('非 text 消息(post 等)→ undefined 丢弃', () => {
  const data = { ...p2pText, message: { ...p2pText.message, message_type: 'post', content: '{"title":"x"}' } };
  assert.equal(feishuEventToInbound('fs1', data), undefined);
});

test('{header,event} 全量包裹形态:归一取 event 一侧', () => {
  const m = feishuEventToInbound('fs1', { header: { event_id: 'x' }, event: p2pText });
  assert.ok(m !== undefined);
  assert.equal(m.chatId, 'oc_1');
  assert.equal(m.text, '你好');
});

test('content 畸形 JSON:降级空文本不抛', () => {
  const data = { ...p2pText, message: { ...p2pText.message, content: 'not-json{' } };
  const m = feishuEventToInbound('fs1', data);
  assert.ok(m !== undefined);
  assert.equal(m.text, '');
});

test('受理 ack 请求形状:POST reactions emoji_type=OnIt(2026-11-22 用户裁定「官方处理中 icon」)', () => {
  const p = feishuAckReactionPayload('om_9');
  assert.equal(p.method, 'POST');
  assert.equal(p.url, '/open-apis/im/v1/messages/om_9/reactions');
  assert.deepEqual(p.data, { reaction_type: { emoji_type: 'OnIt' } });
});

test('群聊 @ 前缀:`<at user_id>` 标签(服务端渲人名);无 mention/空 userId=空串', () => {
  assert.equal(feishuMentionPrefix({ userId: 'ou_abc' }), '<at user_id="ou_abc"></at> ');
  assert.equal(feishuMentionPrefix({ userId: 'ou_abc', display: '晟楷' }), '<at user_id="ou_abc"></at> ');
  assert.equal(feishuMentionPrefix(undefined), '');
  assert.equal(feishuMentionPrefix({ userId: '' }), '');
});

test('markdown 卡片(2026-11-23 用户裁定「正文中支持渲染 md」):card JSON 2.0(schema+body.elements,表格等标准语法)+卡内 <at id> 语法', () => {
  assert.equal(
    feishuCardContent('# 标题\n- 列表'),
    '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"# 标题\\n- 列表"}]}}',
  );
  assert.equal(feishuCardMentionPrefix({ userId: 'ou_abc' }), '<at id="ou_abc"></at> ');
  assert.equal(feishuCardMentionPrefix(undefined), '');
  assert.equal(feishuCardMentionPrefix({ userId: '' }), '');
});
