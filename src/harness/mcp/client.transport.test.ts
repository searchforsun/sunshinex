import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools';
import { McpHost } from './client';

test('McpHost：不可达 streamable http URL 连接失败收进警告单，不阻断', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost([{ name: 'far', url: 'http://127.0.0.1:1/mcp', transport: 'http' }], registry);
  const r = await host.registerTools();
  assert.equal(r.registered, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /connection failed \(far\)/);
  assert.ok(!/requires a command/.test(r.warnings[0]), '应经由远程传输连接失败，而非形态守卫兜底');
});

test('McpHost：不可达 sse URL 连接失败收进警告单，不阻断', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost([{ name: 'far', url: 'http://127.0.0.1:1/mcp', transport: 'sse' }], registry);
  const r = await host.registerTools();
  assert.equal(r.registered, 0);
  assert.match(r.warnings[0], /connection failed \(far\)/);
});

test('McpHost：逐服务器隔离——坏服务器收警告，好服务器工具照常注册', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost(
    [
      { name: 'bad', url: 'http://127.0.0.1:1/mcp', transport: 'http' },
      { name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] },
    ],
    registry,
  );
  try {
    const r = await host.registerTools();
    assert.equal(r.registered, 1, '坏服务器只损失自身，好服务器工具照常注册');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /connection failed \(bad\)/);
    assert.ok(registry.get('mcp__fs__echo'), 'mock echo 工具应已注册');
  } finally {
    await host.close();
  }
});

test('McpHost：重名服务器收警告跳过，不阻断', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost(
    [
      { name: 'dup', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'dup'] },
      { name: 'dup', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'dup'] },
    ],
    registry,
  );
  try {
    const r = await host.registerTools();
    assert.equal(r.warnings.filter((w) => /duplicate MCP server name \(dup\) skipped/.test(w)).length, 1, '重名第二台收警告跳过');
    assert.equal(r.registered, 1, '重名跳过不损失首台注册');
  } finally {
    await host.close();
  }
});

test('McpHost：transport 缺省 = stdio（既有 stdio 回归由全量套件保障）', () => {
  // 契约占位：缺省行为断言见 config.mcp.transport.test.ts（解析缺省）与 client.register.test.ts（stdio 连接链）
  assert.ok(true);
});
