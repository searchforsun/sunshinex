import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest } from '../types';
import type { OutputStyle } from '../types';
import { MARKDOWN_LINE, outputStyleLine } from './prompts/shared';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
// 测试卫生：数据目录钉文件私有目录（reactor.chat.test.ts 同款先例）
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-output-style-data-'));

const DONE = '{"done":true,"reply":"ok"}';

/** 提示词捕获桩：记录每轮请求消息视图，供稳定段断言 */
function makeReactor(tmp: string, outputStyle?: OutputStyle): { reactor: Reactor; requests: ChatRequest[] } {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const requests: ChatRequest[] = [];
  const base = new ScriptedAdapter([DONE]);
  const capture: ModelAdapter = {
    provider: base.provider,
    chat: async (req, hooks) => {
      requests.push(req);
      return base.chat(req, hooks);
    },
  };
  return {
    reactor: new Reactor({ registry, safety, context, model: capture, ...(outputStyle ? { outputStyle } : {}) }),
    requests,
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-output-style-'));
}

test('缺省（未注入 outputStyle）：输出约定行保持现行字节形态，零 terminal 约束文案', async () => {
  const tmp = tmpdir();
  try {
    const { reactor, requests } = makeReactor(tmp);
    const r = await reactor.run({ goal: '缺省面' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const stable = requests[0].messages[0]?.content ?? '';
    assert.ok(stable.includes(MARKDOWN_LINE), '缺省稳定段必须仍是 MARKDOWN_LINE 原文（既有前缀基线零漂移）');
    assert.ok(!stable.includes('```'), '缺省面不出现围栏约束文案');
    assert.ok(!stable.includes('default form'), '缺省面不出现 terminal 图示缺省形态文案');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("outputStyle='terminal'：稳定段携带围栏带语言标签与 ASCII 图示两行约束", async () => {
  const tmp = tmpdir();
  try {
    const { reactor, requests } = makeReactor(tmp, 'terminal');
    const r = await reactor.run({ goal: 'TUI 面' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const stable = requests[0].messages[0]?.content ?? '';
    const expected = outputStyleLine('terminal');
    assert.ok(stable.includes(expected), 'terminal 面稳定段必须逐字节包含 outputStyleLine 产物');
    assert.ok(expected.includes('explicit language tag'), '约束须含「围栏必须带语言标签」');
    assert.ok(expected.includes('ASCII'), '约束须含「图示走 ASCII」');
    assert.ok(!stable.includes(MARKDOWN_LINE), 'terminal 面以专用行替代通用 MARKDOWN_LINE，零双份');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('terminal 面相邻步前缀逐字节稳定：稳定段跨步不变，唯一差异在尾部', async () => {
  const tmp = tmpdir();
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const context = new ContextManager(tmp, store);
    const requests: ChatRequest[] = [];
    const base = new ScriptedAdapter(['{"tool":"glob","input":{"pattern":"*"},"done":false}', DONE]);
    const capture: ModelAdapter = {
      provider: base.provider,
      chat: async (req, hooks) => {
        requests.push(req);
        return base.chat(req, hooks);
      },
    };
    const reactor = new Reactor({ registry, safety, context, model: capture, outputStyle: 'terminal' });
    const r = await reactor.run({ goal: '前缀验收' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    assert.ok(requests.length >= 2, '应有两轮模型调用');
    assert.equal(requests[0].messages[0].content, requests[1].messages[0].content, '稳定段（含输出样式行）跨步逐字节相等');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
