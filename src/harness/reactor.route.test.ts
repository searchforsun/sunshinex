import { textReplyToChatFace } from '../model/chat-stub';
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
  return { provider: 'scripted', chat: textReplyToChatFace(async () => replies[Math.min(call++, replies.length - 1)] )};
}

test('路由观测：无 hint 缺省 medium（run 级常量），RouteDecision 随 run 结果返回', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-route1-'));
  try {
    const reactor = makeReactor(tmp, scripted([DONE_REPLY]));
    const r = await reactor.run({ goal: '小任务' }, { maxSteps: 2 });
    assert.equal(r.done, true);
    assert.ok(r.route, 'RunResult 应携带路由决策');
    assert.equal(r.route?.tier, 'medium', '无外部 hint 缺省 medium（系统不按占比自动换档）');
    assert.match(r.route?.reason ?? '', /default:medium/, 'reason 留痕缺省来源');
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

test('路由观测：模型回复携带 tier 字段被忽略（自调通道已摘除），缺省档整场恒定', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-route3-'));
  try {
    const reactor = makeReactor(tmp, scripted([
      '{"tool":"read","input":{"path":"a.txt"},"tier":"large","done":false}',
      '{"done":true,"reply":"ok"}',
    ]));
    const r = await reactor.run({ goal: '偏好被忽略' }, { maxSteps: 3 });
    assert.equal(r.done, true);
    assert.equal(r.route?.tier, 'medium', 'reply.tier 不得改变路由：档位只由用户级参数决定');
    assert.match(r.route?.reason ?? '', /default:medium/, '留痕缺省来源');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
