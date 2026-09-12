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

/** 折叠提示计数：折叠的思考/工具块各带一处提示（实时/入档「Tab 翻阅」、翻阅视口「↑↓ 展开」）；展开后消失（头部文案不含这两串） */
const countHint = (f: string): number => (f.match(/Tab 翻阅|↑↓ 展开/g) ?? []).length;
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

test('App：Tab 历史翻阅（块粒度）——默认展开最新 3 块、↑↓ 移动唯一焦点、越底回实时', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp2-'));
  try {
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((n) => makeLongFile(tmp, `${n}.txt`));
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        `{"tool":"read","input":{"path":"${a}"},"done":false}`,
        `{"tool":"read","input":{"path":"${b}"},"done":false}`,
        `{"tool":"read","input":{"path":"${c}"},"done":false}`,
        '{"done":true,"reply":"r1"}',
        `{"tool":"read","input":{"path":"${d}"},"done":false}`,
        `{"tool":"read","input":{"path":"${e}"},"done":false}`,
        '{"done":true,"reply":"r2"}',
      ]),
    });
    await ctrl.submit('批量读甲');
    await ctrl.waitIdle();
    await ctrl.submit('批量读乙');
    await ctrl.waitIdle();
    const { lastFrame, write, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    await sleep(200);
    write('\t'); // 进入翻阅：焦点=末块，默认展开最新 3 块（b2–b4），b0/b1 折叠
    await sleep(150);
    const f1 = lastFrame() ?? '';
    assert.match(f1, /历史翻阅/, 'Tab 应进入翻阅视图');
    assert.equal(countHint(f1), 2, '仅最早的 2 块保持折叠（默认展开最新 3 块）');
    const l1 = countL(f1);
    assert.ok(l1 >= 750 && l1 < 1000, `默认展开 3 块全文（got ${l1}）`);
    write('\u001B[A');
    await sleep(120);
    write('\u001B[A');
    await sleep(120);
    write('\u001B[A'); // 焦点移出默认区（b1）：窗口随动收窄至焦点所在轮，焦点块并入默认区展开（至多 4 块）
    await sleep(150);
    const f2 = lastFrame() ?? '';
    assert.equal(countHint(f2), 1, '焦点上移后仅 b0 折叠（焦点块并入默认 3 块，展开 ≤4）');
    const l2 = countL(f2);
    assert.ok(l2 >= 250 && l2 < 700, `视口只渲染焦点所在轮（折叠 b0 摘要 + 展开 b1 全文，got ${l2}）`);
    write('\u001B[A'); // 焦点=b0
    await sleep(120);
    const f3 = lastFrame() ?? '';
    assert.equal(countHint(f3), 1, 'b0 展开后 b1 折叠，同时至多 4 块展开语义不变');
    for (let i = 0; i < 5; i++) {
      write('\u001B[B'); // ↓ 连按越过末块 → 回实时
      await sleep(80);
    }
    await sleep(100);
    const f4 = lastFrame() ?? '';
    assert.ok(!f4.includes('历史翻阅'), '↓ 越过末块应回实时视图');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：思考默认折叠为摘要行；翻阅焦点块默认展开看全文', async () => {
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
    write('\t'); // 翻阅：唯一思考块即焦点，进入即自动展开
    await sleep(150);
    const rev = lastFrame() ?? '';
    assert.match(rev, /历史翻阅/);
    assert.ok(rev.includes('先想再想'), '进入翻阅焦点块默认展开，思考全文可见');
    write('\t'); // 翻阅态 Tab 即退出回实时
    await sleep(150);
    assert.ok(!(lastFrame() ?? '').includes('历史翻阅'), '翻阅态 Tab 应退出翻阅');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
