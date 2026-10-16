import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import type { ChatRequest, ChatResult } from '../types';
import { ModelAdapter, ScriptedAdapter, UsageHooks } from '../model/adapter';
import { listSessions, readSessionMeta, sessionsDir } from './session-journal';
import { resolveDataDir } from '../config/data-dir';

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
  async chat(_req: ChatRequest, _hooks?: UsageHooks): Promise<ChatResult> {
    return { finish: 'stop', content: this.text, toolCalls: [] };
  }
  async chatStream(_req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    for (const r of this.opts.reasoning ?? []) hooks?.onReasoning?.(r);
    for (const ch of this.text) onDelta(ch);
    return { finish: 'stop', content: this.text, toolCalls: [] };
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
        `{"tool":"read","input":{"path":${JSON.stringify(filePath)}},"done":false}`,
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
    assert.equal(result.detail, 'written +1 -0', 'write 结果 detail 应为完整 observation（diffstat 形态）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话 detail：closeTask 落会话级旁车 meta（G14.17 runs/steps/tokens/模型，列表回溯零重放）', async () => {
  const tmp = tmpdir('sunshinex-detail-meta-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"write","input":{"path":"m.txt","content":"hi"},"done":false}',
        '{"done":true,"reply":"第一轮"}',
        '{"done":true,"reply":"第二轮"}',
      ]),
    });
    await ctrl.submit('第一轮任务');
    await ctrl.waitIdle();
    const id = ctrl.ensureJournal().currentId;
    assert.ok(id, '首轮建档');
    const metaFile = path.join(sessionsDir(resolveDataDir(tmp)), id + '.meta.json');
    assert.ok(fs.existsSync(metaFile), 'closeTask 落旁车 meta');
    const first = readSessionMeta(resolveDataDir(tmp), id!);
    assert.equal(first.runs, 1, '台账累计 run 数');
    assert.ok((first.steps ?? 0) >= 1, '任务步数累计');
    assert.equal(typeof first.tokens, 'number');
    assert.equal(typeof first.seconds, 'number');
    assert.equal(first.model, 'scripted', '无 label 回落 provider');
    assert.ok((first.ctxWindow ?? 0) > 0, '窗口预算');
    assert.equal(first.title, undefined, 'TUI 无 rename 面不产标题');
    // 第二轮:读旧值算累计(runs +1/tokens 累加),其余键保留
    await ctrl.submit('第二轮任务');
    await ctrl.waitIdle();
    const second = readSessionMeta(resolveDataDir(tmp), id!);
    assert.equal(second.runs, 2);
    assert.ok((second.tokens ?? 0) >= (first.tokens ?? 0), 'tokens 单调累计');
    assert.equal(second.model, 'scripted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('会话 /btw（G14.29）：fork 旁路一轮,答案 ⪽ 旁白落屏;主链零插入,fork 档 side 标记且列表滤除', async () => {
  const tmp = tmpdir('sunshinex-btw-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"主线完成"}', '{"done":true,"reply":"旁路解释"}']),
    });
    await ctrl.submit('主线任务');
    await ctrl.waitIdle();
    ctrl.ensureJournal();
    const dataDir = resolveDataDir(tmp);
    const before = new Set(fs.readdirSync(sessionsDir(dataDir))); // 同文件它用例共享 pinned dataDir——按增量断言
    await ctrl.submit('/btw 为什么这么改?');
    await ctrl.waitIdle();
    const sys = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text);
    assert.ok(sys.some((t2) => t2.includes('旁路解释')), '答案旁白落屏');
    // 主链零插入:主线回复仍是最后一条 assistant(旁白为 system 不算)
    const lastAssistant = ctrl.getState().messages.filter((m) => m.role === 'assistant').at(-1);
    assert.equal(lastAssistant?.text.trim(), '主线完成');
    // fork 档:恰一新增 + side 标记 + 列表滤除
    const forkFiles = fs
      .readdirSync(sessionsDir(dataDir))
      .filter((f) => f.endsWith('.jsonl') && !before.has(f));
    assert.equal(forkFiles.length, 1, 'fork 档在盘');
    const forkId = forkFiles[0]!.slice(0, -'.jsonl'.length);
    assert.equal(readSessionMeta(dataDir, forkId).side, true, 'side 标记');
    assert.equal(listSessions(dataDir).some((r) => r.id === forkId), false, '列表滤除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

