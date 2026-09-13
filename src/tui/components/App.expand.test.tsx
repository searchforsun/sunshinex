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
/** 会话历史打印段头部计数（每次 Tab 触发追加一段） */
const countDumpHeader = (f: string): number => (f.match(/会话历史（全展开）/g) ?? []).length;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

test('App：Tab 展开打印——全会话历史全展开滚入滚动缓冲，可重复触发，动态帧保持干净', async () => {
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
    const { lastFrame, allOutput, write, unmount } = render(
      <App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />,
    );
    await sleep(200);
    assert.ok(!allOutput().includes('会话历史（全展开）'), 'Tab 前无打印段');
    write('\t'); // 展开打印：全会话历史（5 个工具 observation 全文）一次性滚入滚动缓冲
    await sleep(150);
    const after1 = allOutput();
    assert.equal(countDumpHeader(after1), 1, '打印段出现一次');
    const seg1 = after1.slice(after1.indexOf('会话历史（全展开）'));
    assert.ok(countL(seg1) >= 1000, `5 个 observation 全文可见（got ${countL(seg1)}）`);
    assert.ok(!(lastFrame() ?? '').includes('会话历史'), '打印段属滚动缓冲，动态帧不承载');
    assert.match(lastFrame() ?? '', /空闲/, '打印后动态帧仍只剩输入框与状态栏');
    write('\u001B[A'); // ↑ 归输入历史：无输入历史时缓冲纹丝不动
    await sleep(100);
    assert.equal(countDumpHeader(allOutput()), 1, '↑ 不触发任何翻阅行为（键位冲突解除）');
    write('\t'); // 可重复触发：再次打印最新快照
    await sleep(150);
    const after2 = allOutput();
    assert.equal(countDumpHeader(after2), 2, '第二次打印段追加');
    const seg2 = after2.slice(after2.indexOf('会话历史（全展开）', after1.indexOf('会话历史（全展开）') + 1));
    assert.ok(countL(seg2) >= 1000, `第二次打印段同样全展开（got ${countL(seg2)}）`);
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：思考默认折叠为摘要行；Tab 展开打印显示思考全文', async () => {
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
    write('\t'); // 展开打印：思考全文入缓冲
    await sleep(150);
    const dumped = allOutput();
    assert.equal(countDumpHeader(dumped), 1);
    assert.ok(dumped.includes('先想再想'), '打印段包含思考全文');
    assert.ok(!(lastFrame() ?? '').includes('先想再想'), '动态帧不承载打印段');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
