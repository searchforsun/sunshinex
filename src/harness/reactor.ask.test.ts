import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ScriptedAdapter } from '../model/adapter';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import type { AskUserSeam } from '../types';

// 测试卫生：数据目录钉文件私有目录（沿 reactor.test 先例）
process.env.SUNSHINEX_DATA_DIR = process.env.SUNSHINEX_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-askreactor-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = process.env.SUNSHINEX_USER_SKILLS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-askreactor-uskills-'));

function makeReactorWithAsk(tmp: string, steps: string[], ask: AskUserSeam): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp, undefined, undefined, undefined, undefined, undefined, undefined, ask)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: new ScriptedAdapter(steps) });
}

test('ask_question 单发：经 seam 问询、裁决回填为观察（执行面贯通）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-askreactor1-'));
  try {
    const ask: AskUserSeam = async () => ({ type: 'selected', labels: ['Yes'] });
    const reactor = makeReactorWithAsk(tmp, [
      '{"tool":"ask_question","input":{"question":"Proceed?","options":[{"label":"Yes"},{"label":"No"}]},"done":false}',
      '{"done":true,"reply":"ok"}',
    ], ask);
    const r = await reactor.run({ goal: 'ask single' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    const resultRow = r.steps.find((s) => s.action === 'tool-result' && s.observation === 'answer: Yes');
    assert.ok(resultRow, 'ask_question 应有观察记录（裁决回填 role:tool 面）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ask_question 混批按序串行：与只读工具同批真实执行（ask seam 依序调用）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-askreactor2-'));
  try {
    const asked: string[] = [];
    const ask: AskUserSeam = async (q: { question: string }) => { asked.push(q.question); return { type: 'selected', labels: ['Yes'] }; };
    const reactor = makeReactorWithAsk(tmp, [
      '{"tools":[{"tool":"ask_question","input":{"question":"Proceed?","options":[{"label":"Yes"},{"label":"No"}]}},{"tool":"glob","input":{"pattern":"*.ts"}}],"done":false}',
      '{"done":true,"reply":"ok"}',
    ], ask);
    const r = await reactor.run({ goal: 'ask parallel' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    assert.deepEqual(asked, ['Proceed?'], 'ask_question 在混合批中按序真实执行（先于 glob）');
    assert.ok(!r.steps.some((s) => s.observation.includes('Parallel batch rejected')), '混合批按序执行不拒绝');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
