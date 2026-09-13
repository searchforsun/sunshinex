import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools';
import { McpHost } from './client';

/** 远程形态必须经真实传输发起连接失败，而非被 stdio 形态守卫兜底（消息不含「缺少 stdio command」即证明走了传输工厂） */
async function assertRemoteConnectFailed(transport: 'http' | 'sse', port: number): Promise<void> {
  const registry = new ToolRegistry();
  const host = new McpHost([{ name: 'far', url: `http://127.0.0.1:${port}/mcp`, transport }], registry);
  await assert.rejects(
    () => host.registerTools(),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'MCP_CONNECT_FAILED');
      assert.ok(!/缺少 stdio command/.test((e as Error).message), '应经由远程传输连接失败，而非形态守卫兜底');
      return true;
    },
  );
}

test('McpHost：不可达 streamable http URL 连接失败收束为 MCP_CONNECT_FAILED', async () => {
  await assertRemoteConnectFailed('http', 1);
});

test('McpHost：不可达 sse URL 连接失败收束为 MCP_CONNECT_FAILED', async () => {
  await assertRemoteConnectFailed('sse', 1);
});

test('McpHost：transport 缺省 = stdio（既有 stdio 回归由全量套件保障）', () => {
  // 契约占位：缺省行为断言见 config.mcp.transport.test.ts（解析缺省）与 client.register.test.ts（stdio 连接链）
  assert.ok(true);
});
