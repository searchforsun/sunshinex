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
    assert.match(all, /\/help 查看命令/);
    const frame = lastFrame() ?? '';
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
    const { allOutput, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const all = allOutput();
    assert.match(all, /⏺ \[WRITE\] a\.txt/); // 工具调用行英文动词 + 方括号高亮
    assert.match(all, /✓/);              // 工具结果行成功
    assert.match(all, /写个文件/);        // 用户消息（色带）
    assert.match(all, /ok/);             // 助手裸文本答复
    assert.ok(!all.includes('[你]'), '不得出现 [你] 角色标签');
    assert.ok(!all.includes('[助手]'), '助手答复应为裸文本');
    assert.ok(!all.includes('[工具]'), '工具行应为 ⏺/⎿ 形态');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Static 语义——横幅与已入档历史只打印一次，动态帧不含封存历史', async () => {
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
    const all = allOutput();
    // 横幅只随挂载打印一次（旧行为：每帧全量重绘时横幅在 stdout 上出现多次）
    const bannerCount = all.split('SunshineX TUI v1.0.0').length - 1;
    assert.ok(bannerCount === 1, `横幅应恰好打印一次，实际 ${bannerCount} 次`);
    assert.ok(all.includes('任务甲') && all.includes('任务乙'), '两轮消息均以 Static 终稿入滚动缓冲');
    assert.equal(all.split('任务甲').length - 1, 1, '每条消息只打印一次');
    const frame = lastFrame() ?? '';
    assert.ok(!frame.includes('任务甲') && !frame.includes('任务乙'), '动态帧零消息渲染（全部入 Static）');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
