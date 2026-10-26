import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools';
import { McpHost } from './client';

/** 握手身份校验 fixture：配置名与 mock serverInfo.name 分离注入 */
function makeFixture(configName: string, mockName: string): { registry: ToolRegistry; host: McpHost } {
  const registry = new ToolRegistry();
  const host = new McpHost(
    [{ name: configName, command: 'node', args: ['scripts/mock-mcp-server.js', '--name', mockName] }],
    registry,
  );
  return { registry, host };
}

test('MCP 握手身份不符降级软提示（2026-10-26 用户实测主流服务器常态）：照常注册 + identity note 警告', async () => {
  const { registry, host } = makeFixture('fs', 'other');
  try {
    const r = await host.registerTools();
    assert.equal(r.registered, 1, '身份不符不再硬拒——lark-project-mcp 等主流服务器照常注册');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /identity note \(fs\): serverInfo\.name=other \(accepted\)/);
    assert.ok(registry.has('mcp__fs__echo'), '软提示路径工具照常登记');
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

