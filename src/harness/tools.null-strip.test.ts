import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, stripNullInputArgs } from './tools';
import type { RegisteredTool } from './tools';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { SafetyChain } from './security/chain';
import { DryRun } from './security/dryrun';
import type { ToolInput } from '../types';

/**
 * 执行边界 null 键剥离钉（2026-10-03 真机「INVALID_ARG: Unknown isolation: null」五连拒）：
 * 仓内工具 schema 约定「可选项以 null 联合进 required」——严格守约端点对缺省可选项必发字面 JSON null，
 * null 是缺席标记非值；registry.execute 单点剥键后安全链与 executor 均按键缺席语义走。
 */

test('stripNullInputArgs：null 值键剥除、无 null 原对象直返（零克隆）、非 null 值原样保留', () => {
  assert.deepEqual(stripNullInputArgs({ a: null, b: 1, c: 'x', d: null }), { b: 1, c: 'x' });
  const keep = { b: 1 };
  assert.equal(stripNullInputArgs(keep), keep, '无 null 键原对象引用直返');
  assert.deepEqual(stripNullInputArgs({}), {});
});

test('registry.execute 剥离单点：null 键不落安全链与 executor（executor 视角键缺席）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tools-nullstrip-'));
  try {
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), tmp);
    const registry = new ToolRegistry();
    let seen: ToolInput | undefined;
    const probe: RegisteredTool = {
      name: 'probe',
      description: 'probe',
      category: 'read',
      executor: async (input) => {
        seen = input;
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    };
    registry.register(probe);
    const r = await registry.execute('probe', { path: 'a', offset: null, tag: null } as unknown as ToolInput, safety);
    assert.equal(r.ok, true, `probe 应放行执行：${JSON.stringify(r)}`);
    assert.deepEqual(seen, { path: 'a' }, 'null 键剥为缺席（安全链与 executor 同一归一视角）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
