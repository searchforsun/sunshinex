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
import { LearnedSkillStore } from './skills/learned';
import { parseSkillFrontmatter } from './skills';
import { Harness } from './index';
import { ModelAdapter } from '../model/adapter';

function makeReactor(tmp: string, adapter: ModelAdapter, settle?: (r: { goal: string; reply: string }) => void): Reactor {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter, ...(settle ? { settle } : {}) });
}

test('done 路径：settle 触发一次，产物 frontmatter 可解析', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle1-'));
  try {
    const calls: { goal: string; reply: string }[] = [];
    const learned = new LearnedSkillStore(tmp);
    const reactor = makeReactor(
      tmp,
      new ScriptedAdapter(['{"done":true,"reply":"部署手册已完成"}']),
      (r) => {
        calls.push(r);
        learned.settle(r.goal, r.reply);
      },
    );
    const r = reactor.run({ goal: '部署手册' }, { maxSteps: 3 });
    return r.then((res) => {
      assert.equal(res.done, true);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], { goal: '部署手册', reply: '部署手册已完成' });
      const dir = path.join(tmp, '.data', 'skills');
      const ids = fs.readdirSync(dir);
      assert.equal(ids.length, 1);
      const meta = parseSkillFrontmatter(fs.readFileSync(path.join(dir, ids[0], 'skill.md'), 'utf8'));
      assert.equal(meta.name, '沉淀:部署手册');
      assert.equal(meta.kind, 'prompt');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('失败路径：maxSteps 耗尽与模型失败均零触发 settle', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle2-'));
  try {
    let calls = 0;
    const exhausted = makeReactor(
      tmp,
      new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo x"},"done":false}']),
      () => {
        calls += 1;
      },
    );
    const r1 = await exhausted.run({ goal: 'g' }, { maxSteps: 1 });
    assert.equal(r1.done, false);
    // 模型调用失败路径：适配器直接抛错
    const boomReactor = makeReactor(
      tmp,
      {
        provider: 'boom',
        complete: async () => {
          throw new Error('boom');
        },
      },
      () => {
        calls += 1;
      },
    );
    const r2 = await boomReactor.run({ goal: 'g' }, { maxSteps: 2 });
    assert.equal(r2.done, false);
    assert.equal(calls, 0, '失败路径不得触发 settle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle 抛错：吞错记 episodic，不影响 RunResult', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle3-'));
  try {
    const store = new FileStore(path.join(tmp, '.data'));
    const reactor = makeReactor(tmp, new ScriptedAdapter(['{"done":true,"reply":"ok"}']), () => {
      throw new Error('沉淀炸了');
    });
    const r = await reactor.run({ goal: 'g' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    assert.equal(r.reply, 'ok');
    const episodic = store.read<string[]>('memory.episodic', []);
    assert.ok(episodic.some((l) => l.includes('settle') && l.includes('沉淀炸了')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Harness 装配：缺省开启沉淀，learnSkills:false 可关', async () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle4-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle5-'));
  try {
    const h1 = new Harness({ root: tmp1, model: new ScriptedAdapter(['{"done":true,"reply":"验收手册"}']) });
    const r1 = await h1.reactor.run({ goal: '验收手册' }, { maxSteps: 3 });
    assert.equal(r1.done, true);
    const dir1 = path.join(tmp1, '.data', 'skills');
    assert.ok(fs.existsSync(dir1), '缺省开启：学习产物应落盘');
    assert.equal(fs.readdirSync(dir1).length, 1);

    const h2 = new Harness({ root: tmp2, model: new ScriptedAdapter(['{"done":true,"reply":"验收手册"}']), learnSkills: false });
    await h2.reactor.run({ goal: '验收手册' }, { maxSteps: 3 });
    assert.ok(!fs.existsSync(path.join(tmp2, '.data', 'skills')), 'learnSkills:false 不落盘');
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});
