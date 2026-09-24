import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoopEngine, LoopDeps } from '../loop/engine';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { ToolRegistry } from './tools';
import { StubAdapter } from '../model/adapter';
import { Harness } from './index';
import type { LoopContext, LoopNodeBase, NodeOutput } from '../types';

/** 项目级 mcp.json 指向 mock stdio server（scripts/mock-mcp-server.js，与 client.register.test.ts 同源夹具） */
function writeProjectMcpJson(root: string, servers: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
}

test('Harness MCP 装配接线：两级配置 → mcpReady 注册 mcp__ 工具 → guard 放行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
  writeProjectMcpJson(root, { fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] } });
  const h = new Harness({ root, mode: 'dontAsk' });
  try {
    await h.mcpReady();
    assert.ok(h.tools.get('mcp__fs__echo'), 'mcp__fs__echo 应注册进主链注册表');
    const d = h.security.preToolUse('mcp__fs__echo', {});
    assert.equal(d.allowed, true, 'guard 应按配置名单放行已登记 server 的工具');
  } finally {
    await h.mcpClose();
  }
});

test('Harness MCP 降级语义：坏服务器 mcpReady 不拒绝，警告单可读、好服务器照常', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
  writeProjectMcpJson(root, {
    bad: { url: 'http://127.0.0.1:1/mcp', transport: 'http' },
    fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] },
  });
  const h = new Harness({ root, mode: 'dontAsk' });
  try {
    await h.mcpReady(); // 降级语义：不拒绝
    assert.ok(h.tools.get('mcp__fs__echo'), '坏服务器不影响好服务器注册');
    const warns = h.mcpWarnings();
    assert.equal(warns.length, 1);
    assert.match(warns[0], /connection failed \(bad\)/);
  } finally {
    await h.mcpClose();
  }
});

test('Harness MCP 收口幂等：未连接时 close 为 no-op，连接后 close 后可重连', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
  const h = new Harness({ root, mode: 'dontAsk' });
  await h.mcpReady(); // 空配置零开销直通
  await h.mcpClose();
  await h.mcpClose(); // 幂等
  assert.equal(h.tools.list().filter((t: { name: string }) => t.name.startsWith('mcp__')).length, 0);
});

test('Harness MCP 闸门：未登记 server 的 mcp__ 工具被 guard 拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
  writeProjectMcpJson(root, { fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] } });
  const h = new Harness({ root, mode: 'dontAsk' });
  const d = h.security.preToolUse('mcp__other__tool', {});
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /not registered/);
});

/** 引擎级就绪门槛用例夹具：最小 LoopDeps */
function engineDeps(root: string, extra: Partial<LoopDeps>): { deps: LoopDeps } {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  const registry = new ToolRegistry();
  return {
    deps: {
      safety,
      registry,
      context: new ContextManager(root, new FileStore(root)),
      model: new StubAdapter(),
      ...extra,
    },
  };
}

test('LoopEngine mcpReady 拒绝 → 确定性 failed（MCP_ASSEMBLY_FAILED），不进首节点', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
  const seen: string[] = [];
  const node = { id: 'n1', kind: 'check', run: () => { seen.push('node'); return { status: 'done' as const, reply: 'ok' }; } } as never;
  const { deps } = engineDeps(root, {
    mcpReady: () => Promise.reject(new Error('MCP server connection failed (fs): spawn boom')),
  });
  const engine = new LoopEngine([node], deps, { maxIterations: 4, maxTokens: 10_000, timeoutMs: 60_000 });
  const r = await engine.run('g');
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /MCP_ASSEMBLY_FAILED/);
  assert.deepEqual(seen, [], '注册链失败时首节点不应执行');
});

test('LoopEngine mcpReady 先于首节点执行（就绪门槛语义）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
  const order: string[] = [];
  const { deps } = engineDeps(root, { mcpReady: async () => void order.push('ready') });
  const node = { id: 'n1', kind: 'check', run: () => { order.push('node'); return { status: 'done' as const, reply: 'ok' }; } } as never;
  const engine = new LoopEngine([node], deps, { maxIterations: 4, maxTokens: 10_000, timeoutMs: 60_000 });
  const r = await engine.run('g');
  assert.equal(r.status, 'done');
  assert.deepEqual(order, ['ready', 'node']);
});
