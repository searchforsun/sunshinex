import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as React from 'react';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询等待帧内容匹配（渲染与 run 均为异步，断言前需等帧刷新） */
async function waitForFrame(lastFrame: () => string | undefined, re: RegExp, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!re.test(lastFrame() ?? '')) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForFrame 超时：${String(re)}；当前帧：${lastFrame() ?? '(空)'}`);
    }
    await tick();
  }
}

test('App：审批模态出现 → y 键裁决放行 → write 落盘 → 流式回复收束', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-app1-'));
  try {
    // write 工具不在只读白名单内 → manual 模式必挂起审批（asker 未注入 → 控制器键盘裁决挂起）
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });

    const ui = render(React.createElement(App, { controller: ctrl }));
    await tick(50); // 等挂载 effect 完成订阅，避免与首轮通知竞态

    const run = ctrl.submit('写个文件');
    await waitForFrame(ui.lastFrame, /审批/);

    ui.write('y'); // 键盘裁决：放行一次
    await run;
    await ctrl.waitIdle();
    await waitForFrame(ui.lastFrame, /ok/);
    assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8'), 'hi', '批准后 write 应真实落盘');
    ui.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：无审批流直达完成（缺省 dontAsk 模式零模态）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-app2-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"done-reply"}']),
    });

    const ui = render(React.createElement(App, { controller: ctrl }));
    await tick(50); // 等挂载 effect 完成订阅

    await ctrl.submit('直接完成');
    await ctrl.waitIdle();
    await waitForFrame(ui.lastFrame, /done-reply/);
    assert.equal(ctrl.getState().approval, undefined, 'dontAsk 模式不应产生审批挂起');
    ui.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
