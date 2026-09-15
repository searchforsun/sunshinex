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
import { ModelAdapter, ResponseFormat, UsageHooks } from '../model/adapter';
import { ACTION_ENVELOPE_FORMAT } from './action-schema';

function makeReactor(tmp: string, adapter: ModelAdapter): Reactor {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter });
}

async function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.SUNSHINEX_STRUCTURED_OUTPUT;
  if (value === undefined) delete process.env.SUNSHINEX_STRUCTURED_OUTPUT;
  else process.env.SUNSHINEX_STRUCTURED_OUTPUT = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_STRUCTURED_OUTPUT;
    else process.env.SUNSHINEX_STRUCTURED_OUTPUT = prev;
  }
}

/** 记录两路调用实际收到的 format：stream（reactor 首选）与 complete（无流式通道时的降级） */
function probeAdapter(seen: Array<ResponseFormat | undefined>, withStream = true): ModelAdapter {
  const complete = async (_p: string, _h?: UsageHooks, format?: ResponseFormat): Promise<string> => {
    seen.push(format);
    return '{"done":true,"reply":"ok"}';
  };
  const adapter: ModelAdapter = { provider: 'probe', complete };
  if (withStream) {
    (adapter as { completeStream?: unknown }).completeStream = async (
      _p: string,
      onDelta: (t: string) => void,
      hooks?: UsageHooks,
      format?: ResponseFormat,
    ): Promise<string> => {
      seen.push(format);
      const text = '{"done":true,"reply":"ok"}';
      for (const ch of text) onDelta(ch);
      hooks?.onUsage?.(0);
      return text;
    };
  }
  return adapter;
}

test('结构化输出：缺省把信封 json_schema 随流式调用下发', async () => {
  await withEnv(undefined, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-so1-'));
    try {
      const seen: Array<ResponseFormat | undefined> = [];
      const r = await makeReactor(tmp, probeAdapter(seen)).run({ goal: 'g' }, { maxSteps: 2 });
      assert.equal(r.done, true);
      assert.deepEqual(seen, [ACTION_ENVELOPE_FORMAT]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test('结构化输出：SUNSHINEX_STRUCTURED_OUTPUT=json 降级 json_object；off 关闭不携带', async () => {
  await withEnv('json', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-so2-'));
    try {
      const seen: Array<ResponseFormat | undefined> = [];
      await makeReactor(tmp, probeAdapter(seen)).run({ goal: 'g' }, { maxSteps: 2 });
      assert.deepEqual(seen, [{ type: 'json_object' }]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  await withEnv('off', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-so3-'));
    try {
      const seen: Array<ResponseFormat | undefined> = [];
      await makeReactor(tmp, probeAdapter(seen)).run({ goal: 'g' }, { maxSteps: 2 });
      assert.deepEqual(seen, [undefined], 'off 时两路调用均不携带 format');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test('结构化输出：适配器无流式通道时 format 经 complete 降级路同样下发', async () => {
  await withEnv(undefined, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-so4-'));
    try {
      const seen: Array<ResponseFormat | undefined> = [];
      const r = await makeReactor(tmp, probeAdapter(seen, false)).run({ goal: 'g' }, { maxSteps: 2 });
      assert.equal(r.done, true);
      assert.deepEqual(seen, [ACTION_ENVELOPE_FORMAT]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
