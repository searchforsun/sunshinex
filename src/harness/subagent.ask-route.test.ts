import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, SubagentRunner } from './subagent';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import type { AskUserRequest } from '../types';

/** 子智能体 ask 路由(2026-11-14 用户裁定「子智能体支持 ask_question,路由到主对话」):
 *  deps.ask 在座 → fork 子面 ask_question 在册且归因透传;缺省 → 维持剔除旧制 */

function makeRunner(ask?: (req: AskUserRequest) => Promise<{ type: 'dismissed' }>): { runner: SubagentRunner; registry: ToolRegistry } {
  const tmp = '.';
  const context = { appendChain: () => undefined, chainView: () => [] } as never;
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const reg = new AgentRegistry();
  reg.registerBuiltins();
  const runner = new SubagentRunner({ registry, safety, context, model: {} as never, ask }, reg);
  return { runner, registry };
}

describe('子智能体 ask 路由(subagent.ask-route)', () => {
  test('deps.ask 在座:派生子面注册 ask_question,归因 askedBy 随请求透传父接缝', async () => {
    const seen: AskUserRequest[] = [];
    const parent = async (req: AskUserRequest): Promise<{ type: 'dismissed' }> => {
      seen.push(req);
      throw new Error('stop-here');
    };
    const { runner } = makeRunner(parent);
    const child = runner.deriveChildRegistry(undefined, { label: 'Tester#2', taskId: 'task-1' });
    const ask = child.get('ask_question');
    assert.ok(ask, '路由版 ask_question 应在册');
    await assert.rejects(
      ask.executor({ question: '选哪个?', options: [{ label: 'A' }, { label: 'B' }] }),
      /stop-here/,
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].askedBy, { label: 'Tester#2', taskId: 'task-1' });
    assert.deepEqual(seen[0].options.map((o) => o.label), ['A', 'B']);
  });

  test('deps.ask 缺省(headless 装配):派生子面无 ask_question=剔除旧制', () => {
    const { runner } = makeRunner(undefined);
    const child = runner.deriveChildRegistry(undefined, { label: 'Tester' });
    assert.equal(child.get('ask_question'), undefined);
  });

  test('deps.ask 在座但未传归因(主链直问面):派生子面同样剔除', () => {
    const { runner } = makeRunner(async () => ({ type: 'dismissed' }));
    const child = runner.deriveChildRegistry(undefined);
    assert.equal(child.get('ask_question'), undefined);
  });
});
