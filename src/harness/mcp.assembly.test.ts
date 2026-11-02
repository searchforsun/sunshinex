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
import { ToolRegistry } from './tools';
import { StubAdapter } from '../model/adapter';
import { Harness } from './index';
import { approveMcpServer } from '../catalog/approvals';

/** 项目级 mcp.json 指向 mock stdio server（scripts/mock-mcp-server.js，与 client.register.test.ts 同源夹具） */
function writeProjectMcpJson(root: string, servers: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
}

/** HOME 钉桩（async）：2026-10-28 批准阀接线后，项目条目装配经 approvalState 读 $HOME/.sunshinex/settings.json——
 *  不钉则触真实用户家（真档畸形会让构造链抛错）；用毕还原。批准记录经 approveMcpServer 落桩内家目录。 */
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

test('Harness MCP 装配接线：两级配置 → mcpReady 注册 mcp__ 工具 → guard 放行', async () => {
  await withHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
    writeProjectMcpJson(root, { fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] } });
    approveMcpServer(root, 'fs'); // 2026-10-28 批准阀：项目条目 approved 才拉起进程
    const h = new Harness({ root, mode: 'full-access' });
    try {
      await h.mcpReady();
      assert.ok(h.tools.get('mcp__fs__echo'), 'mcp__fs__echo 应注册进主链注册表');
      const d = h.security.preToolUse('mcp__fs__echo', {});
      assert.equal(d.allowed, true, 'guard 应按配置名单放行已登记 server 的工具');
    } finally {
      await h.mcpClose();
    }
  });
});

test('Harness MCP 降级语义：坏服务器 mcpReady 不拒绝，警告单可读、好服务器照常', async () => {
  await withHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
    writeProjectMcpJson(root, {
      bad: { url: 'http://127.0.0.1:1/mcp', transport: 'http' },
      fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] },
    });
    approveMcpServer(root, 'bad'); // 坏服务器也要批准才进装配面（否则批准阀先拦，测不到连接降级）
    approveMcpServer(root, 'fs');
    const h = new Harness({ root, mode: 'full-access' });
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
});

test('Harness MCP 收口幂等：未连接时 close 为 no-op，连接后 close 后可重连', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
  const h = new Harness({ root, mode: 'full-access' });
  await h.mcpReady(); // 空配置零开销直通
  await h.mcpClose();
  await h.mcpClose(); // 幂等
  assert.equal(h.tools.list().filter((t: { name: string }) => t.name.startsWith('mcp__')).length, 0);
});

test('Harness MCP 闸门：未登记 server 的 mcp__ 工具被 guard 拒绝', async () => {
  // HOME 钉桩：构造链经批准阀读全局 settings（本项目条目未批准不装配，闸门断言不受影响）
  await withHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
    writeProjectMcpJson(root, { fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] } });
    const h = new Harness({ root, mode: 'full-access' });
    const d = h.security.preToolUse('mcp__other__tool', {});
    assert.equal(d.allowed, false);
    assert.match(d.reason ?? '', /not registered/);
  });
});

/** 引擎级就绪门槛用例夹具：最小 LoopDeps */
function engineDeps(root: string, extra: Partial<LoopDeps>): { deps: LoopDeps } {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
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

test('警告单链面一次化（D59）：持续失败同文案只报一次；恢复出单摘录后同文案重报（换回全量实现必红）', async () => {
  await withHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-warnonce-'));
    const bad = { dead: { command: 'sunshinex-missing-cmd-for-warnonce-pin' } };
    writeProjectMcpJson(root, bad);
    approveMcpServer(root, 'dead');
    const h = new Harness({ root, mode: 'full-access' });
    try {
      await h.mcpReady();
      const first = h.mcpWarningsOnce();
      assert.equal(first.length, 1, '首次上报：失败警告进链面');
      await h.mcpReady(); // 持续失败：每轮重建同文案刷新警告单
      assert.equal(h.mcpWarningsOnce().length, 0, '持续失败同文案不得每轮重复进链（O(runs) 刷屏病根，D59）');
      assert.equal(h.mcpWarnings().length, 1, '展示面（TUI/自检）保持全量口径');
      // 恢复：配置换好 server → 重建成功警告单收缩 → 摘已上报记录
      const good = { fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] } };
      writeProjectMcpJson(root, good);
      approveMcpServer(root, 'fs');
      await h.mcpReady();
      assert.equal(h.mcpWarningsOnce().length, 0, '恢复后警告单为空');
      // 再失败（同 server 同命令=同文案）：状态变更须重新进链——摘录未发生即此处空（旧实现必红）
      writeProjectMcpJson(root, bad);
      await h.mcpReady();
      const again = h.mcpWarningsOnce();
      assert.equal(again.length, 1, '恢复后再失败须重新上报（内容收缩摘已上报记录的判别面）');
      assert.match(again[0]!, /connection failed \(dead\)/);
    } finally {
      await h.mcpClose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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

test('Harness MCP 会话内热载：mcp.json 变更 → mcpReady 重注册 + 工具面 diff 漂移行 + guard 名单对齐', async () => {
  await withHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-assembly-'));
    writeProjectMcpJson(root, { fs: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] } });
    approveMcpServer(root, 'fs');
    const h = new Harness({ root, mode: 'full-access' });
    try {
      // 首次注册零漂移（模型没见过旧面——漂移行只在曾注册后的变更轮产出）
      const first = await h.mcpReady();
      assert.deepEqual(first, [], '首次注册零漂移行');
      assert.ok(h.tools.get('mcp__fs__echo'));
      // 变更配置（fs → fs2）：重注册 + added/removed 两行 + guard 名单同步
      writeProjectMcpJson(root, { fs2: { command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs2'] } });
      approveMcpServer(root, 'fs2');
      const drift = await h.mcpReady();
      assert.equal(drift.filter((l) => l.startsWith('[mcp] tools added')).length, 1, 'added 漂移行');
      assert.match(drift.find((l) => l.startsWith('[mcp] tools added'))!, /mcp__fs2__echo/);
      assert.equal(drift.filter((l) => l.startsWith('[mcp] tools removed')).length, 1, 'removed 漂移行');
      assert.match(drift.find((l) => l.startsWith('[mcp] tools removed'))!, /mcp__fs__echo/);
      assert.ok(h.tools.get('mcp__fs2__echo'), '新 server 工具已注册');
      assert.equal(h.tools.get('mcp__fs__echo'), undefined, '旧 server 工具已下架');
      assert.equal(h.security.preToolUse('mcp__fs2__echo', {}).allowed, true, 'guard 名单已对齐新配置（新工具放行）');
      assert.equal(h.security.preToolUse('mcp__fs__echo', {}).allowed, false, 'guard 名单已对齐新配置（旧工具拒绝）');
      // 未变更：零开销直通零漂移
      assert.deepEqual(await h.mcpReady(), []);
    } finally {
      await h.mcpClose();
    }
  });
});
