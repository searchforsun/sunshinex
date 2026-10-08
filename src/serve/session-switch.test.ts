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
    explicitDefault: true,
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

test('mode 切换:idle 下三态循环回显;snapshot.mode 随之', () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().mode, 'dontAsk');
  assert.equal(s.setMode('manual'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'manual');
  assert.equal(s.setMode('plan'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'plan');
  assert.equal(s.setMode('plan'), 'ok'); // 幂等
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
