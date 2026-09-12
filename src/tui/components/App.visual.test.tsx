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
    const { lastFrame, unmount } = render(
      <App controller={ctrl} banner={{ version: '0.1.0', model: 'test-model', root: tmp }} />,
    );
    const frame = lastFrame() ?? '';
    assert.match(frame, /SunshineX TUI v0\.1\.0/);
    assert.match(frame, /test-model/);
    assert.match(frame, /\/help 查看命令/);
    assert.match(frame, /❯/);          // 输入框提示符
    assert.match(frame, /↑0 tokens/);  // 状态栏本轮 tokens
    assert.match(frame, /缓存 \d+%/); // 状态栏缓存命中率
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
    const { lastFrame, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /⏺ \[WRITE\] a\.txt/); // 工具调用行英文动词 + 方括号高亮
    assert.match(frame, /✓/);              // 工具结果行成功
    assert.match(frame, /写个文件/);        // 用户消息（色带）
    assert.match(frame, /ok/);             // 助手裸文本答复
    assert.ok(!frame.includes('[你]'), '不得出现 [你] 角色标签');
    assert.ok(!frame.includes('[助手]'), '助手答复应为裸文本');
    assert.ok(!frame.includes('[工具]'), '工具行应为 ⏺/⎿ 形态');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
