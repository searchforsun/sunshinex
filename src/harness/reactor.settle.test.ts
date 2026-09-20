import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import type { SettlePayload } from './reactor';
import { ModelAdapter, ScriptedAdapter } from '../model/adapter';
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

function makeReactor(tmp: string, adapter: ModelAdapter, settle?: (r: SettlePayload) => void): { reactor: Reactor; context: ContextManager } {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return { reactor: new Reactor({ registry, safety, context, model: adapter, ...(settle ? { settle } : {}) }), context };
}

test('done 路径：settle 触发一次，产物 frontmatter 可解析', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle1-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const calls: SettlePayload[] = [];
    const learned = new LearnedSkillStore(tmp);
    const { reactor } = makeReactor(
      tmp,
      new ScriptedAdapter(['{"done":true,"reply":"部署手册已完成"}']),
      (r) => {
        calls.push(r);
        learned.settle(r.goal, r.reply);
      },
    );
    // await 必须落在 try 内：return r.then(...) 形态下 finally 在 promise 解决前执行（删目录+还原环境），
    // settle 异步落盘晚于清理，旧环境靠回退链 mkdir「复活」已删目录侥幸通过——竞态已消除
    const res = await reactor.run({ goal: '部署手册' }, { maxSteps: 3 });
    assert.equal(res.done, true);
    assert.equal(calls.length, 1);
    // 载荷四元组：done 单步收口无工具步可摘要 → digest 为空串（非触发面缺陷；有步骤的中止路径 digest 非空见下例）
    assert.deepEqual(calls[0], { goal: '部署手册', reply: '部署手册已完成', outcome: 'done', digest: '' });
    const dir = path.join(tmp, '.data', 'skills');
    const ids = fs.readdirSync(dir);
    assert.equal(ids.length, 1);
    const meta = parseSkillFrontmatter(fs.readFileSync(path.join(dir, ids[0], 'skill.md'), 'utf8'));
    assert.equal(meta.name, 'settle:部署手册');
    assert.equal(meta.kind, 'prompt');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('全终态触发：maxSteps 耗竭 → stopped、模型失败 → failed，各触发一次并携带 digest', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle2-'));
  try {
    const stopped: SettlePayload[] = [];
    const { reactor: exhausted } = makeReactor(
      tmp,
      new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo x"},"done":false}']),
      (r) => {
        stopped.push(r);
      },
    );
    const r1 = await exhausted.run({ goal: 'g' }, { maxSteps: 1 });
    assert.equal(r1.done, false);
    assert.equal(r1.stopReason, 'max-steps');
    assert.equal(stopped.length, 1, '中止路径同样入队一次（D4 全终态）');
    assert.equal(stopped[0].outcome, 'stopped');
    assert.equal(stopped[0].reply, '', '无最终答复归一为空串');
    assert.ok(stopped[0].digest.includes('[tool] exec'), 'digest 承载已观察步骤（观察行首行）');
    // 模型调用失败路径：适配器直接抛错
    const failed: SettlePayload[] = [];
    const { reactor: boomReactor } = makeReactor(
      tmp,
      {
        provider: 'boom',
        complete: async () => {
          throw new Error('boom');
        },
      },
      (r) => {
        failed.push(r);
      },
    );
    const r2 = await boomReactor.run({ goal: 'g' }, { maxSteps: 2 });
    assert.equal(r2.done, false);
    assert.equal(r2.stopReason, 'model-error');
    assert.equal(failed.length, 1, '模型失败路径同样入队一次（D4 全终态）');
    assert.equal(failed[0].outcome, 'failed');
    assert.equal(failed[0].reply, 'boom');
    assert.equal(failed[0].digest, '', '零步可摘要：首调即失败、无观察行（digest 空≠未触发）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settle 抛错：吞错记 episodic，不影响 RunResult', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle3-'));
  try {
    const { reactor, context } = makeReactor(tmp, new ScriptedAdapter(['{"done":true,"reply":"ok"}']), () => {
      throw new Error('沉淀炸了');
    });
    const r = await reactor.run({ goal: 'g' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    assert.equal(r.reply, 'ok');
    assert.ok(context.chainView().some((s) => s.action === 'note' && /沉淀失败|Settle failed/.test(s.observation)), '沉淀失败记链行、不倒灌任务结果');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Harness 装配：缺省开启沉淀，learnSkills:false 可关', async () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle4-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settle5-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  try {
    process.env.SUNSHINEX_DATA_DIR = path.join(tmp1, '.data');
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
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp1, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});
