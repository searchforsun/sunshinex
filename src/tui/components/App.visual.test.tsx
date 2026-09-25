import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

test('App：启动横幅 + 输入框 + 状态栏常驻渲染', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-vis1-'));
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"hi"}']) });
    const { lastFrame, allOutput, unmount } = render(
      <App controller={ctrl} banner={{ version: '0.1.0', model: 'test-model', root: tmp }} />,
    );
    const all = allOutput();
    assert.match(all, /SunshineX TUI v0\.1\.0/); // 横幅入 Static 一次性打印
    assert.match(all, /test-model/);
    assert.match(all, /\/help commands/);
    const frame = lastFrame() ?? '';
    assert.match(frame, /❯/);          // 输入框提示符
    assert.match(frame, /↑0 tokens/);  // 状态栏本轮 tokens
    assert.match(frame, /cache \d+%/); // 状态栏缓存命中率（英文口径）
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：消息区新渲染口径（去标签/工具两行/助手裸文本）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-vis2-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('写个文件');
    await ctrl.waitIdle();
    const { allOutput, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const all = allOutput();
    assert.match(all, /● \[WRITE\] a\.txt/); // 工具调用行英文动词 + 方括号高亮
    assert.match(all, /✓/);              // 工具结果行成功
    assert.match(all, /写个文件/);        // 用户消息（色带）
    assert.match(all, /ok/);             // 助手裸文本答复
    assert.ok(!all.includes('[你]'), '不得出现 [你] 角色标签');
    assert.ok(!all.includes('[助手]'), '助手答复应为裸文本');
    assert.ok(!all.includes('[工具]'), '工具行应为 ●/⎿ 形态');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：全量渲染语义——历史消息原地入帧，动态帧承载完整转录', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-vis3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"done":true,"reply":"第一轮答复"}',
        '{"done":true,"reply":"第二轮答复"}',
      ]),
    });
    const { lastFrame, allOutput, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    await ctrl.submit('任务甲');
    await ctrl.waitIdle();
    await ctrl.submit('任务乙');
    await ctrl.waitIdle();
    await new Promise((r) => setTimeout(r, 100)); // ink 异步刷帧：waitIdle 后等一拍再断言（探针实锤的时序口径）
    const all = allOutput();
    const frame = lastFrame() ?? '';
    // 全量渲染（2026-09-26 去 Static 裁决）：每帧承载完整历史——终态行始终可见，收拢段的历史行不再从画面消失
    assert.ok(all.includes('任务甲') && all.includes('任务乙'), '两轮消息均入滚动缓冲');
    assert.ok(frame.includes('任务甲') && frame.includes('任务乙'), '动态帧承载完整转录（历史行每帧原地可见）');
    assert.ok(frame.includes('第一轮答复') && frame.includes('第二轮答复'), '历史答复随帧原地渲染');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
