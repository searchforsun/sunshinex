import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

test('会话 detail：thinking 折叠保留思考全文，text 仍为摘要', async () => {
  const tmp = tmpdir('sunshinex-detail1-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new HookAdapter('{"done":true,"reply":"答复"}', { reasoning: ['先想', '再想'] }),
    });
    await ctrl.submit('任务');
    await ctrl.waitIdle();
    const thinking = ctrl.getState().messages.filter((m) => m.role === 'thinking');
    assert.equal(thinking.length, 1);
    assert.match(thinking[0].text, /^Thought for \d+s$/, '折叠行 text 仍为摘要');
    assert.equal(thinking[0].detail, '先想再想', 'detail 应保留思考全文');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话 detail：tool-result 归约 detail 为完整 observation', async () => {
  const tmp = tmpdir('sunshinex-detail2-');
  try {
    const longContent = 'L'.repeat(250);
    const filePath = path.join(tmp, 'long.txt');
    fs.writeFileSync(filePath, longContent, 'utf8');
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        `{"tool":"read","input":{"path":"${filePath}"},"done":false}`,
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('读长文件');
    await ctrl.waitIdle();
    const result = ctrl.getState().messages.find((m) => m.role === 'tool' && m.kind === 'result');
    assert.ok(result, '应存在工具结果行');
    assert.equal(result.text.length, 200, 'text 仍为 200 截断摘要');
    assert.equal(result.detail, longContent, 'detail 应为完整 observation');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话 detail：write 结果 detail 为完整 observation（非截断）', async () => {
  const tmp = tmpdir('sunshinex-detail3-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"a.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('写文件');
    await ctrl.waitIdle();
    const result = ctrl.getState().messages.find((m) => m.role === 'tool' && m.kind === 'result');
    assert.ok(result);
    assert.equal(result.detail, 'written', 'write 结果 detail 应为完整 observation');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
