import { textReplyToChatFace } from '../model/chat-stub';
import type { ModelAdapter } from '../model/adapter';
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 测试卫生：数据目录钉文件私有目录（沿 reactor.test 先例，防共享目录并发写入污染装配产物）
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-steer-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-steer-uskills-'));

function makeReactor(
  tmp: string,
  adapter: ModelAdapter,
  steer?: () => string[],
): { reactor: Reactor; context: ContextManager } {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  const reactor = new Reactor({ registry, safety, context, model: adapter, ...(steer ? { steer } : {}) });
  return { reactor, context };
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

test('运行中穿插：步边界消费 steer 钩子，用户行尾追进下一装配面与主链（对标 CC queued messages）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-steer-'));
  const responses = [
    '{"tool":"exec","input":{"command":"echo step1"},"done":false}',
    '{"done":true,"reply":"ok"}',
  ];
  const prompts: string[] = [];
  const adapter = {
    provider: 'scripted-steer',
    chat: textReplyToChatFace(async (p: string) => { prompts.push(p); return responses.shift()!; }),
  };
  // 用户在任务运行中插入：首个步边界（零新步）不消费，工具步完成后的下一个步边界才投递
  let drains = 0;
  const { reactor, context } = makeReactor(tmp, adapter, () => (++drains === 1 ? ['User steer: also update the README'] : []));

  const r = await reactor.run({ goal: 'do work' });
  assert.equal(r.done, true);
  assert.equal(prompts.length, 2, '两步两帧');
  assert.ok(!prompts[0].includes('User steer:'), '首帧装配面无穿插行');
  assert.ok(prompts[1].includes('User steer: also update the README'), '次帧装配面携带穿插行');
  // 前缀钉子（CLAUDE.md §11）：首个差异点落在尾部新增段——穿插行只以尾追出现，零前缀击穿
  const common = commonPrefix(prompts[0], prompts[1]);
  assert.ok(common > 0, '相邻帧存在公共前缀');
  assert.ok(prompts[1].slice(common).includes('User steer:'), '差异段含穿插行（尾追语义）');
  assert.ok(!prompts[0].slice(common).includes('User steer:'), '差异非首帧既有内容位移');

  // 主链落点：session 作用域收束回写含穿插行（可审计、后续轮次装配自然携带）
  const chain = context.chainView();
  assert.ok(chain.some((s) => s.action === 'task' && s.observation === 'User steer: also update the README'), '穿插行已入会话链');
  const stepNums = chain.map((s) => s.step);
  for (let i = 1; i < stepNums.length; i++) {
    assert.ok(stepNums[i] > stepNums[i - 1], '链步骤号严格递增（穿插行不与执行步撞号）');
  }
});

test('运行中穿插：起步后步边界消费，多行按入队序尾追、同一边界只消费一次', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-steer2-'));
  const responses = [
    '{"tool":"exec","input":{"command":"echo step1"},"done":false}',
    '{"done":true,"reply":"ok"}',
  ];
  const prompts: string[] = [];
  const adapter = {
    provider: 'scripted-steer2',
    chat: textReplyToChatFace(async (p: string) => { prompts.push(p); return responses.shift()!; }),
  };
  let drains = 0;
  const { reactor } = makeReactor(tmp, adapter, () => (++drains === 1 ? ['User steer: first', 'User steer: second'] : []));

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  assert.ok(!prompts[0].includes('User steer:'), '首帧（零新步边界）无穿插');
  const i1 = prompts[1].indexOf('User steer: first');
  const i2 = prompts[1].indexOf('User steer: second');
  assert.ok(i1 >= 0 && i2 > i1, '多行穿插按入队序尾追进同一装配面');
  assert.equal(drains, 1, '起步后仅此一个步边界消费，done 即退出不重复 drain');
});

test('起步前不消费：零新步边界不投递，穿插行留在通道由会话层收口兜底', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-steer3-'));
  const prompts: string[] = [];
  const adapter = {
    provider: 'scripted-steer3',
    chat: textReplyToChatFace(async (p: string) => { prompts.push(p); return '{"done":true,"reply":"ok"}'; }),
  };
  let drains = 0;
  const { reactor } = makeReactor(tmp, adapter, () => { drains++; return ['User steer: early']; });

  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  assert.equal(drains, 0, '单步 done 任务无已起步边界，drain 零触发');
  assert.ok(!prompts[0].includes('User steer:'), '穿插行不进终稿前装配面');
});
