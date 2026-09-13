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

interface FixtureOpts {
  configName: string;
  guardServers: string[];
  mockArgs?: string[];
  callTimeoutMs?: number;
}

function makeFixture(opts: FixtureOpts): { registry: ToolRegistry; safety: SafetyChain; host: McpHost } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-gates-'));
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk', opts.guardServers),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  // mock 身份与配置名对齐（--name）：McpHost 握手校验配置名=serverInfo.name，各用例聚焦目标闸门而非身份不匹配
  const host = new McpHost(
    [{ name: opts.configName, command: 'node', args: ['scripts/mock-mcp-server.js', '--name', opts.configName, ...(opts.mockArgs ?? [])] }],
    registry,
    { callTimeoutMs: opts.callTimeoutMs },
  );
  return { registry, safety, host };
}

test('全链路 mask：echo 回显含凭据文本经安全链出口脱敏', async () => {
  const { registry, safety, host } = makeFixture({ configName: 'fs', guardServers: ['fs'] });
  try {
    await host.registerTools();
    const r = await registry.execute('mcp__fs__echo', { text: 'token sk-abcdef0123456789abcdefgh' }, safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout, 'echo: token ***');
  } finally {
    await host.close();
  }
});

test('白名单闸门：未登记服务器的工具被 guard 拒绝（COMMAND_DENIED）', async () => {
  const { registry, safety, host } = makeFixture({ configName: 'other', guardServers: ['fs'], mockArgs: ['--name', 'other'] });
  try {
    assert.equal(await host.registerTools(), 1, '注册链成功（闸门在 guard 不在注册期）');
    const r = await registry.execute('mcp__other__echo', { text: 'hi' }, safety);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, 'COMMAND_DENIED');
  } finally {
    await host.close();
  }
});

test('超时闸门：慢 server 超过 callTimeoutMs 收束为 MCP_TIMEOUT', async () => {
  const { registry, safety, host } = makeFixture({
    configName: 'fs',
    guardServers: ['fs'],
    mockArgs: ['--delay', '500'],
    callTimeoutMs: 100,
  });
  try {
    await host.registerTools();
    const r = await registry.execute('mcp__fs__echo', { text: 'hi' }, safety);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, 'MCP_TIMEOUT');
  } finally {
    await host.close();
  }
});

test('体积闸门：参数超 64KB 拒绝（MCP_ARGS_TOO_LARGE），不发起调用', async () => {
  const { registry, safety, host } = makeFixture({ configName: 'fs', guardServers: ['fs'] });
  try {
    await host.registerTools();
    const r = await registry.execute('mcp__fs__echo', { text: 'x'.repeat(70_000) }, safety);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, 'MCP_ARGS_TOO_LARGE');
  } finally {
    await host.close();
  }
});
