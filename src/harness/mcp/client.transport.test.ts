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

// 债 D21 钉子：stdio 传输构造参数必须收到「宿主环境继承 + cfg.env 覆盖优先」的合并 env。
// 截获方式说明：编译产物是 CJS，client.js 对 SDK 命名导入在调用点动态取模块属性，
// 故运行期替换模块导出的构造器即可截获构造参数——不真实 spawn，测试零子进程、零网络。
interface CapturedStdioParams {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

test('McpHost：stdio 构造收到合并 env（宿主变量在场、cfg.env 覆盖优先）；http 构造不受 env 影响', async () => {
  const stdioMod = require('@modelcontextprotocol/sdk/client/stdio.js') as {
    StdioClientTransport: new (p: CapturedStdioParams) => unknown;
  };
  const httpMod = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as {
    StreamableHTTPClientTransport: new (u: URL) => unknown;
  };
  const realStdio = stdioMod.StdioClientTransport;
  const realHttp = httpMod.StreamableHTTPClientTransport;
  let stdioParams: CapturedStdioParams | undefined;
  let httpArg: unknown;
  class CaptureStdio {
    constructor(p: CapturedStdioParams) {
      stdioParams = p;
    }
    async start(): Promise<void> {
      throw new Error('capture-only transport');
    }
    async close(): Promise<void> {}
  }
  class CaptureHttp {
    constructor(u: URL) {
      httpArg = u;
    }
    async start(): Promise<void> {
      throw new Error('capture-only transport');
    }
    async close(): Promise<void> {}
  }
  const HOST_ONLY = 'SUNSHINEX_TEST_ENV_HOST_ONLY';
  const SHARED = 'SUNSHINEX_TEST_ENV_SHARED';
  const SERVER_ONLY = 'SUNSHINEX_TEST_ENV_SERVER_ONLY';
  const prevHost = process.env[HOST_ONLY];
  const prevShared = process.env[SHARED];
  process.env[HOST_ONLY] = 'from-host';
  process.env[SHARED] = 'from-host';
  Object.defineProperty(stdioMod, 'StdioClientTransport', { value: CaptureStdio, configurable: true });
  Object.defineProperty(httpMod, 'StreamableHTTPClientTransport', { value: CaptureHttp, configurable: true });
  try {
    const registry = new ToolRegistry();
    const host = new McpHost(
      [
        { name: 'fs', command: 'node', args: ['x'], env: { [SHARED]: 'from-server', [SERVER_ONLY]: 'sv' } },
        { name: 'far', transport: 'http', url: 'http://127.0.0.1:1/mcp', env: { [SERVER_ONLY]: 'sv' } },
      ],
      registry,
    );
    const r = await host.registerTools();
    assert.equal(r.registered, 0);
    assert.equal(r.warnings.length, 2, '两台均在连接步失败（capture-only 传输），装配流不受截获影响');
    assert.ok(stdioParams, 'stdio 传输构造必须发生');
    assert.equal(stdioParams?.command, 'node');
    assert.equal(stdioParams?.env?.[HOST_ONLY], 'from-host', '宿主环境变量须继承进子进程 env');
    assert.equal(stdioParams?.env?.[SHARED], 'from-server', 'cfg.env 同名键须覆盖宿主变量');
    assert.equal(stdioParams?.env?.[SERVER_ONLY], 'sv', '服务器专属变量须透传');
    assert.ok(httpArg instanceof URL, 'http 分支构造参数仍是 URL 本体，env 不进入远程传输构造');
  } finally {
    Object.defineProperty(stdioMod, 'StdioClientTransport', { value: realStdio, configurable: true, writable: true });
    Object.defineProperty(httpMod, 'StreamableHTTPClientTransport', { value: realHttp, configurable: true, writable: true });
    if (prevHost === undefined) delete process.env[HOST_ONLY];
    else process.env[HOST_ONLY] = prevHost;
    if (prevShared === undefined) delete process.env[SHARED];
    else process.env[SHARED] = prevShared;
  }
});
