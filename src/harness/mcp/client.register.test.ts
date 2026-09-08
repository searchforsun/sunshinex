import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';
import { McpHost } from './client';

function makeFixture(serverNames: string[]): { registry: ToolRegistry; safety: SafetyChain; host: McpHost } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-'));
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk', [], serverNames),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  const host = new McpHost([{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] }], registry);
  return { registry, safety, host };
}

test('McpHost 注册链：handshake → tools/list → 规范名注册（mcp__fs__echo，category external）', async () => {
  const { registry, host } = makeFixture(['fs']);
  try {
    const n = await host.registerTools();
    assert.equal(n, 1);
    const spec = registry.get('mcp__fs__echo');
    assert.ok(spec, '规范名 mcp__fs__echo 应已注册');
    assert.equal(spec.category, 'external');
  } finally {
    await host.close();
  }
});

test('McpHost：经 registry.execute 走安全链调用 mock echo，结果过 mask 出口', async () => {
  const { registry, safety, host } = makeFixture(['fs']);
  try {
    await host.registerTools();
    const r = await registry.execute('mcp__fs__echo', { text: 'hi' }, safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout, 'echo: hi');
  } finally {
    await host.close();
  }
});
