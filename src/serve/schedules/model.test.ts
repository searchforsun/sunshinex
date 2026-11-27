import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft } from './model';

/** 2026-11-21 用户裁定「指令落点三种」：project（缺省，原行为）/sunx/通道，后两者发给已有会话 */

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '巡检',
    prompt: '检查',
    root: 'D:/w',
    effort: 'medium',
    mode: 'full-access',
    recurrence: { unit: 'day', every: 1, at: '09:00' },
    startAt: 1_000,
    ...over,
  };
}

test('validateDraft：target 缺省=project，并清掉无关目标 id', () => {
  const r = validateDraft(base({ targetJournalId: 'old-jid', targetChannelId: 'c', targetChatId: 'x' }), 2_000);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.target, 'project');
  assert.equal(r.value.targetJournalId, undefined);
  assert.equal(r.value.targetChannelId, undefined);
  assert.equal(r.value.targetChatId, undefined);
});

test('validateDraft：sunx 必须带 targetJournalId，合法时透出 label', () => {
  const bad = validateDraft(base({ target: 'sunx' }), 2_000);
  assert.equal(bad.ok, false);
  const ok = validateDraft(base({ target: 'sunx', targetJournalId: ' jid-1 ', targetLabel: ' 运维助手 ' }), 2_000);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.target, 'sunx');
  assert.equal(ok.value.targetJournalId, 'jid-1');
  assert.equal(ok.value.targetLabel, '运维助手');
  assert.equal(ok.value.targetChannelId, undefined);
});

test('validateDraft：channel 必须带两段（通道 id + 聊天 id）', () => {
  assert.equal(validateDraft(base({ target: 'channel', targetChannelId: 'feishu' }), 2_000).ok, false);
  const ok = validateDraft(base({ target: 'channel', targetChannelId: 'feishu', targetChatId: 'oc_1', targetLabel: '飞书 · 项目群' }), 2_000);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.target, 'channel');
  assert.equal(ok.value.targetChannelId, 'feishu');
  assert.equal(ok.value.targetChatId, 'oc_1');
  assert.equal(ok.value.targetLabel, '飞书 · 项目群');
});

test('validateDraft：非法 target 拒绝', () => {
  const r = validateDraft(base({ target: 'wechat' }), 2_000);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /target/);
});
