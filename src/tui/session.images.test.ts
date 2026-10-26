import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KernelEntry } from '../session/entry';
import { SessionController } from './session';
import { entriesToChatItems } from './commands-session';
import { ScriptedAdapter } from '../model/adapter';

/** TUI 图片附件提交面（2026-10-26 图片功能）：submit 带图 → 消息区 user 条目随行 images；
 *  运行中排队带图 → 轮收束 drainQueue 补跑仍带图；恢复面 entriesToChatItems 透传 images。
 *  转录/持久化面与 GUI 共用内核 seg 行（kernelEventRows 单点，seglog.images.test 已钉）——
 *  此处断言可观测的消息区视图面 */

const PNG = 'data:image/png;base64,aGVsbG8=';
const JPEG = 'data:image/jpeg;base64,aGVsbG8y';

function makeCtrl(cards: string[]): SessionController {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tui-img-'));
  return new SessionController({ root: tmp, model: new ScriptedAdapter(cards) });
}

function userRows(ctrl: SessionController): Array<{ text: string; images?: string[] }> {
  return ctrl
    .getState()
    .messages.filter((m) => m.role === 'user')
    .map((m) => ({ text: m.text, ...(m.images !== undefined ? { images: m.images } : {}) }));
}

test('submit 带图：消息区 user 条目随行 images；纯文本提交不受扰（回归）', async () => {
  const ctrl = makeCtrl(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']);
  await ctrl.submit('看这张图', [PNG, JPEG]);
  const rows = userRows(ctrl);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, '看这张图');
  assert.deepEqual(rows[0]!.images, [PNG, JPEG], '消息区条目随行 images');

  await ctrl.submit('纯文本一条');
  const rows2 = userRows(ctrl);
  assert.equal(rows2.length, 2);
  assert.equal(rows2[1]!.images, undefined, '无图提交不落 images 键');
});

test('纯图无文本：亦成提交（图片即消息），user 行文本空、images 在场', async () => {
  const ctrl = makeCtrl(['{"done":true,"reply":"ok"}']);
  await ctrl.submit('', [PNG]);
  const rows = userRows(ctrl);
  assert.equal(rows.length, 1, '纯图提交入消息区');
  assert.equal(rows[0]!.text, '');
  assert.deepEqual(rows[0]!.images, [PNG]);
});

test('运行中排队带图：轮收束 drainQueue 补跑仍带图（排队→真正发送全链不丢）', async () => {
  const ctrl = makeCtrl(['{"done":true,"reply":"first"}', '{"done":true,"reply":"second"}']);
  ctrl.queueEnqueue('带图排队', [PNG]);
  await ctrl.submit('首任务');
  // 首轮收束后 drainQueue 自动补跑排队条（排队态零上屏——发送时刻才入对话）
  const rows = userRows(ctrl);
  const queued = rows.find((r) => r.text === '带图排队');
  assert.ok(queued, '排队条已补跑入消息区');
  assert.deepEqual(queued!.images, [PNG], '补跑条 images 原样');
  assert.equal(ctrl.queueItems().length, 0, '队列已清');
});

test('计划反馈态带图提交：图片可见化忽略（系统行提示）+ 纯图不发空反馈', async () => {
  const ctrl = makeCtrl(['{"done":true,"reply":"ok"}']);
  ctrl.planFeedbackMode = true;
  await ctrl.submit('这个方向不对', [PNG]);
  assert.ok(
    ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('attached images were ignored')),
    '随行图片忽略出系统行（不静默丢）',
  );
  // 纯图无文本：反馈态不成提交（不发空反馈）
  const ctrl2 = makeCtrl(['{"done":true,"reply":"ok"}']);
  ctrl2.planFeedbackMode = true;
  await ctrl2.submit('', [PNG]);
  assert.equal(ctrl2.getState().messages.filter((m) => m.role === 'user').length, 0, '反馈态纯图零 user 行');
});

test('恢复面 entriesToChatItems：user 条 images 透传（resume 后 [Image N] 标记数据源）', () => {
  const items = entriesToChatItems(
    [
      { seq: 1, ts: 100, kind: 'user', md: '带图一条', images: [PNG] },
      { seq: 2, ts: 101, kind: 'user', md: '无图一条' },
    ] as unknown as KernelEntry[],
    () => 80,
  );
  assert.deepEqual(items[0]!.images, [PNG]);
  assert.equal(items[1]!.images, undefined);
});
