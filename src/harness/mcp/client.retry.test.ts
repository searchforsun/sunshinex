import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry, CodedToolError } from '../tools';
import { McpHost } from './client';

/** 断链重试链判别力钉（2026-11-01 用户裁定「运行中调用异常应触发重试,2 次后如实回报」）。
 *  现场用 scripts/mock-mcp-server.js 的 --die-once-file/--die-on-call all/--fail-call 模式造真实现场：
 *  server 进程中途死亡（pending 请求收传输层连接类错误，重连后见哨兵即恢复健康）/ 恒死 / 业务 isError 结果。 */

/** 跨重启恰死一次的哨兵文件（重连=全新进程，进程内计数对每次重连都归零，须文件哨兵承载「只死一次」） */
function dieOnceMarker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-retry-'));
  return path.join(dir, 'died-marker');
}

function echoExecutor(registry: ToolRegistry, name = 'mcp__fs__echo'): (input: unknown) => Promise<unknown> {
  const tool = registry.get(name);
  assert.ok(tool, `echo 工具应已注册: ${name}`);
  return (input: unknown) => tool!.executor(input as never);
}

test('断链重连成功：server 中途死亡一次，重连后重试返回真实结果', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost(
    [{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs', '--die-once-file', dieOnceMarker()] }],
    registry,
  );
  try {
    await host.registerTools();
    const out = (await echoExecutor(registry)({ text: 'hi' })) as { stdout: string };
    assert.equal(out.stdout, 'echo: hi', '首调断链→重连→重试应拿到新 server 的真实回执');
  } finally {
    await host.close();
  }
});

test('断链穷尽：server 恒死，2 次重连后如实报 MCP_CONNECT_FAILED', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost(
    [{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs', '--die-on-call', 'all'] }],
    registry,
  );
  try {
    await host.registerTools();
    await assert.rejects(
      () => echoExecutor(registry)({ text: 'x' }),
      (e: unknown) => {
        assert.ok(e instanceof CodedToolError, `应抛 CodedToolError，实为 ${String(e)}`);
        assert.equal(e.code, 'MCP_CONNECT_FAILED');
        assert.match(e.message, /after 2 reconnect attempts/, '穷尽文案应如实报重连次数');
        return true;
      },
    );
  } finally {
    await host.close();
  }
});

test('错误分类学：重连后的超时保持 MCP_TIMEOUT 原样上抛，不误标 server unreachable', async () => {
  const registry = new ToolRegistry();
  // 首调 server 即死（快），重连后的新 server 带慢响应——重试链上的第二次失败是超时非断链
  const host = new McpHost(
    [{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs', '--die-once-file', dieOnceMarker(), '--delay', '400'] }],
    registry,
    { callTimeoutMs: 120 },
  );
  try {
    await host.registerTools();
    await assert.rejects(
      () => echoExecutor(registry)({ text: 'x' }),
      (e: unknown) => {
        assert.ok(e instanceof CodedToolError, `应抛 CodedToolError，实为 ${String(e)}`);
        assert.equal(e.code, 'MCP_TIMEOUT', `超时须保持原码——误标 CONNECT_FAILED 即错误分类学被重试状态污染（旧实现必红）`);
        return true;
      },
    );
  } finally {
    await host.close();
  }
});

test('业务错误不重试：isError 结果即时抛 MCP_TOOL_ERROR，零重连', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost(
    [{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs', '--fail-call'] }],
    registry,
  );
  try {
    await host.registerTools();
    await assert.rejects(
      () => echoExecutor(registry)({ text: 'x' }),
      (e: unknown) => {
        assert.ok(e instanceof CodedToolError);
        assert.equal(e.code, 'MCP_TOOL_ERROR');
        assert.equal(e.message, 'boom', '业务失败文案如实透传（若被当断链重试穷尽即变 CONNECT_FAILED 文案，必红）');
        return true;
      },
    );
  } finally {
    await host.close();
  }
});
