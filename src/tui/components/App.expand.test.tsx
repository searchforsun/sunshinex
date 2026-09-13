import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../../model/adapter';

/** 钩子适配器：reasoning 增量可注入（驱动思考实时区） */
class HookAdapter implements ModelAdapter {
  readonly provider = 'hooks';
  constructor(
    private readonly text: string,
    private readonly opts: { reasoning?: string[] } = {},
  ) {}
  async complete(): Promise<string> {
    return this.text;
  }
  async completeStream(_prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    for (const r of this.opts.reasoning ?? []) hooks?.onReasoning?.(r);
    for (const ch of this.text) onDelta(ch);
    return this.text;
  }
}

/** 造一个 250 字符长文件：read 全文为 250 连串 L；折叠摘要仅首行宽度截断（远短于 200 连串），据此精确判别展开态 */
function makeLongFile(tmp: string, name: string): string {
  const filePath = path.join(tmp, name);
  fs.writeFileSync(filePath, 'L'.repeat(250), 'utf8');
  return filePath;
}

/** L 总量口径（按段累计）：折叠摘要首行仅 ~68 连串（宽度截断），展开后全文 250——折行会切碎长串，必须按段累计 */
const countL = (f: string): number => (f.match(/L{30,}/g) ?? []).reduce((a, b) => a + b.length, 0);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 门闩适配器：首轮 complete 挂起保持 running 态（release 放行），用于验证展开模式切换无状态门槛 */
class GateAdapter implements ModelAdapter {
  readonly provider = 'gate';
  private turn = 0;
  private resolveTurn!: () => void;
  private readonly firstTurn = new Promise<void>((resolve) => (this.resolveTurn = resolve));
  async complete(): Promise<string> {
    if (this.turn++ === 0) await this.firstTurn;
    return 'ok';
  }
  async completeStream(_prompt: string, onDelta: (t: string) => void): Promise<string> {
    return this.complete();
  }
  release(): void {
    this.resolveTurn();
  }
}

test('App：实时/历史默认折叠——工具结果单行摘要，全文仅 Tab 展开打印可见', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp1-'));
  try {
    const filePath = makeLongFile(tmp, 'long.txt');
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        `{"tool":"read","input":{"path":"${filePath}"},"done":false}`,
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('读长文件');
    await ctrl.waitIdle();
    const { lastFrame, allOutput, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    const all = allOutput();
    assert.match(all, /\[READ\]/, '调用行应显示工具名与路径');
    assert.match(all, /⎿ ✓/, '结果行应保留 ✓/✗ 状态');
    assert.ok(!/\+\d+ 行 · Tab/.test(all), '工具结果摘要不再带「+N 行」尾缀');
    assert.ok(!all.includes('[Tab'), '折叠摘要不再带翻阅/展开提示标记');
    assert.ok(!all.includes('L'.repeat(200)), '折叠摘要不应出现完整 observation');
    assert.ok(!all.includes('L'.repeat(250)), '全文（250 连 L）不应在实时/入档任何帧出现');
    const frame = lastFrame() ?? '';
    assert.ok(!frame.includes('[READ]'), '消息全部入 Static，动态帧零消息渲染');
    assert.match(frame, /空闲/, '动态帧只剩输入框与状态栏');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Tab 切换历史展开模式——运行中可切、回调触发、现场回写、可逆', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp2-'));
  try {
    const gate = new GateAdapter();
    const ctrl = new SessionController({ root: tmp, model: gate });
    const retain = { buffer: '', cursor: 0, expandAll: false, latestFull: false, history: [], histIdx: -1 };
    const repaints: number[] = [];
    const { write, unmount } = render(
      <App
        controller={ctrl}
        banner={{ version: '1.0.0', model: 'm', root: tmp }}
        retain={retain}
        onRequestRepaint={() => repaints.push(repaints.length + 1)}
      />,
    );
    await sleep(80);
    void ctrl.submit('长任务');
    await sleep(150);
    assert.equal(ctrl.getState().status, 'running', '门闩适配器保持运行态');

    write('\t'); // 运行中切到全展开模式
    await sleep(80);
    assert.equal(repaints.length, 1, '运行中 Tab 即触发整屏重绘（无状态门槛）');
    assert.equal(retain.expandAll, true, '现场回写：重挂后保持展开模式');

    gate.release();
    await ctrl.waitIdle();
    assert.equal(repaints.length, 1, '任务运行不触发重绘，模式切换只重绘一次');

    write('\t'); // 再按切回折叠
    await sleep(80);
    assert.equal(repaints.length, 2, '再按再次重绘');
    assert.equal(retain.expandAll, false, 'toggle 可逆');

    write('\u000f'); // Ctrl+O：第二层（内容深度）切换
    await sleep(80);
    assert.equal(repaints.length, 3, 'Ctrl+O 同样触发整屏重绘');
    assert.equal(retain.latestFull, true, '内容深度开关回写 retain');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：retain 展开模式恢复——挂载即全展开渲染历史块', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const { allOutput, unmount } = render(
      <App
        controller={ctrl}
        banner={{ version: '1.0.0', model: 'm', root: tmp }}
        retain={{ buffer: '', cursor: 0, expandAll: true, latestFull: false, history: [], histIdx: -1 }}
      />,
    );
    await sleep(150);
    const all = allOutput();
    assert.ok(all.includes('先想再想'), '展开模式下思考全文随 Static 重放可见');
    assert.ok(all.includes('答复'), '重放含助手答复');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
