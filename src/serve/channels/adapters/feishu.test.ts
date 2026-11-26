/** 飞书适配器单测(纯函数锚点):feishuEventToInbound 的形状归一/字段映射/过滤语义;
 *  受理 ack(OnIt 表情)与群聊 @(at 标签)的请求/前缀纯形状(2026-11-22 用户裁定双条)。
 *  SDK 外连面(WS/HTTP)不进单测——适配器经 engine dry-run 链路覆盖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feishuEventToInbound, feishuAckReactionPayload, feishuMentionPrefix, feishuPostContent, feishuResolveMentions, feishuPermissionVerdict } from './feishu';

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

test('@ 提及占位符还原成姓名(2026-11-25 用户报障「上下文只看到 @_user_1,不知道是谁」):key 全文替换,name 缺席回落 open_id;无 mentions/畸形零改动', () => {
  const mentions = [
    { key: '@_user_1', name: '景楷', id: { open_id: 'ou_1' } },
    { key: '@_user_2', name: '', id: { open_id: 'ou_2' } },
  ];
  assert.equal(feishuResolveMentions('@_user_1 你好 @_user_2', mentions), '@景楷 你好 @ou_2');
  assert.equal(feishuResolveMentions('纯文本', mentions), '纯文本');
  assert.equal(feishuResolveMentions('@_user_1 你好', undefined), '你好'); // 残留占位符一律清除
  assert.equal(feishuResolveMentions('@_user_1', [{ key: 1 }]), ''); // mentions 形状不符同样不留编码
});

test('group 事件正文:@_user_N 占位符随事件落地为姓名(模型上下文可读)', () => {
  const data = {
    ...p2pText,
    message: {
      ...p2pText.message,
      chat_type: 'group',
      chat_id: 'oc_g3',
      content: JSON.stringify({ text: '@_user_1 1' }),
      mentions: [{ key: '@_user_1', name: '景楷（孙啊超）', id: { open_id: 'ou_1' } }],
    },
  };
  const m = feishuEventToInbound('fs1', data);
  assert.ok(m !== undefined);
  assert.equal(m.text, '@景楷（孙啊超） 1');
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

test('markdown post 消息(2026-11-23 用户裁定「不是卡片,普通文本中显示 md 格式化,可复制」):post 单 md 标签 JSON+at 提及同 text 面语法', () => {
  assert.equal(
    feishuPostContent('# 标题\n- 列表'),
    '{"zh_cn":{"content":[[{"tag":"md","text":"# 标题\\n- 列表"}]]}}',
  );
  // md 标签内 at 提及=<at user_id>(CommonMark+GFM 子集的飞书扩展,与 text 面同语法)
  assert.equal(feishuMentionPrefix({ userId: 'ou_abc' }), '<at user_id="ou_abc"></at> ');
});

test('权限探测三态:成功=已开通;权限码/权限文案=缺失;业务错误=已开通;失败无码=未知(2026-11-25 用户指正「假的鉴权」)', () => {
  assert.equal(feishuPermissionVerdict({ code: 0 }), true);
  assert.equal(feishuPermissionVerdict({ code: 99991672, msg: 'Access denied. One of the following scopes is required' }), false);
  assert.equal(feishuPermissionVerdict({ code: 40004, msg: 'user not found' }), true); // 有权限:业务校验拦下
  assert.equal(feishuPermissionVerdict({ code: 230001, msg: 'invalid receive_id' }), true);
  assert.equal(feishuPermissionVerdict({ code: -1, msg: 'Request failed with status code 400' }), null); // 失败≠已开通
  assert.equal(feishuPermissionVerdict({}), null);
});
