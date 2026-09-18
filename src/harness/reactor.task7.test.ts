import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reactor } from './reactor';
import { ContextManager } from './context';
import { ToolRegistry } from './tools';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { FileStore } from '../storage/adapter';
import type { ModelAdapter } from '../model/adapter';
// 测试卫生：本文件压缩断言按 est 精算标定，数据目录钉文件私有目录——共享数据目录被并发写入学习技能时，技能清单进装配产物会破坏精算基线
process.env.SUNSHINEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t7-data-'));
process.env.SUNSHINEX_USER_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t7-uskills-'));

/** Task 7（规格 F 项）：反应式压缩兜底——端点超长错误 → 压缩 + 重试一次 */

function fixture(): { tmp: string; cm: ContextManager; registry: ToolRegistry; safety: SafetyChain } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshine-t7-'));
  const cm = new ContextManager(tmp, new FileStore(tmp));
  const registry = new ToolRegistry();
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  return { tmp, cm, registry, safety };
}

test('Task7 溢出一次 → 压缩后重试成功，run done', async () => {
  const { tmp, cm, registry, safety } = fixture();
  try {
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: 'openai',
      complete: async () => {
        calls++;
        if (calls === 1) throw new Error('maximum context length exceeded: prompt 900000 tokens');
        return JSON.stringify({ done: true, reply: 'ok' });
      },
    };
    const reactor = new Reactor({ registry, safety, context: cm, model: adapter });
    const r = await reactor.run({ goal: 'probe' });
    assert.equal(r.stopReason, 'done', '重试后应正常完成');
    assert.ok(cm.compactionCount() >= 1, '应发生过一次压缩');
    assert.equal(calls, 2, '恰重试一次');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task7 连续两次溢出 → model-error（重试至多一次）', async () => {
  const { tmp, cm, registry, safety } = fixture();
  try {
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: 'openai',
      complete: async () => {
        calls++;
        throw new Error('prompt too long: 900000 tokens > 800000 maximum');
      },
    };
    const reactor = new Reactor({ registry, safety, context: cm, model: adapter });
    const r = await reactor.run({ goal: 'probe' });
    assert.equal(r.stopReason, 'model-error');
    assert.equal(calls, 2, '第二次溢出不再重试');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task7 非溢出错误（401）→ 不触发压缩直接 model-error', async () => {
  const { tmp, cm, registry, safety } = fixture();
  try {
    const adapter: ModelAdapter = {
      provider: 'openai',
      complete: async () => {
        throw new Error('401 Unauthorized: invalid api key');
      },
    };
    const reactor = new Reactor({ registry, safety, context: cm, model: adapter });
    const r = await reactor.run({ goal: 'probe' });
    assert.equal(r.stopReason, 'model-error');
    assert.equal(cm.compactionCount(), 0, '非溢出错误不触发压缩');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
