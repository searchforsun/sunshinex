import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { McpHost } from './client';

/** 握手身份校验 fixture：配置名与 mock serverInfo.name 分离注入 */
function makeFixture(configName: string, mockName: string): { registry: ToolRegistry; host: McpHost } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-call-'));
  const registry = new ToolRegistry();
  const host = new McpHost(
    [{ name: configName, command: 'node', args: ['scripts/mock-mcp-server.js', '--name', mockName] }],
    registry,
  );
  return { registry, host };
}

test('MCP 握手身份校验：配置名与 serverInfo.name 不符收警告拒绝注册（防冒名绕过登记制）', async () => {
  const { registry, host } = makeFixture('fs', 'other');
  try {
    const r = await host.registerTools();
    assert.equal(r.registered, 0, '身份不符不得留下任何工具');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /handshake identity mismatch \(fs\)/);
    assert.equal(registry.has('mcp__fs__echo'), false, '拒绝注册时不得留下任何工具');
  } finally {
    await host.close();
  }
});

test('MCP 身份对齐：配置名与 serverInfo.name 一致时注册成功', async () => {
  const { registry, host } = makeFixture('fs', 'fs');
  try {
    const r = await host.registerTools();
    assert.equal(r.registered, 1);
    assert.equal(r.warnings.length, 0);
    assert.ok(registry.has('mcp__fs__echo'));
  } finally {
    await host.close();
  }
});

