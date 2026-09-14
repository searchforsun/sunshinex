import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter } from '../model/adapter';

const DONE_REPLY = '{"done":true,"reply":"ok"}';

function makeReactor(
  tmp: string,
  adapter: ModelAdapter,
  reverseTools = false,
): { reactor: Reactor; prompts: string[] } {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  const tools = builtinTools(safety, tmp);
  for (const t of reverseTools ? [...tools].reverse() : tools) registry.register(t);
  const context = new ContextManager(tmp, store);
  const prompts: string[] = [];
  const capture: ModelAdapter = {
    provider: 'capture',
    complete: async (p: string) => {
      prompts.push(p);
      return adapter.complete(p);
    },
  };
  return { reactor: new Reactor({ registry, safety, context, model: capture }), prompts };
}

function scripted(replies: string[]): ModelAdapter {
  let call = 0;
  return { provider: 'scripted', complete: async () => replies[Math.min(call++, replies.length - 1)] };
}

test('前缀稳定化：相邻步严格前缀连续（无档位行，唯一差异是尾部 history 追加）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-prefix1-'));
  try {
    const { reactor, prompts } = makeReactor(tmp, scripted([
      '{"tool":"read","input":{"path":"a.txt"},"done":false}',
      '{"done":true,"reply":"ok"}',
      DONE_REPLY,
    ]));
    const r = await reactor.run({ goal: '前缀验收' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    assert.ok(prompts.length >= 2, `应至少两轮 prompt，实际 ${prompts.length}`);

    // 档位行整体摘除：模型档位是用户级参数（--tier //model），不进提示词
    for (const p of prompts) {
      assert.ok(!p.includes('Current compute tier'), '提示词不得再含档位行');
    }
    // 相邻步严格前缀连续：后一轮 prompt 以前一轮为逐字节前缀，唯一差异是尾部 history 追加
    for (let i = 1; i < prompts.length; i++) {
      assert.ok(prompts[i].startsWith(prompts[i - 1]), `第 ${i + 1} 轮 prompt 应以第 ${i} 轮为逐字节前缀（前缀缓存第一要义）`);
    }
    assert.ok(prompts[0].startsWith('You are SunshineX'), '稳定前缀以身份段开头');
    assert.ok(prompts[0].includes('Available tools:'), '稳定前缀覆盖工具清单段');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('前缀稳定化：工具清单段序与注册顺序无关（按名固定）', async () => {
  // root 已作为环境事实注入 prompt：两台 reactor 须共用同一 root，仅保留注册顺序这一变量
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-prefix2-'));
  try {
    const a = makeReactor(tmp, scripted([DONE_REPLY]));
    const b = makeReactor(tmp, scripted([DONE_REPLY]), true);
    await a.reactor.run({ goal: 'g' }, { maxSteps: 2 });
    await b.reactor.run({ goal: 'g' }, { maxSteps: 2 });
    assert.equal(a.prompts[0], b.prompts[0], '同内容不同注册顺序应产出同一 prompt');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('环境事实：提示词注入工作目录绝对路径与工具选择政策（相对 root 收敛为绝对）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-envfact-'));
  try {
    const { reactor, prompts } = makeReactor(tmp, scripted([DONE_REPLY]));
    await reactor.run({ goal: 'g' }, { maxSteps: 2 });
    const p = prompts[0];
    assert.ok(p.includes(`Current working directory (project root): ${tmp}`), '提示词应含工作目录绝对路径（环境事实）');
    assert.ok(p.includes('Tool choice:'), '提示词应含工具选择政策（专用工具优先、exec 兜底）');
    assert.ok(p.indexOf('Current working directory') > p.indexOf('Context:'), '工作目录属上下文段环境事实');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
