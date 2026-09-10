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
function makeLongFile(tmp: string): { filePath: string; longContent: string } {
  const longContent = 'L'.repeat(250);
  const filePath = path.join(tmp, 'long.txt');
  fs.writeFileSync(filePath, longContent, 'utf8');
  return { filePath, longContent };
}

test('App：工具调用行高亮（[VERB]）+ 结果折叠提示 [Tab 展开]', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp1-'));
  try {
    const { filePath, longContent } = makeLongFile(tmp);
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        `{"tool":"read","input":{"path":"${filePath}"},"done":false}`,
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('读长文件');
    await ctrl.waitIdle();
    const { lastFrame, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const frame = lastFrame() ?? '';
    assert.match(frame, /\[READ\]/, '工具名应加方括号高亮');
    assert.match(frame, /long\.txt/, '目标摘要应显示路径');
    assert.match(frame, /\[Tab 展开\]/, '折叠态应显示展开提示');
    assert.ok(!frame.includes(longContent), '折叠态不应显示结果全文');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Tab 切换展开工具结果全文', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp2-'));
  try {
    const { filePath, longContent } = makeLongFile(tmp);
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        `{"tool":"read","input":{"path":"${filePath}"},"done":false}`,
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('读长文件');
    await ctrl.waitIdle();
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200)); // 等挂载
    const countL = (f: string): number => f.split('L').length - 1;
    // 折叠态：摘要为 200 个 L（渲染折行不影响字符计数）
    assert.ok(countL(lastFrame() ?? '') < 250, '折叠态不应显示完整 observation');
    write('\t'); // Tab 切换展开
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(countL(lastFrame() ?? '') >= 250, '展开态应显示完整 observation');
    write('\t'); // 再 Tab 折叠
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(countL(lastFrame() ?? '') < 250, '再次 Tab 应折叠');
    assert.ok(longContent.length === 250);
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App：Tab 展开思考全文（reasoning detail）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-exp3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const { lastFrame, write, unmount } = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!(lastFrame() ?? '').includes('先想再想'), '折叠态不应显示思考全文');
    write('\t');
    await new Promise((r) => setTimeout(r, 150));
    assert.ok((lastFrame() ?? '').includes('先想再想'), '展开态应显示思考全文');
    unmount();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
