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

function makeReactor(tmp: string, adapter: ModelAdapter): Reactor {
  const store = new FileStore(path.join(tmp, '.data'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter });
}

function scripted(replies: string[]): ModelAdapter {
  let call = 0;
  return { provider: 'scripted', complete: async () => replies[Math.min(call++, replies.length - 1)] };
}

test('路由观测：复杂度信号入参，RouteDecision 随 run 结果返回', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-route1-'));
  try {
    const reactor = makeReactor(tmp, scripted([DONE_REPLY]));
    const r = await reactor.run({ goal: '小任务' }, { maxSteps: 2 });
    assert.equal(r.done, true);
    assert.ok(r.route, 'RunResult 应携带路由决策');
    assert.equal(r.route?.tier, 'small', '小任务低复杂度应路由 small');
    assert.ok(r.route?.reason.includes('complexity:low'), `reason 应留痕复杂度来源，实际：${r.route?.reason}`);
    assert.equal(r.route?.adapterProvider, 'scripted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('路由观测：外部 role hint 优先于每步复杂度信号', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-route2-'));
  try {
    const reactor = makeReactor(tmp, scripted([DONE_REPLY]));
    const r = await reactor.run({ goal: '小任务但角色是评审' }, { maxSteps: 2, routeHint: { role: 'critic' } });
    assert.equal(r.done, true);
    assert.equal(r.route?.tier, 'large', 'critic 角色应路由 large');
    assert.ok(r.route?.reason.includes('role:critic'), `reason 应留痕角色来源，实际：${r.route?.reason}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('路由观测：模型一次性偏好覆盖下一轮路由，RunResult 记录实际生效的最后一次决策', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-route3-'));
  try {
    const reactor = makeReactor(tmp, scripted([
      '{"tool":"read","input":{"path":"a.txt"},"tier":"large","done":false}',
      '{"done":true,"reply":"ok"}',
    ]));
    const r = await reactor.run({ goal: '偏好覆盖' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    assert.equal(r.route?.tier, 'large', '最终决策应为模型偏好的 large');
    assert.equal(r.route?.reason, 'model:preference');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
