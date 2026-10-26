import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

// 技能池钉定(隔离)：空目录=纯内置池，断言确定性（App.input.test 同款）
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inp-img-skills-'));

/** TUI Ctrl+V 贴图交互（2026-10-26 图片功能，Claude Code 对标）：读图接缝注入钉产物——
 *  chip 显形/退格弹出/提交随行/无图提示/超限钳制。判据一律轮询（waitFor）非固定 sleep——
 *  ink 渲染类测试满核并发+机热的计时抖动家族（run-tests.js 在案教训），固定 sleep 即隐患 */

const PNG = 'data:image/png;base64,aGVsbG8=';
const JPEG = 'data:image/jpeg;base64,aGVsbG8y';

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询至预期态：deadline 内每 40ms 采样一次，超时抛错（判据来自真实 DOM/状态，非时序祈祷） */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await wait(40);
  }
}

test('App：Ctrl+V 贴图 → [Image 1] chip；再贴累积；退格弹出；回车提交带图并清 chips', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tui-ctrlv-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}', '{"done":true,"reply":"ok"}']) });
    let clip = PNG;
    const { lastFrame, write, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} readPasteImage={() => Promise.resolve(clip)} />,
    );
    await wait(200);
    write('\x16'); // Ctrl+V
    await waitFor(() => (lastFrame() ?? '').includes('[Image 1]'));
    assert.match(lastFrame() ?? '', /\[Image 1\]/, 'chip 显形');
    clip = JPEG;
    write('\x16');
    await waitFor(() => (lastFrame() ?? '').includes('[Image 1] [Image 2]'));
    assert.match(lastFrame() ?? '', /\[Image 1\] \[Image 2\]/, '双 chip 累积');
    // 退格弹出最后一个 chip（空缓冲）
    write('\u007F');
    await waitFor(() => !(lastFrame() ?? '').includes('[Image 2]'));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('[Image 1]') && !frame.includes('[Image 2]'), '退格弹出 [Image 2]');
    // 输入文本回车提交：附件随行、chips 清空
    write('看图');
    await waitFor(() => (lastFrame() ?? '').includes('看图'));
    write('\r');
    await waitFor(() => ctrl.getState().messages.some((m) => m.role === 'user' && m.text === '看图'));
    await waitFor(() => !(lastFrame() ?? '').includes('[Image 1]'));
    const users = ctrl.getState().messages.filter((m) => m.role === 'user');
    assert.deepEqual(users[users.length - 1]!.images, [PNG], '提交随行 images（剩余 1 张）');
    assert.doesNotMatch(lastFrame() ?? '', /\[Image 1\]/, '提交后 chips 清空');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：剪贴板无图 → 系统行提示；8 张封顶溢出提示', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tui-ctrlv2-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    let clip: string | undefined = undefined;
    const { lastFrame, write, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} readPasteImage={() => Promise.resolve(clip)} />,
    );
    await wait(200);
    write('\x16');
    // 测试语言钉 en（test-env 单点）——断言以 en 书写
    await waitFor(() => ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('No image in clipboard')));
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('No image in clipboard')),
      '无图出系统行提示',
    );
    clip = PNG;
    for (let i = 0; i < 10; i++) {
      const before = (lastFrame() ?? '').match(/\[Image \d+\]/g)?.length ?? 0;
      write('\x16');
      // 贴图异步落地：轮询帧内 chip 数增长；封顶（8 张）后不再增长即停在当轮
      await waitFor(() => ((lastFrame() ?? '').match(/\[Image \d+\]/g)?.length ?? 0) > before || before >= 8, 2500);
    }
    await waitFor(() => ctrl.getState().messages.some((m) => m.role === 'system' && m.text.includes('Up to 8 images')));
    const last = ctrl.getState().messages.filter((m) => m.role === 'system').at(-1);
    assert.ok(last?.text.includes('Up to 8 images'), '溢出出钳制提示');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
