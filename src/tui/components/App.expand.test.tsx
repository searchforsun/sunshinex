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

/** 折叠提示计数：折叠的思考/工具块各带一处「Tab 翻阅」；展开后消失（翻阅头部文案不含该串） */
const countHint = (f: string): number => f.split('Tab 翻阅').length - 1;
/** L 总量口径（单帧）：折叠摘要首行仅 ~68 连串（宽度截断），展开后全文 250——折行会切碎长串，必须按段累计 */
const countL = (f: string): number => (f.match(/L{30,}/g) ?? []).reduce((a, b) => a + b.length, 0);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('App：实时/历史默认折叠——工具结果单行摘要，全文仅翻阅可见', async () => {
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
    assert.ok(all.includes('Tab 翻阅'), '折叠摘要应带翻阅提示');
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

test('App：Tab 历史翻阅——默认折叠、↑↓ 追踪、同时只展开一块', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp2-'));
  try {
    const one = makeLongFile(tmp, 'one.txt');
    const two = makeLongFile(tmp, 'two.txt');
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        `{"tool":"read","input":{"path":"${one}"},"done":false}`,
        '{"done":true,"reply":"r1"}',
        `{"tool":"read","input":{"path":"${two}"},"done":false}`,
        '{"done":true,"reply":"r2"}',
      ]),
    });
    await ctrl.submit('读甲');
    await ctrl.waitIdle();
    await ctrl.submit('读乙');
    await ctrl.waitIdle();
    const { lastFrame, write, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    await sleep(200);
    const f0 = lastFrame() ?? '';
    assert.equal(countHint(f0), 0, '动态帧不承载消息（全部已入 Static）');
    write('\t'); // 进入历史翻阅：视口内两轮均折叠
    await sleep(150);
    const f1 = lastFrame() ?? '';
    assert.match(f1, /历史翻阅/, 'Tab 应进入翻阅视图');
    assert.equal(countHint(f1), 2, '翻阅态两轮均折叠');
    assert.ok(countL(f1) < 200, `翻阅默认不展示全文（got ${countL(f1)}）`);
    write('\t'); // 展开视口末轮（仅一块）
    await sleep(150);
    const f2 = lastFrame() ?? '';
    assert.equal(countHint(f2), 1, '同时只展开一块（末轮展开、首轮仍折叠）');
    const l2 = countL(f2);
    assert.ok(l2 >= 250 && l2 < 450, `只应展开末轮一块（got ${l2}）`);
    write('\u001B[A'); // ↑ 追踪到第 1 轮：视口仅剩第 1 轮（折叠）
    await sleep(150);
    const f3 = lastFrame() ?? '';
    assert.equal(countHint(f3), 1, '↑ 后视口仅含第 1 轮折叠');
    assert.ok(countL(f3) < 200, `展开态不随视口残留（got ${countL(f3)}）`);
    write('\t'); // 展开当前轮
    await sleep(150);
    const f4 = lastFrame() ?? '';
    assert.equal(countHint(f4), 0, '当前轮展开后无折叠块');
    const l4 = countL(f4);
    assert.ok(l4 >= 250 && l4 < 450, `第 1 轮全文可见（got ${l4}）`);
    write('\u001B'); // Esc 返回实时：当前轮恢复折叠
    await sleep(150);
    const f5 = lastFrame() ?? '';
    assert.ok(!f5.includes('历史翻阅'), 'Esc 应退出翻阅视图');
    assert.equal(countHint(f5), 0, 'Esc 后动态帧零消息渲染');
    assert.ok(countL(f5) < 200, `实时视图不展示全文（got ${countL(f5)}）`);
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：思考默认折叠为摘要行；翻阅展开看全文', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const { lastFrame, allOutput, write, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    await sleep(200);
    const all = allOutput();
    assert.ok(all.includes('Thought for'), '思考摘要行随 Static 入档');
    assert.ok(!all.includes('先想再想'), '思考全文默认不展示');
    assert.ok(!(lastFrame() ?? '').includes('Thought for'), '动态帧不承载消息');
    write('\t'); // 翻阅（单轮折叠）
    await sleep(150);
    const rev = lastFrame() ?? '';
    assert.match(rev, /历史翻阅/);
    assert.ok(rev.includes('Thought for'), '翻阅折叠态保留摘要行');
    assert.ok(!rev.includes('先想再想'), '翻阅折叠态不显示思考全文');
    write('\t'); // 展开当前块
    await sleep(150);
    assert.ok((lastFrame() ?? '').includes('先想再想'), 'Tab 展开后思考全文可见');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
