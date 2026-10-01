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

test('App：运行中 Tab 展开待办全量清单，再按收回（2026-10-01 用户裁决「运行过程中点 Tab 展开 todolist」；尾部重挂后经 retain 保留不回折）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tab-todo-'));
  let term: ReturnType<typeof render> | undefined;
  try {
    // 混合适配器：第一轮 todo_write 落三态待办，第二轮挂起不归——撑出稳定的「运行中+有待办」现场
    let calls = 0;
    let release: (() => void) | undefined;
    const todos = [
      { text: '调研', status: 'completed' },
      { text: '实现', status: 'in_progress' },
      { text: '落库', status: 'pending' },
    ];
    const hungAdapter = {
      provider: 'hung',
      async chat() {
        if (calls++ === 0) {
          return { finish: 'tool_calls' as const, content: '', toolCalls: [{ id: 'c1', name: 'todo_write', argsJson: JSON.stringify({ todos }) }] };
        }
        return new Promise((resolve) => {
          release = () => resolve({ finish: 'stop' as const, content: '收尾', toolCalls: [] });
        });
      },
    };
    const ctrl = new SessionController({ root: tmp, model: hungAdapter as never });
    term = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    const { write, lastFrame } = term;
    await sleep(200);
    void ctrl.submit('干活'); // 第一轮 todo_write 执行，第二轮挂起 → status running + todos 3 项
    await sleep(400);
    assert.equal(ctrl.getState().status, 'running', '前置：回合在途');
    assert.equal(ctrl.getState().todos.length, 3, '前置：待办三项已落');
    assert.match(lastFrame() ?? '', /todo 1\/3 · ▸/, '前置：运行中待办折叠单行');
    assert.doesNotMatch(lastFrame() ?? '', /○ 落库/, '前置：全量清单不在帧');
    write('\t'); // Tab → 展开待办
    await sleep(200);
    assert.match(lastFrame() ?? '', /○ 落库/, 'Tab 后全量清单展开（✓/▸/○ 三态行在帧）');
    await sleep(500); // 越过 Tab 触发的尾部重挂
    assert.match(lastFrame() ?? '', /○ 落库/, '尾部重挂后待办保持展开（retain 保留不回折）');
    write('\t'); // Tab → 收回
    await sleep(200);
    assert.doesNotMatch(lastFrame() ?? '', /○ 落库/, '再按 Tab 收回折叠单行');
    release?.();
    await ctrl.waitIdle();
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
