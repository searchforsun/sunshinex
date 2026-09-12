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

/** 造一个 250 字符长文件并返回其绝对路径（read 工具需绝对路径，200 摘要与 250 全文可区分） */
function makeLongFile(tmp: string, name: string): string {
  const filePath = path.join(tmp, name);
  fs.writeFileSync(filePath, 'L'.repeat(250), 'utf8');
  return filePath;
}

const countL = (f: string): number => (f.match(/L{50,}/g) ?? []).reduce((a, b) => a + b.length, 0); // 只统计长 L 串：避免随机 tmp 路径字符干扰
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('App：实时视图默认全展开——工具结果全文直接上屏，无折叠提示', async () => {
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
    const { allOutput, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const all = allOutput();
    assert.match(all, /\[READ\]/, '工具名应加方括号高亮');
    assert.match(all, /long\.txt/, '调用行应显示路径');
    assert.ok(!all.includes('[Tab 展开]'), '实时/历史默认全展开，不应有折叠提示');
    assert.ok(countL(all) >= 250, '默认应展示完整 observation 而非 200 字摘要');
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
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await sleep(200);
    write('\t'); // 进入历史翻阅：视口内两轮均折叠（各 200 摘要）
    await sleep(150);
    assert.match(lastFrame() ?? '', /历史翻阅/, 'Tab 应进入翻阅视图');
    assert.equal(countL(lastFrame() ?? ''), 400, '翻阅态两轮均折叠');
    write('\t'); // 展开视口末轮（仅一块）：200 + 250
    await sleep(150);
    const c1 = countL(lastFrame() ?? '');
    assert.ok(c1 >= 450 && c1 < 500, `只应展开末轮一块（got ${c1}）`);
    write('\u001B[A'); // ↑ 追踪到第 1 轮：视口仅剩第 1 轮（折叠）
    await sleep(150);
    assert.equal(countL(lastFrame() ?? ''), 200, '↑ 后视口仅含第 1 轮折叠');
    write('\t'); // 展开当前轮
    await sleep(150);
    const c2 = countL(lastFrame() ?? '');
    assert.ok(c2 >= 250 && c2 < 400, `只应展开当前一块（got ${c2}）`);
    write('\u001B'); // Esc 返回实时：当前轮全展开
    await sleep(150);
    assert.ok(!(lastFrame() ?? '').includes('历史翻阅'), 'Esc 应退出翻阅视图');
    assert.ok(countL(lastFrame() ?? '') >= 250, '实时视图恢复全展开');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：思考默认展开全文；翻阅折叠后 Tab 展开', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await sleep(200);
    assert.ok((lastFrame() ?? '').includes('Thought for'), '思考摘要行应显示');
    assert.ok((lastFrame() ?? '').includes('先想再想'), '实时视图默认展开思考全文');
    write('\t'); // 翻阅（单轮折叠）
    await sleep(150);
    const rev = lastFrame() ?? '';
    assert.match(rev, /历史翻阅/);
    assert.ok(rev.includes('Thought for'));
    assert.ok(!rev.includes('先想再想'), '翻阅折叠态不显示思考全文');
    write('\t'); // 展开当前块
    await sleep(150);
    assert.ok((lastFrame() ?? '').includes('先想再想'), 'Tab 应展开思考全文');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
