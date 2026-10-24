import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, CodedToolError } from './tools';
import { builtinTools } from './tools/builtin';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';

/** O6 工具误用观测（Anthropic ACI「test how the model uses your tools」）：执行面结果分桶计数——
 *  ok / CodedToolError 码（INVALID_ARG=模型传参误用主信号）/ COMMAND_DENIED / TOOL_NOT_FOUND /
 *  EXEC_FAILED 五路各钉一例（换回无计数实现 usageStats 恒零即红）。计数是纯新增观测面，
 *  既有 Result 契约零改动。stub 带 root 内合法 path 过链——read 类空 path 链层即拒，到不了 executor。 */

function registryWith(): { registry: ToolRegistry; safety: SafetyChain; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-regusage-'));
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed', 'utf8');
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  const stub = (name: string, executor: () => Promise<{ stdout: string; exitCode: number; stderr: string; timedOut: boolean }>) =>
    registry.register({
      name,
      parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
      description: `test stub (${name})`,
      category: 'read',
      executor,
    });
  stub('fake_invalid', async () => {
    throw new CodedToolError('INVALID_ARG', 'bad input shape (misuse signal)');
  });
  stub('fake_crash', async () => {
    throw new Error('boom');
  });
  stub('fake_ok', async () => ({ stdout: 'done', exitCode: 0, stderr: '', timedOut: false }));
  return { registry, safety, root };
}

test('usageStats：ok/INVALID_ARG/EXEC_FAILED/COMMAND_DENIED/TOOL_NOT_FOUND 五路分桶', async () => {
  const { registry, safety, root } = registryWith();
  const seedInput = { path: path.join(root, 'seed.txt') };
  const invalid = await registry.execute('fake_invalid', seedInput, safety);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_ARG');
  const crash = await registry.execute('fake_crash', seedInput, safety);
  assert.equal(crash.ok, false);
  if (!crash.ok) assert.equal(crash.error.code, 'EXEC_FAILED');
  // denied:webfetch 非法 scheme 走 guard 协议底线（webfetch.test 同款拒绝路径）
  const denied = await registry.execute('webfetch', { url: 'ftp://example.com/x' }, safety);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'COMMAND_DENIED');
  const missing = await registry.execute('nonexistent_tool', {}, safety);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'TOOL_NOT_FOUND');
  assert.equal(registry.usageStats().calls, 4);
  assert.deepEqual(registry.usageStats().byOutcome, {
    INVALID_ARG: 1,
    EXEC_FAILED: 1,
    COMMAND_DENIED: 1,
    TOOL_NOT_FOUND: 1,
  });
});

test('usageStats：ok 桶计数 + derive 子面独立（不聚合进父面,注记口径）', async () => {
  const { registry, safety, root } = registryWith();
  const child = registry.derive();
  const ok = await child.execute('fake_ok', { path: path.join(root, 'seed.txt') }, safety);
  assert.ok(ok.ok);
  assert.deepEqual(child.usageStats(), { calls: 1, byOutcome: { ok: 1 } });
  assert.equal(registry.usageStats().calls, 0, 'derive 子面独立计数,父面零计入');
});
