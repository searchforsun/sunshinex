import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';
import type { ModelAdapter } from '../../model/adapter';
import type { ChatRequest, ChatResult } from '../../types';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 挂起适配器：模型调用永挂直至外部 signal 中止（运行态现场） */
class HangingAdapter implements ModelAdapter {
  readonly provider = 'hanging';
  async chat(req: ChatRequest): Promise<ChatResult> {
    const signal = req.signal;
    return new Promise((_, reject) => {
      if (signal?.aborted) return reject(new Error('Task interrupted'));
      signal?.addEventListener('abort', () => reject(new Error('Task interrupted')), { once: true });
    });
  }
}

test('App 键提示条：空闲态常驻（补全/历史/子代理/help），banner 快捷键行退役不双显', async () => {
  const tmp = tmpDir('sunshinex-keyhints1-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp });
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('⌨'), 3000);
    const f = term?.lastFrame() ?? '';
    assert.ok(f.includes('Ctrl+B'), '空闲态含子代理浏览键（此前无任何可见提示）');
    assert.ok(f.includes('/help'), '/help 由条承载（banner 行退役后唯一入口）');
    assert.ok(!(term?.allOutput() ?? '').includes('plan-then-execute'), 'banner 旧快捷键行退役');
    assert.ok(f.includes('❯') && f.indexOf('⌨') > f.indexOf('❯'), '条在输入框下方（一眼可见位）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App 键提示条：运行中换暂停/待办/详情组，模态卡在场条退场', async () => {
  const tmp = tmpDir('sunshinex-keyhints2-');
  let term: ReturnType<typeof render> | undefined;
  const ctrl = new SessionController({ root: tmp, model: new HangingAdapter() });
  const pending = ctrl.submit('长任务');
  try {
    await waitFor(() => ctrl.getState().status === 'running');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('⌨'), 3000);
    const f = term?.lastFrame() ?? '';
    assert.ok(f.includes('Ctrl+C'), '运行中含暂停键（两次 Ctrl+C 第一段入口）');
    assert.ok(f.includes('Ctrl+O'), '运行中含详情键');
    assert.ok(!f.includes('/help'), '运行中不含空闲态 /help（矩阵分流）');
    // 中断收尾
    term.write('\x03');
    await new Promise((r) => setTimeout(r, 40));
    term.write('\x03');
    await pending;
    await waitFor(() => ctrl.getState().status === 'idle', 3000);
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App 键提示条：审批卡在场条退场（卡 hint 承载不双显）', async () => {
  const tmp = tmpDir('sunshinex-keyhints3-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter(['{"tool":"exec","input":{"command":"touch approval-probe.txt"},"done":false}', '{"done":true,"reply":"ok"}']),
    });
    const p = ctrl.submit('go');
    await waitFor(() => ctrl.getState().status === 'awaiting-approval', 5000);
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('放行一次') || (term?.lastFrame() ?? '').includes('Approve once'), 3000);
    assert.ok(!(term?.lastFrame() ?? '').includes('⌨'), '模态卡在场键提示条退场');
    await ctrl.resolveApproval('deny');
    await p.catch(() => {});
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
