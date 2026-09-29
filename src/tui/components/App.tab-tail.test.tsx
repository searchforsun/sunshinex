import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';

// 钉短裸 ESC 拼接窗口（use-input 拆包重组默认 40ms）
process.env.SUNSHINEX_ESC_JOIN_MS = '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('App：Tab/Ctrl+O 折叠切换请求 tail 模式重绘（2026-09-30「折叠闪频」——清屏整屏重放在无 DEC 2026 的 WT 上即空白帧，tail 原位重写带可达性判定）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tab-tail-'));
  try {
    const ctrl = new SessionController({ root: tmp });
    const modes: (string | undefined)[] = [];
    const term = render(
      <App
        controller={ctrl}
        banner={{ version: '1.0.0', model: 'm', root: tmp }}
        onRequestRepaint={(mode) => modes.push(mode)}
      />,
    );
    await sleep(200); // 等挂载与首帧（expandAllInitRef 首挂不触发）
    term.write('\t'); // Tab 折叠切换
    await sleep(100);
    assert.equal(modes.length, 1, '前置：Tab 恰触发一次重绘请求');
    assert.equal(modes[0], 'tail', 'Tab 折叠请求 tail 模式（可达时原位重写零闪屏，超视口由 tui-loop 回落 full）');
    term.unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
