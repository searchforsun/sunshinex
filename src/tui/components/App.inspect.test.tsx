import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// App inspect 全屏接管（规格 §3.3）：键位全序列经 test-ink write 直驱——Ctrl+B 进入浏览 → Enter 进入全屏 → Esc 退出。
// 运行中子代理经子面板事件构造（SessionController.onEventForTest 与生产 onEvent 同通道）
test('App inspect：运行中子代理整页接管，Esc 退出恢复主界面（ChildPanel 行回到帧内）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-inspect-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const term = render(<App controller={ctrl} />);
    ctrl.onEventForTest({ type: 'token', text: '分析中…\n', payload: { subagent: 'w' } } as never);
    for (let i = 0; i < 40 && !(term.lastFrame() ?? '').includes('[w]'); i++) await sleep(25);
    assert.ok(!(term.lastFrame() ?? '').includes('子代理视图'), '未进入前全屏视图不在场');
    term.write('\u0002'); // Ctrl+B：浏览模式（运行中行在场即允许）
    await sleep(50);
    term.write('\r'); // Enter：选中运行中子代理 → 全屏接管
    await sleep(50);
    assert.match(term.lastFrame() ?? '', /子代理视图|subagent view/, '全屏视图接管整页');
    assert.match(term.lastFrame() ?? '', /分析中…/, '子代理转录实时呈现');
    term.write('\u001B'); // Esc：退出
    await sleep(50);
    assert.ok(!(term.lastFrame() ?? '').includes('子代理视图'), '退出后全屏视图消失');
    assert.match(term.lastFrame() ?? '', /\[w\]/, '回到主界面（ChildPanel 行在场）');
    term.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
