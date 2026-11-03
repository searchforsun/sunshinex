import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelSwitcher } from '../model/catalog';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ModelChoice } from '../config/providers';
import { SessionRuntime } from './session';

/** G10-C1b 运行中切换面:model switchTo 透传 + snapshot 回显 + mode 重建(idle)。 */

const CHOICES: ModelChoice[] = [
  { id: 'a/m1', provider: 'openai', model: 'm1', baseUrl: 'http://localhost:9', apiKeyEnv: 'X1' },
  { id: 'a/m2', provider: 'openai', model: 'm2', baseUrl: 'http://localhost:9', apiKeyEnv: 'X2' },
];

class FakeSwitcher extends ModelSwitcher {
  protected buildAdapter(): ModelAdapter {
    return new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
  }
}

function makeSession(): SessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-g10-switch-'));
  const sw = new FakeSwitcher({
    default: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    choices: CHOICES,
  });
  return new SessionRuntime({
    id: 's1',
    root,
    model: sw,
    modelSwitcher: sw,
    nextSeq: (() => {
      let n = 0;
      return () => ++n;
    })(),
    broadcast: () => {},
    mintPid: () => 'p1',
  });
}

test('model 切换:switchTo 透传 + snapshot 回显;unknown id false 不动现状', () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().model, undefined); // 缺省主模型态
  assert.equal(s.setModel('a/m1'), true);
  assert.equal(s.snapshotResponse().model, 'a/m1');
  assert.equal(s.setModel('nope'), false);
  assert.equal(s.snapshotResponse().model, 'a/m1');
  assert.equal(s.setModel(undefined), true); // 回缺省主模型
  assert.equal(s.snapshotResponse().model, undefined);
});

test('mode 切换:idle 下四值循环回显;snapshot.mode 随之(缺省 full-access=原 dontAsk 地位)', async () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().mode, 'full-access');
  assert.equal(await s.setMode('read-only'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'read-only');
  assert.equal(await s.setMode('acceptEdits'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'acceptEdits');
  assert.equal(await s.setMode('plan'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'plan');
  assert.equal(await s.setMode('plan'), 'ok'); // 幂等
  assert.equal(s.snapshotResponse().mode, 'plan');
});

test('tier/effort 覆盖:合法值回显、default 清除、非法值 false 不动', () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().tier, undefined);
  assert.equal(s.setTier('large'), true);
  assert.equal(s.snapshotResponse().tier, 'large');
  assert.equal(s.setTier('huge'), false);
  assert.equal(s.snapshotResponse().tier, 'large');
  s.clearTier();
  assert.equal(s.snapshotResponse().tier, undefined);
  assert.equal(s.setEffort('high'), true);
  assert.equal(s.snapshotResponse().effort, 'high');
  assert.equal(s.setEffort('nope'), false);
  s.clearEffort();
  assert.equal(s.snapshotResponse().effort, undefined);
});

test('2026-11-03 轻量切档:运行中切真档不再 busy——guard 活改即时生效,后续工具按新档判决', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-lightswitch-'));
  // 门控适配器:r1=write(full-access 放行) → r2=write(等待门放行,此时已切 read-only→拒) → r3=done
  let round = 0;
  let release2: () => void = () => undefined;
  const gate2 = new Promise<void>((r) => { release2 = r; });
  const writeCall = (): { finish: 'tool_calls'; content: string; toolCalls: Array<{ id: string; name: string; argsJson: string }> } => ({
    finish: 'tool_calls',
    content: '',
    toolCalls: [{ id: `call_${round}`, name: 'write', argsJson: JSON.stringify({ path: 'mid-run.txt', content: 'x' }) }],
  });
  const model: ModelAdapter = {
    provider: 'gated',
    async chat() {
      round += 1;
      if (round === 1) return writeCall();
      if (round === 2) { await gate2; return writeCall(); }
      return { finish: 'stop', content: '收尾', toolCalls: [] };
    },
  } as unknown as ModelAdapter;
  const s = new SessionRuntime({
    id: 's1',
    root,
    model,
    nextSeq: (() => { let n = 0; return () => ++n; })(),
    broadcast: () => {},
    mintPid: () => 'p1',
  });
  const chainText = (): string => JSON.stringify(s.runtime.harness.context.chainView());
  try {
    assert.deepEqual(s.submit('写个文件'), { ok: true });
    // r1 write 执行完(全档放行,结果行入链)即切 read-only——确定性时序:先等结果行再切
    const deadline = Date.now() + 8000;
    while (!chainText().includes('mid-run.txt')) {
      if (Date.now() > deadline) throw new Error('waitFor 超时:r1 write 结果行');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(await s.setMode('read-only'), 'ok', '运行中切真档受理(轻量直切,不再 busy)');
    assert.equal(s.runtime.harness.security.mode, 'read-only', 'guard 活改即时生效');
    release2(); // 放行 r2:同一 run 的下一个 write 按新档拒绝
    const deadline2 = Date.now() + 8000;
    while (!chainText().includes('COMMAND_DENIED')) {
      if (Date.now() > deadline2) throw new Error('waitFor 超时:r2 拒绝行');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(s.snapshotResponse().mode, 'read-only');
    // 空闲恢复后切回 full-access
    const deadline3 = Date.now() + 8000;
    while (s.status() !== 'idle') {
      if (Date.now() > deadline3) throw new Error('waitFor 超时:run 收束');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(await s.setMode('full-access'), 'ok');
    assert.equal(s.runtime.harness.security.mode, 'full-access');
  } finally {
    await s.teardown().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
